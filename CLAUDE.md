# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

The control room for the user's Herdr session. It keeps a registry of projects (name → repo path) and agents (Claude, Cursor). It opens agents on projects, and it runs cross-project **jobs**: one agent per repo, driven through design → plan → build, with everything reported back here.

## Commands

```bash
bun test                              # all tests
bun test tests/open.test.ts           # one file
bun test -t "name collision"          # tests matching a name

bun orch.ts open <project> [agent] [--topic T] [--folder F] [--continue | --resume ID]
                                                 # new tab in the project's workspace (created if missing); agent defaults to the default agent; tab labelled T;
                                                 # runs in F (the base folder or a git worktree of it); resumes the newest session there, or session ID
bun orch.ts bash <project> [--topic T] [--folder F]   # same tab placement, plain terminal, no agent
bun orch.ts folders <project> [agent] [--with-sessions] [--json]   # base folder + git worktrees, with the agent's session count and last use
bun orch.ts sessions <project> [agent] [--folder F] [--json]       # the agent's sessions started in F, newest first, marked if open in Herdr
bun orch.ts code <project | path | .>            # open a project's repo, or any dir, in VS Code (no Herdr)
bun orch.ts status [--json]           # every Herdr agent, mapped to project and job
bun orch.ts cleanup [workspace...] [--idle 1h] [--json]   # list dormant agents (idle, no child processes) with a pick each; nothing is closed
bun orch.ts cleanup --close <pick...>            # close the picks the user approved
bun orch.ts setup [--json]            # prerequisites (gh / glab optional), installed agents, registry state (what /setup reads)
bun orch.ts agent add <claude|cursor> | agent default <name> | agent remove <name>
bun orch.ts project list [--json]     # registered projects, most recently used first
bun orch.ts project add <path> --description D [--name N] [--context a,b]
bun orch.ts project remove <name>     # refused while an unfinished job includes it
bun orch.ts skills [project] [--resolve <skill>]
bun orch.ts job new|list|show|stage|log|agent|spawn ...
bun orch.ts mr show <ref> [--fetch] [--json]          # an MR/PR's metadata (state, fork, branches, head sha); --fetch also makes its head and base local (fetching only what's missing); <ref> is its URL, or <project> <id> (bare number)
bun orch.ts mr threads <ref> [--json]                 # its review threads, resolved or not
bun orch.ts mr position <ref> --path P --line N [--old-path O] [--side new|old] [--head SHA]   # where an inline comment would land; checks the line is changed
bun orch.ts mr post <ref> [--dry-run] [--head SHA]    # post a review ({summary, comments} JSON on stdin); exits 3, posting nothing, if a comment is off the diff
                                                      # --head SHA (both): exit 1, posting nothing, if the MR's head is no longer the reviewed SHA
                                                      # errors raised before anything is sent say "nothing was posted"
bun orch.ts mr note <ref>                             # post a general note (body on stdin); prints its url
bun orch.ts mr reply <ref> --thread ID                # reply in a review thread (body on stdin); prints the reply's url
bun orch.ts mr resolve <ref> --thread ID              # resolve a review thread; exits 1 if it stays unresolved
bun orch.ts mr worktree <ref> [--protect a,b]         # a worktree on the MR's source branch to fix in (never your own checkout); prints its path; refuses local commits origin doesn't have
```

Slash commands: `/setup`, `/intro`, `/open`, `/bash`, `/code`, `/status`, `/cleanup`, `/job`, `/mr-review`, `/mr-fix`, `/register`, `/unregister`, `/agent`. They call the CLI as `bun orch.ts …` from the orchestrator root, never by absolute path, so any clone works.

## Architecture

- **The script does the mechanics; skills do the judgment.** `orch.ts` (Bun, no dependencies) and `src/` handle the registry, Herdr calls, skill scanning, job records and spawning, all deterministically. The `orchestrate-job` skill (plus `claude-code` / `cursor-cli` for driving each agent) handles question routing, cross-repo contract checks and approval stops.
- **All Herdr, git, editor and forge calls go through injectable runners.** That's `Runner` in `src/herdr.ts`, `GitRunner` in `src/git.ts`, `EditorRunner` in `src/editor.ts` and `ForgeRunner` in `src/forge.ts` (the `gh` / `glab` calls behind `orch mr`, via `Deps.forge`), passed in via `Deps` to `main(argv, deps)` in `orch.ts`. Session stores are read from `Deps.claudeProjects` (`~/.claude/projects`) and `Deps.cursorChats` (`~/.cursor/chats`), read-only. Tests use `tests/fakes.ts` (`fakeRunner`, `testRegistry`, `testDeps`) and never touch the real Herdr session.
- **Registry:** `registry/projects.json` and `registry/agents.json`, local to each user (git-ignored); `registry/*-example.json` are the tracked templates. `orch.ts` loads the registry lazily, so `setup` and `agent` work before it exists and other commands say "run /setup first". Projects come from `/register <path>` (or `orch project add`); entries have `name`, `path`, `description`, `context` files relative to the repo. Agents come from the presets in `src/manage.ts` (`/agent add`, `/setup`): Herdr `--kind`, `openArgs` (interactive), `jobArgs` (broad permissions for job agents), optional `worktreeArgs` (added only inside job-created worktrees) and `resumeArgs` (e.g. `["--resume", "{session}"]`). A new agent kind needs a preset plus a skill for driving it.
- **Workspaces:** a project's workspace is the Herdr workspace whose label equals the project name. Job agents with the default mode get a linked worktree workspace labelled `<project>:<job-id>`, at `<repo>.worktrees/<job-id>` on branch `feature/<job-id>` off a fetched `origin/dev`. `/mr-fix` opens its agent as a tab in the project's own workspace, in a worktree at `<repo>.worktrees/mr-<n>` (GitLab) or `pr-<n>` (GitHub) on the MR's source branch (`orch mr worktree`); later runs on the same MR reuse it.
- **Agent names** must match Herdr's `^[a-z][a-z0-9_-]{0,31}$`; `toAgentName` in `src/open.ts` sanitizes them (e.g. `shop2.0` → `shop2-0`). They're unique across the whole Herdr session, so `open` names agents after their kind and numbers repeats: `claude`, `claude-2`, ...; the tab takes `--topic`, else Herdr's default label. Job agents use `jobAgentName` in `src/spawn.ts`, which is `<project>-<slug>` plus a hash of the job id, so long slugs never collide.
- **Job agent lifecycle:** `starting` → `started`, or `start-failed`. Running `job spawn` again on a `start-failed` agent that is now live adopts it. On a `stopped` agent, it reopens the recorded worktree and merges into the existing record. A `stopped` agent with `lastCwd` reopens there, resuming `sessionId` via the agent's `resumeArgs`. `createdWorkspace` says whether the job owns the workspace or only its tab.
- **Jobs:** `jobs/<id>/` holds `job.json` (stage and agents), `summary.md` (what the user reads) and `log.md` (routed questions and answers). The directory is local (git-ignored).
- **Skills:** the source is in `.agents/skills/<name>/`, and `.claude/skills/<name>` is a symlink to it. The one exception is `mr-fix`: it has no symlink, because Claude Code treats commands and skills alike, so a `mr-fix` skill here would shadow the `/mr-fix` command (loading the fix process into the orchestrator's own checkout). Fix agents get it by path, and `scanSkills` still finds it under `.agents/skills`. Repo skills are never installed or edited from here; an agent uses the repo's own copy of a skill if it has one, else this orchestrator's copy by absolute path (`orch skills <project> --resolve <skill>`).

## Rules that aren't obvious from the code

- **Choices are pickers.** When a slash command or skill needs the user to choose from a known set of options, ask with `AskUserQuestion`, never by asking them to type. Free-text answers (paths, change requests, descriptions) stay free text. Never pick on the user's behalf. A question needs 2–4 options (add "Cancel" or "None" when only one is left) and unique labels, because the answer comes back as the label.
- **Repo rules win.** A repo's `CLAUDE.md` / `AGENTS.md` / rules / skills override the orchestrator's fallback mechanics (worktree flow, base branch, branch names, env setup, where docs go).
- Never push, open MRs, or answer an agent's permission dialog without the user. Never close Herdr workspaces/tabs/panes without the user's confirmation, and never ones this orchestrator didn't create except through `/cleanup`.
- `/mr-fix` is the one exception to never pushing without the user: invoking it approves committing and pushing to that MR's own branch, replying and resolving fixed threads. Permission dialogs on the way are still the user's.
- Cursor's workspace-trust dialog shows up in Herdr as `idle`. Read the pane before prompting an interactive Cursor agent, or any text you send may answer the dialog. Cursor job agents launch with `--force`, plus `--trust` (the agent's `worktreeArgs`) only inside a job-created worktree, never the user's own checkout.
- Specs and plans go in `docs/superpowers/`, which is local-only (git-ignored). Write them there; never commit them.
- `herdr` with no subcommand fails inside a pane ("nested herdr is disabled"), so always pass a subcommand. `herdr --help` output for the installed binary is the authority on syntax.
