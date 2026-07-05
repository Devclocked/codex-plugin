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

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function safeId(value) {
  return String(value).replace(/[^a-zA-Z0-9_-]/g, '_');
}

function writeJsonFile(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
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

  function gitExec(cwd, command) {
    try {
      return execSync(command, {
        cwd,
        timeout: 3000,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
    } catch {
      return null;
    }
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

  function resolveGitContext(input) {
    const roots = Array.isArray(input.workspace_roots) ? input.workspace_roots : [];
    const pathCandidates = [
      input.file_path,
      input.tool_input?.file_path,
      Array.isArray(input.modified_files) ? input.modified_files[0] : null,
      roots[0],
      input.cwd,
    ];

    let workingDir = null;
    for (const candidate of pathCandidates) {
      const abs = toAbsoluteDir(candidate);
      if (abs) {
        workingDir = abs;
        break;
      }
    }

    if (!workingDir) {
      return {
        workspaceFingerprint: null,
        repoUrl: null,
        repoFullName: null,
        repoName: null,
        branch: null,
        gitRoot: null,
      };
    }

    const cached = loadCachedGitContext(workingDir);
    if (cached) return cached;

    const gitRoot = gitExec(workingDir, 'git rev-parse --show-toplevel') || workingDir;
    let workspaceFingerprint = null;
    try {
      const resolvedRoot = fs.realpathSync(gitRoot).replace(/\/+$/, '').toLowerCase();
      workspaceFingerprint = createHash('sha256').update(resolvedRoot).digest('hex');
    } catch {
      workspaceFingerprint = null;
    }

    const repoUrl = gitExec(gitRoot, 'git remote get-url origin');
    const repoFullName = parseRepoFullName(repoUrl);
    const branch = gitExec(gitRoot, 'git rev-parse --abbrev-ref HEAD');
    const repoName = repoFullName ? repoFullName.split('/').pop() : path.basename(gitRoot);

    const gitContext = {
      workspaceFingerprint,
      repoUrl: repoUrl || null,
      repoFullName,
      repoName: repoName || null,
      branch: branch || null,
      gitRoot,
    };

    saveCachedGitContext(workingDir, gitContext);
    return gitContext;
  }

  function callEdgeFunction(apiKey, fnName, body) {
    return new Promise((resolve, reject) => {
      const url = new URL(`/functions/v1/${fnName}`, SUPABASE_URL);
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
      input,
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
    wakeShipper,
    writeJsonFile,
  };
}

module.exports = {
  MAX_SHIP_ATTEMPTS,
  createPluginRuntime,
};
