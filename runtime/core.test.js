const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// resolveGitContext caches under $HOME/.config/devclocked. Redirect HOME
// before requiring core so tests never touch real plugin state.
process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'devclocked-codex-core-test-'));

const { createPluginRuntime } = require('./core');

const NOT_A_REPO_ERROR = {
  status: 128,
  stderr: 'fatal: not a git repository (or any of the parent directories): .git\n',
};

function makeRuntime(execSyncImpl) {
  return createPluginRuntime({
    namespace: 'test-hook',
    source: 'test-plugin',
    shipperPath: path.join(process.env.HOME, 'hooks', 'ship.js'),
    pluginVersion: '0.0.0-test',
    execSyncImpl,
  });
}

function makeDirs(...segments) {
  const dir = path.join(process.env.HOME, ...segments);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function makeFile(dir, name) {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, '');
  return filePath;
}

function repoExec(repoRoot, remoteUrl) {
  return (command) => {
    if (command.includes('--show-toplevel')) return `${repoRoot}\n`;
    if (command.includes('get-url')) {
      if (!remoteUrl) throw { status: 2, stderr: "error: No such remote 'origin'\n" };
      return `${remoteUrl}\n`;
    }
    if (command.includes('--abbrev-ref')) return 'main\n';
    throw new Error(`unexpected git command: ${command}`);
  };
}

test('git works: identity is the repo root regardless of which files tools touch', () => {
  const repoRoot = makeDirs('projects', 'widget');
  const subDir = makeDirs('projects', 'widget', 'src', 'pages');
  const elsewhere = makeDirs('unrelated', 'scratch');
  const runtime = makeRuntime(repoExec(repoRoot, 'git@github.com:acme/widget.git'));

  const context = runtime.resolveGitContext({
    cwd: subDir,
    tool_input: { file_path: makeFile(elsewhere, 'notes.md') },
  });

  assert.equal(context.resolution, 'git');
  assert.equal(context.gitRoot, repoRoot);
  assert.equal(context.workspacePath, repoRoot);
  assert.equal(context.repoName, 'widget');
  assert.equal(context.repoFullName, 'acme/widget');
  assert.equal(context.branch, 'main');
  assert.ok(context.workspaceFingerprint);
  assert.equal(context.resolutionFailure, null);
});

test('not a repo (exit 128): exactly one identity, named from the session cwd', () => {
  const projectDir = makeDirs('plain', 'my-notes');
  makeDirs('plain', 'my-notes', 'drafts');
  const runtime = makeRuntime(() => {
    throw NOT_A_REPO_ERROR;
  });

  const context = runtime.resolveGitContext({
    cwd: projectDir,
    tool_input: { file_path: path.join(projectDir, 'drafts', 'a.md') },
  });

  assert.equal(context.resolution, 'cwd');
  assert.equal(context.repoName, 'my-notes');
  assert.equal(context.workspacePath, projectDir);
  assert.equal(context.gitRoot, null);
  assert.equal(context.repoUrl, null);
  assert.ok(context.workspaceFingerprint);
});

test('not a repo with only file-path dirs (no session cwd) defers instead of naming', () => {
  const fileDir = makeDirs('plain', 'loose-files');
  const runtime = makeRuntime(() => {
    throw NOT_A_REPO_ERROR;
  });

  const context = runtime.resolveGitContext({
    tool_input: { file_path: makeFile(fileDir, 'a.md') },
  });

  assert.equal(context.resolution, 'deferred');
  assert.equal(context.repoName, null);
  assert.equal(context.workspaceFingerprint, null);
});

test('not a repo in cwd but the touched file lives in a repo: that repo wins', () => {
  const plainDir = makeDirs('plain', 'launchpad');
  const repoRoot = makeDirs('projects', 'rocket');
  const repoSubDir = makeDirs('projects', 'rocket', 'lib');
  const runtime = makeRuntime((command, options) => {
    if (options.cwd === plainDir) throw NOT_A_REPO_ERROR;
    return repoExec(repoRoot, 'https://github.com/acme/rocket.git')(command);
  });

  const context = runtime.resolveGitContext({
    cwd: plainDir,
    tool_input: { file_path: makeFile(repoSubDir, 'a.js') },
  });

  assert.equal(context.resolution, 'git');
  assert.equal(context.repoName, 'rocket');
  assert.equal(context.gitRoot, repoRoot);
});

test('spawn failure (ENOENT): naming deferred, no fingerprint, workspace path kept', () => {
  const sessionDir = makeDirs('projects', 'ghost', 'sub');
  const runtime = makeRuntime(() => {
    throw { code: 'ENOENT' };
  });

  const context = runtime.resolveGitContext({
    cwd: sessionDir,
    tool_input: { file_path: path.join(sessionDir, 'a.ts') },
  });

  assert.equal(context.resolution, 'deferred');
  assert.equal(context.resolutionFailure, 'git_unavailable');
  assert.equal(context.repoName, null);
  assert.equal(context.workspaceFingerprint, null);
  assert.equal(context.workspacePath, sessionDir);
});

test('shell-level command-not-found (exit 127) classifies as git unavailable, not as no-repo', () => {
  const sessionDir = makeDirs('projects', 'no-git-on-path');
  const runtime = makeRuntime(() => {
    throw { status: 127, stderr: 'sh: git: command not found\n' };
  });

  const context = runtime.resolveGitContext({ cwd: sessionDir });

  assert.equal(context.resolution, 'deferred');
  assert.equal(context.resolutionFailure, 'git_unavailable');
  assert.equal(context.repoName, null);
});

test('timeout: naming deferred, no per-subfolder fingerprint fabricated', () => {
  const sessionDir = makeDirs('projects', 'slow-disk');
  const runtime = makeRuntime(() => {
    throw { killed: true, signal: 'SIGTERM', status: null };
  });

  const context = runtime.resolveGitContext({ cwd: sessionDir });

  assert.equal(context.resolution, 'deferred');
  assert.equal(context.resolutionFailure, 'timeout');
  assert.equal(context.repoName, null);
  assert.equal(context.workspaceFingerprint, null);
});

test('deferred resolutions are not cached: git recovering un-defers the same dir', () => {
  const repoRoot = makeDirs('projects', 'recovers');
  let failing = true;
  const runtime = makeRuntime((command) => {
    if (failing) throw { code: 'ENOENT' };
    return repoExec(repoRoot, 'git@github.com:acme/recovers.git')(command);
  });

  const deferred = runtime.resolveGitContext({ cwd: repoRoot });
  assert.equal(deferred.resolution, 'deferred');

  failing = false;
  const recovered = runtime.resolveGitContext({ cwd: repoRoot });
  assert.equal(recovered.resolution, 'git');
  assert.equal(recovered.repoName, 'recovers');
});

test('remote sandbox session with no repo defers instead of minting a candidate', () => {
  const sandboxDir = makeDirs('workspace');
  const runtime = makeRuntime(() => {
    throw NOT_A_REPO_ERROR;
  });

  const context = runtime.resolveGitContext({
    cwd: sandboxDir,
    devclocked_capture: { remote: true },
  });

  assert.equal(context.resolution, 'deferred');
  assert.equal(context.resolutionFailure, 'remote_non_git');
  assert.equal(context.repoName, null);
});

test('non-git session cwd equal to $HOME is guarded and defers', () => {
  const runtime = makeRuntime(() => {
    throw NOT_A_REPO_ERROR;
  });

  const context = runtime.resolveGitContext({ cwd: process.env.HOME });

  assert.equal(context.resolution, 'deferred');
  assert.equal(context.resolutionFailure, 'unnameable_dir');
  assert.equal(context.repoName, null);
});

test('classifyGitFailure maps error shapes to failure classes', () => {
  const runtime = makeRuntime(() => '');
  assert.equal(runtime.classifyGitFailure({ status: 128, stderr: 'fatal: not a git repository' }), 'not_a_repo');
  assert.equal(runtime.classifyGitFailure({ status: 128, stderr: 'fatal: detected dubious ownership' }), 'git_error');
  assert.equal(runtime.classifyGitFailure({ status: 127 }), 'git_unavailable');
  assert.equal(runtime.classifyGitFailure({ status: 126 }), 'git_unavailable');
  assert.equal(runtime.classifyGitFailure({ code: 'ENOENT' }), 'git_unavailable');
  assert.equal(runtime.classifyGitFailure({ code: 'EAGAIN' }), 'git_unavailable');
  assert.equal(runtime.classifyGitFailure({ code: 'ETIMEDOUT' }), 'timeout');
  assert.equal(runtime.classifyGitFailure({ signal: 'SIGTERM', killed: true }), 'timeout');
  assert.equal(runtime.classifyGitFailure(null), 'git_unavailable');
});

test('pruneStaleStreamState removes stale stream files and keeps live ones (catch-up from 2026-07-05 generation)', () => {
  const runtime = makeRuntime(() => '');
  const now = Date.now();
  runtime.saveStreamState('stale-stream', { last_tick_at: now - 7 * 60 * 60 * 1000 });
  runtime.saveStreamState('live-stream', { last_tick_at: now - 60 * 1000 });

  const removed = runtime.pruneStaleStreamState(now);

  assert.equal(removed, 1);
  assert.equal(runtime.getStreamState('stale-stream'), null);
  assert.ok(runtime.getStreamState('live-stream'));
});

test('pluginVersion option is exposed on the runtime (catch-up from 2026-07-05 generation)', () => {
  const runtime = makeRuntime(() => '');
  assert.equal(runtime.pluginVersion, '0.0.0-test');
});

test('repo_url with embedded credentials is stripped before it reaches context', () => {
  const repoRoot = makeDirs('projects', 'secretrepo');
  const runtime = makeRuntime(
    repoExec(repoRoot, 'https://user:ghp_LIVETOKEN123@github.com/acme/secretrepo.git')
  );

  const context = runtime.resolveGitContext({ cwd: repoRoot });

  assert.equal(context.resolution, 'git');
  assert.ok(!context.repoUrl.includes('ghp_LIVETOKEN123'), 'token must not survive');
  assert.ok(!context.repoUrl.includes('@'), 'userinfo must be blanked');
  assert.equal(context.repoUrl, 'https://github.com/acme/secretrepo.git');
  assert.equal(context.repoFullName, 'acme/secretrepo');
});

test('enqueueHookEvent drops raw prompt/diff/command content and writes 0600', () => {
  const runtime = makeRuntime(() => '');
  const filePath = runtime.enqueueHookEvent({
    hook_event_name: 'afterFileEdit',
    session_id: 'sess-1',
    file_path: '/tmp/project/src/app.ts',
    tool_name: 'Write',
    tool_input: { file_path: '/tmp/project/src/app.ts', content: 'const SECRET = "sk-live-xyz";' },
    command: 'aws s3 cp secret.txt s3://bucket --key AKIASECRET',
    prompt: 'my private prompt with confidential business plans',
    edits: [{ old_string: 'a\nb\nc', new_string: 'a\nb\nc\nd\ne' }],
  });

  const raw = fs.readFileSync(filePath, 'utf-8');
  assert.ok(!raw.includes('SECRET'), 'raw Write content must not be on disk');
  assert.ok(!raw.includes('AKIASECRET'), 'command args must not be on disk');
  assert.ok(!raw.includes('confidential'), 'raw prompt must not be on disk');
  assert.ok(!raw.includes('prompt'), 'prompt field must be dropped entirely');

  const envelope = JSON.parse(raw);
  // Consumed fields survive.
  assert.equal(envelope.input.hook_event_name, 'afterFileEdit');
  assert.equal(envelope.input.file_path, '/tmp/project/src/app.ts');
  assert.equal(envelope.input.tool_input.file_path, '/tmp/project/src/app.ts');
  assert.equal(envelope.input.command, 'aws');
  // Edit line counts are preserved for countEditLines (old=3 lines, new=5 lines).
  assert.equal(envelope.input.edits[0].old_string.split('\n').length, 3);
  assert.equal(envelope.input.edits[0].new_string.split('\n').length, 5);

  if (process.platform !== 'win32') {
    const mode = fs.statSync(filePath).mode & 0o777;
    assert.equal(mode, 0o600, `queue file must be 0600, got ${mode.toString(8)}`);
  }
});

test('acquireShipperLock treats an empty lock file with a fresh mtime as held (DEV-938)', () => {
  const runtime = makeRuntime(() => '');
  fs.mkdirSync(path.dirname(runtime.SHIPPER_LOCK_PATH), { recursive: true });
  // The window between openSync('wx') and writeFileSync in another shipper.
  fs.writeFileSync(runtime.SHIPPER_LOCK_PATH, '');

  assert.equal(runtime.acquireShipperLock(), null);
  assert.equal(fs.existsSync(runtime.SHIPPER_LOCK_PATH), true);

  fs.unlinkSync(runtime.SHIPPER_LOCK_PATH);
});

test('acquireShipperLock reclaims an empty lock file whose mtime is older than LOCK_STALE_MS (DEV-938)', () => {
  const runtime = makeRuntime(() => '');
  fs.mkdirSync(path.dirname(runtime.SHIPPER_LOCK_PATH), { recursive: true });
  fs.writeFileSync(runtime.SHIPPER_LOCK_PATH, '');
  // LOCK_STALE_MS is 60s; five minutes is comfortably past it.
  const oldSeconds = (Date.now() - 5 * 60_000) / 1000;
  fs.utimesSync(runtime.SHIPPER_LOCK_PATH, oldSeconds, oldSeconds);

  const fd = runtime.acquireShipperLock();

  assert.equal(typeof fd, 'number');
  const lock = JSON.parse(fs.readFileSync(runtime.SHIPPER_LOCK_PATH, 'utf-8'));
  assert.equal(lock.pid, process.pid);
  assert.equal(typeof lock.started_at, 'number');

  runtime.releaseShipperLock(fd);
  assert.equal(fs.existsSync(runtime.SHIPPER_LOCK_PATH), false);
});

// --- DEV-936: dead-letter store instead of dropping exhausted envelopes ------
// Design ported from tracker-core DEV-826. Every runtime in this file shares one
// namespace, so each test starts from an empty dead-letter dir.

function clearDeadLetter(runtime) {
  for (const filePath of runtime.listDeadLetterFiles()) fs.unlinkSync(filePath);
}

function writeDeadLetterEntry(runtime, name, ageMs, padBytes = 0) {
  fs.mkdirSync(runtime.DEAD_LETTER_DIR, { recursive: true });
  const filePath = path.join(runtime.DEAD_LETTER_DIR, name);
  fs.writeFileSync(
    filePath,
    JSON.stringify({
      id: name,
      captured_at: new Date(Date.now() - ageMs).toISOString(),
      attempts: 5,
      dead_lettered_at: new Date().toISOString(),
      dead_letter_reason: 'max_attempts:edge_function_503',
      input: { hook_event_name: 'afterFileEdit', session_id: name, pad: 'x'.repeat(padBytes) },
    })
  );
  return filePath;
}

test('an exhausted envelope moves into the dead-letter dir instead of being unlinked (DEV-936)', () => {
  const runtime = makeRuntime(() => '');
  clearDeadLetter(runtime);
  const filePath = runtime.enqueueHookEvent({
    hook_event_name: 'afterFileEdit',
    session_id: 'sess-936-move',
  });
  const envelope = JSON.parse(fs.readFileSync(filePath, 'utf-8'));

  const parked = runtime.deadLetterEnvelope(filePath, envelope, 'max_attempts:edge_function_503');

  assert.equal(parked, path.join(runtime.DEAD_LETTER_DIR, path.basename(filePath)));
  assert.equal(fs.existsSync(filePath), false, 'the envelope must leave the live queue');
  assert.equal(fs.existsSync(parked), true, 'the envelope must survive on disk');

  const stored = JSON.parse(fs.readFileSync(parked, 'utf-8'));
  assert.ok(stored.dead_lettered_at, 'dead_lettered_at must be stamped');
  assert.equal(stored.dead_letter_reason, 'max_attempts:edge_function_503');
  assert.deepEqual(stored.input, envelope.input, 'the payload must survive untouched');

  // The dead-letter dir is a sibling of the queue dir, so the live drain keeps
  // ignoring parked envelopes until a replay puts them back.
  assert.deepEqual(runtime.listDeadLetterFiles(), [parked]);
  assert.ok(runtime.listQueueFiles().every((queued) => !queued.startsWith(runtime.DEAD_LETTER_DIR)));

  clearDeadLetter(runtime);
});

test('dead-letter pruning evicts entries past the 7-day age cap and keeps younger ones (DEV-936)', () => {
  const runtime = makeRuntime(() => '');
  clearDeadLetter(runtime);
  assert.equal(runtime.DEAD_LETTER_MAX_AGE_MS, 7 * 24 * 60 * 60 * 1000);

  const eightDaysOld = writeDeadLetterEntry(runtime, 'aged-out.json', 8 * 24 * 60 * 60 * 1000);
  const sixDaysOld = writeDeadLetterEntry(runtime, 'still-young.json', 6 * 24 * 60 * 60 * 1000);

  assert.equal(runtime.pruneDeadLetter(), 1);
  assert.equal(fs.existsSync(eightDaysOld), false);
  assert.equal(fs.existsSync(sixDaysOld), true);

  clearDeadLetter(runtime);
});

test('dead-letter pruning evicts oldest-first until the byte ceiling is met (DEV-936)', () => {
  const runtime = makeRuntime(() => '');
  clearDeadLetter(runtime);
  assert.equal(runtime.DEAD_LETTER_MAX_BYTES, 5 * 1024 * 1024);

  const oldest = writeDeadLetterEntry(runtime, 'a-oldest.json', 30 * 60_000, 3000);
  const middle = writeDeadLetterEntry(runtime, 'b-middle.json', 20 * 60_000, 3000);
  const newest = writeDeadLetterEntry(runtime, 'c-newest.json', 10 * 60_000, 3000);

  // A ceiling only the newest entry fits under: the two older ones must go, in
  // age order, and eviction must stop as soon as the store is under the cap.
  const maxBytes = fs.statSync(newest).size;
  assert.equal(runtime.pruneDeadLetter(Date.now(), { maxBytes }), 2);

  assert.equal(fs.existsSync(oldest), false);
  assert.equal(fs.existsSync(middle), false);
  assert.equal(fs.existsSync(newest), true, 'the newest entry must survive');

  clearDeadLetter(runtime);
});

test('every dead-letter eviction is logged — the only path that loses activity is never silent (DEV-936)', () => {
  const runtime = makeRuntime(() => '');
  clearDeadLetter(runtime);
  const logPath = path.join(runtime.LOG_DIR, 'shipper.log');
  const before = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf-8').length : 0;

  writeDeadLetterEntry(runtime, 'loud-eviction.json', 9 * 24 * 60 * 60 * 1000);
  assert.equal(runtime.pruneDeadLetter(), 1);

  const written = fs.readFileSync(logPath, 'utf-8').slice(before);
  const entry = written
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .find((line) => line.extra?.file === 'loud-eviction.json');
  assert.ok(entry, 'expected an eviction log entry');
  assert.match(entry.message, /Evicted dead-lettered hook event/);
  assert.equal(entry.extra.reason, 'max_age');

  clearDeadLetter(runtime);
});

test('replayDeadLetter returns envelopes to the queue with a clean retry budget (DEV-936)', () => {
  const runtime = makeRuntime(() => '');
  clearDeadLetter(runtime);
  const parked = writeDeadLetterEntry(runtime, 'replay-me.json', 60_000);
  const spent = JSON.parse(fs.readFileSync(parked, 'utf-8'));
  spent.retry_after = new Date(Date.now() + 15_000).toISOString();
  fs.writeFileSync(parked, JSON.stringify(spent));

  assert.equal(runtime.replayDeadLetter(), 1);

  const requeued = path.join(runtime.QUEUE_DIR, 'replay-me.json');
  assert.equal(fs.existsSync(parked), false);
  assert.equal(fs.existsSync(requeued), true);

  const envelope = JSON.parse(fs.readFileSync(requeued, 'utf-8'));
  assert.equal(envelope.attempts, 0, 'attempts must reset');
  assert.equal(envelope.retry_after, undefined, 'the backoff must be cleared');
  assert.equal(
    runtime.shouldRetryEnvelope(envelope),
    true,
    'a replayed envelope must be immediately eligible'
  );

  fs.unlinkSync(requeued);
  clearDeadLetter(runtime);
});

test('replayDeadLetterFile returns one envelope to the queue with a clean retry budget (DEV-936)', () => {
  const runtime = makeRuntime(() => '');
  clearDeadLetter(runtime);
  const parked = writeDeadLetterEntry(runtime, 'replay-one.json', 60_000);
  const spent = JSON.parse(fs.readFileSync(parked, 'utf-8'));
  spent.retry_after = new Date(Date.now() + 15_000).toISOString();
  fs.writeFileSync(parked, JSON.stringify(spent));

  const { queuedPath: requeued, quarantined } = runtime.replayDeadLetterFile(parked);

  assert.equal(quarantined, false);
  assert.equal(requeued, path.join(runtime.QUEUE_DIR, 'replay-one.json'));
  assert.equal(fs.existsSync(parked), false);
  const envelope = JSON.parse(fs.readFileSync(requeued, 'utf-8'));
  assert.equal(envelope.attempts, 0, 'attempts must reset');
  assert.equal(envelope.retry_after, undefined, 'the backoff must be cleared');
  assert.equal(runtime.shouldRetryEnvelope(envelope), true);

  fs.unlinkSync(requeued);
  clearDeadLetter(runtime);
});

test('replayDeadLetter moves at most the replay limit, oldest first (DEV-936)', () => {
  const runtime = makeRuntime(() => '');
  clearDeadLetter(runtime);
  for (let i = 0; i < 30; i += 1) {
    writeDeadLetterEntry(runtime, `bulk-${String(i).padStart(3, '0')}.json`, (30 - i) * 60_000);
  }

  assert.equal(runtime.DEAD_LETTER_REPLAY_LIMIT, 25);
  assert.equal(runtime.replayDeadLetter(), 25);
  assert.equal(runtime.listDeadLetterFiles().length, 5, 'the rest wait for the next run');

  for (const filePath of runtime.listQueueFiles()) fs.unlinkSync(filePath);
  clearDeadLetter(runtime);
});

test('an unreadable queue file is quarantined out of both globs instead of wedging the drain (DEV-936)', () => {
  const runtime = makeRuntime(() => '');
  clearDeadLetter(runtime);
  for (const filePath of runtime.listQueueFiles()) fs.unlinkSync(filePath);

  const corrupt = path.join(runtime.QUEUE_DIR, 'truncated.json');
  runtime.ensureDir(runtime.QUEUE_DIR);
  fs.writeFileSync(corrupt, '{"id":"half-writ');
  assert.throws(() => runtime.readJsonFile(corrupt));

  assert.equal(runtime.quarantineEnvelope(corrupt, new SyntaxError('Unexpected end of JSON input')), true);

  assert.equal(fs.existsSync(corrupt), false);
  assert.equal(fs.existsSync(path.join(runtime.QUARANTINE_DIR, 'truncated.json')), true);
  assert.deepEqual(runtime.listQueueFiles(), [], 'a corrupt file must not be re-listed');
  assert.deepEqual(runtime.listDeadLetterFiles(), [], 'and it is not replayable either');

  fs.rmSync(runtime.QUARANTINE_DIR, { recursive: true, force: true });
});

test('a dead-lettered envelope that will not parse is quarantined rather than replayed forever (DEV-936)', () => {
  const runtime = makeRuntime(() => '');
  clearDeadLetter(runtime);
  runtime.ensureDir(runtime.DEAD_LETTER_DIR);
  const parked = path.join(runtime.DEAD_LETTER_DIR, 'corrupt-parked.json');
  fs.writeFileSync(parked, '{"captured_at":');

  assert.deepEqual(runtime.replayDeadLetterFile(parked), { queuedPath: null, quarantined: true });
  assert.equal(fs.existsSync(parked), false);
  assert.equal(fs.existsSync(path.join(runtime.QUARANTINE_DIR, 'corrupt-parked.json')), true);

  fs.rmSync(runtime.QUARANTINE_DIR, { recursive: true, force: true });
  clearDeadLetter(runtime);
});

test('writeJsonFile publishes by rename, so a reader never sees a partial envelope (DEV-936)', () => {
  const runtime = makeRuntime(() => '');
  for (const filePath of runtime.listQueueFiles()) fs.unlinkSync(filePath);

  const filePath = runtime.enqueueHookEvent({ hook_event_name: 'afterFileEdit', session_id: 'sess-atomic' });

  // Every intermediate write lands on a .tmp name that neither glob matches,
  // and nothing is left behind once the rename completes.
  const residue = fs.readdirSync(runtime.QUEUE_DIR).filter((name) => name.endsWith('.tmp'));
  assert.deepEqual(residue, []);
  assert.doesNotThrow(() => runtime.readJsonFile(filePath));

  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(filePath).mode & 0o777, 0o600, 'the rename must preserve 0600');
  }

  fs.unlinkSync(filePath);
});

test('a queue file that parses fine is left in place when processing fails for another reason (DEV-936)', () => {
  const runtime = makeRuntime(() => '');
  for (const filePath of runtime.listQueueFiles()) fs.unlinkSync(filePath);

  const filePath = runtime.enqueueHookEvent({ hook_event_name: 'afterFileEdit', session_id: 'sess-transient' });

  // A transient write failure must not relocate captured activity.
  assert.equal(runtime.quarantineEnvelope(filePath, new Error('EROFS: read-only file system')), false);
  assert.equal(fs.existsSync(filePath), true);
  assert.equal(fs.existsSync(path.join(runtime.QUARANTINE_DIR, path.basename(filePath))), false);

  fs.unlinkSync(filePath);
});

test('the once-per-run sweep clears quarantined files past the age cap (DEV-936 R1)', () => {
  const runtime = makeRuntime(() => '');
  clearDeadLetter(runtime);
  runtime.ensureDir(runtime.QUARANTINE_DIR);

  const aged = path.join(runtime.QUARANTINE_DIR, 'aged.json');
  const fresh = path.join(runtime.QUARANTINE_DIR, 'fresh.json');
  fs.writeFileSync(aged, '{"broken');
  fs.writeFileSync(fresh, '{"broken');
  const eightDaysAgo = (Date.now() - 8 * 24 * 60 * 60 * 1000) / 1000;
  fs.utimesSync(aged, eightDaysAgo, eightDaysAgo);

  runtime.pruneDeadLetter();

  assert.equal(fs.existsSync(aged), false, 'the quarantine store must not grow forever');
  assert.equal(fs.existsSync(fresh), true, 'a recent one stays around to be diagnosed');

  fs.rmSync(runtime.QUARANTINE_DIR, { recursive: true, force: true });
});

test('the once-per-run sweep clears orphaned .tmp files past the age cap (DEV-936 R2)', () => {
  const runtime = makeRuntime(() => '');
  clearDeadLetter(runtime);
  runtime.ensureDir(runtime.QUEUE_DIR);
  runtime.ensureDir(runtime.DEAD_LETTER_DIR);

  // A write that died between writeFileSync and renameSync.
  const orphans = [
    path.join(runtime.QUEUE_DIR, '123-4-abc.json.99.tmp'),
    path.join(runtime.DEAD_LETTER_DIR, '123-4-def.json.99.tmp'),
  ];
  const fresh = path.join(runtime.DEAD_LETTER_DIR, '123-4-ghi.json.99.tmp');
  for (const filePath of [...orphans, fresh]) fs.writeFileSync(filePath, 'x'.repeat(1000));
  const eightDaysAgo = (Date.now() - 8 * 24 * 60 * 60 * 1000) / 1000;
  for (const filePath of orphans) fs.utimesSync(filePath, eightDaysAgo, eightDaysAgo);

  runtime.pruneDeadLetter();

  for (const filePath of orphans) assert.equal(fs.existsSync(filePath), false);
  assert.equal(fs.existsSync(fresh), true, 'a fresh temp file may belong to a live write');
  // Either way a .tmp is invisible to both globs, so it can never be shipped.
  assert.deepEqual(runtime.listQueueFiles(), []);
  assert.deepEqual(runtime.listDeadLetterFiles(), []);

  fs.unlinkSync(fresh);
});

test('a failed write leaves no temp file behind (DEV-936 R2)', () => {
  const runtime = makeRuntime(() => '');
  runtime.ensureDir(runtime.QUEUE_DIR);
  const target = path.join(runtime.QUEUE_DIR, 'blocked.json');
  const tmpPath = `${target}.${process.pid}.tmp`;

  // Model an ENOSPC that lands part-way through: the temp file exists on disk
  // by the time the write throws. That is the orphan nothing else would ever
  // clean up — and an orphan in the dead-letter dir is invisible to the 5 MB
  // ceiling. Only a write that is itself inside the try can unlink it.
  const realWriteFileSync = fs.writeFileSync;
  fs.writeFileSync = (filePath, ...rest) => {
    realWriteFileSync(filePath, ...rest);
    if (filePath === tmpPath) throw new Error('ENOSPC: no space left on device');
    return undefined;
  };

  try {
    assert.throws(() => runtime.writeJsonFile(target, { id: 'x' }), /ENOSPC/);
  } finally {
    fs.writeFileSync = realWriteFileSync;
  }

  assert.equal(fs.existsSync(target), false, 'a failed write must not publish');
  assert.equal(fs.existsSync(tmpPath), false, 'no orphan may survive a failed write');
  assert.deepEqual(
    fs.readdirSync(runtime.QUEUE_DIR).filter((name) => name.endsWith('.tmp')),
    []
  );
});
