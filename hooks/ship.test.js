const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// ship.js pulls in runtime state helpers that touch $HOME/.config/devclocked.
// Redirect HOME before requiring so tests never touch real plugin state.
process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'devclocked-codex-ship-test-'));

const {
  DELAYED_ENVELOPE_MS,
  STALE_SESSION_END_MS,
  envelopeAgeMs,
  isActivityTypeTransition,
  isStaleSessionEnd,
  processEnvelope,
} = require('./ship');
const runtime = require('./runtime');

test('a differing classification counts as a transition and ships through the throttle', () => {
  assert.equal(isActivityTypeTransition({ last_activity_type: 'coding' }, 'planning'), true);
});

test('a same-type tick inside the window keeps throttling', () => {
  assert.equal(isActivityTypeTransition({ last_activity_type: 'coding' }, 'coding'), false);
});

test('no recorded prior type cannot be a transition (pre-existing state keeps old behavior)', () => {
  assert.equal(isActivityTypeTransition(null, 'coding'), false);
  assert.equal(isActivityTypeTransition({}, 'coding'), false);
  assert.equal(isActivityTypeTransition({ last_tick_at: 123 }, 'coding'), false);
});

// --- DEV-938: stale session-end discard / delayed-envelope logging ------------

const SHIPPER_LOG_PATH = path.join(process.env.HOME, '.config', 'devclocked', 'codex-plugin-logs', 'shipper.log');

function readShipperLogEntries() {
  if (!fs.existsSync(SHIPPER_LOG_PATH)) return [];
  return fs
    .readFileSync(SHIPPER_LOG_PATH, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function backdateEnvelope(filePath, ageMs) {
  const envelope = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  envelope.captured_at = new Date(Date.now() - ageMs).toISOString();
  fs.writeFileSync(filePath, JSON.stringify(envelope));
}

test('envelopeAgeMs measures from captured_at and treats a missing/invalid one as fresh (DEV-938)', () => {
  const now = Date.parse('2026-08-20T10:00:00.000Z');
  assert.equal(envelopeAgeMs({ captured_at: '2026-08-20T09:55:00.000Z' }, now), 5 * 60_000);
  assert.equal(envelopeAgeMs({}, now), 0);
  assert.equal(envelopeAgeMs({ captured_at: 'not-a-date' }, now), 0);
  assert.equal(envelopeAgeMs(undefined, now), 0);
});

test('only a Stop older than the 20-minute idle window counts as a stale session end (DEV-938)', () => {
  assert.equal(STALE_SESSION_END_MS, 20 * 60_000);
  assert.equal(DELAYED_ENVELOPE_MS, 2 * 60_000);
  // A one-minute-old session end is NOT discarded by this rule.
  assert.equal(isStaleSessionEnd('Stop', 60_000), false);
  assert.equal(isStaleSessionEnd('Stop', STALE_SESSION_END_MS), false);
  assert.equal(isStaleSessionEnd('Stop', STALE_SESSION_END_MS + 1), true);
  assert.equal(isStaleSessionEnd('Stop', 21 * 60_000), true);
  // Non-session-end events are never discarded for age alone.
  assert.equal(isStaleSessionEnd('PostToolUse', 7 * 60 * 60_000), false);
  assert.equal(isStaleSessionEnd('SessionStart', 7 * 60 * 60_000), false);
});

test('a Stop envelope 21 minutes old is discarded as stale_session_end and its stream state removed (DEV-938)', async () => {
  const sessionId = 'sess-938-stale-end';
  const filePath = runtime.enqueueHookEvent({ hook_event_name: 'Stop', thread_id: sessionId });
  backdateEnvelope(filePath, 21 * 60_000);
  runtime.saveStreamState(sessionId, {
    started_at: Date.now() - 60 * 60_000,
    last_tick_at: Date.now() - 21 * 60_000,
    last_activity_type: 'coding',
  });

  await processEnvelope(filePath, 'test-api-key');

  assert.equal(fs.existsSync(filePath), false);
  assert.equal(runtime.getStreamState(sessionId), null);
  const drop = readShipperLogEntries().find(
    (entry) => entry.message === 'Dropping queued hook event' && entry.extra?.file === path.basename(filePath)
  );
  assert.ok(drop, 'expected a discard log entry for the stale envelope');
  assert.equal(drop.extra.reason, 'stale_session_end');
  assert.equal(drop.extra.hook_event_name, 'Stop');
  assert.match(fs.readFileSync(SHIPPER_LOG_PATH, 'utf-8'), /stale_session_end/);
});

test('a non-lifecycle envelope 5 minutes old logs "Shipping delayed hook event" and continues (DEV-938)', async () => {
  const sessionId = 'sess-938-delayed';
  const filePath = runtime.enqueueHookEvent({ hook_event_name: 'PostToolUse', thread_id: sessionId, tool_name: 'Bash' });
  backdateEnvelope(filePath, 5 * 60_000);
  // Seed a tick inside the 30s throttle window with no recorded activity type,
  // so after the delay check the envelope takes the network-free 'throttled'
  // exit instead of calling track-tick.
  runtime.saveStreamState(sessionId, { last_tick_at: Date.now() });

  await processEnvelope(filePath, 'test-api-key');

  const entries = readShipperLogEntries();
  const delayed = entries.find(
    (entry) => entry.message === 'Shipping delayed hook event' && entry.extra?.file === path.basename(filePath)
  );
  assert.ok(delayed, 'expected a delayed-envelope log entry');
  assert.equal(delayed.extra.hook_event_name, 'PostToolUse');
  assert.ok(delayed.extra.age_ms >= 5 * 60_000);
  const drop = entries.find(
    (entry) => entry.message === 'Dropping queued hook event' && entry.extra?.file === path.basename(filePath)
  );
  assert.equal(drop?.extra.reason, 'throttled');
  assert.equal(fs.existsSync(filePath), false);
});
