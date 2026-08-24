/**
 * User-facing names persisted by the Codex app-server.
 *
 * Codex exposes `Thread.name`, `agentNickname`, and `agentRole` through its v2
 * protocol and stores the same values in `<CODEX_HOME>/state_*.sqlite`. Hooks
 * do not receive those fields, so a remote DevClocked hook reads the matching
 * thread row locally and puts the name on the outgoing tick.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_LABEL_LEN = 72;
const THREAD_NAME_QUERY = `
  SELECT name, agent_nickname, agent_role
    FROM threads
   WHERE id = ?
   LIMIT 1
`;

let sqliteModule;
let sqliteUnavailable = false;

function safeHomedir() {
  try {
    const home = os.homedir();
    return typeof home === 'string' ? home : '';
  } catch {
    return '';
  }
}

function codexHome(env = process.env, home = safeHomedir()) {
  const configured = typeof env.CODEX_HOME === 'string' ? env.CODEX_HOME.trim() : '';
  return configured || (home ? path.join(home, '.codex') : '');
}

function stateStoreCandidates(env = process.env, home = safeHomedir()) {
  const root = codexHome(env, home);
  if (!root) return [];

  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }

  return entries
    .filter((entry) => entry.isFile() && /^state_\d+\.sqlite$/.test(entry.name))
    .map((entry) => ({
      path: path.join(root, entry.name),
      version: Number(entry.name.match(/^state_(\d+)\.sqlite$/)[1]),
    }))
    .sort((left, right) => right.version - left.version)
    .map((entry) => entry.path);
}

function truncateLabel(value, max = MAX_LABEL_LEN) {
  const clean = String(value).replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max - 1);
  const lastSpace = cut.lastIndexOf(' ');
  const head = lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut;
  return `${head.trimEnd()}…`;
}

function loadSqlite() {
  if (sqliteModule) return sqliteModule;
  if (sqliteUnavailable) return null;

  const originalEmitWarning = process.emitWarning;
  process.emitWarning = function quietSqliteWarning(warning, ...rest) {
    const text = typeof warning === 'string' ? warning : warning && warning.message;
    if (typeof text === 'string' && text.includes('SQLite')) return undefined;
    return originalEmitWarning.call(process, warning, ...rest);
  };
  try {
    sqliteModule = require('node:sqlite');
    return sqliteModule;
  } catch {
    sqliteUnavailable = true;
    return null;
  } finally {
    process.emitWarning = originalEmitWarning;
  }
}

function firstLabel(row) {
  if (!row || typeof row !== 'object') return null;
  const candidates = [
    ['name', 'codex'],
    ['agent_role', 'codex-agent-role'],
    ['agent_nickname', 'codex-agent'],
  ];
  for (const [field, source] of candidates) {
    if (typeof row[field] !== 'string') continue;
    const title = truncateLabel(row[field]);
    if (title) return { title, source };
  }
  return null;
}

function queryStore(storePath, threadId) {
  const sqlite = loadSqlite();
  if (!sqlite) return null;

  let db;
  try {
    db = new sqlite.DatabaseSync(storePath, { readOnly: true });
    return firstLabel(db.prepare(THREAD_NAME_QUERY).get(threadId));
  } catch {
    return null;
  } finally {
    try {
      if (db) db.close();
    } catch {
      // A close failure cannot improve this hook event.
    }
  }
}

function lookupThread(threadId, stores = stateStoreCandidates()) {
  if (typeof threadId !== 'string' || !threadId.trim()) return null;
  for (const storePath of stores) {
    const hit = queryStore(storePath, threadId.trim());
    if (hit) return hit;
  }
  return null;
}

module.exports = {
  THREAD_NAME_QUERY,
  codexHome,
  firstLabel,
  lookupThread,
  stateStoreCandidates,
  truncateLabel,
};
