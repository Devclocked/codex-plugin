const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Stream/state helpers below touch disk under $HOME/.config/devclocked. Point
// HOME at a throwaway dir before requiring runtime.js so tests never read or
// write the real plugin state.
process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'devclocked-codex-runtime-test-'));

const {
  buildTrackTickRequest,
  classifyActivity,
  isTrackTickProcessed,
  resolveStream,
  saveStreamState,
} = require('./runtime');

test('resolveStream keeps root thread id stable for Codex hooks', () => {
  const stream = resolveStream('PostToolUse', {
    thread_id: 'thread-123',
    turn_id: 'turn-456',
    tool_name: 'Bash',
  });

  assert.equal(stream.rootStreamId, 'thread-123');
  assert.equal(stream.streamId, 'turn-456');
  assert.equal(stream.throttleId, 'thread-123');
});

test('buildTrackTickRequest emits codex-compatible ai_tool metadata', () => {
  const payload = buildTrackTickRequest(
    'UserPromptSubmit',
    {
      thread_id: 'thread-123',
      turn_id: 'turn-456',
      cwd: '/tmp/example',
      timestamp: '2026-04-18T10:00:00.000Z',
    },
    {
      streamId: 'turn-456',
      parentStreamId: null,
      rootStreamId: 'thread-123',
      isSubagent: false,
      gitBranch: null,
    },
    { branch: 'main', repo_name: 'example' },
    { repoUrl: null, repoFullName: null, workspaceFingerprint: null }
  );

  const aiTool = payload.ticks[0].activity_context.ai_tool;
  assert.equal(aiTool.tool, 'codex-cli');
  assert.equal(aiTool.stream_id, 'turn-456');
  assert.equal(aiTool.root_stream_id, 'thread-123');
  assert.equal(aiTool.session_file_id, 'thread-123');
});

test('Stop reuses the last real activity type recorded for the stream', () => {
  const stream = { streamId: 'turn-9', rootStreamId: 'thread-stop-1', throttleId: 'thread-stop-1' };
  saveStreamState('thread-stop-1', { last_tick_at: Date.now() - 60_000, last_activity_type: 'planning' });

  const activity = classifyActivity('Stop', {}, stream);
  assert.equal(activity.activity_type, 'planning');
  assert.equal(activity.sub_type, 'session_end');
});

test('Stop omits activity_type when the stream has no recorded activity', () => {
  const stream = { streamId: 'turn-9', rootStreamId: 'thread-stop-2', throttleId: 'thread-stop-2' };

  const activity = classifyActivity('Stop', {}, stream);
  assert.equal(activity.activity_type, undefined);
  assert.equal(activity.sub_type, 'session_end');
});

test('Stop runtime_ms reflects elapsed time since the last tick when known', () => {
  const stream = { streamId: 'turn-9', rootStreamId: 'thread-stop-3', throttleId: 'thread-stop-3' };
  saveStreamState('thread-stop-3', { last_tick_at: Date.now() - 42_000, last_activity_type: 'coding' });

  const payload = buildTrackTickRequest(
    'Stop',
    { thread_id: 'thread-stop-3', timestamp: new Date().toISOString() },
    stream,
    { branch: null, repo_name: 'example' },
    { repoUrl: null, repoFullName: null, workspaceFingerprint: null }
  );

  const aiTool = payload.ticks[0].activity_context.ai_tool;
  assert.ok(aiTool.runtime_ms >= 42_000, `expected elapsed runtime, got ${aiTool.runtime_ms}`);
});

test('Stop runtime_ms falls back to the fixed estimate with no prior tick', () => {
  const stream = { streamId: 'turn-9', rootStreamId: 'thread-stop-4', throttleId: 'thread-stop-4' };

  const payload = buildTrackTickRequest(
    'Stop',
    { thread_id: 'thread-stop-4', timestamp: new Date().toISOString() },
    stream,
    { branch: null, repo_name: 'example' },
    { repoUrl: null, repoFullName: null, workspaceFingerprint: null }
  );

  assert.equal(payload.ticks[0].activity_context.ai_tool.runtime_ms, 5_000);
});

test('isTrackTickProcessed rejects accepted but unprocessed responses', () => {
  assert.equal(isTrackTickProcessed({
    status: 200,
    body: JSON.stringify({ processed_count: 0, session_updated: false }),
  }), false);
  assert.equal(isTrackTickProcessed({
    status: 200,
    body: JSON.stringify({ processed_count: 1, session_updated: false }),
  }), true);
  assert.equal(isTrackTickProcessed({
    status: 200,
    body: JSON.stringify({ processed_count: 0, session_updated: true }),
  }), true);
});
