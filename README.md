# Herdr Orchestrator

The control room for a Herdr session. From this one directory you can:

- **open** an agent (Claude Code or Cursor) on any registered project with one command,
- see the **status** of every agent across Herdr workspaces, by project and job,
- run cross-project **jobs**: one agent per repo, driven through design → plan → build, with every question, decision and result reported back here.

## Prerequisites

- [Bun](https://bun.sh): runs `orch.ts` (no other dependencies to install).
- [Herdr](https://herdr.dev): the terminal workspace the agents live in. Run the orchestrator from inside a Herdr pane (`HERDR_ENV=1`).
- git: job agents work in their own worktrees.
- Optional, for `/mr-review` and `/mr-fix`: [`gh`](https://cli.github.com) for GitHub pull requests, [`glab`](https://gitlab.com/gitlab-org/cli) for GitLab merge requests, logged in.
- At least one agent CLI: [Claude Code](https://claude.com/claude-code) (`claude`) and/or [Cursor CLI](https://cursor.com/cli) (`cursor-agent`).
- Recommended for jobs: Claude job agents use your own Claude Code permission settings. With `"permissions": { "defaultMode": "auto" }` in `~/.claude/settings.json` they rarely stop to ask; without it, expect a permission prompt for most edits and commands, each routed back to you. (Cursor job agents run with `--force`.)

## Getting started

1. Clone this repo.
2. Inside Herdr, open Claude Code in the repo folder.
3. Run `/setup`. It checks the prerequisites, lets you pick your agents and a default, registers the orchestrator itself, then helps you register your repos.
4. Run `/intro` for a short tour.

Your registry (`registry/agents.json`, `registry/projects.json`), `docs/` and `jobs/` are local to you and ignored by git. `registry/*-example.json` show the file format.

Then, for example:

```
/open my-service                 # your default agent in a new tab of the project's workspace
/open my-service cursor          # or a specific agent
/open my-service --topic "login bug"   # tab labelled with a topic
/open my-service --continue      # pick up the newest session (asks which worktree first, if there are any)
/open my-service --resume        # pick a past session from a list
/status                          # every agent, by project and job
/job add a status field to the orders API and show it in the UI
```

## Slash commands

| Command | What it does |
| --- | --- |
| `/setup` | First-time setup: checks prerequisites, picks your agents and default, registers the orchestrator itself, then your repos. Safe to run again. |
| `/intro` | A short explanation of this tool. |
| `/open [project] [agent] [--continue \| --resume] [--topic T]` | Opens an agent in a new tab of the project's workspace (the workspace labelled with the project name; created if missing). Agent defaults to your default agent. If the project has git worktrees, it first asks which folder: the base folder or a worktree. `--continue` resumes the newest session in that folder; `--resume` lets you pick one. The agent is named after its kind (`claude`, then `claude-2`, ... since Herdr names are session-wide); the tab is labelled `T` if given, else Herdr numbers it as usual. |
| `/bash [project] [--topic T]` | Same tab placement and folder question, a plain terminal with no agent. |
| `/code [project \| path \| .]` | Opens a project's repo, or any directory, in VS Code. |
| `/status` | Shows every Herdr agent mapped to its project and job, plus what each open job is waiting on. |
| `/cleanup [workspace...]` | Lists dormant agents and closes only the ones you approve. |
| `/mr-review <MR/PR URL \| project id> [--checks] [--dry-run]` | Reviews a GitLab merge request or GitHub pull request of a registered project with parallel reviewer agents, verifies each finding, and posts the survivors as inline comments plus a summary. Checks are left to CI: only `--checks` also runs the repo's own lint, typecheck and tests on the head, in the background while the reviewers work (outside auto mode the repo's check commands aren't allowed in the background, so they are reported as not run). The review runs in the background (a `mr-review-runner` agent, which dispatches the reviewers and the verifier), so you can keep working or start another review meanwhile (not the same MR while its review is running in this session); the report comes back here. It needs the session scratchpad, and anything that needs you (a leftover pending GitHub review, a login problem) comes back as a stop with what to do. `--dry-run` posts nothing and shows every comment in chat. Invoking it is the approval to post. An MR URL is matched to a project by its `origin` remote's host and path, so an `origin` that uses an SSH host alias (e.g. `git@gitlab-work:group/repo.git`) won't match it, and `<project> <id>` would take the alias for the server's host name: point `origin` at the real host for `/mr-review` and `/mr-fix`. |
| `/mr-fix <MR/PR URL \| project id> [agent]` | Fixes the open review threads of an MR/PR in an agent tab of its project, in a worktree on the MR's own branch, watched from here (it waits on the agent in the background, so you can keep working). The agent commits and pushes to that branch, replies in each thread and resolves the fixed ones. Refuses fork MRs/PRs. |
| `/register <path> [name]` | Reads the repo, proposes a name, description and context files, and saves them after you approve. |
| `/unregister <project>` | Removes a project from the registry (refused while an unfinished job includes it). The repo itself is untouched. The orchestrator's own entry can't be removed. |
| `/agent add\|default\|remove <name>` | Adds Claude or Cursor, switches the default agent, or removes one. |
| `/job <request>` | Starts a cross-project job. Also `/job list`, `/job show <id>`, `/job resume <id>`. |

Whenever a command needs you to choose (a project, a folder, a session, which agents to close, approving a design), it shows the options as a picker rather than asking you to type. Leave out the project and the command asks for it.

## CLI

```
bun orch.ts open <project> [agent] [--topic T] [--folder F] [--continue | --resume ID]
bun orch.ts bash <project> [--topic T] [--folder F]
bun orch.ts folders <project> [agent] [--with-sessions] [--json]
bun orch.ts sessions <project> [agent] [--folder F] [--json]
bun orch.ts code <project | path | .>
bun orch.ts status [--json]
bun orch.ts cleanup [workspace...] [--idle 1h] [--json] | cleanup --close <pick...>
bun orch.ts setup [--json]
bun orch.ts agent add <claude|cursor> | agent default <name> | agent remove <name>
bun orch.ts project list [--json]
bun orch.ts project add <path> --description D [--name N] [--context a,b,c]
bun orch.ts project remove <name>
bun orch.ts skills [project] [--resolve <skill>] [--json]
bun orch.ts job new <slug> --title T --request R --projects a,b
bun orch.ts job list
bun orch.ts job show <id>
bun orch.ts job stage <id> <stage>
bun orch.ts job log <id> <text>
bun orch.ts job agent <id> <agentName> key=value...
bun orch.ts job spawn <id> <project> [agent] [--repo-worktree] [--trust]
bun orch.ts mr show <ref> [--fetch] [--json]
bun orch.ts mr threads <ref> [--json]
bun orch.ts mr position <ref> --path P --line N [--old-path O] [--side new|old] [--head SHA] [--json]
bun orch.ts mr post <ref> [--dry-run] [--head SHA] [--json] [--input FILE]
bun orch.ts mr note <ref> [--json]
bun orch.ts mr reply <ref> --thread ID [--json]
bun orch.ts mr resolve <ref> --thread ID [--json]
bun orch.ts mr worktree <ref> [--protect a,b] [--json]
```

`<ref>` is an MR/PR URL, or `<project> <id>` with the id as a bare number (`bun orch.ts mr show shop-api 42`). `note` and `reply` read their body from stdin; `post` reads the review JSON from `--input FILE` (so a background agent needs no shell redirect), else from stdin. `--head SHA` makes `position` and `post` refuse (exit 1, posting nothing) if the MR's head is no longer the SHA you reviewed. `mr post` exits 3, posting nothing, when a comment isn't on a changed line, and any error it raises before sending anything says "nothing was posted".

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

Both files are local (git-ignored); `/setup`, `/register`, `/unregister` and `/agent` write them. `registry/agents-example.json` and `registry/projects-example.json` show the format. Only Claude and Cursor are offered for now: a new agent kind also needs a skill under `.agents/skills/` that teaches the orchestrator how to drive it.

## Skills

Skill sources live in `.agents/skills/<name>/`, with `.claude/skills/<name>` symlinked to each.

- `orchestrate-job`: runs a job end to end
- `claude-code`, `cursor-cli`: how to start, prompt, read and unblock each agent through Herdr
- General-purpose skills (`brainstorming`, `writing-plans`, `executing-plans`, …) from [obra/superpowers](https://github.com/obra/superpowers), pinned in `skills-lock.json`

When a job agent needs a skill, it uses the repo's own copy if there is one, otherwise this orchestrator's copy by absolute path (`bun orch.ts skills <project> --resolve <skill>`). The orchestrator never installs or edits skills inside a repo.

## Ground rules

- **Repo rules win.** A repo's `CLAUDE.md`, `AGENTS.md`, rules and skills override the orchestrator's defaults for worktrees, base branch, branch names, env setup and where docs go.
- The orchestrator never pushes, opens merge requests, or answers an agent's permission dialog without you. The one exception: invoking `/mr-fix` approves its agent committing and pushing to that MR's own branch, and replying to and resolving the threads it fixed.
- `.claude/settings.json` (tracked) allows the calls a review makes, `bun orch.ts mr post` included, so a background `/mr-review` isn't stopped by permission prompts it can't answer. Invoking `/mr-review` without `--dry-run` is the approval to post. These allow rules apply to every session in this repo, not only `/mr-review`: `mr post` is allowed from any session here. Force-removal is allowed only for a review's own worktree (`git -C … worktree remove --force */mr-*/wt`, and `worktree add --detach */mr-*/wt <head>` to create it), never for another worktree. The same file denies `git -C … -c`, `--config-env`, `--output` and `--ext-diff`, which would let a `git -C` read run a configured command or write a file; no review call uses them.
- It only closes Herdr workspaces, tabs and panes it created.

## Development

```bash
bun test                       # all tests
bun test tests/open.test.ts    # one file
bun test -t "name collision"   # tests matching a name
```

All Herdr, git and forge calls go through injectable runners (`Runner` in `src/herdr.ts`, `GitRunner` in `src/git.ts`, `ForgeRunner` in `src/forge.ts`), passed to `main(argv, deps)` in `orch.ts`. Tests use the fakes in `tests/fakes.ts` and never touch a real Herdr session. See [`CLAUDE.md`](CLAUDE.md) for the details agents working on this repo need.

## License

[MIT](LICENSE). Vendored skills keep their upstream licenses:

- `brainstorming`, `executing-plans`, `finishing-a-development-branch`, `subagent-driven-development`, `writing-plans`: [obra/superpowers](https://github.com/obra/superpowers), MIT ([`third_party/superpowers-LICENSE`](third_party/superpowers-LICENSE))
- `herdr`: [herdrdev/herdr](https://github.com/herdrdev/herdr), Apache-2.0 ([`third_party/herdr-LICENSE`](third_party/herdr-LICENSE))
