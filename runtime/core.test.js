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
