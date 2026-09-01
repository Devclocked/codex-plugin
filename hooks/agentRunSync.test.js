const test = require('node:test');
const assert = require('node:assert/strict');
const { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { AGENT_RUN_FILE_ENV, WORKER_SOURCE, spawnAgentRunSync } = require('./agentRunSync');

function spawnRecorder() {
  const calls = [];
  return {
    calls,
    spawn(command, args, options) {
      const child = {
        unref() {},
      };
      calls.push({ command, args, options });
      return child;
    },
  };
}

test('Codex Stop launches one detached targeted sync', () => {
  const recorder = spawnRecorder();
  const transcriptPath = '/tmp/codex transcript.jsonl';
  assert.equal(spawnAgentRunSync(
    { hook_event_name: 'Stop', transcript_path: transcriptPath },
    { spawnFn: recorder.spawn },
  ), true);
  const [call] = recorder.calls;
  assert.equal(call.command, process.execPath);
  assert.deepEqual(call.args, ['-e', WORKER_SOURCE]);
  assert.equal(JSON.stringify(call.args).includes(transcriptPath), false);
  assert.equal(call.options.detached, true);
  assert.equal(call.options.shell, false);
  assert.equal(call.options.stdio, 'ignore');
  assert.equal(call.options.windowsHide, true);
  assert.equal(call.options.env[AGENT_RUN_FILE_ENV], transcriptPath);
  assert.equal(call.options.env.DEVCLOCKED_AGENT_RUN_RUNTIME, 'codex');
  assert.equal(call.options.env.DEVCLOCKED_AGENT_RUN_LOG_NAMESPACE, 'codex-plugin');
});

test('Codex helper skips other events and missing or relative paths', () => {
  const recorder = spawnRecorder();
  for (const input of [
    { hook_event_name: 'PostToolUse', transcript_path: '/tmp/transcript.jsonl' },
    { hook_event_name: 'Stop' },
    { hook_event_name: 'Stop', transcript_path: 'relative/transcript.jsonl' },
  ]) {
    assert.equal(spawnAgentRunSync(input, { spawnFn: recorder.spawn }), false);
  }
  assert.deepEqual(recorder.calls, []);
});

test('Codex helper keeps injection-shaped paths out of argv and disables the shell', () => {
  const recorder = spawnRecorder();
  const transcriptPath = '/tmp/transcript; touch planted-file.jsonl';
  assert.equal(spawnAgentRunSync(
    { hook_event_name: 'Stop', transcript_path: transcriptPath },
    { spawnFn: recorder.spawn },
  ), true);
  assert.equal(recorder.calls[0].options.shell, false);
  assert.equal(recorder.calls[0].args.includes(transcriptPath), false);
  assert.equal(recorder.calls[0].options.env[AGENT_RUN_FILE_ENV], transcriptPath);
});

test('Codex detached worker logs a nonzero npx exit generically', { skip: process.platform === 'win32' }, () => {
  const home = mkdtempSync(path.join(tmpdir(), 'devclocked-codex-worker-'));
  const bin = path.join(home, 'bin');
  mkdirSync(bin);
  const npx = path.join(bin, 'npx');
  writeFileSync(npx, '#!/bin/sh\nexit 1\n');
  chmodSync(npx, 0o700);
  const transcriptPath = '/tmp/private-transcript.jsonl';
  const result = spawnSync(process.execPath, ['-e', WORKER_SOURCE], {
    env: {
      ...process.env,
      HOME: home,
      PATH: `${bin}:${process.env.PATH || ''}`,
      [AGENT_RUN_FILE_ENV]: transcriptPath,
      DEVCLOCKED_AGENT_RUN_RUNTIME: 'codex',
      DEVCLOCKED_AGENT_RUN_LOG_NAMESPACE: 'codex-plugin',
    },
  });
  assert.equal(result.status, 0, result.stderr.toString());
  const log = readFileSync(path.join(home, '.config', 'devclocked', 'codex-plugin-logs', 'hook.log'), 'utf8');
  assert.match(log, /Failed to launch agent-run sync/);
  assert.equal(log.includes(transcriptPath), false);
});

test('Codex helper reports launch failure without passing the transcript path', () => {
  const failures = [];
  const result = spawnAgentRunSync(
    { hook_event_name: 'Stop', transcript_path: '/tmp/private-transcript.jsonl' },
    {
      spawnFn() { throw new Error('npx unavailable'); },
      onError(error) { failures.push(error.message); },
    },
  );
  assert.equal(result, false);
  assert.deepEqual(failures, ['npx unavailable']);
});
