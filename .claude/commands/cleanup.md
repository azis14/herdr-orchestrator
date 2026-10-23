---
description: Close dormant agents across Herdr or in named workspaces, after confirmation
argument-hint: [workspace...] [--idle D]
allowed-tools: Bash(bun /home/user/orchestrator/orch.ts cleanup:*)
---

Run `bun /home/user/orchestrator/orch.ts cleanup $ARGUMENTS` and show the table and the skipped block. This only lists; nothing is closed yet.

Flag any candidate whose last message ends with a question mark (it may be waiting on an answer) or whose IDLE shows `unknown` (no transcript, so its age can't be confirmed). Repeat the note at the bottom: scheduled wakeups, `/loop` and Monitor waits can't be detected.

Ask the user which to close: all, some by agent name, or none. Wait for the answer. Never run `--close` without it.

For the agents they approve, run `bun /home/user/orchestrator/orch.ts cleanup --close <pick>...` with the PICK values of those rows only, copied exactly from the table. Report the output lines. A `not closed` line means the agent changed or went away since the listing; say so and don't retry it without a fresh listing.
