const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// ship.js pulls in runtime state helpers that touch $HOME/.config/devclocked.
// Redirect HOME before requiring so tests never touch real plugin state.
process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'devclocked-codex-ship-test-'));

const { isActivityTypeTransition } = require('./ship');

test('a differing classification counts as a transition and ships through the throttle', () => {
  assert.equal(isActivityTypeTransition({ last_activity_type: 'coding' }, 'planning'), true);
});

test('a same-type tick inside the window keeps throttling', () => {
  assert.equal(isActivityTypeTransition({ last_activity_type: 'coding' }, 'coding'), false);
});

test('no recorded prior type cannot be a transition (pre-existing state keeps old behavior)', () => {
  assert.equal(isActivityTypeTransition(null, 'coding'), false);
  assert.equal(isActivityTypeTransition({}, 'coding'), false);
  assert.equal(isActivityTypeTransition({ last_tick_at: 123 }, 'coding'), false);
});
