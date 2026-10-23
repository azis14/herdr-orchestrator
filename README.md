# orchestrator

The control room for a Herdr session. From this one directory you can:

- **open** an agent (Claude Code or Cursor) on any registered project with one command,
- see the **status** of every agent across Herdr workspaces, by project and job,
- run cross-project **jobs**: one agent per repo, driven through design → plan → build, with every question, decision and result reported back here.

The full design is in [`docs/superpowers/specs/2026-10-23-orchestrator-design.md`](docs/superpowers/specs/2026-10-23-orchestrator-design.md).

## Requirements

- [Bun](https://bun.sh) (no other dependencies)
- Herdr, with this orchestrator running inside a Herdr pane (`HERDR_ENV=1`)
- The agent CLIs you want to drive: `claude` and/or `cursor-agent`
- `git`, for job worktrees

## Quick start

Run Claude Code in this directory, inside Herdr, and use the slash commands:

```
/register ~/repos/my-service     # add a repo to the registry
/open my-service                 # Claude in a new tab of the project's workspace
/open my-service cursor          # or Cursor
/open my-service --topic "login bug"   # tab labelled with a topic
/status                          # every agent, by project and job
/job add a status field to the orders API and show it in the UI
```

Or call the CLI directly:

```bash
bun orch.ts open <project> [agent] [--topic T]
bun orch.ts status [--json]
```

## Slash commands

| Command | What it does |
| --- | --- |
| `/open <project> [agent] [--topic T]` | Opens an agent in a new tab of the project's workspace (the workspace labelled with the project name; created if missing). Agent defaults to `claude`. The agent is named after its kind (`claude`, then `claude-2`, ... since Herdr names are session-wide); the tab is labelled `T` if given, else Herdr numbers it as usual. |
| `/status` | Shows every Herdr agent mapped to its project and job, plus what each open job is waiting on. |
| `/register <path> [name]` | Reads the repo, proposes a name, description and context files, and saves them after you approve. |
| `/job <request>` | Starts a cross-project job. Also `/job list`, `/job show <id>`, `/job resume <id>`. |

## CLI

```
bun orch.ts open <project> [agent] [--topic T]
bun orch.ts status [--json]
bun orch.ts project add <path> --description D [--name N] [--context a,b,c]
bun orch.ts skills [project] [--resolve <skill>] [--json]
bun orch.ts job new <slug> --title T --request R --projects a,b
bun orch.ts job list
bun orch.ts job show <id>
bun orch.ts job stage <id> <stage>
bun orch.ts job log <id> <text>
bun orch.ts job agent <id> <agentName> key=value...
bun orch.ts job spawn <id> <project> [agent] [--repo-worktree] [--trust]
```

The CLI does the mechanics (registry, Herdr calls, job records, spawning) deterministically. Judgment — routing questions between agents, checking cross-repo contracts, stopping for approval — lives in the `orchestrate-job` skill, which `/job` loads.

## Jobs

A job is one piece of work that spans one or more registered projects. It moves through these stages:

```
design → design-review → plan → plan-review → build → integrate → done
```

`design-review`, `plan-review` and `integrate` stop for your approval. Each job has a directory under `jobs/<id>/`:

- `job.json`: stage, projects and agents
- `summary.md`: what you read to know where things stand
- `log.md`: every routed question and answer

By default each job agent works in its own linked worktree at `<repo>.worktrees/<job-id>`, on branch `feature/<job-id>` off a freshly fetched `origin/dev`, in a Herdr workspace labelled `<project>:<job-id>`. Your own checkout is never touched. For repos with their own worktree flow, spawn with `--repo-worktree` and the agent follows the repo's rules instead.

## Registry

- `registry/projects.json`: each project's `name`, `path`, `description` and `context` (the repo's agent-instruction files, relative to the repo root).
- `registry/agents.json`: each agent's Herdr `kind`, `openArgs` for interactive use, `jobArgs` for job agents, and optional `worktreeArgs` added only inside job-created worktrees. `defaultAgent` picks the agent used when none is named.

To add a project, use `/register` or `bun orch.ts project add`. To add an agent, add an entry to `agents.json` and a skill under `.agents/skills/` that teaches the orchestrator how to drive it.

## Skills

Skill sources live in `.agents/skills/<name>/`, with `.claude/skills/<name>` symlinked to each.

- `orchestrate-job`: runs a job end to end
- `claude-code`, `cursor-cli`: how to start, prompt, read and unblock each agent through Herdr
- General-purpose skills (`brainstorming`, `writing-plans`, `executing-plans`, …) from [obra/superpowers](https://github.com/obra/superpowers), pinned in `skills-lock.json`

When a job agent needs a skill, it uses the repo's own copy if there is one, otherwise this orchestrator's copy by absolute path (`bun orch.ts skills <project> --resolve <skill>`). The orchestrator never installs or edits skills inside a repo.

## Ground rules

- **Repo rules win.** A repo's `CLAUDE.md`, `AGENTS.md`, rules and skills override the orchestrator's defaults for worktrees, base branch, branch names, env setup and where docs go.
- The orchestrator never pushes, opens merge requests, or answers an agent's permission dialog without you.
- It only closes Herdr workspaces, tabs and panes it created.

## Development

```bash
bun test                       # all tests
bun test tests/open.test.ts    # one file
bun test -t "name collision"   # tests matching a name
```

All Herdr and git calls go through injectable runners (`Runner` in `src/herdr.ts`, `GitRunner` in `src/git.ts`), passed to `main(argv, deps)` in `orch.ts`. Tests use the fakes in `tests/fakes.ts` and never touch a real Herdr session. See [`CLAUDE.md`](CLAUDE.md) for the details agents working on this repo need.
