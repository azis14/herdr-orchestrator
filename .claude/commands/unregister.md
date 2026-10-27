---
description: Remove a project from the orchestrator's registry
argument-hint: <project>
allowed-tools: Bash(bun orch.ts project remove:*), Bash(bun orch.ts project list:*), Read, AskUserQuestion
---

Unregister the project named in `$ARGUMENTS`.

1. Run `bun orch.ts project list --json`. The row with `builtIn: true` is the orchestrator itself: if that's the project named, say the orchestrator can't be unregistered and stop. If no project was named, or there's no such project, ask which one with AskUserQuestion, from the rows with `builtIn: false`: project names (description: the project's description), 3 per page plus "More…". A page with only one project also gets "Cancel", since a question needs at least 2 options. If there are no such rows, say there's nothing to unregister and stop.
2. Read `registry/projects.json` and show the entry (name, path, description). Say that only the registry entry goes: the repo, its worktrees and its Herdr workspace are left alone. Ask with AskUserQuestion: "Remove" / "Cancel". Stop on "Cancel".
3. Run `bun orch.ts project remove '<name>'` and report the result. If it refuses because of unfinished jobs, show the message as is and stop.
