#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { runShipper } = require('../runtime/ship');
const {
  MAX_SHIP_ATTEMPTS,
  appendLog,
  buildTrackTickRequest,
  callEdgeFunction,
  discardEnvelope,
  getStreamState,
  markEnvelopeRetry,
  readJsonFile,
  removeStreamState,
  resolveGitContext,
  resolveRepo,
  resolveStream,
  saveStreamState,
  shouldRetryEnvelope,
  shouldThrottle,
} = require('./runtime');
const runtime = require('./runtime');

function isLifecycleEvent(hookEvent) {
  return ['SessionStart', 'Stop'].includes(hookEvent);
}

function initializeLifecycleState(hookEvent, stream) {
  if (hookEvent === 'SessionStart') {
    saveStreamState(stream.rootStreamId, {
      started_at: Date.now(),
      last_tick_at: null,
      is_subagent: false,
      parent_stream_id: null,
      root_stream_id: stream.rootStreamId,
      is_parallel: false,
      subagent_type: null,
      git_branch: stream.gitBranch,
      task: null,
    });
  }
}

async function processEnvelope(filePath, apiKey) {
  const envelope = readJsonFile(filePath);
  if (!shouldRetryEnvelope(envelope)) return;

  const input = envelope.input || {};
  const hookEvent = input.hook_event_name;
  if (!hookEvent) {
    discardEnvelope(filePath, envelope, 'missing_hook_event_name');
    return;
  }

  const stream = resolveStream(hookEvent, input);
  initializeLifecycleState(hookEvent, stream);

  if (!isLifecycleEvent(hookEvent) && shouldThrottle(stream.throttleId || stream.streamId)) {
    discardEnvelope(filePath, envelope, 'throttled');
    return;
  }

  const gitContext = resolveGitContext(input);
  const repo = resolveRepo(input, stream, gitContext);
  const payload = buildTrackTickRequest(hookEvent, input, stream, repo, gitContext);

  try {
    await callEdgeFunction(apiKey, 'track-tick', payload);

    if (!isLifecycleEvent(hookEvent)) {
      const throttleStateId = stream.throttleId || stream.streamId;
      const state = getStreamState(throttleStateId) || {};
      state.last_tick_at = Date.now();
      saveStreamState(throttleStateId, state);
    }

    runtime.recordPluginActivity({
      workspaceFingerprint: gitContext.workspaceFingerprint,
      rootStreamId: stream.rootStreamId,
      streamId: stream.streamId,
      sessionFileId: payload.ticks[0]?.activity_context?.ai_tool?.session_file_id || null,
      observedAt: payload.ticks[0]?.timestamp,
    });

    if (hookEvent === 'Stop') {
      removeStreamState(stream.rootStreamId);
    }

    fs.unlinkSync(filePath);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown_error';
    if ((envelope.attempts || 0) + 1 >= MAX_SHIP_ATTEMPTS) {
      discardEnvelope(filePath, envelope, `max_attempts:${message}`);
      return;
    }
    markEnvelopeRetry(filePath, envelope, message);
    appendLog('shipper', 'Queued hook event failed to send', {
      file: path.basename(filePath),
      hook_event_name: hookEvent,
      attempts: (envelope.attempts || 0) + 1,
      error: message,
    });
  }
}

runShipper(runtime, processEnvelope);
