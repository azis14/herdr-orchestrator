---
description: Open a plain terminal (no agent) on a registered project in Herdr
argument-hint: [project] [--topic T]
allowed-tools: Bash(bun orch.ts bash:*), Bash(bun orch.ts folders:*), Bash(bun orch.ts project list:*), AskUserQuestion
---

Open a terminal for the user, from `$ARGUMENTS`: an optional project and `--topic T` (pass it through).

Ask every choice with AskUserQuestion, with the same pages, "Other" matching, labels and 2-option minimum as `/open` (see `.claude/commands/open.md`: the rules at the top, then steps 1 and 2):

1. **Project:** if none was given or it isn't registered, ask from `bun orch.ts project list --json`.
2. **Folder:** run `bun orch.ts folders <project> --json`. If it lists only the base folder, use it. Otherwise ask: "Base folder" first, then 2 worktrees per page, then "Older…".
3. Run `bun orch.ts bash <project> --folder <F> [--topic T]` and report its output line.

If it fails, show the names from the error. If it reports a tab or pane left open after a failure, pass those ids on so the user can use or close them. Don't close anything yourself.
