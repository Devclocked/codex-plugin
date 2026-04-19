async function readStdin() {
  let raw = '';
  for await (const chunk of process.stdin) {
    raw += chunk;
  }
  return raw;
}

async function runTrack(runtime, transformInput) {
  try {
    const raw = await readStdin();
    const parsed = raw.trim() ? JSON.parse(raw) : {};
    const input = transformInput ? transformInput(parsed) : parsed;
    if (!input?.hook_event_name) {
      process.stdout.write('{}');
      process.exit(0);
    }

    runtime.enqueueHookEvent(input);
    runtime.wakeShipper();
  } catch (error) {
    runtime.appendLog('hook', 'Failed to capture hook event', {
      error: error instanceof Error ? error.message : 'unknown_error',
    });
  }

  process.stdout.write('{}');
  process.exit(0);
}

module.exports = {
  runTrack,
};
