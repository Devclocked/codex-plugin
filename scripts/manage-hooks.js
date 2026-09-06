#!/usr/bin/env node

const crypto = require('crypto');
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
const PLUGIN_CACHE_DIR = path.join(CODEX_HOME, 'plugins', 'cache');
const DUPLICATE_PLUGIN_NAME = 'devclocked-codex';

// Codex keys hook trust as `<hooks file>:<event>:<group>:<handler>` and only
// the four events below are installed here, so the label map stays narrow.
const HOOK_EVENT_KEY_LABELS = {
  SessionStart: 'session_start',
  UserPromptSubmit: 'user_prompt_submit',
  PostToolUse: 'post_tool_use',
  Stop: 'stop',
};

// Codex drops the matcher for events that cannot carry one before hashing.
const MATCHER_EVENTS = new Set(['PostToolUse']);

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

function groupMatcher(group) {
  const matcher = group && typeof group === 'object' ? group.matcher : undefined;
  return typeof matcher === 'string' ? matcher : null;
}

// Codex trusts a handler under `<file>:<event>:<group>:<handler>`, so every
// index in this file is load-bearing (DEV-1240). Appending a fresh group pushes
// our handler to an index that has no trust entry and every hook then fails
// silently. Merge into the first group that already carries the same matcher
// instead, replacing a handler that is already there in place, and never
// delete a group that other groups follow: an emptied group stays as
// `hooks: []` so the foreign handlers behind it keep their trust keys.
function placeManagedHandlers(existingGroups, managedGroup) {
  const groups = (Array.isArray(existingGroups) ? existingGroups : [])
    .filter((group) => group && typeof group === 'object')
    .map((group) => ({ ...group, hooks: Array.isArray(group.hooks) ? [...group.hooks] : [] }));

  const target = managedGroup
    ? groups.findIndex((group) => groupMatcher(group) === groupMatcher(managedGroup))
    : -1;
  let replaced = false;
  const emptied = new Set();

  groups.forEach((group, groupIndex) => {
    group.hooks = group.hooks.flatMap((hook) => {
      if (!isManagedHook(hook)) return [hook];
      if (groupIndex === target && !replaced) {
        replaced = true;
        return [managedGroup.hooks[0]];
      }
      return [];
    });
    if (group.hooks.length === 0) emptied.add(groupIndex);
  });

  if (managedGroup && !replaced) {
    if (target === -1) {
      groups.push(managedGroup);
    } else {
      groups[target].hooks.push(...managedGroup.hooks);
      emptied.delete(target);
    }
  }

  while (groups.length > 0 && emptied.has(groups.length - 1)) {
    groups.pop();
  }

  return groups;
}

function hooksTable(config) {
  const hooks = config && typeof config === 'object' ? config.hooks : null;
  return hooks && typeof hooks === 'object' ? hooks : {};
}

function stripManagedHooks(config) {
  const nextHooks = {};
  for (const [eventName, entries] of Object.entries(hooksTable(config))) {
    const cleaned = placeManagedHandlers(entries, null);
    if (cleaned.length > 0) nextHooks[eventName] = cleaned;
  }
  return { hooks: nextHooks };
}

function mergeManagedHooks(existing, managed) {
  const source = hooksTable(existing);
  const managedHooks = hooksTable(managed);
  const merged = { hooks: {} };

  for (const eventName of new Set([...Object.keys(source), ...Object.keys(managedHooks)])) {
    const groups = Array.isArray(managedHooks[eventName]) ? managedHooks[eventName] : [null];
    let entries = source[eventName];
    for (const group of groups) entries = placeManagedHandlers(entries, group);
    if (entries.length > 0) merged.hooks[eventName] = entries;
  }

  return merged;
}

function unquoteTomlKey(raw) {
  if (raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1);
  if (raw.startsWith('"') && raw.endsWith('"')) {
    return raw.slice(1, -1).replace(/\\(["\\])/g, '$1');
  }
  return raw;
}

function parseHookTrustState(configText) {
  const state = new Map();
  const lines = typeof configText === 'string' ? configText.split('\n') : [];
  let current = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[')) {
      const section = trimmed.match(/^\[hooks\.state\.("(?:[^"\\]|\\.)*"|'[^']*')\]$/);
      current = section ? unquoteTomlKey(section[1]) : null;
      if (current) state.set(current, { trustedHash: null, enabled: true });
      continue;
    }
    if (!current) continue;
    const hash = trimmed.match(/^trusted_hash\s*=\s*"([^"]*)"$/);
    if (hash) state.get(current).trustedHash = hash[1];
    const enabled = trimmed.match(/^enabled\s*=\s*(true|false)$/);
    if (enabled) state.get(current).enabled = enabled[1] === 'true';
  }

  return state;
}

// Mirrors codex-rs `hook_hash`: a normalized identity serialized to canonical
// (key-sorted, compact) JSON and hashed with SHA-256. Verified byte-for-byte
// against the trusted_hash values Codex 0.149 wrote for all four events.
function hookIdentityHash(eventName, group, handler) {
  const config = {
    type: 'command',
    command: typeof handler.command === 'string' ? handler.command : '',
    async: handler.async === true,
    timeout: typeof handler.timeout === 'number' ? Math.max(1, handler.timeout) : 600,
  };
  if (typeof handler.statusMessage === 'string') config.statusMessage = handler.statusMessage;

  const identity = { event_name: HOOK_EVENT_KEY_LABELS[eventName], hooks: [config] };
  const matcher = groupMatcher(group);
  if (MATCHER_EVENTS.has(eventName) && matcher !== null) identity.matcher = matcher;

  const canonical = (value) => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.keys(value)
          .sort()
          .map((key) => [key, canonical(value[key])])
      );
    }
    return value;
  };

  const digest = crypto.createHash('sha256').update(JSON.stringify(canonical(identity))).digest('hex');
  return `sha256:${digest}`;
}

function managedHookTrust(hooksConfig, hooksPath, configText) {
  const hooks = hooksConfig && typeof hooksConfig === 'object' ? hooksConfig.hooks : null;
  if (!hooks || typeof hooks !== 'object') return [];

  const state = parseHookTrustState(configText);
  const entries = [];

  for (const [eventName, groups] of Object.entries(hooks)) {
    const label = HOOK_EVENT_KEY_LABELS[eventName];
    if (!label || !Array.isArray(groups)) continue;

    groups.forEach((group, groupIndex) => {
      const handlers = group && Array.isArray(group.hooks) ? group.hooks : [];
      handlers.forEach((handler, handlerIndex) => {
        if (!isManagedHook(handler)) return;
        const key = `${hooksPath}:${label}:${groupIndex}:${handlerIndex}`;
        const entry = state.get(key);
        const trustedHash = entry?.trustedHash || null;
        const currentHash = hookIdentityHash(eventName, group, handler);
        let status = 'untrusted';
        if (trustedHash) status = trustedHash === currentHash ? 'trusted' : 'modified';
        // A trusted handler that Codex has disabled still never runs.
        if (status === 'trusted' && entry?.enabled === false) status = 'disabled';
        entries.push({ eventName, key, currentHash, trustedHash, status });
      });
    });
  }

  return entries;
}

function eventList(trustEntries, status) {
  const matched = trustEntries.filter((entry) => entry.status === status);
  return matched.length === 0 ? null : [...new Set(matched.map((entry) => entry.eventName))].join(', ');
}

function untrustedHookMessage(trustEntries) {
  const events = [
    ...new Set(
      trustEntries
        .filter((entry) => entry.status === 'untrusted' || entry.status === 'modified')
        .map((entry) => entry.eventName)
    ),
  ].join(', ');
  if (!events) return null;
  return (
    `devclocked codex hooks are not trusted by Codex (${events}). ` +
    'Open an interactive codex session and re-trust hooks, or run with --dangerously-bypass-hook-trust.'
  );
}

function disabledHookMessage(trustEntries) {
  const events = eventList(trustEntries, 'disabled');
  if (!events) return null;
  return (
    `devclocked codex hooks are disabled in config.toml (${events}). ` +
    'Set enabled = true on the matching [hooks.state] entry.'
  );
}

// A cached copy of the same plugin registers the same hooks twice, so Codex
// runs one of them under a plugin trust key the installer never writes.
function findDuplicatePluginHooks(cacheDir) {
  const found = [];
  const matches = (name) => name === DUPLICATE_PLUGIN_NAME || name.startsWith(`${DUPLICATE_PLUGIN_NAME}@`);

  const readDirs = (dir) => {
    try {
      return fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory());
    } catch {
      return [];
    }
  };

  for (const entry of readDirs(cacheDir)) {
    if (matches(entry.name)) {
      found.push(path.join(cacheDir, entry.name));
      continue;
    }
    for (const nested of readDirs(path.join(cacheDir, entry.name))) {
      if (matches(nested.name)) found.push(path.join(cacheDir, entry.name, nested.name));
    }
  }

  return found;
}

// Codex keys the cached copy's trust as `<plugin>@<marketplace>:hooks.json:...`,
// separate from the hooks.json keys, so trust does not follow the user from one
// copy to the other.
function hasCachedPluginTrust(configText) {
  for (const [key, entry] of parseHookTrustState(configText)) {
    if (key.startsWith(`${DUPLICATE_PLUGIN_NAME}@`) && entry.trustedHash) return true;
  }
  return false;
}

function duplicatePluginMessage(duplicates, trustEntries = [], cachedPluginTrusted = false) {
  if (duplicates.length === 0) return null;
  const lead = `a duplicate ${DUPLICATE_PLUGIN_NAME} plugin ships the same hooks (${duplicates.join(', ')}). `;
  const untrusted = trustEntries.filter((entry) => entry.status !== 'trusted');
  if (trustEntries.length > 0 && untrusted.length === 0) {
    return `${lead}The hooks.json handlers are trusted, so remove the cached copy and Codex runs one.`;
  }
  const hooksJsonState =
    trustEntries.length === 0
      ? 'no devclocked handlers are installed in hooks.json'
      : `the hooks.json handlers are not all trusted (${untrusted.map((entry) => `${entry.eventName}=${entry.status}`).join(' ')})`;
  const cachedState = cachedPluginTrusted ? ' and config.toml holds trust for the cached copy' : '';
  return (
    `${lead}Trust is per copy: ${hooksJsonState}${cachedState}, so removing the cached copy now would stop tracking. ` +
    'Re-trust the hooks.json handlers in an interactive codex session first.'
  );
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

  const finalConfigText = readText(CONFIG_PATH) || '';
  return {
    configChanged: feature.changed,
    installedHooks: countManagedHooks(merged),
    pluginRoot,
    trust: managedHookTrust(merged, HOOKS_PATH, finalConfigText),
    duplicatePlugins: findDuplicatePluginHooks(PLUGIN_CACHE_DIR),
    cachedPluginTrusted: hasCachedPluginTrust(finalConfigText),
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
    trust: managedHookTrust(hooksConfig, HOOKS_PATH, configText),
    duplicatePlugins: findDuplicatePluginHooks(PLUGIN_CACHE_DIR),
    cachedPluginTrusted: hasCachedPluginTrust(configText),
  };
}

function warningLines(status) {
  return [
    untrustedHookMessage(status.trust),
    disabledHookMessage(status.trust),
    duplicatePluginMessage(status.duplicatePlugins, status.trust, status.cachedPluginTrusted),
  ].filter(Boolean);
}

function printDoctorStatus(status) {
  const lines = [
    'DevClocked Codex Hook Install Status',
    `plugin root: ${status.pluginRoot}`,
    `feature flag: ${status.codexHooksEnabled ? 'enabled' : 'missing'} (${status.configPath})`,
    `hooks file: ${status.hooksFilePresent ? 'present' : 'missing'} (${status.hooksPath})`,
    `managed hooks: ${status.managedHooksInstalled}`,
    `track script: ${status.trackScriptPresent ? 'present' : 'missing'}`,
    `hook trust: ${status.trust.map((entry) => `${entry.eventName}=${entry.status}`).join(' ') || 'none'}`,
    ...warningLines(status),
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
    for (const warning of warningLines(result)) {
      process.stdout.write(`${warning}\n`);
    }
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
  disabledHookMessage,
  doctor,
  duplicatePluginMessage,
  ensureCodexHooksFeature,
  findDuplicatePluginHooks,
  hasCachedPluginTrust,
  hookIdentityHash,
  isManagedHook,
  managedHookTrust,
  mergeManagedHooks,
  parseHookTrustState,
  shellQuote,
  stripManagedHooks,
  untrustedHookMessage,
};
