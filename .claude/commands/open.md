---
description: Open an agent on a registered project in Herdr
argument-hint: <project> [agent] [--topic T]
allowed-tools: Bash(bun /home/user/orchestrator/orch.ts open:*)
---

Run `bun /home/user/orchestrator/orch.ts open $ARGUMENTS` and report its output line.

If it fails because the project or agent is unknown, show the list of known names from the error. If it reports a tab or pane left open after a failed agent start, pass those ids on so the user can use or close them. Don't close anything yourself.
