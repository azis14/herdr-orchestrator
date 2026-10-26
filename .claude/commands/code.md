---
description: Open a registered project's repo, a directory path, or the current dir in VS Code
argument-hint: <project | path | .>
allowed-tools: Bash(bun orch.ts code:*)
---

Run `bun orch.ts code $ARGUMENTS` and report its output line.

A registered project name wins over a same-named directory. If the target is neither a project nor a directory, show the known project names from the error. If the `code` launcher itself fails, report its error.
