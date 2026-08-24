# DevClocked for Codex

Codex-native DevClocked tracking plugin.

This plugin makes Codex itself trigger DevClocked tracking, so Codex work keeps tracking even when the DevClocked Mac app is not open. The supported activation path is: install the plugin, then let the plugin install its managed entries into the official Codex hooks surface at `~/.codex/hooks.json`.

For Codex sessions that execute on an SSH server, follow the
[remote hosting guide](https://github.com/sketchymedia/devclocked-trackers/blob/main/docs/REMOTE_HOSTING.md), including the complete
Hetzner example and host-local verification steps.

## What it includes

- Codex hooks for session lifecycle, prompt submissions, and Bash tool activity
- Remote stream names from Codex `Thread.name`, with agent role/nickname and T3 Code/Demuxx fallbacks
- DevClocked MCP tools for summaries and activity lookups
- Skills for time review and weekly summaries
- Local queue + background shipper for reliable event delivery

## Setup

1. Install DevClocked auth with `npx devclocked setup` or `devclocked login`
2. Restart Codex after this repo's marketplace file is present at `.agents/plugins/marketplace.json`
3. In Codex, open the plugin directory, choose `DevClocked Local Plugins`, and install `DevClocked`
4. Install the plugin-managed Codex hooks:

```bash
npm run install-hooks
```

5. Verify setup:

```bash
npm run doctor
node ./hooks/status.js
```

6. Start a new Codex session and approve the four DevClocked hooks when Codex opens its hook review screen
7. Start coding in Codex

## Local install wiring

In the monorepo, DevClocked exposes the plugin through:

- `.agents/plugins/marketplace.json`
- plugin source path: `./packages/codex-plugin`

Codex will copy the installed plugin into its local cache on install.

For runtime tracking, the plugin owns installation into the official Codex hooks config at `~/.codex/hooks.json`. The installer enables `hooks = true` in `~/.codex/config.toml` and migrates the deprecated `codex_hooks` flag.

## Remote stream names

Codex hooks include the thread ID but not its user-facing name. On the remote host, the plugin reads only the matching row from Codex's local `state_*.sqlite` database and sends `Thread.name` as the DevClocked stream title. It does not read turn content or prompts. A named sub-agent can fall back to `agentRole` and `agentNickname`.

The title order is:

1. Codex `Thread.name`, including names set with `/rename` or `thread/name/set`
2. Codex sub-agent role
3. Codex sub-agent nickname
4. The T3 Code or Demuxx thread title stored on the same remote host
5. DevClocked's shortened Codex thread ID fallback

`DEVCLOCKED_TRACK_SESSION_TITLES=0` disables all title collection on that host.

## Standalone repo publishing

This folder is intentionally self-contained so it can be synced to the standalone Codex plugin repository.

The publish unit is:

- `packages/codex-plugin`

It now includes its own local `runtime/` helpers, so a subtree-style push or folder sync to `Devclocked/codex-plugin` does not depend on sibling monorepo packages.

If you publish it as its own repo, this folder already includes:

- `.codex-plugin/plugin.json`
- `.mcp.json`
- `.agents/plugins/marketplace.json`
- `runtime/` for local hook shipping
- `LICENSE`

## Local smoke test

1. Quit the DevClocked Mac app so the daemon is not the primary trigger.
2. Restart Codex and install the plugin from the local marketplace.
3. Run `npm run install-hooks` from `packages/codex-plugin`.
   In the standalone repo, just run `npm run install-hooks` from the repo root.
4. Start a Codex session in a git-backed repo and use at least:
   - one prompt
   - one Bash tool call
5. Check plugin state:

```bash
npm run doctor
node ./hooks/status.js
```

6. Confirm DevClocked receives activity.
7. Re-open the DevClocked Mac app and repeat a short Codex session to confirm no double-counting against daemon fallback.

## Coverage model

- Codex hooks are the primary live source for Codex activity
- The desktop daemon remains a fallback by watching `~/.codex/sessions/**/*.jsonl`
- When both are present, Codex plugin activity wins and the daemon suppresses duplicate Codex ticks

## Debugging

```bash
node ./hooks/status.js
node ./hooks/status.js --json
npm run doctor
npm run doctor -- --json
npm run uninstall-hooks
```
