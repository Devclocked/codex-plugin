const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  codexHome,
  firstLabel,
  lookupThread,
  stateStoreCandidates,
} = require('./codexThreadNames');

function sqliteAvailable() {
  try {
    require('node:sqlite');
    return true;
  } catch {
    return false;
  }
}

function writeFixtureDb(dbPath, rows) {
  const { DatabaseSync } = require('node:sqlite');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      name TEXT,
      agent_nickname TEXT,
      agent_role TEXT
    );
  `);
  const insert = db.prepare('INSERT INTO threads (id, name, agent_nickname, agent_role) VALUES (?, ?, ?, ?)');
  for (const row of rows) {
    insert.run(row.id, row.name ?? null, row.agentNickname ?? null, row.agentRole ?? null);
  }
  db.close();
}

test('codexHome honours CODEX_HOME and otherwise uses the user home', () => {
  assert.equal(codexHome({ CODEX_HOME: '/srv/codex' }, '/home/dev'), '/srv/codex');
  assert.equal(codexHome({}, '/home/dev'), '/home/dev/.codex');
});

test('stateStoreCandidates checks the newest Codex state schema first', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'devclocked-codex-home-'));
  const root = path.join(home, '.codex');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'state_2.sqlite'), '');
  fs.writeFileSync(path.join(root, 'state_11.sqlite'), '');
  fs.writeFileSync(path.join(root, 'history.jsonl'), '');

  assert.deepEqual(stateStoreCandidates({}, home), [
    path.join(root, 'state_11.sqlite'),
    path.join(root, 'state_2.sqlite'),
  ]);
});

test('firstLabel prefers the user-facing thread name, then agent role and nickname', () => {
  assert.deepEqual(firstLabel({ name: 'Fix authentication flow', agent_role: 'Reviewer', agent_nickname: 'Ampere' }), {
    title: 'Fix authentication flow',
    source: 'codex',
  });
  assert.deepEqual(firstLabel({ name: null, agent_role: 'Reviewer', agent_nickname: 'Ampere' }), {
    title: 'Reviewer',
    source: 'codex-agent-role',
  });
  assert.deepEqual(firstLabel({ name: null, agent_role: null, agent_nickname: 'Ampere' }), {
    title: 'Ampere',
    source: 'codex-agent',
  });
  assert.equal(firstLabel({ name: '   ', agent_role: null, agent_nickname: null }), null);
});

test('lookupThread reads names from Codex state without reading conversation content', { skip: !sqliteAvailable() }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devclocked-codex-state-'));
  const store = path.join(root, 'state_5.sqlite');
  writeFixtureDb(store, [
    { id: 'thread-named', name: 'Remote deploy repair' },
    { id: 'thread-agent', agentNickname: 'Ampere', agentRole: 'Auditor' },
    { id: 'thread-plain' },
  ]);

  assert.deepEqual(lookupThread('thread-named', [store]), { title: 'Remote deploy repair', source: 'codex' });
  assert.deepEqual(lookupThread('thread-agent', [store]), { title: 'Auditor', source: 'codex-agent-role' });
  assert.equal(lookupThread('thread-plain', [store]), null);
  assert.equal(lookupThread('missing', [store]), null);
});
