---
description: Register a repo as an orchestrator project
argument-hint: <path> [name]
allowed-tools: Bash(bun orch.ts project add:*), Bash(ls:*), Read, Glob, AskUserQuestion
---

Register the repo at the path in `$ARGUMENTS` (an optional second word is the project name).

1. Expand `~` to the home directory and list the repo's top level, including dotfiles.
2. Context: collect whichever of these exist, relative to the repo: `CLAUDE.md`, `AGENTS.md`, `.cursorrules`, `.cursor/rules`, `docs`, plus any other agent-instruction files you find (e.g. `.github/copilot-instructions.md`). If none exist, use `README.md`.
3. Description: read the README and CLAUDE.md and write one line in the registry's style, e.g. "Dashboard API (Go + Echo)".
4. Name: the given name, else the folder name.
5. Show the name, path, description and context list, then ask with AskUserQuestion: "Save" / "Change something" / "Cancel". On "Change something", ask what to change (free text), apply it and show the entry and the question again. On "Cancel", stop. Don't save before "Save".
6. On "Save", run `bun orch.ts project add '<path>' --name '<name>' --description='<description>' --context '<a,b,c>'` and report the saved entry. Single-quote every value (write a `'` inside one as `'\''`) so spaces, quotes and `$` in a path or description reach the CLI unchanged. If it fails, show the error and let the user adjust.
