const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MANAGED_PREFIX,
  buildManagedHooks,
  countManagedHooks,
  ensureCodexHooksFeature,
  mergeManagedHooks,
  stripManagedHooks,
} = require('./manage-hooks');

test('ensureCodexHooksFeature appends feature section when missing', () => {
  const result = ensureCodexHooksFeature('model = "gpt-5.4"\n');
  assert.equal(result.changed, true);
  assert.match(result.text, /\[features\]\ncodex_hooks = true\n$/);
});

test('ensureCodexHooksFeature leaves existing enabled flag unchanged', () => {
  const result = ensureCodexHooksFeature('[features]\ncodex_hooks = true\n');
  assert.equal(result.changed, false);
  assert.equal(result.text, '[features]\ncodex_hooks = true\n');
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
