const test = require('node:test');
const assert = require('node:assert/strict');

const { acquireShipperLockWithWait, drainQueue } = require('./ship');

// A fake runtime backed by an in-memory "queue dir": listQueueFiles reflects
// whatever is in the set at the moment it is called, exactly like readdirSync.
function fakeRuntime(queue) {
  return {
    loadAuth: () => 'test-api-key',
    listQueueFiles: () => [...queue].sort(),
    appendLog: () => {},
  };
}

test('drainQueue re-lists after a pass and ships an envelope enqueued mid-pass (DEV-938)', async () => {
  const queue = new Set(['/q/a.json']);
  const processed = [];
  const processEnvelope = async (filePath, apiKey) => {
    assert.equal(apiKey, 'test-api-key');
    processed.push(filePath);
    queue.delete(filePath);
    // A second hook fires while a.json is shipping. Its shipper finds the lock
    // held and defers to us, so b.json is only visible on the re-list.
    if (filePath === '/q/a.json') queue.add('/q/b.json');
  };

  const result = await drainQueue(fakeRuntime(queue), processEnvelope);

  assert.deepEqual(processed, ['/q/a.json', '/q/b.json']);
  assert.deepEqual(result, { passes: 2, attempted: 2 });
  assert.equal(queue.size, 0);
});

test('drainQueue does not spin on a file that refuses to be removed', async () => {
  const queue = new Set(['/q/stuck.json']);
  let calls = 0;

  const result = await drainQueue(fakeRuntime(queue), async () => {
    calls += 1;
  });

  assert.equal(calls, 1);
  assert.deepEqual(result, { passes: 1, attempted: 1 });
});

test('drainQueue stops at maxPasses while new files keep appearing', async () => {
  const queue = new Set(['/q/0.json']);
  let next = 1;
  const processEnvelope = async (filePath) => {
    queue.delete(filePath);
    queue.add(`/q/${next++}.json`);
  };

  const result = await drainQueue(fakeRuntime(queue), processEnvelope, { maxPasses: 3 });

  assert.deepEqual(result, { passes: 3, attempted: 3 });
});

test('drainQueue is a no-op on an empty queue', async () => {
  const result = await drainQueue(fakeRuntime(new Set()), async () => {
    assert.fail('processEnvelope must not be called');
  });

  assert.deepEqual(result, { passes: 0, attempted: 0 });
});

test('acquireShipperLockWithWait returns the fd once the lock frees up on the 3rd poll (DEV-938)', async () => {
  let polls = 0;
  let sleeps = 0;
  const runtime = { acquireShipperLock: () => (++polls >= 3 ? 42 : null) };

  const fd = await acquireShipperLockWithWait(runtime, {
    timeoutMs: 5000,
    intervalMs: 100,
    sleep: async () => {
      sleeps += 1;
    },
  });

  assert.equal(fd, 42);
  assert.equal(polls, 3);
  assert.equal(sleeps, 2);
});

test('acquireShipperLockWithWait returns null once the timeout is spent waiting', async () => {
  let polls = 0;
  const sleeps = [];
  const runtime = {
    acquireShipperLock: () => {
      polls += 1;
      return null;
    },
  };

  const fd = await acquireShipperLockWithWait(runtime, {
    timeoutMs: 500,
    intervalMs: 100,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });

  assert.equal(fd, null);
  assert.deepEqual(sleeps, [100, 100, 100, 100, 100]);
  assert.equal(polls, 6);
});
