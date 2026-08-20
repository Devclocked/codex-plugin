#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { runShipper } = require('../runtime/ship');
const {
  MAX_SHIP_ATTEMPTS,
  appendLog,
  buildTrackTickRequest,
  callEdgeFunction,
  classifyActivity,
  deadLetterEnvelope,
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

// True when the newly classified tick's activity type differs from the last
// one shipped for this stream. Used to let transitions through the 30s
// throttle window instead of hard-dropping them. When there's no recorded
// prior type (e.g. state predates this field), we can't detect a transition,
// so same-window ticks keep throttling as before.
function isActivityTypeTransition(priorState, newActivityType) {
  return Boolean(priorState?.last_activity_type) && priorState.last_activity_type !== newActivityType;
}

// A session-end marker older than the backend's idle authority (20 min) carries
// no time signal: the backend already closed the session by idle timeout, so
// shipping it late can only anchor a phantom session at its stale captured_at
// (DEV-938: an envelope orphaned in the queue for 7h back-dated a new session).
const STALE_SESSION_END_MS = 20 * 60_000;
// Anything older than this shipped late for some reason worth seeing in the log.
const DELAYED_ENVELOPE_MS = 2 * 60_000;

function envelopeAgeMs(envelope, nowMs = Date.now()) {
  const capturedAt = Date.parse(envelope?.captured_at);
  if (Number.isNaN(capturedAt)) return 0;
  return Math.max(0, nowMs - capturedAt);
}

// Lifecycle markers older than the backend's idle authority (20 min) carry no
// time signal. An end marker is redundant: the backend already closed the
// session by idle timeout, so shipping it late can only anchor a phantom
// session at its stale captured_at (DEV-938). A START marker is worse — the
// dead-letter replay (DEV-936) can hand back a sessionStart from before an
// outage, and initializing stream state for it would anchor a session at
// reconnect time whose matching end marker is itself discarded as stale,
// leaving a session that never closes.
const STALE_LIFECYCLE_REASONS = {
  Stop: 'stale_session_end',
  SessionStart: 'stale_session_start',
};

function staleLifecycleReason(hookEvent, ageMs) {
  if (ageMs <= STALE_SESSION_END_MS) return null;
  return STALE_LIFECYCLE_REASONS[hookEvent] || null;
}

function isStaleSessionEnd(hookEvent, ageMs) {
  return staleLifecycleReason(hookEvent, ageMs) === 'stale_session_end';
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

  const ageMs = envelopeAgeMs(envelope);
  const staleReason = staleLifecycleReason(hookEvent, ageMs);
  if (staleReason === 'stale_session_end') {
    // Backend already closed this session by idle timeout — see STALE_SESSION_END_MS.
    removeStreamState(stream.rootStreamId);
    discardEnvelope(filePath, envelope, staleReason);
    return;
  }
  if (staleReason) {
    // stale_session_start: discard WITHOUT creating stream state, which is
    // why initializeLifecycleState now runs below this check and not above it.
    discardEnvelope(filePath, envelope, staleReason);
    return;
  }

  initializeLifecycleState(hookEvent, stream);
  if (ageMs > DELAYED_ENVELOPE_MS) {
    appendLog('shipper', 'Shipping delayed hook event', {
      file: path.basename(filePath),
      hook_event_name: hookEvent,
      age_ms: ageMs,
    });
  }

  const throttleStateId = stream.throttleId || stream.streamId;
  if (!isLifecycleEvent(hookEvent) && shouldThrottle(throttleStateId)) {
    const priorState = getStreamState(throttleStateId);
    const newActivity = classifyActivity(hookEvent, input, stream);
    if (!isActivityTypeTransition(priorState, newActivity.activity_type)) {
      discardEnvelope(filePath, envelope, 'throttled');
      return;
    }
  }

  const gitContext = resolveGitContext(input);
  const repo = resolveRepo(input, stream, gitContext);
  const payload = buildTrackTickRequest(hookEvent, input, stream, repo, gitContext, envelope);

  try {
    const response = await callEdgeFunction(apiKey, 'track-tick', payload);
    if (!runtime.isTrackTickProcessed(response)) {
      discardEnvelope(filePath, envelope, 'track_tick_unprocessed');
      appendLog('shipper', 'Dropping hook event because track-tick processed no activity', {
        file: path.basename(filePath),
        hook_event_name: hookEvent,
      });
      // A 2xx that processed nothing still proves the backend is up, which is
      // all the dead-letter replay needs to unlock (DEV-936).
      return { shipped: false, reachable: true };
    }

    if (!isLifecycleEvent(hookEvent)) {
      const state = getStreamState(throttleStateId) || {};
      state.last_tick_at = Date.now();
      state.last_activity_type =
        payload.ticks[0]?.activity_context?.ai_tool?.activity_type || state.last_activity_type;
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
    return { shipped: true, reachable: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown_error';
    if ((envelope.attempts || 0) + 1 >= MAX_SHIP_ATTEMPTS) {
      // Retries exhausted. This used to unlink the envelope, so ~75s of backend
      // downtime destroyed the activity for good. Park it in the bounded
      // dead-letter store instead and let the next reachable run replay it —
      // ingest is idempotent, so a late replay cannot double-count (DEV-936).
      envelope.attempts = (envelope.attempts || 0) + 1;
      envelope.last_error = message;
      envelope.last_attempt_at = new Date().toISOString();
      deadLetterEnvelope(filePath, envelope, `max_attempts:${message}`);
      return { shipped: false, reachable: false, failed: true };
    }
    markEnvelopeRetry(filePath, envelope, message);
    appendLog('shipper', 'Queued hook event failed to send', {
      file: path.basename(filePath),
      hook_event_name: hookEvent,
      attempts: (envelope.attempts || 0) + 1,
      error: message,
    });
    // failed: the send itself did not land, so a dead-letter replay drain stops
    // here instead of paying a timeout for every remaining parked envelope.
    return { shipped: false, reachable: false, failed: true };
  }
}

if (require.main === module) {
  runShipper(runtime, processEnvelope);
}

module.exports = {
  DELAYED_ENVELOPE_MS,
  STALE_SESSION_END_MS,
  envelopeAgeMs,
  isActivityTypeTransition,
  isLifecycleEvent,
  isStaleSessionEnd,
  processEnvelope,
  staleLifecycleReason,
};
