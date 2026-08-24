/**
 * Shell thread names for the hook runtimes (DEV-1055).
 *
 * t3 code, and the Demuxx fork of it, drive Claude Code and Codex through
 * their SDKs. The agent still fires hooks, but the session never gets an
 * `ai-title` and the Codex thread never reaches `session_index.jsonl`, because
 * both of those are written by the interactive clients. The only place the
 * thread's name exists is the shell's own store, `<base>/userdata/state.sqlite`.
 *
 * On the machine that also runs the DevClocked desktop app the daemon reads
 * that store itself (`packages/daemon/src/parsers/shellStreamNaming.ts`). On a
 * remote environment there is no desktop app: the hooks are the only
 * DevClocked code on the host, so they read the store and put the name on the
 * tick as `stream_title` + `stream_title_source`, and the backend labels the
 * stream for every surface. Keep the query and the privacy rule in step with
 * the daemon copy by hand.
 *
 * PRIVACY (DEV-816). A thread is created with the user's raw first prompt as
 * its title and renamed to a written summary later. Raw prompt text is never
 * read under any setting, so a title only counts once it differs from the one
 * `thread.created` carries. A thread still on its creation title is unnamed.
 *
 * Hooks are short-lived processes, so there is no in-memory cache to lean on.
 * Each lookup opens the database read-only (one index seek per thread, ~10 ms
 * against a 150 MB store); the caller throttles by stashing the answer on the
 * stream state. `node:sqlite` needs Node 22.5+; anything older, or no shell on
 * this host, degrades to "no name" and never to an error.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_LABEL_LEN = 72;
const MAX_SOURCE_LEN = 32;

/**
 * Every store this host might have, most specific first. `$T3CODE_HOME` is
 * how both shells relocate their data directory; the defaults are what each
 * ships with. A base named `.demuxx` is the fork wherever it lives.
 */
function shellStoreCandidates(env = process.env, home = safeHomedir()) {
  const bases = [];
  const configured = typeof env.T3CODE_HOME === 'string' ? env.T3CODE_HOME.trim() : '';
  if (configured) bases.push(configured);
  if (home) bases.push(path.join(home, '.demuxx'), path.join(home, '.t3'));

  const seen = new Set();
  const stores = [];
  for (const base of bases) {
    const dbPath = path.join(base, 'userdata', 'state.sqlite');
    if (seen.has(dbPath)) continue;
    seen.add(dbPath);
    stores.push({ path: dbPath, source: path.basename(base) === '.demuxx' ? 'demuxx' : 't3code' });
  }
  return stores;
}

function safeHomedir() {
  try {
    const home = os.homedir();
    return typeof home === 'string' ? home : '';
  } catch {
    return '';
  }
}

function truncateLabel(value, max = MAX_LABEL_LEN) {
  const clean = String(value).replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max - 1);
  const lastSpace = cut.lastIndexOf(' ');
  const head = lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut;
  return `${head.trimEnd()}…`;
}

// Same query as the daemon: renamed threads only, one index seek per thread.
const CLAUDE_SESSION_QUERY = `
  SELECT t.title AS title
    FROM provider_session_runtime r
    JOIN projection_threads t ON t.thread_id = r.thread_id
   WHERE lower(r.provider_name) LIKE 'claude%'
     AND json_extract(r.resume_cursor_json, '$.resume') = ?
     AND t.deleted_at IS NULL
     AND t.title IS NOT NULL
     AND trim(t.title) <> ''
     AND t.title <> coalesce(
           json_extract(
             (SELECT e.payload_json
                FROM orchestration_events e
               WHERE e.aggregate_kind = 'thread'
                 AND e.stream_id = t.thread_id
                 AND e.event_type = 'thread.created'
               ORDER BY e.sequence
               LIMIT 1),
             '$.title'),
           '')
   LIMIT 1
`;

const CODEX_THREAD_QUERY = CLAUDE_SESSION_QUERY
  .replace("lower(r.provider_name) LIKE 'claude%'", "lower(r.provider_name) LIKE 'codex%'")
  .replace("json_extract(r.resume_cursor_json, '$.resume') = ?", "json_extract(r.resume_cursor_json, '$.threadId') = ?");

let sqliteModule;
let sqliteUnavailable = false;

function loadSqlite() {
  if (sqliteModule) return sqliteModule;
  if (sqliteUnavailable) return null;
  // Node tags `node:sqlite` experimental and prints a warning on first
  // require. A hook's stderr is the agent's stderr, so that one line would
  // land in every user's session. Swallow that warning and only that one.
  const originalEmitWarning = process.emitWarning;
  process.emitWarning = function quietSqliteWarning(warning, ...rest) {
    const text = typeof warning === 'string' ? warning : warning && warning.message;
    if (typeof text === 'string' && text.includes('SQLite')) return undefined;
    return originalEmitWarning.call(process, warning, ...rest);
  };
  try {
    // Required lazily so a host without a shell never pays for the module.
    // eslint-disable-next-line global-require
    sqliteModule = require('node:sqlite');
    return sqliteModule;
  } catch {
    sqliteUnavailable = true;
    return null;
  } finally {
    process.emitWarning = originalEmitWarning;
  }
}

function queryStore(store, sql, id) {
  const sqlite = loadSqlite();
  if (!sqlite) return null;

  let exists = false;
  try {
    exists = fs.statSync(store.path).isFile();
  } catch {
    return null;
  }
  if (!exists) return null;

  let db;
  try {
    db = new sqlite.DatabaseSync(store.path, { readOnly: true });
    const row = db.prepare(sql).get(id);
    const title = row && typeof row.title === 'string' ? truncateLabel(row.title) : '';
    return title ? { title, source: store.source.slice(0, MAX_SOURCE_LEN) } : null;
  } catch {
    // Locked, mid-migration, or not a t3 store at all — no name this time.
    return null;
  } finally {
    try {
      if (db) db.close();
    } catch {
      // Nothing useful to do with a close failure.
    }
  }
}

function lookup(sql, id, stores) {
  if (typeof id !== 'string' || !id.trim()) return null;
  for (const store of stores) {
    const hit = queryStore(store, sql, id.trim());
    if (hit) return hit;
  }
  return null;
}

/** `{ title, source }` for a Claude Code session id, or null. */
function lookupClaudeSession(sessionId, stores = shellStoreCandidates()) {
  return lookup(CLAUDE_SESSION_QUERY, sessionId, stores);
}

/** `{ title, source }` for a Codex thread id, or null. */
function lookupCodexThread(threadId, stores = shellStoreCandidates()) {
  return lookup(CODEX_THREAD_QUERY, threadId, stores);
}

/**
 * Whether shell titles may leave this host on ticks. Shell titles are
 * deliberate names, never the raw prompt, so they ship by default — a remote
 * environment has no desktop app to hand a local-only name to, so "local only"
 * would mean "nowhere". `DEVCLOCKED_TRACK_SESSION_TITLES=0` or
 * `track_session_titles: false` in the desktop's daemon-config.json (same
 * setting the daemon honours, DEV-854) turns them off.
 */
function shellTitlesEnabled(env = process.env, configPath = defaultDaemonConfigPath()) {
  const fromEnv = typeof env.DEVCLOCKED_TRACK_SESSION_TITLES === 'string'
    ? env.DEVCLOCKED_TRACK_SESSION_TITLES.trim().toLowerCase()
    : '';
  if (fromEnv) return !['0', 'false', 'off', 'no'].includes(fromEnv);

  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (config && typeof config === 'object') {
      if (config.track_session_titles === false || config.trackSessionTitles === false) return false;
    }
  } catch {
    // No desktop config on this host — the default stands.
  }
  return true;
}

function defaultDaemonConfigPath() {
  const home = safeHomedir();
  return home ? path.join(home, '.config', 'devclocked', 'daemon-config.json') : '';
}

module.exports = {
  shellStoreCandidates,
  lookupClaudeSession,
  lookupCodexThread,
  shellTitlesEnabled,
  truncateLabel,
  CLAUDE_SESSION_QUERY,
  CODEX_THREAD_QUERY,
};
