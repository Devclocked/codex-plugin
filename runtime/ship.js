// Shipper orchestration. Every hook spawns one detached shipper; the lock file
// makes them serial. Before DEV-938 a shipper that lost the lock exited at once
// and the winner listed the queue exactly once, so an envelope enqueued in the
// ~400 ms between two hooks sat on disk until the NEXT hook fired — hours later
// in the incident — and then shipped with its original captured_at, back-dating
// a brand-new session. Now losers wait briefly for the lock and the holder
// re-lists the queue after each pass until nothing new shows up.

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Poll runtime.acquireShipperLock() until it yields an fd or timeoutMs of
// waiting has elapsed. Returns the fd, or null when the lock stayed busy.
async function acquireShipperLockWithWait(runtime, { timeoutMs = 5000, intervalMs = 100, sleep = defaultSleep } = {}) {
  const deadline = Date.now() + timeoutMs;
  let waitedMs = 0;
  for (;;) {
    const fd = runtime.acquireShipperLock();
    if (fd) return fd;
    if (waitedMs >= timeoutMs || Date.now() >= deadline) return null;
    await sleep(intervalMs);
    waitedMs += intervalMs;
  }
}

// Ship every queued envelope, re-listing the queue after each pass so envelopes
// enqueued mid-pass (by hooks whose own shipper deferred to us) are picked up.
// Stops when the re-list is empty, when it contains nothing we have not already
// attempted in this run (a file that refuses to be removed must not spin the
// loop), or at maxPasses.
async function drainQueue(runtime, processEnvelope, { maxPasses = 25, apiKey = runtime.loadAuth() } = {}) {
  const attempted = new Set();
  let passes = 0;
  let files = runtime.listQueueFiles();

  while (files.length > 0 && passes < maxPasses) {
    passes += 1;
    for (const filePath of files) {
      attempted.add(filePath);
      await processEnvelope(filePath, apiKey);
    }
    files = runtime.listQueueFiles().filter((filePath) => !attempted.has(filePath));
  }

  return { passes, attempted: attempted.size };
}

async function runShipper(runtime, processEnvelope) {
  const lockFd = await acquireShipperLockWithWait(runtime);
  if (!lockFd) {
    // The holder re-lists the queue after every pass, so whatever our hook
    // enqueued is its to ship — deferring loses nothing.
    runtime.appendLog('shipper', 'Shipper lock busy, deferring to holder');
    process.exit(0);
  }

  try {
    const apiKey = runtime.loadAuth();
    if (!apiKey) {
      runtime.appendLog('shipper', 'Skipping ship pass because auth is missing');
      process.exit(0);
    }

    await drainQueue(runtime, processEnvelope, { apiKey });

    if (typeof runtime.pruneStaleStreamState === 'function') {
      const pruned = runtime.pruneStaleStreamState();
      if (pruned > 0) {
        runtime.appendLog('shipper', 'Pruned stale stream state', { count: pruned });
      }
    }
  } catch (error) {
    runtime.appendLog('shipper', 'Shipper crashed', {
      error: error instanceof Error ? error.message : 'unknown_error',
    });
  } finally {
    runtime.releaseShipperLock(lockFd);
  }

  process.exit(0);
}

module.exports = {
  acquireShipperLockWithWait,
  drainQueue,
  runShipper,
};
