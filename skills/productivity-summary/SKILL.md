---
name: productivity-summary
description: Generate a branded DevClocked productivity summary as a terminal dashboard — ASCII box charts, progress bars, and shipped-work recaps. Use when the user wants a weekly recap, wants to understand their work patterns, or is planning their time.
---

# Productivity Summary

## When to use
- User asks for a weekly summary or recap
- User wants to understand their work patterns
- User is planning work and wants context on recent activity
- User asks "where did my time go this week?"

## Fetch — pick tools by question
- Hours per day this week → `get_weekly_summary_raw` (JSON) → daily-hours bar chart
- When in the day do I work? → `get_time_breakdown` with `group_by=hour` → time-of-day profile
- Which weekdays? → `get_time_breakdown` with `group_by=weekday` → weekday distribution
- What did I ship? → `get_delivery_report` → shipped-work summary (commits/PRs/cost)
- Quick dashboard → `get_summary` / `get_weekly_summary` → already-formatted ASCII dashboards; display verbatim in a code block, never paraphrase the box art away

`get_today_activity` and `get_projects` fill in detail when needed. Never guess or estimate time — always fetch.

## Render — capability ladder
DevClocked brand: dark bg `#0a0a0b`, gold accent `#D4A843`. Activity colors: coding=gold `#D4A843`, planning=purple, debugging=green, reading=cyan.

1. HTML/React artifacts available → branded dashboard artifact from the raw JSON tools using the brand tokens.
2. Markdown chat → tables + code-block `█` bar charts with clear headers.
3. **Terminal (Codex CLI — the default here)** → ASCII box dashboard: bordered box, solid `█` bars per repo/day, matching the DevClocked CLI look.

Comparison bars (day vs day, repo vs repo, model vs model) use solid `█` runs scaled to the max row — no empty `░` filler track. Bar length alone encodes the value; give any non-zero value at least one `█`, and give zero values no bar (keep the label + value text). Put the value next to the label so rows stay scannable.

In Codex, default to tier 3. Example built from `get_weekly_summary_raw`:

```
┌─ DevClocked · Week of Aug 3 ───────────────┐
│ Total 23.4h   Sessions 18   Shipped 12 PRs │
│                                            │
│ Mon 4.2h ████████     Thu 3.1h ██████      │
│ Tue 5.1h ██████████   Fri 2.0h ████        │
│                                            │
│ my-app       9.8h ████████████             │
│ api-server   6.2h ████████                 │
└────────────────────────────────────────────┘
```

## Tone
- Helpful, not judgmental — tracking is self-awareness, not surveillance.
- Offer 1–2 data-backed observations (top project share, deep-work blocks, busiest days).
- For exportable reports, point to app.devclocked.com.
