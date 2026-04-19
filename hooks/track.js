#!/usr/bin/env node

const runtime = require('./runtime');
const { runTrack } = require('../runtime/track');

runTrack(runtime, (input) => ({
  ...input,
  hook_event_name: process.argv[2] || input.hook_event_name || null,
}));
