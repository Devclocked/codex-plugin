const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// ship.js pulls in runtime state helpers that touch $HOME/.config/devclocked.
// Redirect HOME before requiring so tests never touch real plugin state.
process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'devclocked-codex-ship-test-'));

const runtime = require('./runtime');

// ship.js destructures callEdgeFunction out of ./runtime at require time, so
// the stub has to be installed on the exports object BEFORE ship.js is
// required. Nothing in this file may reach the network.
const edgeCalls = [];
let edgeUp = false;
runtime.callEdgeFunction = async (apiKey, fnName, body) => {
  edgeCalls.push({ apiKey, fnName, body });
  if (!edgeUp) throw new Error('edge_function_503');
  return { status: 200, body: JSON.stringify({ processed_count: 1, session_updated: true }) };
};

const {
  DELAYED_ENVELOPE_MS,
  STALE_SESSION_END_MS,
  envelopeAgeMs,
  isActivityTypeTransition,
  isStaleSessionEnd,
  processEnvelope,
  staleLifecycleReason,
} = require('./ship');
const { drainQueue } = require('../runtime/ship');

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

// --- DEV-936: retry exhaustion dead-letters instead of destroying activity ----
// Design ported from tracker-core DEV-826. Before this, ~75s of backend
// downtime (5 attempts) unlinked the envelope and the activity was gone.

const { MAX_SHIP_ATTEMPTS } = runtime;

function purgeQueues() {
  for (const filePath of runtime.listQueueFiles()) fs.unlinkSync(filePath);
  for (const filePath of runtime.listDeadLetterFiles()) fs.unlinkSync(filePath);
}

// Retries are gated by a 15s backoff stamp; clear it so a whole exhaustion
// cycle fits in one test.
async function exhaustRetries(filePath) {
  for (let attempt = 0; attempt < MAX_SHIP_ATTEMPTS; attempt += 1) {
    const envelope = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    delete envelope.retry_after;
    fs.writeFileSync(filePath, JSON.stringify(envelope));
    await processEnvelope(filePath, 'test-api-key');
  }
}

test('an envelope whose retries are exhausted is dead-lettered, not deleted (DEV-936)', async () => {
  purgeQueues();
  edgeUp = false;
  const filePath = runtime.enqueueHookEvent({ hook_event_name: 'PostToolUse', thread_id: 'sess-936-exhaust', tool_name: 'Bash' });
  const name = path.basename(filePath);

  await exhaustRetries(filePath);

  const parked = path.join(runtime.DEAD_LETTER_DIR, name);
  assert.equal(fs.existsSync(filePath), false, 'the envelope must leave the live queue');
  assert.equal(fs.existsSync(parked), true, 'the envelope must survive in the dead-letter store');

  const envelope = JSON.parse(fs.readFileSync(parked, 'utf-8'));
  assert.ok(envelope.dead_lettered_at, 'dead_lettered_at must be stamped');
  assert.match(envelope.dead_letter_reason, /^max_attempts:/);
  assert.equal(envelope.attempts, MAX_SHIP_ATTEMPTS);
  // Parked envelopes stay invisible to the live drain until a replay.
  assert.deepEqual(runtime.listQueueFiles(), []);

  purgeQueues();
});

test('a dead-lettered envelope replays and ships EXACTLY ONCE when the backend recovers (DEV-936)', async () => {
  purgeQueues();
  edgeUp = false;
  const filePath = runtime.enqueueHookEvent({ hook_event_name: 'PostToolUse', thread_id: 'sess-936-replay', tool_name: 'Bash' });
  const name = path.basename(filePath);
  await exhaustRetries(filePath);
  assert.equal(fs.existsSync(path.join(runtime.DEAD_LETTER_DIR, name)), true);

  edgeUp = true;
  edgeCalls.length = 0;
  const result = await drainQueue(runtime, processEnvelope, { apiKey: 'test-api-key' });

  assert.equal(result.replayed, 1);
  assert.equal(result.shipped, 1);
  assert.equal(edgeCalls.length, 1, 'a replayed envelope must reach track-tick exactly once');
  assert.equal(edgeCalls[0].fnName, 'track-tick');
  assert.equal(fs.existsSync(path.join(runtime.DEAD_LETTER_DIR, name)), false);
  assert.equal(fs.existsSync(path.join(runtime.QUEUE_DIR, name)), false);

  purgeQueues();
});

test('a replay against a still-unreachable backend makes one pass and keeps the envelope (DEV-936)', async () => {
  purgeQueues();
  edgeUp = false;
  const filePath = runtime.enqueueHookEvent({ hook_event_name: 'PostToolUse', thread_id: 'sess-936-still-down', tool_name: 'Bash' });
  const name = path.basename(filePath);
  await exhaustRetries(filePath);

  edgeCalls.length = 0;
  const result = await drainQueue(runtime, processEnvelope, { apiKey: 'test-api-key' });

  assert.equal(result.replayed, 1);
  assert.equal(result.shipped, 0);
  assert.equal(edgeCalls.length, 1, 'one attempt per replayed envelope, then the run ends');

  // Nothing lost: back in the live queue with one spent attempt, on its way to
  // the dead-letter store again through the normal retry path.
  const requeued = path.join(runtime.QUEUE_DIR, name);
  assert.equal(fs.existsSync(requeued), true);
  const envelope = JSON.parse(fs.readFileSync(requeued, 'utf-8'));
  assert.equal(envelope.attempts, 1);
  assert.ok(envelope.retry_after);

  purgeQueues();
});

test('a replayed dead-letter session end is still discarded as stale — lifecycle events are time-sensitive, ticks are not (DEV-936/DEV-938)', async () => {
  purgeQueues();
  edgeUp = true;
  edgeCalls.length = 0;
  const filePath = runtime.enqueueHookEvent({ hook_event_name: 'Stop', thread_id: 'sess-936-stale-replay' });
  const name = path.basename(filePath);
  backdateEnvelope(filePath, 25 * 60_000);
  runtime.deadLetterEnvelope(
    filePath,
    JSON.parse(fs.readFileSync(filePath, 'utf-8')),
    'max_attempts:edge_function_503'
  );

  const result = await drainQueue(runtime, processEnvelope, { apiKey: 'test-api-key' });

  assert.equal(result.replayed, 1);
  assert.equal(result.shipped, 0);
  assert.equal(edgeCalls.length, 0, 'the backend already closed this session by idle timeout');
  assert.equal(fs.existsSync(path.join(runtime.QUEUE_DIR, name)), false);
  assert.equal(fs.existsSync(path.join(runtime.DEAD_LETTER_DIR, name)), false);
  const drop = readShipperLogEntries().find(
    (entry) => entry.message === 'Dropping queued hook event' && entry.extra?.file === name
  );
  assert.equal(drop?.extra.reason, 'stale_session_end');

  purgeQueues();
});

// --- DEV-936 F5: a replayed lifecycle START must not anchor a phantom session -

test('staleLifecycleReason flags both ends of the lifecycle past the idle window (DEV-936)', () => {
  assert.equal(staleLifecycleReason('Stop', STALE_SESSION_END_MS + 1), 'stale_session_end');
  assert.equal(staleLifecycleReason('SessionStart', STALE_SESSION_END_MS + 1), 'stale_session_start');
  assert.equal(staleLifecycleReason('SessionStart', STALE_SESSION_END_MS), null);
  // Ticks are not time-sensitive — preserving them is the whole point.
  assert.equal(staleLifecycleReason('PostToolUse', 7 * 60 * 60_000), null);
});

test('a session start older than the idle window is discarded without creating stream state (DEV-936)', async () => {
  purgeQueues();
  edgeUp = true;
  edgeCalls.length = 0;
  const filePath = runtime.enqueueHookEvent({ hook_event_name: 'SessionStart', thread_id: 'sess-936-stale-start' });
  const name = path.basename(filePath);
  backdateEnvelope(filePath, 25 * 60_000);

  await processEnvelope(filePath, 'test-api-key');

  assert.equal(fs.existsSync(filePath), false);
  assert.equal(edgeCalls.length, 0, 'a stale start must never reach track-tick');
  assert.equal(
    runtime.getStreamState('sess-936-stale-start'),
    null,
    'a replayed start must not anchor a session at reconnect time'
  );
  const drop = readShipperLogEntries().find(
    (entry) => entry.message === 'Dropping queued hook event' && entry.extra?.file === name
  );
  assert.equal(drop?.extra.reason, 'stale_session_start');

  purgeQueues();
});

// --- DEV-936 F4: one corrupt file must not wedge the shipper -----------------

test('a truncated queue file is quarantined and blocks neither the next envelope nor the replay (DEV-936)', async () => {
  purgeQueues();
  edgeUp = false;

  // Park a real envelope for the replay to pick up.
  const parkedSource = runtime.enqueueHookEvent({ hook_event_name: 'PostToolUse', thread_id: 'sess-936-corrupt-parked', tool_name: 'Bash' });
  const parkedName = path.basename(parkedSource);
  runtime.deadLetterEnvelope(
    parkedSource,
    JSON.parse(fs.readFileSync(parkedSource, 'utf-8')),
    'max_attempts:edge_function_503'
  );

  // A queue file whose JSON never finished writing, sorted ahead of the good
  // one so it is the first thing the drain touches.
  runtime.ensureDir(runtime.QUEUE_DIR);
  const corrupt = path.join(runtime.QUEUE_DIR, '0000000000000-0-corrupt.json');
  fs.writeFileSync(corrupt, '{"id":"half-writ');

  const good = runtime.enqueueHookEvent({ hook_event_name: 'PostToolUse', thread_id: 'sess-936-corrupt-good', tool_name: 'Bash' });
  edgeUp = true;
  edgeCalls.length = 0;

  const result = await drainQueue(runtime, processEnvelope, { apiKey: 'test-api-key' });

  assert.equal(result.quarantined, 1);
  assert.equal(fs.existsSync(corrupt), false, 'the corrupt file must leave the queue');
  assert.equal(fs.existsSync(path.join(runtime.QUARANTINE_DIR, path.basename(corrupt))), true);
  assert.equal(fs.existsSync(good), false, 'the good envelope still shipped');
  assert.equal(result.replayed, 1, 'and the dead-letter replay still ran');
  assert.equal(fs.existsSync(path.join(runtime.DEAD_LETTER_DIR, parkedName)), false);
  assert.equal(result.shipped, 2);
  assert.equal(edgeCalls.length, 2);

  fs.rmSync(runtime.QUARANTINE_DIR, { recursive: true, force: true });
  purgeQueues();
});
