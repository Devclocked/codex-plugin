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
// Exhausting MAX_SHIP_ATTEMPTS used to unlink the envelope, so ~75s of backend
// downtime destroyed the activity permanently. Exhausted envelopes now move to
// a bounded on-disk dead-letter store and replay once sends succeed again
// (DEV-936, design ported from tracker-core DEV-826). Backend ingest is
// idempotent (tick_key + request_key), so replaying a stale backlog is safe
// with no client-side dedupe. Eviction below is the only path that loses data.
const DEAD_LETTER_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const DEAD_LETTER_MAX_BYTES = 5 * 1024 * 1024;
// At 5 MB the store holds ~19.5k envelopes. Replaying them all in one run would
// hold the shipper lock far past LOCK_STALE_MS (60s), at which point another
// shipper reclaims the lock from a LIVE holder and the two ship concurrently.
// Cap the batch and drain it oldest-first over successive runs instead.
const DEAD_LETTER_REPLAY_LIMIT = 25;
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

// Write via a temp file + rename so a reader never sees a half-written
// envelope. A plain writeFileSync left truncated JSON behind whenever the
// process died mid-write, and one unparsable file used to wedge the whole
// shipper (DEV-936). The temp name does not end in .json, so neither
// listQueueFiles nor listDeadLetterFiles can pick it up.
function writeJsonFile(filePath, value) {
  ensureDir(path.dirname(filePath));
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  try {
    // 0600: queue envelopes and state can carry file paths and identifiers —
    // owner read/write only (DEV-715).
    fs.writeFileSync(tmpPath, JSON.stringify(value, null, 2), { mode: 0o600 });
    try {
      fs.chmodSync(tmpPath, 0o600);
    } catch {
      // best-effort — non-POSIX platforms have no meaningful mode.
    }
    fs.renameSync(tmpPath, filePath);
  } catch (error) {
    // The write itself has to be inside the try: an ENOSPC/EIO part-way
    // through leaves a temp file that nothing else will ever clean up.
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // ignore
    }
    throw error;
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
    // Our own capture envelope, stamped by track.js from env — the sanitizer
    // exists to strip the host tool's payload, not this namespace. Preserve
    // scalar leaves by type so no future capture key can be silently truncated
    // by any copy; nested values still get dropped (DEV-817).
    const capture = {};
    for (const [key, value] of Object.entries(input.devclocked_capture)) {
      if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
        capture[key] = value;
      }
    }
    clean.devclocked_capture = capture;
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
  // Sibling of QUEUE_DIR, never inside it: listQueueFiles() globs every *.json
  // in QUEUE_DIR, so a dead-letter entry parked there would be picked straight
  // back up by the next drain instead of waiting for a replay.
  const DEAD_LETTER_DIR = path.join(DEVCLOCKED_HOME, `${namespace}-dead-letter`);
  // Envelopes that cannot be parsed at all. Kept out of both the queue and the
  // dead-letter globs: a corrupt file cannot be shipped and cannot be replayed,
  // so parking it here is what stops it wedging every later envelope (DEV-936).
  const QUARANTINE_DIR = path.join(DEVCLOCKED_HOME, `${namespace}-corrupt`);
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
      let reclaimable = false;
      try {
        const existing = readJsonFile(SHIPPER_LOCK_PATH);
        const stale = !existing.started_at || Date.now() - existing.started_at > LOCK_STALE_MS;
        const dead = !existing.pid || !isProcessAlive(existing.pid);
        reclaimable = stale || dead;
      } catch {
        // Empty or unparsable lock: most likely another shipper is between
        // openSync('wx') and writeFileSync. Treat it as HELD unless the file
        // itself is old — unlinking a fresh lock here let two shippers run
        // concurrently (DEV-938).
        try {
          reclaimable = Date.now() - fs.statSync(SHIPPER_LOCK_PATH).mtimeMs > LOCK_STALE_MS;
        } catch {
          return null;
        }
      }
      if (!reclaimable) return null;
      try {
        fs.unlinkSync(SHIPPER_LOCK_PATH);
      } catch {
        return null;
      }
      return acquireShipperLock();
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

  // Intentional drops only — a missing hook event name, a session end the
  // backend already closed, a throttled tick, a tick the backend processed as
  // no-op. Retry exhaustion is NOT one of these; it goes to the dead-letter
  // store below (DEV-936).
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

  function listDeadLetterFiles() {
    try {
      ensureDir(DEAD_LETTER_DIR);
      return fs
        .readdirSync(DEAD_LETTER_DIR)
        .filter((name) => name.endsWith('.json'))
        .sort()
        .map((name) => path.join(DEAD_LETTER_DIR, name));
    } catch {
      return [];
    }
  }

  // Park an envelope whose retries are exhausted. Write-then-remove so a crash
  // between the two can only duplicate, never lose — and duplicates are
  // absorbed by the idempotent backend ingest. Returns the new path, or null
  // when the move failed (the envelope then stays queued and retries again).
  function deadLetterEnvelope(filePath, envelope, reason) {
    const target = path.join(DEAD_LETTER_DIR, path.basename(filePath));
    envelope.dead_lettered_at = new Date().toISOString();
    envelope.dead_letter_reason = reason;
    try {
      writeJsonFile(target, envelope);
      fs.unlinkSync(filePath);
    } catch (error) {
      appendLog('shipper', 'Failed to dead-letter queued hook event', {
        file: path.basename(filePath),
        reason,
        error: error instanceof Error ? error.message : 'unknown_error',
      });
      return null;
    }
    appendLog('shipper', 'Dead-lettered queued hook event, will replay on reconnect', {
      file: path.basename(filePath),
      reason,
      hook_event_name: envelope.input?.hook_event_name || null,
      attempts: envelope.attempts || 0,
    });
    // Deliberately NOT pruning here. Pruning stats and reads every entry, and
    // an outage dead-letters envelopes in bursts — doing it per move burned
    // ~52s of the 60s lock window on a 100-envelope burst. drainQueue prunes
    // once per run instead (DEV-936).
    return target;
  }

  // Delete files in dirPath whose mtime is past maxAgeMs. Used for the two side
  // stores that hold nothing shippable: .tmp orphans left by a write that died
  // before its rename, and quarantined envelopes that will never parse. mtime is
  // the right clock for both — neither has a trustworthy captured_at.
  function sweepStaleFiles(dirPath, { now, maxAgeMs, filter, reason }) {
    let names;
    try {
      names = fs.readdirSync(dirPath);
    } catch {
      return 0;
    }
    let removed = 0;
    for (const name of names) {
      if (!filter(name)) continue;
      const filePath = path.join(dirPath, name);
      let stats;
      try {
        stats = fs.statSync(filePath);
      } catch {
        continue;
      }
      if (now - stats.mtimeMs <= maxAgeMs) continue;
      try {
        fs.unlinkSync(filePath);
      } catch {
        continue;
      }
      removed += 1;
      appendLog('shipper', 'Swept stale file', { file: name, dir: dirPath, reason });
    }
    return removed;
  }

  // The once-per-run housekeeping sweep. Bounds the dead-letter store by age and
  // by total bytes, oldest first, and clears the two side stores that would
  // otherwise grow without limit. Dead-letter eviction is the only path that
  // truly loses activity, so every eviction is logged — silent loss here would
  // be the exact bug DEV-936 fixes. The return value counts dead-letter
  // evictions only; the side sweeps log their own.
  function pruneDeadLetter(now = Date.now(), options = {}) {
    const maxAgeMs = options.maxAgeMs ?? DEAD_LETTER_MAX_AGE_MS;
    const maxBytes = options.maxBytes ?? DEAD_LETTER_MAX_BYTES;

    const isTmp = (name) => name.endsWith('.tmp');
    sweepStaleFiles(QUEUE_DIR, { now, maxAgeMs, filter: isTmp, reason: 'orphaned_tmp' });
    sweepStaleFiles(DEAD_LETTER_DIR, { now, maxAgeMs, filter: isTmp, reason: 'orphaned_tmp' });
    sweepStaleFiles(QUARANTINE_DIR, { now, maxAgeMs, filter: () => true, reason: 'quarantine_max_age' });

    const entries = [];
    for (const filePath of listDeadLetterFiles()) {
      let stats;
      try {
        stats = fs.statSync(filePath);
      } catch {
        continue;
      }
      let capturedAtMs = NaN;
      try {
        capturedAtMs = Date.parse(readJsonFile(filePath).captured_at);
      } catch {
        // Unreadable envelope: fall back to mtime so it can still age out.
      }
      if (!Number.isFinite(capturedAtMs)) capturedAtMs = stats.mtimeMs;
      entries.push({ filePath, bytes: stats.size, capturedAtMs });
    }

    let evicted = 0;
    const evict = (entry, reason, detail) => {
      try {
        fs.unlinkSync(entry.filePath);
      } catch {
        return false;
      }
      evicted += 1;
      appendLog('shipper', 'Evicted dead-lettered hook event — activity permanently lost', {
        file: path.basename(entry.filePath),
        reason,
        captured_at: new Date(entry.capturedAtMs).toISOString(),
        bytes: entry.bytes,
        ...detail,
      });
      return true;
    };

    const survivors = [];
    for (const entry of entries) {
      if (now - entry.capturedAtMs > maxAgeMs) {
        if (!evict(entry, 'max_age', { max_age_ms: maxAgeMs })) survivors.push(entry);
        continue;
      }
      survivors.push(entry);
    }

    survivors.sort((a, b) => a.capturedAtMs - b.capturedAtMs);
    let totalBytes = survivors.reduce((sum, entry) => sum + entry.bytes, 0);
    for (const entry of survivors) {
      if (totalBytes <= maxBytes) break;
      if (evict(entry, 'max_bytes', { max_bytes: maxBytes, total_bytes: totalBytes })) {
        totalBytes -= entry.bytes;
      }
    }

    return evicted;
  }

  // Move ONE dead-lettered envelope back into the live queue with a clean retry
  // budget. Deliberately single-envelope: the caller ships each one before
  // moving the next, so a backend that is still unreachable costs exactly one
  // timeout instead of one per parked envelope, and everything not yet moved
  // stays parked. Returns { queuedPath, quarantined }: queuedPath is null when
  // the envelope did not move, and quarantined says whether that was because it
  // would not parse (so the caller can account for it).
  function replayDeadLetterFile(filePath) {
    let envelope;
    try {
      envelope = readJsonFile(filePath);
    } catch (error) {
      // Unparsable and unshippable: quarantine rather than replay it forever.
      return { queuedPath: null, quarantined: quarantineEnvelope(filePath, error) };
    }
    envelope.attempts = 0;
    delete envelope.retry_after;
    envelope.replayed_at = new Date().toISOString();
    const target = path.join(QUEUE_DIR, path.basename(filePath));
    try {
      writeJsonFile(target, envelope);
      fs.unlinkSync(filePath);
    } catch (error) {
      appendLog('shipper', 'Failed to replay dead-lettered hook event', {
        file: path.basename(filePath),
        error: error instanceof Error ? error.message : 'unknown_error',
      });
      return { queuedPath: null, quarantined: false };
    }
    return { queuedPath: target, quarantined: false };
  }

  // Batch form, oldest first, for callers that do not need to stop early.
  function replayDeadLetter(limit = DEAD_LETTER_REPLAY_LIMIT) {
    let replayed = 0;
    for (const filePath of listDeadLetterFiles().slice(0, limit)) {
      if (replayDeadLetterFile(filePath).queuedPath) replayed += 1;
    }
    if (replayed > 0) {
      appendLog('shipper', 'Replayed dead-lettered hook events into the queue', { count: replayed });
    }
    return replayed;
  }

  // A queue file that will not parse cannot ship and cannot replay. Move it out
  // of the way — leaving it in place threw out of processEnvelope, unwound the
  // whole drain and stranded every other envelope behind it (DEV-936).
  //
  // ONLY unparsable files are moved. Any other throw (a transient write failure
  // while stamping a retry, say) leaves a perfectly good envelope alone for the
  // next run rather than quietly relocating captured activity.
  function quarantineEnvelope(filePath, error) {
    if (!fs.existsSync(filePath)) return false;
    try {
      readJsonFile(filePath);
      appendLog('shipper', 'Queue file failed to process but still parses — left in place', {
        file: path.basename(filePath),
        error: error instanceof Error ? error.message : 'unknown_error',
      });
      return false;
    } catch {
      // Genuinely unreadable — fall through and move it.
    }

    const target = path.join(QUARANTINE_DIR, path.basename(filePath));
    let moved = false;
    try {
      ensureDir(QUARANTINE_DIR);
      fs.renameSync(filePath, target);
      moved = true;
    } catch {
      try {
        fs.unlinkSync(filePath);
      } catch {
        // Leave it; the next run catches the same throw and retries the move.
      }
    }
    appendLog('shipper', 'Quarantined unreadable queue file', {
      file: path.basename(filePath),
      moved_to: moved ? target : null,
      error: error instanceof Error ? error.message : 'unknown_error',
    });
    return moved;
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
    DEAD_LETTER_DIR,
    QUARANTINE_DIR,
    SHIPPER_LOCK_PATH,
    SHIPPER_PATH: shipperPath,
    MAX_SHIP_ATTEMPTS,
    DEAD_LETTER_MAX_AGE_MS,
    DEAD_LETTER_MAX_BYTES,
    DEAD_LETTER_REPLAY_LIMIT,
    appendLog,
    acquireShipperLock,
    callEdgeFunction,
    classifyGitFailure,
    deadLetterEnvelope,
    discardEnvelope,
    enqueueHookEvent,
    ensureDir,
    firstOpaqueId,
    getStreamState,
    isTrackTickProcessed,
    listDeadLetterFiles,
    listQueueFiles,
    loadAuth,
    markEnvelopeRetry,
    normalizeOpaqueId,
    pruneDeadLetter,
    quarantineEnvelope,
    readJsonFile,
    recordPluginActivity,
    releaseShipperLock,
    removeStreamState,
    replayDeadLetter,
    replayDeadLetterFile,
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
  DEAD_LETTER_MAX_AGE_MS,
  DEAD_LETTER_MAX_BYTES,
  DEAD_LETTER_REPLAY_LIMIT,
  createPluginRuntime,
};
