---
description: Open a plain terminal (no agent) on a registered project in Herdr
argument-hint: <project> [--topic T]
allowed-tools: Bash(bun /home/user/orchestrator/orch.ts bash:*)
---

Run `bun /home/user/orchestrator/orch.ts bash $ARGUMENTS` and report its output line.

If it fails because the project is unknown, show the list of known names from the error. If it reports a tab or pane left open after a failure, pass those ids on so the user can use or close them. Don't close anything yourself.
