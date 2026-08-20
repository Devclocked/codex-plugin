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

// DEV-674: deferred git resolution must ship with NO project name, and
// workspace_path follows the resolved workspace root (git root or session cwd).
const runtimeExports = require('./runtime');

const dev674Stream = {
  streamId: 's-674',
  parentStreamId: null,
  rootStreamId: 's-674',
  throttleId: 's-674',
  isSubagent: false,
  isParallel: false,
  subagentType: null,
  gitBranch: null,
  task: null,
};

test('resolveRepo mirrors the git context and never basename-guesses on deferral (DEV-674)', () => {
  const named = runtimeExports.resolveRepo(
    { cwd: '/users/dev/projects/example/sub' },
    dev674Stream,
    { resolution: 'git', repoName: 'example', branch: 'main' }
  );
  assert.deepEqual(named, { branch: 'main', repo_name: 'example' });

  const deferred = runtimeExports.resolveRepo(
    { cwd: '/users/dev/projects/example/sub' },
    dev674Stream,
    { resolution: 'deferred', repoName: null, branch: null }
  );
  assert.deepEqual(deferred, { branch: null, repo_name: null });
});

test('buildTrackTickRequest ships workspace_path from a cwd-resolved workspace with no git root (DEV-674)', () => {
  const payload = buildTrackTickRequest(
    'UserPromptSubmit',
    { thread_id: 't-674' },
    dev674Stream,
    { branch: null, repo_name: 'my-notes' },
    {
      repoUrl: null,
      repoFullName: null,
      workspaceFingerprint: 'fp-674',
      gitRoot: null,
      workspacePath: '/users/dev/plain/my-notes',
      resolution: 'cwd',
    }
  );
  assert.equal(payload.workspace_path, '/users/dev/plain/my-notes');
  assert.equal(payload.workspace_fingerprint, 'fp-674');
});

test('deferred resolution ships no workspace_path, no fingerprint, no project name (DEV-674)', () => {
  const payload = buildTrackTickRequest(
    'UserPromptSubmit',
    { thread_id: 't-675' },
    dev674Stream,
    { branch: null, repo_name: null },
    {
      repoUrl: null,
      repoFullName: null,
      workspaceFingerprint: null,
      gitRoot: null,
      workspacePath: null,
      resolution: 'deferred',
      resolutionFailure: 'git_unavailable',
    }
  );
  assert.equal(payload.workspace_path, undefined);
  assert.equal(payload.workspace_fingerprint, undefined);
  assert.equal(payload.ticks[0].project_name, undefined);
});

// --- DEV-936 F1: the payload must be a pure function of the queued envelope ---
// Envelopes queue RAW hook input, so the payload is assembled at SHIP time. When
// request_key and timestamp came from Date.now() at that moment, re-sending the
// same envelope minted a fresh request_key and the backend counted the activity
// twice — the dead-letter replay had no idempotency to rely on.

const IDEMPOTENCY_ENVELOPE = {
  id: '0f8c4a1e-1111-4222-8333-444455556666',
  captured_at: '2026-08-14T07:00:00.000Z',
};

function buildTwice(hookEvent, input, stream, envelope) {
  const repo = { repo_name: 'widget', branch: 'main' };
  const gitContext = { repoUrl: null, repoFullName: null, workspaceFingerprint: null, workspacePath: null, gitRoot: null };
  const first = buildTrackTickRequest(hookEvent, input, stream, repo, gitContext, envelope);
  const second = buildTrackTickRequest(hookEvent, input, stream, repo, gitContext, envelope);
  return [first.ticks[0].activity_context.ai_tool, second.ticks[0].activity_context.ai_tool];
}

test('the same envelope built twice yields an identical request_key and timestamp (DEV-936)', () => {
  const input = { thread_id: 'thread-936-idem', turn_id: 'turn-1', tool_name: 'Bash' };
  const stream = { streamId: 'turn-1', parentStreamId: null, rootStreamId: 'thread-936-idem', isSubagent: false };

  const [first] = buildTwice('PostToolUse', input, stream, IDEMPOTENCY_ENVELOPE);
  // Rebuild after wall-clock time has moved on, which is exactly what a replay
  // hours or days later does.
  const before = Date.now;
  Date.now = () => before() + 90_000;
  let second;
  try {
    [, second] = buildTwice('PostToolUse', input, stream, IDEMPOTENCY_ENVELOPE);
  } finally {
    Date.now = before;
  }

  assert.equal(first.request_key, second.request_key, 'request_key must not move with ship time');
  assert.equal(first.timestamp, second.timestamp, 'timestamp must not move with ship time');
  assert.equal(first.runtime_started_at, second.runtime_started_at);
  assert.equal(first.runtime_ended_at, second.runtime_ended_at);
});

test('the tick is stamped at capture time, not at reconnect time (DEV-936)', () => {
  const input = { thread_id: 'thread-936-idem', turn_id: 'turn-1', tool_name: 'Bash' };
  const stream = { streamId: 'turn-1', parentStreamId: null, rootStreamId: 'thread-936-idem', isSubagent: false };

  const [aiTool] = buildTwice('PostToolUse', input, stream, IDEMPOTENCY_ENVELOPE);

  // A six-day-old replayed tick must be recorded when it happened.
  assert.equal(aiTool.timestamp, IDEMPOTENCY_ENVELOPE.captured_at);
  assert.equal(aiTool.runtime_started_at, IDEMPOTENCY_ENVELOPE.captured_at);
  assert.ok(
    aiTool.request_key.includes(IDEMPOTENCY_ENVELOPE.id),
    `request_key must be keyed on the envelope id, got ${aiTool.request_key}`
  );
});

test('two distinct envelopes for the same stream still get distinct request_keys (DEV-936)', () => {
  const input = { thread_id: 'thread-936-idem', turn_id: 'turn-1', tool_name: 'Bash' };
  const stream = { streamId: 'turn-1', parentStreamId: null, rootStreamId: 'thread-936-idem', isSubagent: false };

  const [a] = buildTwice('PostToolUse', input, stream, IDEMPOTENCY_ENVELOPE);
  const [b] = buildTwice('PostToolUse', input, stream, {
    id: '99999999-1111-4222-8333-444455556666',
    captured_at: IDEMPOTENCY_ENVELOPE.captured_at,
  });

  assert.notEqual(a.request_key, b.request_key);
});

test('an envelope-less build still works and falls back to ship time (DEV-936)', () => {
  const input = { thread_id: 'thread-936-idem', turn_id: 'turn-1', tool_name: 'Bash' };
  const stream = { streamId: 'turn-1', parentStreamId: null, rootStreamId: 'thread-936-idem', isSubagent: false };

  const [aiTool] = buildTwice('PostToolUse', input, stream, undefined);

  assert.ok(aiTool.request_key, 'the legacy 5-arg call must not throw');
  assert.ok(Number.isFinite(Date.parse(aiTool.timestamp)));
});

test('the Codex hook event timestamp keeps precedence over captured_at and stays replay-stable (DEV-936)', () => {
  const input = {
    thread_id: 'thread-936-r3',
    turn_id: 'turn-1',
    tool_name: 'Bash',
    timestamp: '2026-04-18T10:00:00.000Z',
  };
  const stream = { streamId: 'turn-1', parentStreamId: null, rootStreamId: 'thread-936-r3', isSubagent: false };

  const [first] = buildTwice('PostToolUse', input, stream, IDEMPOTENCY_ENVELOPE);
  const before = Date.now;
  Date.now = () => before() + 90_000;
  let second;
  try {
    [, second] = buildTwice('PostToolUse', input, stream, IDEMPOTENCY_ENVELOPE);
  } finally {
    Date.now = before;
  }

  // The hook's own event time is the most accurate clock we get, and it is
  // frozen in the envelope, so precedence costs nothing in replay stability.
  assert.equal(first.timestamp, '2026-04-18T10:00:00.000Z');
  assert.notEqual(first.timestamp, IDEMPOTENCY_ENVELOPE.captured_at);
  assert.equal(first.timestamp, second.timestamp);
  assert.equal(first.request_key, second.request_key);
});
