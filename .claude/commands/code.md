---
description: Open a registered project's repo, a directory path, or the current dir in VS Code
argument-hint: [project | path | .]
allowed-tools: Bash(bun orch.ts code:*), Bash(bun orch.ts project list:*), AskUserQuestion
---

If no target was given, ask which project with AskUserQuestion, from `bun orch.ts project list --json`: project names (description: the project's description), 3 per page plus "More…". Then run `bun orch.ts code <project>`.

Otherwise run `bun orch.ts code $ARGUMENTS` and report its output line.

A registered project name wins over a same-named directory. If the target is neither a project nor a directory, ask which project the same way instead of listing names. If the `code` launcher itself fails, report its error.
