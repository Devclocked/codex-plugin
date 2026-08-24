const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  shellStoreCandidates,
  lookupClaudeSession,
  lookupCodexThread,
  shellTitlesEnabled,
} = require('./shellThreadNames');

function sqliteAvailable() {
  try {
    require('node:sqlite');
    return true;
  } catch {
    return false;
  }
}

const q = (value) => `'${String(value).replace(/'/g, "''")}'`;
const RAW_PROMPT = 'ok so this app Demuxx is not writing the chat names in the sideb...';

function writeFixtureDb(dbPath, threads) {
  const { DatabaseSync } = require('node:sqlite');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE projection_threads (thread_id TEXT PRIMARY KEY, title TEXT NOT NULL, deleted_at TEXT);
    CREATE TABLE provider_session_runtime (thread_id TEXT PRIMARY KEY, provider_name TEXT NOT NULL, resume_cursor_json TEXT);
    CREATE TABLE orchestration_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, aggregate_kind TEXT NOT NULL,
      stream_id TEXT NOT NULL, event_type TEXT NOT NULL, payload_json TEXT NOT NULL);
  `);
  const event = (threadId, type, payload) =>
    db.exec(`INSERT INTO orchestration_events (aggregate_kind, stream_id, event_type, payload_json)
             VALUES ('thread', ${q(threadId)}, ${q(type)}, ${q(JSON.stringify(payload))})`);
  for (const t of threads) {
    db.exec(`INSERT INTO projection_threads VALUES (${q(t.threadId)}, ${q(t.title)}, ${t.deleted ? q('2026-08-24T00:00:00Z') : 'NULL'})`);
    db.exec(`INSERT INTO provider_session_runtime VALUES (${q(t.threadId)}, ${q(t.provider)}, ${q(t.cursor)})`);
    event(t.threadId, 'thread.created', { threadId: t.threadId, title: RAW_PROMPT });
    event(t.threadId, 'thread.activity-appended', { threadId: t.threadId });
    if (t.renamed) event(t.threadId, 'thread.meta-updated', { threadId: t.threadId, title: t.title });
  }
  db.close();
}

function fixtureHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'shell-thread-names-'));
  writeFixtureDb(path.join(home, '.demuxx', 'userdata', 'state.sqlite'), [
    {
      threadId: 'thread-named', provider: 'claudeAgent', renamed: true,
      cursor: JSON.stringify({ threadId: 'thread-named', resume: 'claude-session-1' }),
      title: 'Missing Claude Chat Name Metadata',
    },
    {
      threadId: 'thread-unnamed', provider: 'claudeAgent', renamed: false,
      cursor: JSON.stringify({ threadId: 'thread-unnamed', resume: 'claude-session-2' }),
      title: RAW_PROMPT,
    },
    {
      threadId: 'thread-codex', provider: 'codex', renamed: true,
      cursor: JSON.stringify({ threadId: 'codex-thread-1' }),
      title: 'Add Padded Blog Card Rails',
    },
    {
      threadId: 'thread-deleted', provider: 'claudeAgent', renamed: true, deleted: true,
      cursor: JSON.stringify({ threadId: 'thread-deleted', resume: 'claude-session-3' }),
      title: 'Deleted Thread',
    },
  ]);
  writeFixtureDb(path.join(home, '.t3', 'userdata', 'state.sqlite'), [
    {
      threadId: 't3-thread', provider: 'claudeAgent', renamed: true,
      cursor: JSON.stringify({ threadId: 't3-thread', resume: 'claude-session-t3' }),
      title: 'Upstream t3 thread',
    },
  ]);
  return home;
}

test('shellStoreCandidates probes $T3CODE_HOME, ~/.demuxx, ~/.t3 in that order', () => {
  assert.deepEqual(shellStoreCandidates({ T3CODE_HOME: '/srv/t3' }, '/home/dev'), [
    { path: '/srv/t3/userdata/state.sqlite', source: 't3code' },
    { path: '/home/dev/.demuxx/userdata/state.sqlite', source: 'demuxx' },
    { path: '/home/dev/.t3/userdata/state.sqlite', source: 't3code' },
  ]);
  assert.equal(shellStoreCandidates({}, '').length, 0);
});

test('lookups are a silent no-op with no store on the host', () => {
  const stores = shellStoreCandidates({}, path.join(os.tmpdir(), 'no-shells-here'));
  assert.equal(lookupClaudeSession('claude-session-1', stores), null);
  assert.equal(lookupCodexThread('codex-thread-1', stores), null);
  assert.equal(lookupClaudeSession('', stores), null);
  assert.equal(lookupClaudeSession(undefined, stores), null);
});

test('shellTitlesEnabled defaults on, honours the env kill switch and the desktop config', () => {
  const missing = path.join(os.tmpdir(), 'no-such-daemon-config.json');
  assert.equal(shellTitlesEnabled({}, missing), true);
  assert.equal(shellTitlesEnabled({ DEVCLOCKED_TRACK_SESSION_TITLES: '0' }, missing), false);
  assert.equal(shellTitlesEnabled({ DEVCLOCKED_TRACK_SESSION_TITLES: 'false' }, missing), false);
  assert.equal(shellTitlesEnabled({ DEVCLOCKED_TRACK_SESSION_TITLES: '1' }, missing), true);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shell-titles-config-'));
  const configPath = path.join(dir, 'daemon-config.json');
  fs.writeFileSync(configPath, JSON.stringify({ track_session_titles: false }));
  assert.equal(shellTitlesEnabled({}, configPath), false);
  // Env wins over the file either way.
  assert.equal(shellTitlesEnabled({ DEVCLOCKED_TRACK_SESSION_TITLES: '1' }, configPath), true);
  fs.writeFileSync(configPath, JSON.stringify({ track_session_titles: true }));
  assert.equal(shellTitlesEnabled({}, configPath), true);
});

test('reads renamed threads from every store and tags the source', { skip: !sqliteAvailable() }, () => {
  const home = fixtureHome();
  const stores = shellStoreCandidates({}, home);
  try {
    assert.deepEqual(lookupClaudeSession('claude-session-1', stores), {
      title: 'Missing Claude Chat Name Metadata',
      source: 'demuxx',
    });
    assert.deepEqual(lookupClaudeSession('claude-session-t3', stores), {
      title: 'Upstream t3 thread',
      source: 't3code',
    });
    assert.deepEqual(lookupCodexThread('codex-thread-1', stores), {
      title: 'Add Padded Blog Card Rails',
      source: 'demuxx',
    });
    // Id spaces are separate.
    assert.equal(lookupClaudeSession('codex-thread-1', stores), null);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('never returns a thread still carrying its creation title, nor a deleted one', { skip: !sqliteAvailable() }, () => {
  const home = fixtureHome();
  const stores = shellStoreCandidates({}, home);
  try {
    assert.equal(lookupClaudeSession('claude-session-2', stores), null);
    assert.equal(lookupClaudeSession('claude-session-3', stores), null);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
