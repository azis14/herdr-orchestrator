# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

The control room for the user's Herdr session. It keeps a registry of projects (name → repo path) and agents (Claude, Cursor). It opens agents on projects, and it runs cross-project **jobs**: one agent per repo, driven through design → plan → build, with everything reported back here. Design: `docs/superpowers/specs/2026-10-23-orchestrator-design.md`.

## Commands

```bash
bun test                              # all tests
bun test tests/open.test.ts           # one file
bun test -t "name collision"          # tests matching a name

bun orch.ts open <project> [agent] [--topic T]   # new tab in the project's workspace (created if missing); agent defaults to claude; tab labelled T
bun orch.ts bash <project> [--topic T]           # same tab placement, plain terminal, no agent
bun orch.ts code <project | path | .>            # open a project's repo, or any dir, in VS Code (no Herdr)
bun orch.ts status [--json]           # every Herdr agent, mapped to project and job
bun orch.ts cleanup [workspace...] [--idle 1h] [--json]   # list dormant agents (idle, no child processes) with a pick each; nothing is closed
bun orch.ts cleanup --close <pick...>            # close the picks the user approved
bun orch.ts project add <path> --description D [--name N] [--context a,b]
bun orch.ts skills [project] [--resolve <skill>]
bun orch.ts job new|list|show|stage|log|agent|spawn ...
```

Slash commands: `/open`, `/bash`, `/code`, `/status`, `/cleanup`, `/job`, `/register`.

## Architecture

- **The script does the mechanics; skills do the judgment.** `orch.ts` (Bun, no dependencies) and `src/` handle the registry, Herdr calls, skill scanning, job records and spawning, all deterministically. The `orchestrate-job` skill (plus `claude-code` / `cursor-cli` for driving each agent) handles question routing, cross-repo contract checks and approval stops.
- **All Herdr, git and editor calls go through injectable runners.** That's `Runner` in `src/herdr.ts`, `GitRunner` in `src/git.ts` and `EditorRunner` in `src/editor.ts`, passed in via `Deps` to `main(argv, deps)` in `orch.ts`. Tests use `tests/fakes.ts` (`fakeRunner`, `testRegistry`, `testDeps`) and never touch the real Herdr session.
- **Registry:** `registry/projects.json` and `registry/agents.json`. To add a project, use `/register <path>` (or `orch project add`); entries have `name`, `path`, `description`, `context` files relative to the repo. To add an agent, add an entry with its Herdr `--kind`, `openArgs` (interactive), `jobArgs` (broad permissions for job agents) and optional `worktreeArgs` (added only inside job-created worktrees), plus a skill for driving it.
- **Workspaces:** a project's workspace is the Herdr workspace whose label equals the project name. Job agents with the default mode get a linked worktree workspace labelled `<project>:<job-id>`, at `<repo>.worktrees/<job-id>` on branch `feature/<job-id>` off a fetched `origin/dev`.
- **Agent names** must match Herdr's `^[a-z][a-z0-9_-]{0,31}$`; `toAgentName` in `src/open.ts` sanitizes them (e.g. `shop2.0` → `shop2-0`). They're unique across the whole Herdr session, so `open` names agents after their kind and numbers repeats: `claude`, `claude-2`, ...; the tab takes `--topic`, else Herdr's default label. Job agents use `jobAgentName` in `src/spawn.ts`, which is `<project>-<slug>` plus a hash of the job id, so long slugs never collide.
- **Job agent lifecycle:** `starting` → `started`, or `start-failed`. Running `job spawn` again on a `start-failed` agent that is now live adopts it. On a `stopped` agent, it reopens the recorded worktree and merges into the existing record. `createdWorkspace` says whether the job owns the workspace or only its tab.
- **Jobs:** `jobs/<id>/` holds `job.json` (stage and agents), `summary.md` (what the user reads) and `log.md` (routed questions and answers). The directory is versioned.
- **Skills:** the source is in `.agents/skills/<name>/`, and `.claude/skills/<name>` is a symlink to it. Repo skills are never installed or edited from here; an agent uses the repo's own copy of a skill if it has one, else this orchestrator's copy by absolute path (`orch skills <project> --resolve <skill>`).

## Rules that aren't obvious from the code

- **Repo rules win.** A repo's `CLAUDE.md` / `AGENTS.md` / rules / skills override the orchestrator's fallback mechanics (worktree flow, base branch, branch names, env setup, where docs go). shop2.0 uses its own worktree flow, so its jobs spawn with `--repo-worktree`.
- Never push, open MRs, or answer an agent's permission dialog without the user. Never close Herdr workspaces/tabs/panes without the user's confirmation, and never ones this orchestrator didn't create except through `/cleanup`.
- Cursor's workspace-trust dialog shows up in Herdr as `idle`. Read the pane before prompting an interactive Cursor agent, or any text you send may answer the dialog. Cursor job agents launch with `--force`, plus `--trust` (the agent's `worktreeArgs`) only inside a job-created worktree, never the user's own checkout.
- `herdr` with no subcommand fails inside a pane ("nested herdr is disabled"), so always pass a subcommand. `herdr --help` output for the installed binary is the authority on syntax.
