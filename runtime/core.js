const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');
const { createHash, randomUUID } = require('crypto');

const SUPABASE_URL = 'https://api.devclocked.com';
const SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhhcWZna2ttZWdseXJ1bG1waXN0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTIwMDYyODcsImV4cCI6MjA2NzU4MjI4N30.fTonLdDRqqtV44tBcl0Z7ryvaSD5Gczy-OTkzHUw0o4';
const DEVCLOCKED_HOME = path.join(process.env.HOME || '~', '.config', 'devclocked');
const CLI_CONFIG_PATH = path.join(DEVCLOCKED_HOME, 'cli.json');
const PLUGIN_ACTIVITY_DIR = path.join(DEVCLOCKED_HOME, 'plugin-activity');

const TICK_INTERVAL_MS = 30_000;
const LOCK_STALE_MS = 60_000;
const GIT_CACHE_TTL_MS = 60_000;
const MAX_SHIP_ATTEMPTS = 5;
const RETRY_BACKOFF_MS = 15_000;
const PLUGIN_ACTIVITY_RETENTION_MS = 72 * 60 * 60 * 1000;
const MAX_PLUGIN_ACTIVITY_ENTRIES = 1000;
const STREAM_STATE_TTL_MS = 6 * 60 * 60 * 1000;

// Read the consuming plugin's version from its manifest. The shipper lives at
// <plugin-root>/hooks/ship.js, so the manifest is two levels up. Returns
// 'unknown' rather than throwing — the version stamp must never block shipping.
function readPluginVersion(shipperPath) {
  try {
    const root = path.dirname(path.dirname(shipperPath));
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8'));
    return typeof manifest.version === 'string' && manifest.version ? manifest.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

function ensureDir(dirPath) {
  // 0700: these dirs live under ~/.config/devclocked and hold queued hook
  // payloads, stream state and cached git context — user-private only (DEV-715).
  fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dirPath, 0o700);
  } catch {
    // best-effort — non-POSIX platforms have no meaningful mode.
  }
}

function safeId(value) {
  return String(value).replace(/[^a-zA-Z0-9_-]/g, '_');
}

function writeJsonFile(filePath, value) {
  ensureDir(path.dirname(filePath));
  // 0600: queue envelopes and state can carry file paths and identifiers —
  // owner read/write only (DEV-715).
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), { mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // best-effort — non-POSIX platforms have no meaningful mode.
  }
}

/**
 * Strip embedded credentials from a git remote URL before it becomes the
 * shipped repo_url (DEV-707). `https://user:ghp_xxx@github.com/o/r.git` carries
 * a live token; blank the userinfo, keep everything else untouched.
 */
function sanitizeRepoUrl(url) {
  if (!url) return url;
  const raw = String(url).trim();
  if (!raw) return raw;
  try {
    const parsed = new URL(raw);
    if (parsed.username || parsed.password) {
      parsed.username = '';
      parsed.password = '';
      return parsed.toString();
    }
    return raw;
  } catch {
    return raw.replace(/\/\/[^@/]+@/, '//');
  }
}

// Top-level hook-input fields the shippers actually read (resolveStream,
// resolveRepo, classifyActivity, resolveModel, buildTrackTickRequest across the
// codex + cursor plugins). Everything else — raw prompts, full tool payloads,
// transcripts — is dropped before the envelope is written to disk (DEV-715).
const HOOK_INPUT_SCALAR_FIELDS = [
  'hook_event_name',
  'timestamp',
  // stream / session identity
  'session_id',
  'conversation_id',
  'parent_conversation_id',
  'thread_id',
  'turn_id',
  'prompt_id',
  'request_id',
  'call_id',
  'tool_call_id',
  'message_id',
  'id',
  'generation_id',
  'interaction_id',
  'composer_id',
  'subagent_id',
  // classification / repo hints
  'tool_name',
  'file_path',
  'git_branch',
  'model',
  'subagent_type',
  'task',
  'is_parallel_worker',
  // git-context working-dir hint
  'cwd',
];

// countEditLines only needs the newline count of each edit string. Preserve the
// count exactly while discarding the actual code by substituting a newline-only
// placeholder, so raw diff text never lands on disk.
function newlinePlaceholder(value) {
  const count = typeof value === 'string' ? value.split('\n').length : 1;
  return '\n'.repeat(Math.max(0, count - 1));
}

function sanitizeHookInput(input) {
  if (!input || typeof input !== 'object') return input;
  const clean = {};
  for (const key of HOOK_INPUT_SCALAR_FIELDS) {
    if (input[key] !== undefined) clean[key] = input[key];
  }
  // Container fields: keep only the leaf keys the shippers read, never the raw
  // content they also carry (Write bodies, command args, diff text).
  if (input.tool && typeof input.tool === 'object') {
    clean.tool = { name: input.tool.name };
  }
  if (input.payload && typeof input.payload === 'object') {
    clean.payload = { tool_name: input.payload.tool_name, name: input.payload.name };
  }
  if (input.tool_input && typeof input.tool_input === 'object') {
    clean.tool_input = { file_path: input.tool_input.file_path };
  }
  if (input.devclocked_capture && typeof input.devclocked_capture === 'object') {
    clean.devclocked_capture = { remote: input.devclocked_capture.remote };
  }
  if (Array.isArray(input.workspace_roots)) {
    clean.workspace_roots = input.workspace_roots.filter((r) => typeof r === 'string');
  }
  if (Array.isArray(input.modified_files)) {
    // Only modified_files[0] is read, and only as a directory path.
    clean.modified_files = input.modified_files.filter((r) => typeof r === 'string').slice(0, 1);
  }
  // Only the leading binary token is used (cursor shell entity); drop the
  // arguments, which can carry secrets.
  if (typeof input.command === 'string') {
    clean.command = input.command.split(/\s/)[0];
  }
  if (Array.isArray(input.edits)) {
    clean.edits = input.edits.map((edit) => ({
      new_string: newlinePlaceholder(edit && edit.new_string),
      old_string: newlinePlaceholder(edit && edit.old_string),
    }));
  }
  return clean;
}

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function normalizeOpaqueId(value) {
  if (value === null || value === undefined) return null;
  const lines = String(value)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) return null;

  const preferredCallId = lines.find((line) => line.startsWith('call_'));
  if (preferredCallId) return preferredCallId;

  return lines[0];
}

function firstOpaqueId(...values) {
  for (const value of values) {
    const normalized = normalizeOpaqueId(value);
    if (normalized) return normalized;
  }
  return null;
}

function createPluginRuntime(options) {
  const namespace = options.namespace;
  const source = options.source;
  const shipperPath = options.shipperPath;
  const execSyncImpl = options.execSyncImpl || execSync;
  const pluginVersion = options.pluginVersion || readPluginVersion(shipperPath);
  const STATE_DIR = path.join(DEVCLOCKED_HOME, `${namespace}-state`);
  const QUEUE_DIR = path.join(DEVCLOCKED_HOME, `${namespace}-queue`);
  const LOG_DIR = path.join(DEVCLOCKED_HOME, `${namespace}-logs`);
  const GIT_CACHE_DIR = path.join(DEVCLOCKED_HOME, `${namespace}-cache`);
  const SHIPPER_LOCK_PATH = path.join(QUEUE_DIR, 'shipper.lock');
  const PLUGIN_ACTIVITY_PATH = path.join(PLUGIN_ACTIVITY_DIR, `${source}.json`);

  function appendLog(name, message, extra) {
    try {
      ensureDir(LOG_DIR);
      const entry = {
        timestamp: new Date().toISOString(),
        message,
        ...(extra ? { extra } : {}),
      };
      fs.appendFileSync(path.join(LOG_DIR, `${name}.log`), `${JSON.stringify(entry)}\n`);
    } catch {
      // Logging must never block hooks.
    }
  }

  function loadAuth() {
    try {
      const config = readJsonFile(CLI_CONFIG_PATH);
      return config.api_key || null;
    } catch {
      return null;
    }
  }

  function getStreamState(streamId) {
    try {
      return readJsonFile(path.join(STATE_DIR, `stream_${safeId(streamId)}.json`));
    } catch {
      return null;
    }
  }

  function saveStreamState(streamId, state) {
    writeJsonFile(path.join(STATE_DIR, `stream_${safeId(streamId)}.json`), state);
  }

  function removeStreamState(streamId) {
    try {
      fs.unlinkSync(path.join(STATE_DIR, `stream_${safeId(streamId)}.json`));
    } catch {
      // ignore
    }
  }

  function shouldThrottle(streamId) {
    const state = getStreamState(streamId);
    if (!state || !state.last_tick_at) return false;
    return Date.now() - state.last_tick_at < TICK_INTERVAL_MS;
  }

  // Sweep stream-state files older than the TTL. removeStreamState only fires on
  // session close, which agent CLIs/editors deliver unreliably, so state would
  // leak unbounded (observed 333 live streams) without this catch-all.
  function pruneStaleStreamState(now = Date.now(), ttlMs = STREAM_STATE_TTL_MS) {
    let removed = 0;
    let files;
    try {
      files = fs.readdirSync(STATE_DIR);
    } catch {
      return 0;
    }
    for (const name of files) {
      if (!name.startsWith('stream_') || !name.endsWith('.json')) continue;
      const filePath = path.join(STATE_DIR, name);
      let stale = true;
      try {
        const state = readJsonFile(filePath);
        const lastSeen = state.last_tick_at || state.started_at;
        stale = !lastSeen || now - lastSeen > ttlMs;
      } catch {
        stale = true;
      }
      if (!stale) continue;
      try {
        fs.unlinkSync(filePath);
        removed += 1;
      } catch {
        // ignore
      }
    }
    return removed;
  }

  function toAbsoluteDir(maybePath) {
    if (!maybePath || typeof maybePath !== 'string') return null;
    const candidate = path.isAbsolute(maybePath)
      ? maybePath
      : path.join(process.env.HOME || '/', maybePath);
    try {
      const stat = fs.statSync(candidate);
      if (stat.isDirectory()) return candidate;
      return path.dirname(candidate);
    } catch {
      return null;
    }
  }

  // The detached shipper can inherit a stripped GUI/sandbox environment, so
  // resolve git through the standard system locations even when PATH lacks
  // them — a missing git binary must classify as unavailable, not "no repo".
  const GIT_PATH_FALLBACK = '/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin';

  function classifyGitFailure(error) {
    if (!error || typeof error !== 'object') return 'git_unavailable';
    if (error.code === 'ETIMEDOUT' || error.signal === 'SIGTERM' || error.killed === true) {
      return 'timeout';
    }
    if (error.code === 'ENOENT' || error.code === 'EAGAIN') return 'git_unavailable';
    if (typeof error.status === 'number') {
      // The shell ran but could not find/execute git.
      if (error.status === 127 || error.status === 126) return 'git_unavailable';
      const stderr = String(error.stderr || '');
      if (error.status === 128 && /not a git repository/i.test(stderr)) return 'not_a_repo';
      return 'git_error';
    }
    return 'git_unavailable';
  }

  function gitExecClassified(cwd, command) {
    try {
      const stdout = execSyncImpl(command, {
        cwd,
        timeout: 3000,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          PATH: `${process.env.PATH || ''}:${GIT_PATH_FALLBACK}`,
        },
      }).trim();
      return { ok: true, stdout };
    } catch (error) {
      return { ok: false, failure: classifyGitFailure(error) };
    }
  }

  function gitExec(cwd, command) {
    const result = gitExecClassified(cwd, command);
    return result.ok ? result.stdout : null;
  }

  function parseRepoFullName(repoUrl) {
    if (!repoUrl) return null;
    let match = repoUrl.match(/^git@[^:]+:([^/]+)\/(.+?)(?:\.git)?$/i);
    if (!match) match = repoUrl.match(/^https?:\/\/[^/]+\/([^/]+)\/(.+?)(?:\.git)?(?:\/)?$/i);
    if (!match) match = repoUrl.match(/^ssh:\/\/git@[^/]+\/([^/]+)\/(.+?)(?:\.git)?$/i);
    if (!match) return null;
    return `${match[1]}/${match[2]}`.toLowerCase();
  }

  function getGitCachePath(workingDir) {
    try {
      const resolved = fs.realpathSync(workingDir).replace(/\/+$/, '').toLowerCase();
      const cacheKey = createHash('sha256').update(resolved).digest('hex');
      return path.join(GIT_CACHE_DIR, `${cacheKey}.json`);
    } catch {
      return null;
    }
  }

  function loadCachedGitContext(workingDir) {
    const cachePath = getGitCachePath(workingDir);
    if (!cachePath) return null;

    try {
      const cached = readJsonFile(cachePath);
      if (!cached.cached_at || Date.now() - cached.cached_at > GIT_CACHE_TTL_MS) {
        return null;
      }
      return cached.git_context || null;
    } catch {
      return null;
    }
  }

  function saveCachedGitContext(workingDir, gitContext) {
    const cachePath = getGitCachePath(workingDir);
    if (!cachePath) return;

    writeJsonFile(cachePath, {
      cached_at: Date.now(),
      git_context: gitContext,
    });
  }

  function fingerprintPath(dirPath) {
    try {
      const resolved = fs.realpathSync(dirPath).replace(/\/+$/, '').toLowerCase();
      return createHash('sha256').update(resolved).digest('hex');
    } catch {
      return null;
    }
  }

  function deferredGitContext(workspacePath, failure) {
    return {
      workspaceFingerprint: null,
      repoUrl: null,
      repoFullName: null,
      repoName: null,
      branch: null,
      gitRoot: null,
      workspacePath: workspacePath || null,
      resolution: 'deferred',
      resolutionFailure: failure || null,
    };
  }

  function buildRepoGitContext(gitRoot) {
    const repoUrl = sanitizeRepoUrl(gitExec(gitRoot, 'git remote get-url origin'));
    const repoFullName = parseRepoFullName(repoUrl);
    const branch = gitExec(gitRoot, 'git rev-parse --abbrev-ref HEAD');
    const repoName = repoFullName ? repoFullName.split('/').pop() : path.basename(gitRoot);

    return {
      workspaceFingerprint: fingerprintPath(gitRoot),
      repoUrl: repoUrl || null,
      repoFullName,
      repoName: repoName || null,
      branch: branch || null,
      gitRoot,
      workspacePath: gitRoot,
      resolution: 'git',
      resolutionFailure: null,
    };
  }

  function isGuardedRoot(dirPath) {
    let resolved = dirPath;
    try {
      resolved = fs.realpathSync(dirPath);
    } catch {
      // fall through with the raw path
    }
    const normalized = resolved.replace(/\/+$/, '') || '/';
    let home = process.env.HOME || '';
    try {
      if (home) home = fs.realpathSync(home);
    } catch {
      // keep the raw value
    }
    home = home.replace(/\/+$/, '');
    return normalized === '/' || (Boolean(home) && normalized === home);
  }

  // Identity resolution ladder (DEV-674 / DEV-671): git root when git ran,
  // session-start cwd when git ran and said "not a repository", and DEFER
  // whenever git could not run (missing binary, timeout, spawn failure) —
  // never name a project from a per-tool-call file path, and never mint a
  // fingerprint for a directory git could not vouch for.
  function resolveGitContext(input) {
    const roots = Array.isArray(input.workspace_roots) ? input.workspace_roots : [];
    const remote = input.devclocked_capture?.remote === true;
    const sessionDir = toAbsoluteDir(input.cwd) || toAbsoluteDir(roots[0]);
    const fileDirCandidates = [
      input.file_path,
      input.tool_input?.file_path,
      Array.isArray(input.modified_files) ? input.modified_files[0] : null,
    ];
    let fileDir = null;
    for (const candidate of fileDirCandidates) {
      const abs = toAbsoluteDir(candidate);
      if (abs) {
        fileDir = abs;
        break;
      }
    }

    const identityDir = sessionDir || fileDir;
    if (!identityDir) return deferredGitContext(null, 'no_working_dir');

    const cached = loadCachedGitContext(identityDir);
    if (cached && cached.resolution) return cached;

    const rootResult = gitExecClassified(identityDir, 'git rev-parse --show-toplevel');
    if (rootResult.ok) {
      const gitContext = buildRepoGitContext(rootResult.stdout);
      saveCachedGitContext(identityDir, gitContext);
      return gitContext;
    }

    if (rootResult.failure !== 'not_a_repo') {
      appendLog('shipper', 'Deferring project identity because git could not run', {
        failure: rootResult.failure,
        dir: identityDir,
        path_env: process.env.PATH || null,
      });
      return deferredGitContext(sessionDir, rootResult.failure);
    }

    // git ran and the session dir is genuinely not a repository. If the tool
    // touched a file inside some other repo, that repo's root still wins.
    if (fileDir && fileDir !== identityDir) {
      const fileRootResult = gitExecClassified(fileDir, 'git rev-parse --show-toplevel');
      if (fileRootResult.ok) {
        const gitContext = buildRepoGitContext(fileRootResult.stdout);
        saveCachedGitContext(identityDir, gitContext);
        return gitContext;
      }
    }

    // Legitimate non-git project — but only the session-start cwd may name
    // it, never a file-path-derived subfolder, never a remote sandbox cwd.
    if (!sessionDir || remote || isGuardedRoot(sessionDir)) {
      return deferredGitContext(sessionDir, remote ? 'remote_non_git' : 'unnameable_dir');
    }

    const gitContext = {
      workspaceFingerprint: fingerprintPath(sessionDir),
      repoUrl: null,
      repoFullName: null,
      repoName: path.basename(sessionDir) || null,
      branch: null,
      gitRoot: null,
      workspacePath: sessionDir,
      resolution: 'cwd',
      resolutionFailure: null,
    };
    saveCachedGitContext(identityDir, gitContext);
    return gitContext;
  }

  // Stamp the installed plugin version onto every tick's ai_tool so the backend
  // persists it in activity_logs.activity_context — makes "which version is a
  // user running" queryable from the DB and lets us verify a release propagated.
  function stampPluginVersion(body) {
    if (!body || !Array.isArray(body.ticks)) return;
    for (const tick of body.ticks) {
      const aiTool = tick && tick.activity_context && tick.activity_context.ai_tool;
      if (aiTool && typeof aiTool === 'object' && aiTool.plugin_version === undefined) {
        aiTool.plugin_version = pluginVersion;
      }
    }
  }

  function callEdgeFunction(apiKey, fnName, body) {
    return new Promise((resolve, reject) => {
      const url = new URL(`/functions/v1/${fnName}`, SUPABASE_URL);
      if (fnName === 'track-tick') stampPluginVersion(body);
      const data = JSON.stringify(body);

      const req = https.request(
        url,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'apikey': SUPABASE_ANON_KEY,
            'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
            'x-devclocked-key': apiKey,
            'x-devclocked-source': source,
            'x-devclocked-plugin-version': pluginVersion,
            'Content-Length': Buffer.byteLength(data),
          },
          timeout: 10_000,
        },
        (res) => {
          let responseBody = '';
          res.on('data', (chunk) => (responseBody += chunk));
          res.on('end', () => {
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              resolve({ status: res.statusCode, body: responseBody });
              return;
            }
            reject(new Error(`edge_function_${res.statusCode || 'unknown'}`));
          });
        }
      );

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('timeout'));
      });
      req.write(data);
      req.end();
    });
  }

  function isTrackTickProcessed(response) {
    try {
      const body = typeof response?.body === 'string'
        ? JSON.parse(response.body)
        : response?.body;
      return body?.session_updated === true || Number(body?.processed_count || 0) > 0;
    } catch {
      return false;
    }
  }

  function nextQueueFilePath() {
    ensureDir(QUEUE_DIR);
    return path.join(QUEUE_DIR, `${Date.now()}-${process.pid}-${randomUUID()}.json`);
  }

  function enqueueHookEvent(input) {
    const envelope = {
      id: randomUUID(),
      captured_at: new Date().toISOString(),
      attempts: 0,
      input: sanitizeHookInput(input),
    };
    const filePath = nextQueueFilePath();
    writeJsonFile(filePath, envelope);
    return filePath;
  }

  function listQueueFiles() {
    try {
      ensureDir(QUEUE_DIR);
      return fs
        .readdirSync(QUEUE_DIR)
        .filter((name) => name.endsWith('.json'))
        .sort()
        .map((name) => path.join(QUEUE_DIR, name));
    } catch {
      return [];
    }
  }

  function isProcessAlive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  function acquireShipperLock() {
    ensureDir(QUEUE_DIR);
    try {
      const fd = fs.openSync(SHIPPER_LOCK_PATH, 'wx');
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, started_at: Date.now() }));
      return fd;
    } catch (error) {
      if (error.code !== 'EEXIST') return null;
      try {
        const existing = readJsonFile(SHIPPER_LOCK_PATH);
        const stale = !existing.started_at || Date.now() - existing.started_at > LOCK_STALE_MS;
        const dead = !existing.pid || !isProcessAlive(existing.pid);
        if (stale || dead) {
          fs.unlinkSync(SHIPPER_LOCK_PATH);
          return acquireShipperLock();
        }
      } catch {
        try {
          fs.unlinkSync(SHIPPER_LOCK_PATH);
          return acquireShipperLock();
        } catch {
          return null;
        }
      }
      return null;
    }
  }

  function releaseShipperLock(fd) {
    try {
      fs.closeSync(fd);
    } catch {
      // ignore
    }
    try {
      fs.unlinkSync(SHIPPER_LOCK_PATH);
    } catch {
      // ignore
    }
  }

  function markEnvelopeRetry(filePath, envelope, errorMessage) {
    envelope.attempts = (envelope.attempts || 0) + 1;
    envelope.last_error = errorMessage;
    envelope.last_attempt_at = new Date().toISOString();
    envelope.retry_after = new Date(Date.now() + RETRY_BACKOFF_MS).toISOString();
    writeJsonFile(filePath, envelope);
  }

  function shouldRetryEnvelope(envelope) {
    if (!envelope.retry_after) return true;
    return Date.now() >= new Date(envelope.retry_after).getTime();
  }

  function discardEnvelope(filePath, envelope, reason) {
    appendLog('shipper', 'Dropping queued hook event', {
      file: path.basename(filePath),
      reason,
      hook_event_name: envelope.input?.hook_event_name || null,
      attempts: envelope.attempts || 0,
    });
    try {
      fs.unlinkSync(filePath);
    } catch {
      // ignore
    }
  }

  function wakeShipper() {
    try {
      const { spawn } = require('child_process');
      const child = spawn(process.execPath, [shipperPath], {
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
    } catch (error) {
      appendLog('hook', 'Failed to wake shipper', {
        error: error instanceof Error ? error.message : 'unknown_error',
      });
    }
  }

  function readPluginActivity() {
    try {
      const raw = readJsonFile(PLUGIN_ACTIVITY_PATH);
      const entries = Array.isArray(raw.entries) ? raw.entries : [];
      return {
        version: 1,
        entries,
      };
    } catch {
      return {
        version: 1,
        entries: [],
      };
    }
  }

  function recordPluginActivity(entry) {
    const observedAtMs = new Date(entry.observedAt || Date.now()).getTime();
    const cutoff = Date.now() - PLUGIN_ACTIVITY_RETENTION_MS;
    const current = readPluginActivity();
    const retained = current.entries.filter((item) => {
      const ts = new Date(item.observedAt || 0).getTime();
      return Number.isFinite(ts) && ts >= cutoff;
    });

    retained.push({
      workspaceFingerprint: entry.workspaceFingerprint || null,
      rootStreamId: entry.rootStreamId || null,
      streamId: entry.streamId || null,
      sessionFileId: entry.sessionFileId || null,
      observedAt: Number.isFinite(observedAtMs) ? new Date(observedAtMs).toISOString() : new Date().toISOString(),
    });

    const deduped = [];
    const seen = new Set();
    for (const item of retained.slice(-MAX_PLUGIN_ACTIVITY_ENTRIES)) {
      const key = [
        item.workspaceFingerprint || '',
        item.rootStreamId || '',
        item.streamId || '',
        item.sessionFileId || '',
        item.observedAt || '',
      ].join('::');
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(item);
    }

    writeJsonFile(PLUGIN_ACTIVITY_PATH, {
      version: 1,
      updated_at: new Date().toISOString(),
      entries: deduped,
    });
  }

  return {
    SUPABASE_URL,
    SUPABASE_ANON_KEY,
    CLI_CONFIG_PATH,
    DEVCLOCKED_HOME,
    STATE_DIR,
    QUEUE_DIR,
    LOG_DIR,
    GIT_CACHE_DIR,
    SHIPPER_LOCK_PATH,
    SHIPPER_PATH: shipperPath,
    MAX_SHIP_ATTEMPTS,
    appendLog,
    acquireShipperLock,
    callEdgeFunction,
    classifyGitFailure,
    discardEnvelope,
    enqueueHookEvent,
    ensureDir,
    firstOpaqueId,
    getStreamState,
    isTrackTickProcessed,
    listQueueFiles,
    loadAuth,
    markEnvelopeRetry,
    normalizeOpaqueId,
    readJsonFile,
    recordPluginActivity,
    releaseShipperLock,
    removeStreamState,
    resolveGitContext,
    saveStreamState,
    shouldRetryEnvelope,
    shouldThrottle,
    pruneStaleStreamState,
    wakeShipper,
    writeJsonFile,
    pluginVersion,
  };
}

module.exports = {
  MAX_SHIP_ATTEMPTS,
  createPluginRuntime,
};
