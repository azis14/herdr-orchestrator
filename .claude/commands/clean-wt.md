---
description: Remove a project's git worktrees idle for 7+ days, after you pick which
argument-hint: [project | path | .] [--idle D]
allowed-tools: Bash(bun orch.ts clean-wt:*), Bash(bun orch.ts project list:*), AskUserQuestion
---

If no target was given (no argument, or only `--idle D`), ask which project with AskUserQuestion, from `bun orch.ts project list --json`: project names (description: the project's description), 3 per page plus "More…". A page with only one project also gets "Cancel", since a question needs at least 2 options. The chosen project is the target; keep any `--idle D` that was given.

The target is the project name, path or `.`; the rest of the arguments (`--idle D`) only apply to the listing. Run `bun orch.ts clean-wt <target> [--idle D] --json` for the picker data, then `bun orch.ts clean-wt <target> [--idle D]` and show the user its table, the total, the skipped block and the job warnings. This only lists; nothing is removed yet. If there are no candidates, say so and stop.

Ask which to remove with AskUserQuestion, never as a typed answer:

- **Up to 4 candidates:** one multi-select question, one option per worktree. Label: the worktree's folder name. Description: its warnings first (uncommitted files, commits not pushed, detached HEAD, age unknown), then branch, idle time and size. Nothing ticked means remove none. With a single candidate, add a second option "None (keep it)", since a question needs at least 2 options.
- **More than 4:** ask "Remove all" / "Choose…" / "None". If any candidate has a warning, "Remove all" asks one more yes/no AskUserQuestion that names every candidate with a warning and what it would lose; anything but yes removes nothing. For "Choose…", show the candidates as multi-select questions of 4 options each, up to 4 questions per call, and more calls until every candidate was shown. A question left with one candidate also gets "None of these".

Never run `--remove` without their picks.

For the worktrees they picked, run `bun orch.ts clean-wt <target> --remove <pick>...` with the PICK values of those rows only, copied exactly from the listing (the same target, without `--idle`). Report the output lines: each `removed <path> (<size>)` and `freed about <size>`. Branches are kept, so say so. A `not removed` line means the worktree changed or went away since the listing; say so and don't retry it without a fresh listing.
