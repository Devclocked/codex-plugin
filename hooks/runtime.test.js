const test = require('node:test');
const assert = require('node:assert/strict');

const { buildTrackTickRequest, resolveStream } = require('./runtime');

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
