#!/usr/bin/env node

const runtime = require('./runtime');
const { runTrack } = require('../runtime/track');
const { spawnAgentRunSync } = require('./agentRunSync');

runTrack(runtime, (input) => {
  const captured = {
    ...input,
    hook_event_name: process.argv[2] || input.hook_event_name || null,
  };
  spawnAgentRunSync(captured, {
    onError: () => runtime.appendLog('hook', 'Failed to launch agent-run sync'),
  });
  return captured;
});
