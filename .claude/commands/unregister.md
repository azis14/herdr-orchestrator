---
description: Remove a project from the orchestrator's registry
argument-hint: <project>
allowed-tools: Bash(bun orch.ts project remove:*), Read
---

Unregister the project named in `$ARGUMENTS`.

1. Read `registry/projects.json` and show the entry (name, path, description). If there's no such project, list the known names and stop.
2. Say that only the registry entry goes: the repo, its worktrees and its Herdr workspace are left alone. Wait for the user's OK.
3. Run `bun orch.ts project remove '<name>'` and report the result. If it refuses because of unfinished jobs, show the message as is and stop.
