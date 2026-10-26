---
description: Remove a project from the orchestrator's registry
argument-hint: <project>
allowed-tools: Bash(bun orch.ts project remove:*), Bash(bun orch.ts project list:*), Read, AskUserQuestion
---

Unregister the project named in `$ARGUMENTS`.

1. If no project was named, or there's no such project, ask which one with AskUserQuestion, from `bun orch.ts project list --json`: project names (description: the project's description), 3 per page plus "More…".
2. Read `registry/projects.json` and show the entry (name, path, description). Say that only the registry entry goes: the repo, its worktrees and its Herdr workspace are left alone. Ask with AskUserQuestion: "Remove" / "Cancel". Stop on "Cancel".
3. Run `bun orch.ts project remove '<name>'` and report the result. If it refuses because of unfinished jobs, show the message as is and stop.
