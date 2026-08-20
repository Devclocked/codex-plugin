#!/usr/bin/env node

const path = require('path');
const { createPluginRuntime } = require('../runtime/core');

const runtime = createPluginRuntime({
  namespace: 'codex-plugin',
  source: 'codex-plugin',
  shipperPath: path.join(__dirname, 'ship.js'),
});

function normalizedToolName(input) {
  return (
    input.tool_name ||
    input.tool?.name ||
    input.payload?.tool_name ||
    input.payload?.name ||
    null
  );
}

function resolveStream(hookEvent, input) {
  const rootStreamId =
    runtime.firstOpaqueId(
      input.thread_id,
      input.session_id,
      input.conversation_id,
      input.parent_conversation_id
    ) || 'unknown';

  const streamId =
    runtime.firstOpaqueId(
      input.turn_id,
      input.prompt_id,
      input.request_id,
      input.call_id,
      input.tool_call_id,
      input.message_id,
      input.id
    ) || rootStreamId;

  return {
    streamId,
    parentStreamId: null,
    rootStreamId,
    throttleId: rootStreamId,
    isSubagent: false,
    isParallel: false,
    subagentType: null,
    gitBranch: input.git_branch || null,
    task: null,
  };
}

// Naming is decided entirely by the identity ladder in resolveGitContext —
// a deferred resolution must ship the tick with NO project name rather than
// fall back to a basename guess (DEV-674). Codex's hook-provided git_branch
// still wins over the git context's branch when present.
function resolveRepo(input, stream, gitContext) {
  if (gitContext.resolution === 'deferred') {
    return { branch: stream.gitBranch || null, repo_name: null };
  }
  return {
    branch: gitContext.branch || stream.gitBranch || null,
    repo_name: gitContext.repoName || null,
  };
}

function streamStateId(stream) {
  return stream.throttleId || stream.rootStreamId || stream.streamId;
}

function classifyActivity(hookEvent, input, stream) {
  const toolName = normalizedToolName(input);

  switch (hookEvent) {
    case 'SessionStart':
      return { activity_type: 'coding', sub_type: 'session_start' };
    case 'Stop': {
      // Don't fabricate a "coding" tick at session close (DEV-530 class bug) —
      // reuse the last real classification shipped for this stream, if any.
      // If the session ended with no prior real activity, omit activity_type
      // rather than guessing.
      const priorState = stream ? runtime.getStreamState(streamStateId(stream)) : null;
      if (priorState && priorState.last_activity_type) {
        return { activity_type: priorState.last_activity_type, sub_type: 'session_end' };
      }
      return { activity_type: undefined, sub_type: 'session_end' };
    }
    case 'UserPromptSubmit':
      return { activity_type: 'planning', sub_type: 'prompt_submit' };
    case 'PostToolUse':
      if (toolName === 'Bash') return { activity_type: 'coding', sub_type: 'bash' };
      return { activity_type: 'coding', sub_type: 'tool_use' };
    default:
      return { activity_type: 'coding', sub_type: hookEvent.toLowerCase() };
  }
}

// Ship-time values used to leak into every tick: `now` and request_key were
// derived from Date.now() when the shipper ran, so re-sending the same queued
// envelope minted a NEW request_key and the backend counted the activity twice.
// The dead-letter replay (DEV-936) makes re-sending routine, so both are now
// pure functions of the envelope — its capture instant and its id, both fixed
// when the hook fired. A tick replayed six days later is also recorded at the
// moment it happened rather than at reconnect time.
// Codex hook input carries its own event timestamp, and it is the most accurate
// clock available — it keeps the precedence it had before DEV-936. It is fixed
// in the envelope at enqueue time, so it is replay-stable either way;
// captured_at is the fallback for hooks that send no timestamp.
function tickInstant(input, envelope) {
  if (typeof input.timestamp === 'string' && Number.isFinite(Date.parse(input.timestamp))) {
    return input.timestamp;
  }
  const capturedAt = Date.parse(envelope?.captured_at);
  if (Number.isFinite(capturedAt)) return new Date(capturedAt).toISOString();
  return new Date().toISOString();
}

function buildTrackTickRequest(hookEvent, input, stream, repo, gitContext, envelope) {
  const now = tickInstant(input, envelope);
  // Stable per queued envelope, so a replay collides with the original on the
  // backend's request_key instead of registering as new activity.
  const requestKeyId = envelope?.id || now;
  const toolName = normalizedToolName(input);

  let entity = `codex://${hookEvent}`;
  let entityType = 'window';
  let isWrite = false;

  if (hookEvent === 'PostToolUse' && toolName === 'Bash') {
    entity = 'codex://tool/Bash';
  } else if (hookEvent === 'SessionStart' || hookEvent === 'Stop') {
    entity = `codex://session/${stream.rootStreamId}`;
  } else if (hookEvent === 'UserPromptSubmit') {
    entity = `codex://thread/${stream.rootStreamId}`;
  }

  const activity = classifyActivity(hookEvent, input, stream);
  const workSignature = {
    read_count: 0,
    write_count: isWrite ? 1 : 0,
    exec_count: activity.sub_type === 'bash' ? 1 : 0,
    plan_count: activity.activity_type === 'planning' ? 1 : 0,
    total_turns: 1,
  };
  // Stop has no tool-call duration of its own; when we know when the last
  // real tick for this stream landed, use the actual elapsed time instead of
  // the fixed estimate.
  let runtimeMs = 5_000;
  if (hookEvent === 'Stop') {
    const priorState = runtime.getStreamState(streamStateId(stream));
    const elapsed = priorState && priorState.last_tick_at ? Date.parse(now) - priorState.last_tick_at : null;
    if (Number.isFinite(elapsed) && elapsed > 0) runtimeMs = elapsed;
  }
  const runtimeEndedAt = new Date(new Date(now).getTime() + runtimeMs).toISOString();
  const sessionFileId =
    runtime.firstOpaqueId(input.thread_id, input.session_id, input.conversation_id) || undefined;
  const runId = `codex:${stream.rootStreamId || stream.streamId}`;

  const tick = {
    entity,
    entity_type: entityType,
    timestamp: now,
    is_write: isWrite,
    project_name: repo.repo_name || undefined,
    branch: repo.branch || stream.gitBranch || undefined,
    repo_url: gitContext.repoUrl || undefined,
    repository_full_name: gitContext.repoFullName || undefined,
    repos: gitContext.repoFullName ? { full_name: gitContext.repoFullName } : undefined,
    activity_context: {
      ai_tool: {
        tool: 'codex-cli',
        activity_type: activity.activity_type,
        work_signature: workSignature,
        summary: `Codex ${activity.sub_type}`,
        timestamp: now,
        session_file_id: sessionFileId,
        run_id: runId,
        request_key: `${runId}:${hookEvent}:${stream.streamId}:${requestKeyId}`,
        runtime_ms: runtimeMs,
        runtime_started_at: now,
        runtime_ended_at: runtimeEndedAt,
        measurement_quality: 'estimated',
        is_sidechain: false,
        stream_id: stream.streamId,
        root_stream_id: stream.rootStreamId || stream.streamId,
        stream_role: 'primary',
        ai_tool_version: 1,
      },
    },
  };

  const request = { ticks: [tick] };
  if (gitContext.workspaceFingerprint) {
    request.workspace_fingerprint = gitContext.workspaceFingerprint;
  }
  // Absolute path of the resolved workspace root (git root, or session cwd
  // for non-git projects), sent alongside the one-way fingerprint hash so the
  // backend can do directory-containment checks even when naming is deferred
  // (DEV-551 contract, same field the daemon and cursor-plugin send).
  if (gitContext.workspacePath || gitContext.gitRoot) {
    request.workspace_path = gitContext.workspacePath || gitContext.gitRoot;
  }
  return request;
}

module.exports = {
  ...runtime,
  buildTrackTickRequest,
  classifyActivity,
  normalizedToolName,
  resolveRepo,
  resolveStream,
};
