---
description: Open an agent on a registered project in Herdr, fresh or resuming a past session
argument-hint: [project] [agent] [--continue | --resume] [--topic T]
allowed-tools: Bash(bun orch.ts open:*), Bash(bun orch.ts folders:*), Bash(bun orch.ts sessions:*), Bash(bun orch.ts project list:*), Bash(herdr pane read:*), Bash(herdr pane send-keys:*), Bash(herdr agent get:*), Bash(herdr pane close:*), AskUserQuestion
---

Open an agent for the user, from `$ARGUMENTS`: an optional project, an optional agent, `--continue` (resume the newest session) or `--resume` (pick a session), and `--topic T` (pass it through to `open`).

Every choice below is asked with AskUserQuestion, never as a question the user types an answer to. Paging: when a list doesn't fit, show the first options plus "Older…" (or "More…"), which shows the next page; the last page has no such option. AskUserQuestion always adds "Other" for free text.

- **2 to 4 options per question.** When a page would have only one option, add "Cancel". On "Cancel", stop without opening anything.
- **Labels are unique within a question,** because the answer is the label. Shorten as each step says. If two labels on a page still match, add ` (2)`, ` (3)`, … in page order, and map the answer back by its exact label.

## 1. Project

If no project was given, or it isn't registered, run `bun orch.ts project list --json` and ask which project. Options are project names (description: the project's description), 3 per page plus "More…". Match "Other" text against project names: one match → use it; several → ask again with those; none → say so and ask again.

## 2. Folder

Run `bun orch.ts folders <project> [agent] --json`, adding `--with-sessions` for `--continue` and `--resume`. If it returns only the base folder, skip the question and use it.

Otherwise ask which folder to open in. Each page: "Base folder" first (description: its branch), then 2 worktrees, then "Older…". A worktree's label is its folder's base name; if that's over 30 characters, keep its last 29 after a leading `…` (worktree names often share a long prefix); its description is the branch, then `last session 3d ago` or `no sessions`, then `job <id>, agent live` (or `job <id>`) when the entry has `job`. Match "Other" text against worktree folder names and branches, as for projects.

## 3. Open

- **Plain:** `bun orch.ts open <project> [agent] --folder <F> [--topic T]`.
- **`--continue`:** run `bun orch.ts sessions <project> [agent] --folder <F> --json` and take the first (newest) session. If there are none, say "no sessions to continue in <F>" and stop without opening anything. If it has `openIn`, ask "That session is already open in <workspace> tab <tab>." with "Open anyway" / "Pick another" / "Cancel"; "Pick another" goes to the `--resume` picker below. Then `bun orch.ts open <project> [agent] --folder <F> --resume <id> [--topic T]`.
- **`--resume`:** run the same `sessions` listing (none → say so and stop) and ask which session, 3 per page plus "Older…". Label: the title shortened to 32 characters, then ` · ` and the first 4 characters of the session id (titles repeat, e.g. two `/mr-review` sessions). Description: `2h ago · <branch> · <lastLine>`, leaving out unknown parts, plus `already open in <workspace> tab <tab>` when it has `openIn`. Match "Other" text against titles and ids. If the chosen one is open, ask "Open anyway" / "Cancel". Then `bun orch.ts open <project> [agent] --folder <F> --resume <id> [--topic T]`.

Report the output line. If it fails because the project, agent, folder or session is unknown, show the names from the error.

## 4. Trust prompt

The agents ask whether to trust a folder they haven't seen, which is common in worktrees.

- **Cursor** (it opened): before anything else, run `herdr pane read <pane> --source visible --lines 40`. Herdr shows this prompt as `idle`, so never send text first.
- **Claude** (`open` failed with `agent_not_ready`): the error ends with `left open: … pane <P> (agent <NAME>)`. Run `herdr pane read <P> --source visible --lines 40`.

If the screen shows Cursor's "Workspace Trust Required" or Claude's "Is this a project you created or one you trust?", ask "<agent> in <project> wants to know if it can trust <folder> (pane <P>)." with "Trust this folder" / "Quit". Send only what they picked:

- Cursor: `herdr pane send-keys <P> a` to trust, `q` to quit.
- Claude: send the number shown on screen next to the trust option (or the exit option) with `herdr pane send-keys <P> <n>`. If the prompt is still on screen after a moment, send `enter`. After trusting, run `herdr agent get <NAME>` every couple of seconds for up to 10 seconds. Once it exists, report it as opened (agent, project, pane, and the folder or session if any). If it never appears, report the pane as left open.

After "Quit", ask "Close the tab?" with "Close it" / "Leave it". Run `herdr pane close <P>` only if they choose to close it.

If the screen shows anything else unexpected, report the pane as left open and don't guess. Never close anything without the user's pick.
