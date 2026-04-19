# DevClocked for Codex

Codex-native DevClocked tracking plugin.

This plugin makes Codex itself trigger DevClocked tracking, so Codex work keeps tracking even when the DevClocked Mac app is not open. The supported activation path is: install the plugin, then let the plugin install its managed entries into the official Codex hooks surface at `~/.codex/hooks.json`.

## What it includes

- Codex hooks for session lifecycle, prompt submissions, and Bash tool activity
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

6. Restart Codex again if the install flow prompts for it
7. Start coding in Codex

## Local install wiring

In the monorepo, DevClocked exposes the plugin through:

- `.agents/plugins/marketplace.json`
- plugin source path: `./packages/codex-plugin`

Codex will copy the installed plugin into its local cache on install.

For runtime tracking, the plugin now owns installation into the official Codex hooks config at `~/.codex/hooks.json`. The installer also enables `codex_hooks = true` in `~/.codex/config.toml` if needed.

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
