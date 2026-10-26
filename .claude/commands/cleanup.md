---
description: Close dormant agents across Herdr or in named workspaces, after confirmation
argument-hint: [workspace...] [--idle D]
allowed-tools: Bash(bun orch.ts cleanup:*), AskUserQuestion
---

Run `bun orch.ts cleanup $ARGUMENTS` and show the table and the skipped block. This only lists; nothing is closed yet.

Flag any candidate whose last message ends with a question mark (it may be waiting on an answer) or whose IDLE shows `unknown` (no transcript, so its age can't be confirmed). Repeat the note at the bottom: scheduled wakeups, `/loop` and Monitor waits can't be detected.

Ask which to close with AskUserQuestion, never as a typed answer:

- **Up to 4 candidates:** one multi-select question, one option per agent. Label: the agent name. Description: workspace, idle time and last message, with the `?` and `unknown` warnings. Nothing ticked means close none.
- **More than 4:** ask "Close all" / "Choose…" / "None". For "Choose…", show the candidates as multi-select questions of 4 options each, up to 4 questions per call, and more calls until every candidate was shown.

Never run `--close` without their picks.

For the agents they picked, run `bun orch.ts cleanup --close <pick>...` with the PICK values of those rows only, copied exactly from the table. Report the output lines. A `not closed` line means the agent changed or went away since the listing; say so and don't retry it without a fresh listing.
