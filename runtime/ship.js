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

// processEnvelope reports back as { shipped, reachable, failed }:
//   shipped   — the backend accepted it and the envelope is gone
//   reachable — the backend answered 2xx, even if it processed nothing
//   failed    — the send threw (network error, timeout, non-2xx)
// A plain boolean still works and means "shipped, therefore reachable".
// Reachability is tracked separately from shipping because a run of nothing but
// no-op ticks proves the backend is up just as well as a real tick does
// (DEV-936).
function normalizeResult(value) {
  if (value && typeof value === 'object') {
    const shipped = Boolean(value.shipped);
    return {
      shipped,
      reachable: value.reachable === undefined ? shipped : Boolean(value.reachable),
      failed: Boolean(value.failed),
    };
  }
  const shipped = Boolean(value);
  return { shipped, reachable: shipped, failed: false };
}

// Ship every queued envelope, re-listing the queue after each pass so envelopes
// enqueued mid-pass (by hooks whose own shipper deferred to us) are picked up.
// Stops when the re-list is empty, when it contains nothing we have not already
// attempted in this run (a file that refuses to be removed must not spin the
// loop), or at maxPasses.
//
// DEV-936: once the live queue is drained, the run makes ONE bounded
// dead-letter replay pass — at most replayLimit envelopes, moved back one at a
// time and shipped before the next one moves, stopping at the first send
// failure. The first replayed envelope doubles as the reconnect probe on an
// idle run, so a black-holed backend costs one timeout for the whole run
// instead of one per parked envelope.
async function drainQueue(runtime, processEnvelope, {
  maxPasses = 25,
  apiKey = runtime.loadAuth(),
  replay = true,
  replayLimit = 25,
} = {}) {
  const attempted = new Set();
  const state = { passes: 0, shipped: 0, replayed: 0, quarantined: 0, reachable: false };

  // Resolves to the normalized result, or null when the envelope could not be
  // read at all. One unparsable file used to throw all the way out of the drain
  // and strand every envelope behind it, dead-letter replay included.
  async function attempt(filePath) {
    attempted.add(filePath);
    let result;
    try {
      result = normalizeResult(await processEnvelope(filePath, apiKey));
    } catch (error) {
      // quarantineEnvelope only moves files that genuinely will not parse, so a
      // transient failure leaves the envelope queued for the next run.
      if (typeof runtime.quarantineEnvelope === 'function' && runtime.quarantineEnvelope(filePath, error)) {
        state.quarantined += 1;
      }
      runtime.appendLog('shipper', 'Queued hook event could not be processed', {
        error: error instanceof Error ? error.message : 'unknown_error',
      });
      return null;
    }
    if (result.shipped) state.shipped += 1;
    if (result.reachable) state.reachable = true;
    return result;
  }

  let files = runtime.listQueueFiles();
  while (files.length > 0 && state.passes < maxPasses) {
    state.passes += 1;
    for (const filePath of files) {
      await attempt(filePath);
    }
    files = runtime.listQueueFiles().filter((filePath) => !attempted.has(filePath));
  }

  if (replay) {
    // Prune before replaying — and unconditionally, so the age and byte
    // ceilings hold even on runs that never reach the backend.
    if (typeof runtime.pruneDeadLetter === 'function') runtime.pruneDeadLetter();

    const canReplay =
      typeof runtime.replayDeadLetterFile === 'function' &&
      typeof runtime.listDeadLetterFiles === 'function' &&
      // Either the backend answered this run, or there was nothing live to ask
      // with and the first replayed envelope becomes the probe.
      (state.reachable || attempted.size === 0);

    if (canReplay) {
      for (const parkedPath of runtime.listDeadLetterFiles().slice(0, replayLimit)) {
        const { queuedPath, quarantined } = runtime.replayDeadLetterFile(parkedPath);
        if (quarantined) state.quarantined += 1;
        if (!queuedPath) continue;
        state.replayed += 1;
        const result = await attempt(queuedPath);
        // Still unreachable: leave every remaining envelope parked rather than
        // paying a timeout for each one inside the shipper lock window.
        if (result && result.failed) break;
      }
    }
  }

  return {
    passes: state.passes,
    attempted: attempted.size,
    shipped: state.shipped,
    replayed: state.replayed,
    quarantined: state.quarantined,
    reachable: state.reachable,
  };
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

    const result = await drainQueue(runtime, processEnvelope, { apiKey });
    if (result.replayed > 0 || result.quarantined > 0) {
      runtime.appendLog('shipper', 'Shipper run finished', {
        replayed: result.replayed,
        quarantined: result.quarantined,
        shipped: result.shipped,
        reachable: result.reachable,
      });
    }

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
  normalizeResult,
  runShipper,
};
