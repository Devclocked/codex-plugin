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

function resolveRepo(input, stream, gitContext) {
  if (gitContext.repoName || gitContext.branch) {
    return {
      branch: gitContext.branch || null,
      repo_name: gitContext.repoName || null,
    };
  }

  if (stream.gitBranch && input.cwd) {
    return {
      branch: stream.gitBranch,
      repo_name: path.basename(input.cwd),
    };
  }

  if (input.cwd) {
    return {
      branch: null,
      repo_name: path.basename(input.cwd),
    };
  }

  if (Array.isArray(input.workspace_roots) && input.workspace_roots.length > 0) {
    return {
      branch: null,
      repo_name: path.basename(input.workspace_roots[0]),
    };
  }

  return { branch: null, repo_name: 'unknown' };
}

function classifyActivity(hookEvent, input) {
  const toolName = normalizedToolName(input);

  switch (hookEvent) {
    case 'SessionStart':
      return { activity_type: 'coding', sub_type: 'session_start' };
    case 'Stop':
      return { activity_type: 'coding', sub_type: 'session_end' };
    case 'UserPromptSubmit':
      return { activity_type: 'planning', sub_type: 'prompt_submit' };
    case 'PostToolUse':
      if (toolName === 'Bash') return { activity_type: 'coding', sub_type: 'bash' };
      return { activity_type: 'coding', sub_type: 'tool_use' };
    default:
      return { activity_type: 'coding', sub_type: hookEvent.toLowerCase() };
  }
}

function buildTrackTickRequest(hookEvent, input, stream, repo, gitContext) {
  const now = typeof input.timestamp === 'string' ? input.timestamp : new Date().toISOString();
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

  const activity = classifyActivity(hookEvent, input);
  const workSignature = {
    read_count: 0,
    write_count: isWrite ? 1 : 0,
    exec_count: activity.sub_type === 'bash' ? 1 : 0,
    plan_count: activity.activity_type === 'planning' ? 1 : 0,
    total_turns: 1,
  };
  const runtimeMs = 5_000;
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
        request_key: `${runId}:${hookEvent}:${stream.streamId}:${now}`,
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
