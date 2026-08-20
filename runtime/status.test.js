const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// buildStatus reads the runtime's dirs under $HOME/.config/devclocked. Redirect
// HOME before requiring core so tests never touch real plugin state.
process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'devclocked-codex-status-test-'));

const { createPluginRuntime } = require('./core');
const { buildStatus, printStatus } = require('./status');

const runtime = createPluginRuntime({
  namespace: 'status-test-hook',
  source: 'status-test-plugin',
  shipperPath: path.join(process.env.HOME, 'hooks', 'ship.js'),
  pluginVersion: '0.0.0-test',
  execSyncImpl: () => '',
});

function captureStatus(label) {
  const original = process.stdout.write;
  let out = '';
  process.stdout.write = (chunk) => {
    out += chunk;
    return true;
  };
  try {
    printStatus(runtime, label);
  } finally {
    process.stdout.write = original;
  }
  return out;
}

function clearAll() {
  for (const filePath of runtime.listQueueFiles()) fs.unlinkSync(filePath);
  for (const filePath of runtime.listDeadLetterFiles()) fs.unlinkSync(filePath);
}

test('status reports zero dead-lettered envelopes on a clean install (DEV-936)', () => {
  clearAll();

  const status = buildStatus(runtime);
  assert.equal(status.deadLetter.unsent, 0);
  assert.equal(status.deadLetter.dir, runtime.DEAD_LETTER_DIR);
  assert.equal(status.unsent, 0);

  const printed = captureStatus('Test');
  assert.match(printed, /queue: 0 pending/);
  assert.match(printed, /dead-letter: 0 unsent/);
});

test('status counts pending and dead-lettered envelopes separately, and flags dead-letter when non-zero (DEV-936)', () => {
  clearAll();
  runtime.enqueueHookEvent({ hook_event_name: 'afterFileEdit', session_id: 'sess-status-pending' });

  for (const name of ['dl-1.json', 'dl-2.json']) {
    const filePath = runtime.enqueueHookEvent({ hook_event_name: 'afterFileEdit', session_id: name });
    runtime.deadLetterEnvelope(
      filePath,
      JSON.parse(fs.readFileSync(filePath, 'utf-8')),
      'max_attempts:edge_function_503'
    );
  }

  const status = buildStatus(runtime);
  assert.equal(status.queue.pending, 1);
  assert.equal(status.deadLetter.unsent, 2);
  assert.equal(status.unsent, 3, 'unsent is everything the backend has not accepted');
  assert.ok(status.deadLetter.oldestDeadLetteredAt);

  const printed = captureStatus('Test');
  assert.match(printed, /queue: 1 pending/);
  assert.match(printed, /dead-letter: ! 2 unsent, replays on reconnect/);
  assert.ok(printed.includes(runtime.DEAD_LETTER_DIR));

  clearAll();
});

test('status counts quarantined files and flags them when non-zero (DEV-936 R1)', () => {
  clearAll();
  runtime.ensureDir(runtime.QUARANTINE_DIR);
  fs.writeFileSync(path.join(runtime.QUARANTINE_DIR, 'truncated.json'), '{"id":"half-writ');

  const status = buildStatus(runtime);
  assert.equal(status.quarantine.count, 1);
  assert.equal(status.quarantine.dir, runtime.QUARANTINE_DIR);
  assert.ok(status.quarantine.oldestAt);
  assert.equal(status.unsent, 0, 'an unreadable file is not unsent activity');

  const printed = captureStatus('Test');
  assert.match(printed, /quarantine: ! 1 unreadable file\(s\)/);

  fs.rmSync(runtime.QUARANTINE_DIR, { recursive: true, force: true });
  assert.match(captureStatus('Test'), /quarantine: 0 files/);
});
