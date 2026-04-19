---
name: productivity-summary
description: Generate a productivity summary with insights. Use when the user wants a weekly recap, wants to understand their work patterns, or is planning their time.
---

# Productivity Summary

## When to use
- User asks for a weekly summary or recap
- User wants to understand their work patterns
- User is planning work and wants context on recent activity
- User asks "where did my time go this week?"

## Instructions

1. Fetch `get_weekly_summary`, `get_today_activity`, and `get_projects` from the DevClocked MCP server.
2. Summarize total tracked time, top projects, and the busiest days.
3. Keep the tone helpful and grounded in the data.
4. If the user wants exportable reports, point them to `app.devclocked.com`.
