const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// DEV-1001: the home root used to come from `process.env.HOME`, which Windows
// never sets, so every derived path collapsed onto the literal '~' fallback.
// These tests pin the resolution to os.homedir() on both platform shapes.

const CORE_PATH = require.resolve('./core');

const NOT_A_REPO_ERROR = {
  status: 128,
  stderr: 'fatal: not a git repository (or any of the parent directories): .git\n',
};

// core.js reads the home root into module-level constants at require time and
// re-reads it per call elsewhere, so the environment has to stay patched for
// the whole body and the module has to be loaded fresh under it.
function withHome({ home, userProfile, homedirImpl }, body) {
  const previous = {
    home: process.env.HOME,
    userProfile: process.env.USERPROFILE,
    homedir: os.homedir,
    cached: require.cache[CORE_PATH],
  };
  delete require.cache[CORE_PATH];
  try {
    if (home === undefined) delete process.env.HOME;
    else process.env.HOME = home;
    if (userProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = userProfile;
    if (homedirImpl) os.homedir = homedirImpl;

    const { createPluginRuntime } = require(CORE_PATH);
    return body(
      createPluginRuntime({
        namespace: 'homedir-hook',
        source: 'homedir-plugin',
        shipperPath: path.join(os.tmpdir(), 'hooks', 'ship.js'),
        pluginVersion: '0.0.0-test',
        execSyncImpl: () => {
          throw NOT_A_REPO_ERROR;
        },
      })
    );
  } finally {
    os.homedir = previous.homedir;
    if (previous.home === undefined) delete process.env.HOME;
    else process.env.HOME = previous.home;
    if (previous.userProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previous.userProfile;
    delete require.cache[CORE_PATH];
    if (previous.cached) require.cache[CORE_PATH] = previous.cached;
  }
}

function makeSandbox() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'devclocked-codex-homedir-test-'));
}

function derivedPaths(runtime) {
  return [
    runtime.DEVCLOCKED_HOME,
    runtime.CLI_CONFIG_PATH,
    runtime.STATE_DIR,
    runtime.QUEUE_DIR,
    runtime.LOG_DIR,
    runtime.GIT_CACHE_DIR,
    runtime.DEAD_LETTER_DIR,
    runtime.QUARANTINE_DIR,
  ];
}

test('POSIX: every derived path hangs off $HOME', () => {
  const sandbox = makeSandbox();
  withHome({ home: sandbox }, (runtime) => {
    assert.equal(runtime.DEVCLOCKED_HOME, path.join(sandbox, '.config', 'devclocked'));
    assert.equal(runtime.CLI_CONFIG_PATH, path.join(sandbox, '.config', 'devclocked', 'cli.json'));
    for (const derived of derivedPaths(runtime)) {
      assert.ok(derived.startsWith(sandbox), `${derived} is not under ${sandbox}`);
    }
  });
});

test('Windows shape: HOME unset and USERPROFILE set resolves to the profile dir', () => {
  const userProfile = 'C:\\Users\\devclocked';
  withHome(
    {
      home: undefined,
      userProfile,
      // Stand in for Node's Windows os.homedir(), which reads %USERPROFILE% and
      // ignores $HOME entirely.
      homedirImpl: () => process.env.USERPROFILE,
    },
    (runtime) => {
      assert.equal(runtime.DEVCLOCKED_HOME, path.join(userProfile, '.config', 'devclocked'));
      for (const derived of derivedPaths(runtime)) {
        assert.ok(derived.startsWith(userProfile), `${derived} is not under ${userProfile}`);
      }
    }
  );
});

test('HOME unset: no derived path is relative or contains a literal "~" segment', () => {
  withHome({ home: undefined }, (runtime) => {
    for (const derived of derivedPaths(runtime)) {
      assert.ok(path.isAbsolute(derived), `${derived} is not absolute`);
      assert.ok(!derived.split(path.sep).includes('~'), `${derived} has a literal "~" segment`);
    }
  });
});

test('a relative cwd resolves against os.homedir(), not $HOME', () => {
  const sandbox = makeSandbox();
  const workspace = path.join(sandbox, 'projects', 'widget');
  fs.mkdirSync(workspace, { recursive: true });

  withHome({ home: undefined, homedirImpl: () => sandbox }, (runtime) => {
    const context = runtime.resolveGitContext({ cwd: path.join('projects', 'widget') });
    assert.equal(context.resolution, 'cwd');
    assert.equal(context.workspacePath, workspace);
    assert.equal(context.repoName, 'widget');
  });
});

test('the guarded home root is the one os.homedir() reports', () => {
  const sandbox = makeSandbox();
  const child = path.join(sandbox, 'notes');
  fs.mkdirSync(child, { recursive: true });

  withHome({ home: undefined, homedirImpl: () => sandbox }, (runtime) => {
    const guarded = runtime.resolveGitContext({ cwd: sandbox });
    assert.equal(guarded.resolution, 'deferred');
    assert.equal(guarded.resolutionFailure, 'unnameable_dir');
    assert.equal(guarded.repoName, null);

    const named = runtime.resolveGitContext({ cwd: child });
    assert.equal(named.resolution, 'cwd');
    assert.equal(named.repoName, 'notes');
  });
});
