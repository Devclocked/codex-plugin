const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  MANAGED_PREFIX,
  buildManagedHooks,
  countManagedHooks,
  ensureCodexHooksFeature,
  findDuplicatePluginHooks,
  hookIdentityHash,
  disabledHookMessage,
  duplicatePluginMessage,
  hasCachedPluginTrust,
  managedHookTrust,
  mergeManagedHooks,
  parseHookTrustState,
  stripManagedHooks,
  untrustedHookMessage,
} = require('./manage-hooks');

const HOOKS_PATH = '/tmp/codex-home/hooks.json';

function foreignHook(command) {
  return { type: 'command', command };
}

function managedHook(event) {
  return {
    type: 'command',
    command: `/usr/bin/env ${MANAGED_PREFIX} node '/plugin/root/hooks/track.js' ${event}`,
  };
}

function trustState(entries) {
  return entries
    .map(
      ([key, hash, enabled]) =>
        `[hooks.state."${key}"]\ntrusted_hash = "${hash}"\n` +
        (enabled === undefined ? '' : `enabled = ${enabled}\n`)
    )
    .join('\n');
}

test('ensureCodexHooksFeature appends feature section when missing', () => {
  const result = ensureCodexHooksFeature('model = "gpt-5.4"\n');
  assert.equal(result.changed, true);
  assert.match(result.text, /\[features\]\nhooks = true\n$/);
});

test('ensureCodexHooksFeature leaves existing enabled flag unchanged', () => {
  const result = ensureCodexHooksFeature('[features]\nhooks = true\n');
  assert.equal(result.changed, false);
  assert.equal(result.text, '[features]\nhooks = true\n');
});

test('ensureCodexHooksFeature migrates the deprecated codex_hooks flag', () => {
  const result = ensureCodexHooksFeature('[features]\ncodex_hooks = true\napps = true\n');
  assert.equal(result.changed, true);
  assert.equal(result.text, '[features]\napps = true\nhooks = true\n');
});

test('ensureCodexHooksFeature enables hooks when the current flag is false', () => {
  const result = ensureCodexHooksFeature('[features]\nhooks = false\n');
  assert.equal(result.changed, true);
  assert.equal(result.text, '[features]\nhooks = true\n');
});

test('mergeManagedHooks preserves unrelated hooks and replaces prior managed hooks', () => {
  const existing = {
    hooks: {
      PostToolUse: [
        {
          matcher: 'Write',
          hooks: [{ type: 'command', command: './scripts/other.sh' }],
        },
        {
          matcher: 'Bash',
          hooks: [{ type: 'command', command: `/usr/bin/env ${MANAGED_PREFIX} node '/old/track.js' PostToolUse` }],
        },
      ],
    },
  };
  const managed = buildManagedHooks('/plugin/root');
  const merged = mergeManagedHooks(existing, managed);

  assert.equal(merged.hooks.PostToolUse.length, 2);
  assert.equal(merged.hooks.PostToolUse[0].matcher, 'Write');
  assert.equal(merged.hooks.PostToolUse[1].matcher, 'Bash');
  assert.match(merged.hooks.PostToolUse[1].hooks[0].command, /\/plugin\/root\/hooks\/track\.js/);
  assert.equal(countManagedHooks(merged), 4);
});

test('stripManagedHooks removes only DevClocked-managed commands', () => {
  const config = {
    hooks: {
      Stop: [
        {
          hooks: [
            { type: 'command', command: `/usr/bin/env ${MANAGED_PREFIX} node '/plugin/root/hooks/track.js' Stop` },
            { type: 'command', command: './scripts/cleanup.sh' },
          ],
        },
      ],
    },
  };

  const stripped = stripManagedHooks(config);
  assert.equal(countManagedHooks(stripped), 0);
  assert.equal(stripped.hooks.Stop[0].hooks.length, 1);
  assert.equal(stripped.hooks.Stop[0].hooks[0].command, './scripts/cleanup.sh');
});

test('mergeManagedHooks puts every handler in group 0 of an empty hooks file', () => {
  const merged = mergeManagedHooks({ hooks: {} }, buildManagedHooks('/plugin/root'));

  for (const event of ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop']) {
    assert.equal(merged.hooks[event].length, 1);
    assert.equal(merged.hooks[event][0].hooks.length, 1);
    assert.match(merged.hooks[event][0].hooks[0].command, new RegExp(`track\\.js' ${event}$`));
  }
});

test('mergeManagedHooks merges into an existing group 0 that shares the matcher', () => {
  const existing = {
    hooks: { Stop: [{ hooks: [foreignHook('./scripts/other.sh')] }] },
  };
  const merged = mergeManagedHooks(existing, buildManagedHooks('/plugin/root'));

  assert.equal(merged.hooks.Stop.length, 1);
  assert.equal(merged.hooks.Stop[0].hooks.length, 2);
  assert.equal(merged.hooks.Stop[0].hooks[0].command, './scripts/other.sh');
  assert.match(merged.hooks.Stop[0].hooks[1].command, /track\.js' Stop$/);
});

test('mergeManagedHooks migrates a devclocked handler out of group 1 into group 0', () => {
  const existing = {
    hooks: {
      UserPromptSubmit: [
        { hooks: [foreignHook('./scripts/other.sh')] },
        { hooks: [managedHook('UserPromptSubmit')] },
      ],
    },
  };
  const merged = mergeManagedHooks(existing, buildManagedHooks('/plugin/root'));

  assert.equal(merged.hooks.UserPromptSubmit.length, 1);
  assert.equal(merged.hooks.UserPromptSubmit[0].hooks.length, 2);
  assert.match(merged.hooks.UserPromptSubmit[0].hooks[1].command, /track\.js' UserPromptSubmit$/);
});

test('mergeManagedHooks keeps a new group when no existing group shares the matcher', () => {
  const existing = {
    hooks: { PostToolUse: [{ matcher: 'Write', hooks: [foreignHook('./scripts/other.sh')] }] },
  };
  const merged = mergeManagedHooks(existing, buildManagedHooks('/plugin/root'));

  assert.equal(merged.hooks.PostToolUse.length, 2);
  assert.equal(merged.hooks.PostToolUse[0].matcher, 'Write');
  assert.equal(merged.hooks.PostToolUse[1].matcher, 'Bash');
});

test('parseHookTrustState reads quoted state sections', () => {
  const state = parseHookTrustState(
    '[features]\nhooks = true\n\n[hooks.state."/a/hooks.json:stop:0:0"]\ntrusted_hash = "sha256:abc"\nenabled = false\n'
  );

  assert.equal(state.get('/a/hooks.json:stop:0:0').trustedHash, 'sha256:abc');
  assert.equal(state.get('/a/hooks.json:stop:0:0').enabled, false);
});

test('managedHookTrust reports untrusted when the state key is missing', () => {
  const hooks = { hooks: { Stop: [{ hooks: [managedHook('Stop')] }] } };
  const entries = managedHookTrust(hooks, HOOKS_PATH, '[features]\nhooks = true\n');

  assert.equal(entries.length, 1);
  assert.equal(entries[0].key, `${HOOKS_PATH}:stop:0:0`);
  assert.equal(entries[0].status, 'untrusted');
  assert.match(untrustedHookMessage(entries), /not trusted by Codex \(Stop\)/);
});

test('managedHookTrust reports trusted when the stored hash matches', () => {
  const group = { hooks: [managedHook('Stop')] };
  const hooks = { hooks: { Stop: [group] } };
  const hash = hookIdentityHash('Stop', group, group.hooks[0]);
  const entries = managedHookTrust(hooks, HOOKS_PATH, trustState([[`${HOOKS_PATH}:stop:0:0`, hash]]));

  assert.equal(entries[0].status, 'trusted');
  assert.equal(untrustedHookMessage(entries), null);
});

test('managedHookTrust reports modified when the handler changed since it was trusted', () => {
  const group = { hooks: [managedHook('Stop')] };
  const hooks = { hooks: { Stop: [group] } };
  const stale = hookIdentityHash('Stop', group, { ...group.hooks[0], command: `${group.hooks[0].command} --old` });
  const entries = managedHookTrust(hooks, HOOKS_PATH, trustState([[`${HOOKS_PATH}:stop:0:0`, stale]]));

  assert.equal(entries[0].status, 'modified');
  assert.match(untrustedHookMessage(entries), /not trusted by Codex \(Stop\)/);
});

test('managedHookTrust keys a handler by its real group and handler index', () => {
  const hooks = {
    hooks: {
      UserPromptSubmit: [
        { hooks: [foreignHook('./scripts/other.sh'), managedHook('UserPromptSubmit')] },
      ],
    },
  };
  const entries = managedHookTrust(hooks, HOOKS_PATH, '');

  assert.equal(entries.length, 1);
  assert.equal(entries[0].key, `${HOOKS_PATH}:user_prompt_submit:0:1`);
});

test('findDuplicatePluginHooks finds a cached copy of the plugin', () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-cache-'));
  fs.mkdirSync(path.join(cacheDir, 'devclocked-local', 'devclocked-codex'), { recursive: true });
  fs.mkdirSync(path.join(cacheDir, 'openai-curated-remote', 'linear'), { recursive: true });

  const found = findDuplicatePluginHooks(cacheDir);

  assert.deepEqual(found, [path.join(cacheDir, 'devclocked-local', 'devclocked-codex')]);
  fs.rmSync(cacheDir, { recursive: true, force: true });
});

test('findDuplicatePluginHooks returns nothing for a missing cache directory', () => {
  assert.deepEqual(findDuplicatePluginHooks('/tmp/codex-cache-does-not-exist'), []);
});

test('managedHookTrust reports disabled when a matching hash is switched off', () => {
  const group = { hooks: [managedHook('Stop')] };
  const hooks = { hooks: { Stop: [group] } };
  const hash = hookIdentityHash('Stop', group, group.hooks[0]);
  const entries = managedHookTrust(
    hooks,
    HOOKS_PATH,
    trustState([[`${HOOKS_PATH}:stop:0:0`, hash, false]])
  );

  assert.equal(entries[0].status, 'disabled');
  assert.match(disabledHookMessage(entries), /disabled in config\.toml \(Stop\)/);
  assert.equal(untrustedHookMessage(entries), null);
});

test('managedHookTrust stays trusted when the state entry is explicitly enabled', () => {
  const group = { hooks: [managedHook('Stop')] };
  const hooks = { hooks: { Stop: [group] } };
  const hash = hookIdentityHash('Stop', group, group.hooks[0]);
  const entries = managedHookTrust(
    hooks,
    HOOKS_PATH,
    trustState([[`${HOOKS_PATH}:stop:0:0`, hash, true]])
  );

  assert.equal(entries[0].status, 'trusted');
  assert.equal(disabledHookMessage(entries), null);
});

test('mergeManagedHooks re-install keeps a following foreign group at its index', () => {
  const existing = {
    hooks: {
      Stop: [{ hooks: [managedHook('Stop')] }, { hooks: [foreignHook('./scripts/other.sh')] }],
    },
  };
  const merged = mergeManagedHooks(existing, buildManagedHooks('/plugin/root'));

  assert.equal(merged.hooks.Stop.length, 2);
  assert.equal(merged.hooks.Stop[0].hooks.length, 1);
  assert.match(merged.hooks.Stop[0].hooks[0].command, /track\.js' Stop$/);
  assert.deepEqual(merged.hooks.Stop[1].hooks, [foreignHook('./scripts/other.sh')]);
});

test('mergeManagedHooks re-install replaces a matcher group in place ahead of a foreign matcher group', () => {
  const existing = {
    hooks: {
      PostToolUse: [
        { matcher: 'Bash', hooks: [{ type: 'command', command: `/usr/bin/env ${MANAGED_PREFIX} node '/old/track.js' PostToolUse` }] },
        { matcher: 'Write', hooks: [foreignHook('./scripts/other.sh')] },
      ],
    },
  };
  const merged = mergeManagedHooks(existing, buildManagedHooks('/plugin/root'));

  assert.equal(merged.hooks.PostToolUse.length, 2);
  assert.equal(merged.hooks.PostToolUse[0].matcher, 'Bash');
  assert.equal(merged.hooks.PostToolUse[0].hooks.length, 1);
  assert.match(merged.hooks.PostToolUse[0].hooks[0].command, /\/plugin\/root\/hooks\/track\.js' PostToolUse$/);
  assert.equal(merged.hooks.PostToolUse[1].matcher, 'Write');
  assert.deepEqual(merged.hooks.PostToolUse[1].hooks, [foreignHook('./scripts/other.sh')]);
});

test('mergeManagedHooks migrating out of group 1 leaves it empty so later groups keep their index', () => {
  const existing = {
    hooks: {
      UserPromptSubmit: [
        { hooks: [foreignHook('./scripts/first.sh')] },
        { hooks: [managedHook('UserPromptSubmit')] },
        { hooks: [foreignHook('./scripts/third.sh')] },
      ],
    },
  };
  const merged = mergeManagedHooks(existing, buildManagedHooks('/plugin/root'));

  assert.equal(merged.hooks.UserPromptSubmit.length, 3);
  assert.equal(merged.hooks.UserPromptSubmit[0].hooks[0].command, './scripts/first.sh');
  assert.match(merged.hooks.UserPromptSubmit[0].hooks[1].command, /track\.js' UserPromptSubmit$/);
  assert.deepEqual(merged.hooks.UserPromptSubmit[1].hooks, []);
  assert.deepEqual(merged.hooks.UserPromptSubmit[2].hooks, [foreignHook('./scripts/third.sh')]);
});

test('mergeManagedHooks applied twice is idempotent', () => {
  const existing = {
    hooks: {
      Stop: [{ hooks: [managedHook('Stop')] }, { hooks: [foreignHook('./scripts/other.sh')] }],
      PostToolUse: [
        { matcher: 'Write', hooks: [foreignHook('./scripts/other.sh')] },
        { matcher: 'Bash', hooks: [managedHook('PostToolUse')] },
      ],
      UserPromptSubmit: [
        { hooks: [foreignHook('./scripts/first.sh')] },
        { hooks: [managedHook('UserPromptSubmit')] },
        { hooks: [foreignHook('./scripts/third.sh')] },
      ],
    },
  };
  const managed = buildManagedHooks('/plugin/root');
  const once = mergeManagedHooks(existing, managed);
  const twice = mergeManagedHooks(once, managed);

  assert.deepEqual(twice, once);
});

test('stripManagedHooks keeps an emptied group that other groups follow', () => {
  const config = {
    hooks: {
      Stop: [{ hooks: [managedHook('Stop')] }, { hooks: [foreignHook('./scripts/other.sh')] }],
      SessionStart: [{ hooks: [foreignHook('./scripts/other.sh')] }, { hooks: [managedHook('SessionStart')] }],
    },
  };
  const stripped = stripManagedHooks(config);

  assert.deepEqual(stripped.hooks.Stop, [{ hooks: [] }, { hooks: [foreignHook('./scripts/other.sh')] }]);
  assert.deepEqual(stripped.hooks.SessionStart, [{ hooks: [foreignHook('./scripts/other.sh')] }]);
});

test('duplicatePluginMessage says to remove the cache copy only when hooks.json is trusted', () => {
  const trusted = [{ eventName: 'Stop', status: 'trusted' }];
  const message = duplicatePluginMessage(['/cache/devclocked-local/devclocked-codex'], trusted, true);

  assert.match(message, /\/cache\/devclocked-local\/devclocked-codex/);
  assert.match(message, /hooks\.json handlers are trusted, so remove the cached copy/);
});

test('duplicatePluginMessage warns that removing the cache copy stops tracking when hooks.json is untrusted', () => {
  const trust = [
    { eventName: 'Stop', status: 'trusted' },
    { eventName: 'UserPromptSubmit', status: 'untrusted' },
    { eventName: 'SessionStart', status: 'modified' },
  ];
  const message = duplicatePluginMessage(['/cache/devclocked-local/devclocked-codex'], trust, true);

  assert.match(message, /Trust is per copy/);
  assert.match(message, /UserPromptSubmit=untrusted SessionStart=modified/);
  assert.match(message, /config\.toml holds trust for the cached copy/);
  assert.match(message, /would stop tracking/);
  assert.match(message, /Re-trust the hooks\.json handlers/);
  assert.doesNotMatch(duplicatePluginMessage(['/cache/x'], trust, false), /holds trust for the cached copy/);
  assert.equal(duplicatePluginMessage([], trust, true), null);
});

test('hasCachedPluginTrust detects plugin-keyed state entries', () => {
  const key = 'devclocked-codex@devclocked-local:hooks.json:stop:0:0';
  assert.equal(hasCachedPluginTrust(trustState([[key, 'sha256:abc']])), true);
  assert.equal(hasCachedPluginTrust(trustState([[`${HOOKS_PATH}:stop:0:0`, 'sha256:abc']])), false);
  assert.equal(hasCachedPluginTrust(''), false);
});
