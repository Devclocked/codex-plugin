---
name: time-review
description: Review coding time and session stats. Use when the user asks about how long they've been coding, what they worked on, or wants to see their tracked activity.
---

# Time Review

## When to use
- User asks "how long have I been coding today?"
- User asks "what did I work on today/this week?"
- User wants to see their active session or recent sessions
- User asks about time spent on a specific project

## Instructions

1. Always call `get_summary` first.
2. Start with a one-sentence summary, then show the returned summary in a code block as-is.
3. Use `get_today_activity` only when the user wants raw detail.
4. For weekly views, call `get_weekly_summary` and display it in a code block with a short sentence above.
5. If no data is available, suggest `npx devclocked setup`.
