const path = require('node:path');
const { spawn } = require('node:child_process');
const AGENT_RUN_FILE_ENV = 'DEVCLOCKED_AGENT_RUN_FILE';
const WORKER_SOURCE = String.raw`
const { appendFileSync, mkdirSync } = require('node:fs');
const { homedir } = require('node:os');
const { join } = require('node:path');
const { spawn } = require('node:child_process');
function logFailure() {
  try {
    const dir = join(homedir(), '.config', 'devclocked', process.env.DEVCLOCKED_AGENT_RUN_LOG_NAMESPACE + '-logs');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    appendFileSync(join(dir, 'hook.log'), JSON.stringify({ timestamp: new Date().toISOString(), message: 'Failed to launch agent-run sync' }) + '\n');
  } catch {}
}
const child = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', [
  '-y', '@devclocked/cli@latest', 'agent-runs', 'sync', '--runtime',
  process.env.DEVCLOCKED_AGENT_RUN_RUNTIME, '--file-env',
], { shell: false, stdio: 'ignore', windowsHide: true, env: process.env });
child.on('error', logFailure);
child.on('exit', code => { if (code !== 0) logFailure(); });
`;

function syncArgs() {
  return [
    '-y',
    '@devclocked/cli@latest',
    'agent-runs',
    'sync',
    '--runtime',
    'codex',
    '--file-env',
  ];
}

function spawnAgentRunSync(input, options = {}) {
  if (!input || input.hook_event_name !== 'Stop') return false;
  const transcriptPath = input.transcript_path;
  if (typeof transcriptPath !== 'string' || !path.isAbsolute(transcriptPath)) return false;

  const spawnFn = options.spawnFn || spawn;
  const onError = typeof options.onError === 'function' ? options.onError : () => {};
  try {
    const child = spawnFn(process.execPath, ['-e', WORKER_SOURCE], {
      detached: true,
      env: {
        ...process.env,
        [AGENT_RUN_FILE_ENV]: transcriptPath,
        DEVCLOCKED_AGENT_RUN_LOG_NAMESPACE: 'codex-plugin',
        DEVCLOCKED_AGENT_RUN_RUNTIME: 'codex',
      },
      shell: false,
      stdio: 'ignore',
      windowsHide: true,
    });
    if (typeof child.unref === 'function') child.unref();
    return true;
  } catch (error) {
    onError(error);
    return false;
  }
}

module.exports = { AGENT_RUN_FILE_ENV, WORKER_SOURCE, spawnAgentRunSync, syncArgs };
