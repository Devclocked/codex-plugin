async function runShipper(runtime, processEnvelope) {
  const lockFd = runtime.acquireShipperLock();
  if (!lockFd) process.exit(0);

  try {
    const apiKey = runtime.loadAuth();
    if (!apiKey) {
      runtime.appendLog('shipper', 'Skipping ship pass because auth is missing');
      process.exit(0);
    }

    const queueFiles = runtime.listQueueFiles();
    for (const filePath of queueFiles) {
      await processEnvelope(filePath, apiKey);
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
  runShipper,
};
