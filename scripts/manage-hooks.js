#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const os = require('os');

// os.homedir() rather than process.env.HOME: Windows sets USERPROFILE only, and
// the old '~' fallback resolved to a literal "~" directory beside the CWD, so
// hooks were installed somewhere Codex never reads (DEV-1001).
function resolveHomeDir() {
  try {
    const home = os.homedir();
    return typeof home === 'string' ? home : '';
  } catch {
    return '';
  }
}

const CODEX_HOME = path.join(resolveHomeDir() || '~', '.codex');
const CONFIG_PATH = path.join(CODEX_HOME, 'config.toml');
const HOOKS_PATH = path.join(CODEX_HOME, 'hooks.json');
const MANAGED_PREFIX = 'DEVCLOCKED_CODEX_PLUGIN=1';

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function readText(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function ensureCodexHooksFeature(configText) {
  const source = typeof configText === 'string' ? configText : '';
  const lines = source.length ? source.replace(/\n+$/, '').split('\n') : [];
  const out = [];
  let inFeatures = false;
  let foundFeatures = false;
  let inserted = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      if (inFeatures && !inserted) {
        out.push('hooks = true');
        inserted = true;
      }
      inFeatures = trimmed === '[features]';
      if (inFeatures) foundFeatures = true;
    }

    if (inFeatures && /^codex_hooks\s*=/.test(trimmed)) {
      // `codex_hooks` was the experimental name. Current Codex emits a
      // deprecation warning and reads `hooks` instead.
      continue;
    }

    if (inFeatures && /^hooks\s*=/.test(trimmed)) {
      if (!inserted) {
        const indent = line.match(/^\s*/)?.[0] || '';
        out.push(`${indent}hooks = true`);
        inserted = true;
      }
      continue;
    }
    out.push(line);
  }

  if (inFeatures && !inserted) {
    out.push('hooks = true');
    inserted = true;
  }

  if (!inserted && !foundFeatures) {
    if (out.length && out[out.length - 1] !== '') {
      out.push('');
    }
    out.push('[features]');
    out.push('hooks = true');
  }

  const text = `${out.join('\n').replace(/\n+$/, '')}\n`;
  return {
    changed: text !== source,
    text,
  };
}

function buildManagedHooks(pluginRoot) {
  const trackPath = path.join(pluginRoot, 'hooks', 'track.js');
  const baseCommand = `/usr/bin/env ${MANAGED_PREFIX} node ${shellQuote(trackPath)}`;

  return {
    hooks: {
      SessionStart: [
        {
          hooks: [
            {
              type: 'command',
              command: `${baseCommand} SessionStart`,
            },
          ],
        },
      ],
      UserPromptSubmit: [
        {
          hooks: [
            {
              type: 'command',
              command: `${baseCommand} UserPromptSubmit`,
            },
          ],
        },
      ],
      PostToolUse: [
        {
          matcher: 'Bash',
          hooks: [
            {
              type: 'command',
              command: `${baseCommand} PostToolUse`,
            },
          ],
        },
      ],
      Stop: [
        {
          hooks: [
            {
              type: 'command',
              command: `${baseCommand} Stop`,
            },
          ],
        },
      ],
    },
  };
}

function isManagedHook(hook) {
  if (!hook || typeof hook !== 'object') return false;
  const command = typeof hook.command === 'string' ? hook.command : '';
  const statusMessage = typeof hook.statusMessage === 'string' ? hook.statusMessage : '';
  return command.includes(MANAGED_PREFIX) || statusMessage.includes('DevClocked');
}

function stripManagedHooks(config) {
  const source = config && typeof config === 'object' ? config : {};
  const hooks = source.hooks && typeof source.hooks === 'object' ? source.hooks : {};
  const nextHooks = {};

  for (const [eventName, entries] of Object.entries(hooks)) {
    const cleanedEntries = Array.isArray(entries)
      ? entries
          .map((entry) => {
            if (!entry || typeof entry !== 'object') return null;
            const entryHooks = Array.isArray(entry.hooks) ? entry.hooks.filter((hook) => !isManagedHook(hook)) : [];
            if (entryHooks.length === 0) return null;
            return { ...entry, hooks: entryHooks };
          })
          .filter(Boolean)
      : [];

    if (cleanedEntries.length > 0) {
      nextHooks[eventName] = cleanedEntries;
    }
  }

  return { hooks: nextHooks };
}

function mergeManagedHooks(existing, managed) {
  const cleaned = stripManagedHooks(existing);
  const merged = { hooks: { ...cleaned.hooks } };

  for (const [eventName, entries] of Object.entries(managed.hooks || {})) {
    const preserved = Array.isArray(merged.hooks[eventName]) ? merged.hooks[eventName] : [];
    merged.hooks[eventName] = [...preserved, ...entries];
  }

  return merged;
}

function countManagedHooks(config) {
  const hooks = config && typeof config === 'object' ? config.hooks : null;
  if (!hooks || typeof hooks !== 'object') return 0;

  let count = 0;
  for (const entries of Object.values(hooks)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object' || !Array.isArray(entry.hooks)) continue;
      for (const hook of entry.hooks) {
        if (isManagedHook(hook)) count += 1;
      }
    }
  }
  return count;
}

function install(pluginRoot) {
  const configText = readText(CONFIG_PATH) || '';
  const feature = ensureCodexHooksFeature(configText);
  fs.mkdirSync(CODEX_HOME, { recursive: true });
  if (feature.changed || !readText(CONFIG_PATH)) {
    fs.writeFileSync(CONFIG_PATH, feature.text);
  }

  const existingHooks = readJson(HOOKS_PATH, { hooks: {} });
  const managedHooks = buildManagedHooks(pluginRoot);
  const merged = mergeManagedHooks(existingHooks, managedHooks);
  writeJson(HOOKS_PATH, merged);

  return {
    configChanged: feature.changed,
    installedHooks: countManagedHooks(merged),
    pluginRoot,
  };
}

function uninstall() {
  const existingHooks = readJson(HOOKS_PATH, { hooks: {} });
  const stripped = stripManagedHooks(existingHooks);
  const remaining = Object.keys(stripped.hooks || {}).length;

  if (remaining === 0) {
    try {
      fs.unlinkSync(HOOKS_PATH);
    } catch {
      // ignore missing file
    }
  } else {
    writeJson(HOOKS_PATH, stripped);
  }

  return {
    removedHooks: countManagedHooks(existingHooks) - countManagedHooks(stripped),
    remainingHooks: remaining,
  };
}

function doctor(pluginRoot) {
  const configText = readText(CONFIG_PATH) || '';
  const hooksConfig = readJson(HOOKS_PATH, { hooks: {} });
  const managedHooks = countManagedHooks(hooksConfig);
  const trackPath = path.join(pluginRoot, 'hooks', 'track.js');

  return {
    pluginRoot,
    configPath: CONFIG_PATH,
    hooksPath: HOOKS_PATH,
    codexHooksEnabled: /\bhooks\s*=\s*true\b/.test(configText),
    hooksFilePresent: fs.existsSync(HOOKS_PATH),
    managedHooksInstalled: managedHooks,
    trackScriptPresent: fs.existsSync(trackPath),
  };
}

function printDoctorStatus(status) {
  const lines = [
    'DevClocked Codex Hook Install Status',
    `plugin root: ${status.pluginRoot}`,
    `feature flag: ${status.codexHooksEnabled ? 'enabled' : 'missing'} (${status.configPath})`,
    `hooks file: ${status.hooksFilePresent ? 'present' : 'missing'} (${status.hooksPath})`,
    `managed hooks: ${status.managedHooksInstalled}`,
    `track script: ${status.trackScriptPresent ? 'present' : 'missing'}`,
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
}

function main() {
  const pluginRoot = path.resolve(__dirname, '..');
  const command = process.argv[2] || 'doctor';

  if (command === 'install') {
    const result = install(pluginRoot);
    process.stdout.write(
      `Installed DevClocked Codex hooks (${result.installedHooks})${result.configChanged ? ' and enabled hooks' : ''}.\n`
    );
    return;
  }

  if (command === 'uninstall') {
    const result = uninstall();
    process.stdout.write(`Removed ${result.removedHooks} DevClocked Codex hooks.\n`);
    return;
  }

  if (command === 'doctor') {
    const status = doctor(pluginRoot);
    if (process.argv.includes('--json')) {
      process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
      return;
    }
    printDoctorStatus(status);
    return;
  }

  process.stderr.write(`Unknown command: ${command}\n`);
  process.exit(1);
}

if (require.main === module) {
  main();
}

module.exports = {
  MANAGED_PREFIX,
  buildManagedHooks,
  countManagedHooks,
  doctor,
  ensureCodexHooksFeature,
  isManagedHook,
  mergeManagedHooks,
  shellQuote,
  stripManagedHooks,
};
