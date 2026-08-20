const test = require('node:test');
const assert = require('node:assert/strict');

const { acquireShipperLockWithWait, drainQueue, normalizeResult } = require('./ship');

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
  assert.deepEqual(result, { passes: 2, attempted: 2, shipped: 0, replayed: 0, quarantined: 0, reachable: false });
  assert.equal(queue.size, 0);
});

test('drainQueue does not spin on a file that refuses to be removed', async () => {
  const queue = new Set(['/q/stuck.json']);
  let calls = 0;

  const result = await drainQueue(fakeRuntime(queue), async () => {
    calls += 1;
  });

  assert.equal(calls, 1);
  assert.deepEqual(result, { passes: 1, attempted: 1, shipped: 0, replayed: 0, quarantined: 0, reachable: false });
});

test('drainQueue stops at maxPasses while new files keep appearing', async () => {
  const queue = new Set(['/q/0.json']);
  let next = 1;
  const processEnvelope = async (filePath) => {
    queue.delete(filePath);
    queue.add(`/q/${next++}.json`);
  };

  const result = await drainQueue(fakeRuntime(queue), processEnvelope, { maxPasses: 3 });

  assert.deepEqual(result, { passes: 3, attempted: 3, shipped: 0, replayed: 0, quarantined: 0, reachable: false });
});

test('drainQueue is a no-op on an empty queue', async () => {
  const result = await drainQueue(fakeRuntime(new Set()), async () => {
    assert.fail('processEnvelope must not be called');
  });

  assert.deepEqual(result, { passes: 0, attempted: 0, shipped: 0, replayed: 0, quarantined: 0, reachable: false });
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

// --- DEV-936: bounded dead-letter replay inside a shipper run ----------------

// The fake above has no dead-letter helpers, so drainQueue skips replay
// entirely. This one models the store as a second in-memory set and moves one
// envelope at a time, exactly like the real runtime.
function fakeRuntimeWithDeadLetter(queue, deadLetter, corruptDeadLetter = new Set()) {
  const calls = { prune: 0, replayed: [], quarantined: [] };
  return {
    calls,
    loadAuth: () => 'test-api-key',
    listQueueFiles: () => [...queue].sort(),
    appendLog: () => {},
    pruneDeadLetter: () => {
      calls.prune += 1;
      return 0;
    },
    listDeadLetterFiles: () => [...deadLetter].sort(),
    replayDeadLetterFile: (filePath) => {
      deadLetter.delete(filePath);
      if (corruptDeadLetter.has(filePath)) {
        calls.quarantined.push(filePath);
        return { queuedPath: null, quarantined: true };
      }
      queue.add(filePath);
      calls.replayed.push(filePath);
      return { queuedPath: filePath, quarantined: false };
    },
    quarantineEnvelope: (filePath) => {
      queue.delete(filePath);
      calls.quarantined.push(filePath);
      return true;
    },
  };
}

const SHIPPED = { shipped: true, reachable: true };
const SEND_FAILED = { shipped: false, reachable: false, failed: true };

test('normalizeResult keeps the plain-boolean contract and defaults reachable to shipped (DEV-936)', () => {
  assert.deepEqual(normalizeResult(true), { shipped: true, reachable: true, failed: false });
  assert.deepEqual(normalizeResult(undefined), { shipped: false, reachable: false, failed: false });
  // A 2xx that processed nothing: not shipped, but the backend is up.
  assert.deepEqual(normalizeResult({ shipped: false, reachable: true }), {
    shipped: false,
    reachable: true,
    failed: false,
  });
  assert.deepEqual(normalizeResult(SEND_FAILED), { shipped: false, reachable: false, failed: true });
});

test('an idle run replays the dead-letter store and ships each envelope exactly once (DEV-936)', async () => {
  // Empty live queue: the first replayed envelope doubles as a reconnect probe.
  const queue = new Set();
  const deadLetter = new Set(['/q/dead-1.json', '/q/dead-2.json']);
  const runtime = fakeRuntimeWithDeadLetter(queue, deadLetter);
  const shipped = [];

  const result = await drainQueue(runtime, async (filePath) => {
    shipped.push(filePath);
    queue.delete(filePath);
    return SHIPPED;
  });

  assert.deepEqual(shipped, ['/q/dead-1.json', '/q/dead-2.json'], 'no envelope may ship twice');
  assert.equal(result.shipped, 2);
  assert.equal(result.replayed, 2);
  assert.equal(result.reachable, true);
  assert.equal(runtime.calls.prune, 1, 'pruning runs before replay so expired entries are not replayed');
  assert.equal(queue.size, 0);
  assert.equal(deadLetter.size, 0);
});

test('a live success in the same run unlocks the dead-letter replay (DEV-936)', async () => {
  const queue = new Set(['/q/live.json']);
  const deadLetter = new Set(['/q/dead.json']);
  const runtime = fakeRuntimeWithDeadLetter(queue, deadLetter);
  const shipped = [];

  const result = await drainQueue(runtime, async (filePath) => {
    shipped.push(filePath);
    queue.delete(filePath);
    return SHIPPED;
  });

  assert.deepEqual(shipped, ['/q/live.json', '/q/dead.json']);
  assert.equal(result.shipped, 2);
  assert.equal(result.replayed, 1);
});

test('a 2xx that processed no activity still unlocks the replay (DEV-936 F7)', async () => {
  // track_tick_unprocessed and throttled ticks never "ship", but a 2xx answer
  // proves the backend is up just as well as a real tick does.
  const queue = new Set(['/q/noop.json']);
  const deadLetter = new Set(['/q/dead.json']);
  const runtime = fakeRuntimeWithDeadLetter(queue, deadLetter);

  const result = await drainQueue(runtime, async (filePath) => {
    queue.delete(filePath);
    if (filePath === '/q/noop.json') return { shipped: false, reachable: true };
    return SHIPPED;
  });

  assert.equal(result.reachable, true);
  assert.equal(result.replayed, 1, 'a no-op tick run must not strand the dead-letter store');
  assert.equal(result.shipped, 1);
  assert.equal(deadLetter.size, 0);
});

test('a run where the backend never answered leaves the dead-letter store alone (DEV-936)', async () => {
  const queue = new Set(['/q/live.json']);
  const deadLetter = new Set(['/q/dead.json']);
  const runtime = fakeRuntimeWithDeadLetter(queue, deadLetter);

  const result = await drainQueue(runtime, async (filePath) => {
    queue.delete(filePath);
    return SEND_FAILED;
  });

  assert.equal(result.reachable, false);
  assert.equal(result.replayed, 0);
  assert.deepEqual(runtime.calls.replayed, []);
  assert.equal(runtime.calls.prune, 1, 'the age/byte ceiling must not depend on connectivity');
  assert.equal(deadLetter.size, 1, 'nothing is lost');
});

test('a replay moves at most 25 envelopes per run even with a full store (DEV-936 F2)', async () => {
  // At the 5 MB ceiling the store holds ~19.5k envelopes; replaying them all in
  // one run would blow past the 60s lock-stale window and invite a second
  // shipper to steal the lock from this live holder.
  const queue = new Set();
  const deadLetter = new Set(
    Array.from({ length: 100 }, (_, i) => `/q/dead-${String(i).padStart(3, '0')}.json`)
  );
  const runtime = fakeRuntimeWithDeadLetter(queue, deadLetter);

  const result = await drainQueue(runtime, async (filePath) => {
    queue.delete(filePath);
    return SHIPPED;
  });

  assert.equal(result.replayed, 25);
  assert.equal(runtime.calls.replayed.length, 25);
  assert.equal(deadLetter.size, 75, 'the rest wait for the next run');
  // Oldest first, so the backlog drains in capture order.
  assert.equal(runtime.calls.replayed[0], '/q/dead-000.json');
  assert.equal(runtime.calls.replayed[24], '/q/dead-024.json');
});

test('the first send failure during a replay halts the run with the rest still parked (DEV-936 F3)', async () => {
  const queue = new Set();
  const deadLetter = new Set(
    Array.from({ length: 10 }, (_, i) => `/q/dead-${String(i).padStart(2, '0')}.json`)
  );
  const runtime = fakeRuntimeWithDeadLetter(queue, deadLetter);
  let attempts = 0;

  const result = await drainQueue(runtime, async () => {
    attempts += 1;
    return SEND_FAILED;
  });

  assert.equal(attempts, 1, 'a black-holed backend costs one timeout, not one per envelope');
  assert.equal(runtime.calls.replayed.length, 1);
  assert.equal(result.replayed, 1);
  assert.equal(deadLetter.size, 9, 'the remaining envelopes stay in the dead-letter store');
});

test('an unreadable queue file is quarantined and blocks neither the drain nor the replay (DEV-936 F4)', async () => {
  const queue = new Set(['/q/a-corrupt.json', '/q/b-good.json']);
  const deadLetter = new Set(['/q/dead.json']);
  const runtime = fakeRuntimeWithDeadLetter(queue, deadLetter);
  const shipped = [];

  const result = await drainQueue(runtime, async (filePath) => {
    if (filePath === '/q/a-corrupt.json') throw new SyntaxError('Unexpected end of JSON input');
    shipped.push(filePath);
    queue.delete(filePath);
    return SHIPPED;
  });

  assert.deepEqual(runtime.calls.quarantined, ['/q/a-corrupt.json']);
  assert.equal(result.quarantined, 1);
  assert.deepEqual(shipped, ['/q/b-good.json', '/q/dead.json'], 'the good envelope and the replay both run');
  assert.equal(result.replayed, 1);
  assert.equal(deadLetter.size, 0);
});

test('drainQueue honours replay: false for callers that only want the live queue (DEV-936)', async () => {
  const queue = new Set();
  const deadLetter = new Set(['/q/dead.json']);
  const runtime = fakeRuntimeWithDeadLetter(queue, deadLetter);

  const result = await drainQueue(runtime, async () => SHIPPED, { replay: false });

  assert.equal(result.replayed, 0);
  assert.equal(runtime.calls.prune, 0);
  assert.equal(deadLetter.size, 1);
});

test('a dead-letter entry quarantined during replay is counted, not silently swallowed (DEV-936 R4)', async () => {
  const queue = new Set();
  const deadLetter = new Set(['/q/dead-corrupt.json', '/q/dead-good.json']);
  const runtime = fakeRuntimeWithDeadLetter(queue, deadLetter, new Set(['/q/dead-corrupt.json']));

  const result = await drainQueue(runtime, async (filePath) => {
    queue.delete(filePath);
    return SHIPPED;
  });

  assert.equal(result.quarantined, 1, 'quarantines from the replay path must reach the caller');
  assert.deepEqual(runtime.calls.quarantined, ['/q/dead-corrupt.json']);
  assert.equal(result.replayed, 1, 'the good entry still replays past the corrupt one');
  assert.equal(result.shipped, 1);
});
