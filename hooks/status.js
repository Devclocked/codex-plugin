#!/usr/bin/env node

const runtime = require('./runtime');
const { printStatus } = require('../runtime/status');

printStatus(runtime, 'Codex');
