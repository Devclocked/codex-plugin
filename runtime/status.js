const fs = require('fs');
const path = require('path');

function exists(filePath) {
  try {
    fs.accessSync(filePath);
    return true;
  } catch {
    return false;
  }
}

function safeList(dirPath, filter = () => true) {
  try {
    return fs.readdirSync(dirPath).filter(filter).sort();
  } catch {
    return [];
  }
}

function fileStats(filePath) {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

function tailLines(filePath, count) {
  try {
    const content = fs.readFileSync(filePath, 'utf-8').trim();
    if (!content) return [];
    return content.split('\n').slice(-count);
  } catch {
    return [];
  }
}

function newestFile(dirPath, names) {
  const withStats = names
    .map((name) => ({ name, stats: fileStats(path.join(dirPath, name)) }))
    .filter((entry) => entry.stats);
  withStats.sort((a, b) => b.stats.mtimeMs - a.stats.mtimeMs);
  return withStats[0] || null;
}

function buildStatus(runtime) {
  const queueFiles = safeList(runtime.QUEUE_DIR, (name) => name.endsWith('.json'));
  const oldest = queueFiles[0] ? fileStats(path.join(runtime.QUEUE_DIR, queueFiles[0])) : null;
  const deadLetterFiles = safeList(runtime.DEAD_LETTER_DIR, (name) => name.endsWith('.json'));
  const oldestDeadLetter = deadLetterFiles[0]
    ? fileStats(path.join(runtime.DEAD_LETTER_DIR, deadLetterFiles[0]))
    : null;
  // No extension filter: a quarantined file is whatever name it had in the
  // queue, and the point is to count everything sitting in there.
  const quarantineFiles = safeList(runtime.QUARANTINE_DIR);
  const oldestQuarantine = quarantineFiles[0]
    ? fileStats(path.join(runtime.QUARANTINE_DIR, quarantineFiles[0]))
    : null;
  const stateFiles = safeList(runtime.STATE_DIR, (name) => name.endsWith('.json'));
  const cacheFiles = safeList(runtime.GIT_CACHE_DIR, (name) => name.endsWith('.json'));
  const newestCache = newestFile(runtime.GIT_CACHE_DIR, cacheFiles);
  const logFiles = safeList(runtime.LOG_DIR, (name) => name.endsWith('.log'));

  const logs = {};
  for (const file of logFiles) {
    logs[file] = tailLines(path.join(runtime.LOG_DIR, file), 5);
  }

  let shipperLock = {
    path: runtime.SHIPPER_LOCK_PATH,
    present: false,
    holder: null,
  };

  if (exists(runtime.SHIPPER_LOCK_PATH)) {
    try {
      shipperLock = {
        path: runtime.SHIPPER_LOCK_PATH,
        present: true,
        holder: runtime.readJsonFile(runtime.SHIPPER_LOCK_PATH),
      };
    } catch {
      shipperLock = {
        path: runtime.SHIPPER_LOCK_PATH,
        present: true,
        holder: 'unreadable',
      };
    }
  }

  return {
    auth: {
      configPath: runtime.CLI_CONFIG_PATH,
      configPresent: exists(runtime.CLI_CONFIG_PATH),
      apiKeyPresent: Boolean(runtime.loadAuth()),
    },
    queue: {
      dir: runtime.QUEUE_DIR,
      pending: queueFiles.length,
      oldestQueuedAt: oldest ? oldest.mtime.toISOString() : null,
    },
    deadLetter: {
      dir: runtime.DEAD_LETTER_DIR || null,
      unsent: deadLetterFiles.length,
      oldestDeadLetteredAt: oldestDeadLetter ? oldestDeadLetter.mtime.toISOString() : null,
    },
    quarantine: {
      dir: runtime.QUARANTINE_DIR || null,
      count: quarantineFiles.length,
      oldestAt: oldestQuarantine ? oldestQuarantine.mtime.toISOString() : null,
    },
    // Everything captured that the backend has not accepted yet. Quarantined
    // files are excluded: they are unreadable, not unsent.
    unsent: queueFiles.length + deadLetterFiles.length,
    state: {
      dir: runtime.STATE_DIR,
      activeStreams: stateFiles.length,
    },
    cache: {
      dir: runtime.GIT_CACHE_DIR,
      entries: cacheFiles.length,
      newestUpdatedAt: newestCache ? newestCache.stats.mtime.toISOString() : null,
    },
    shipperLock,
    logs: {
      dir: runtime.LOG_DIR,
      files: logFiles,
      recent: logs,
    },
  };
}

function printStatus(runtime, label) {
  const status = buildStatus(runtime);

  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
    process.exit(0);
  }

  const lines = [
    `DevClocked ${label} Hook Status`,
    `auth: ${status.auth.apiKeyPresent ? 'configured' : 'missing'} (${status.auth.configPath})`,
    `queue: ${status.queue.pending} pending${status.queue.oldestQueuedAt ? `, oldest ${status.queue.oldestQueuedAt}` : ''}`,
    // Dead-lettered envelopes are captured activity the backend has not taken
    // yet — worth calling out, because a number that never falls means the
    // replay is not reaching the backend (DEV-936).
    status.deadLetter.unsent > 0
      ? `dead-letter: ! ${status.deadLetter.unsent} unsent, replays on reconnect${status.deadLetter.oldestDeadLetteredAt ? `, oldest ${status.deadLetter.oldestDeadLetteredAt}` : ''} (${status.deadLetter.dir})`
      : 'dead-letter: 0 unsent',
    // Corrupt envelopes that will never ship. Normally zero; a non-zero count
    // that keeps climbing means something is truncating queue writes.
    status.quarantine.count > 0
      ? `quarantine: ! ${status.quarantine.count} unreadable file(s)${status.quarantine.oldestAt ? `, oldest ${status.quarantine.oldestAt}` : ''} (${status.quarantine.dir})`
      : 'quarantine: 0 files',
    `streams: ${status.state.activeStreams} active state file(s)`,
    `git cache: ${status.cache.entries} entry(s)${status.cache.newestUpdatedAt ? `, newest ${status.cache.newestUpdatedAt}` : ''}`,
    `shipper lock: ${status.shipperLock.present ? 'present' : 'not present'}`,
  ];

  if (status.logs.files.length) {
    lines.push(`logs: ${status.logs.files.join(', ')}`);
    for (const file of status.logs.files) {
      lines.push(`recent ${file}:`);
      for (const line of status.logs.recent[file]) {
        lines.push(line);
      }
    }
  } else {
    lines.push(`logs: none (${runtime.LOG_DIR})`);
  }

  process.stdout.write(`${lines.join('\n')}\n`);
}

module.exports = {
  buildStatus,
  printStatus,
};
