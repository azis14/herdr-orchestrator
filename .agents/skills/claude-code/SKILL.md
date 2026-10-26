---
name: claude-code
description: Use when the orchestrator starts, prompts, reads, or answers a Claude Code agent in Herdr — opening Claude on a project, handing a job agent its task or a skill, reading its output, or handling it when it is blocked.
---

# Claude Code agents

How the orchestrator drives a Claude Code (`claude`) agent running in a Herdr pane. Herdr kind: `claude`. The `herdr` skill covers Herdr itself; this skill covers what is specific to Claude.

## Start

- **Interactive (the user takes over):** `bun orch.ts open <project> claude`. This opens a new tab in the project's workspace (creating the workspace if needed) and starts Claude with its normal defaults. Add `--topic T` to label the tab. `--folder F` opens it in one of the project's worktrees, and `--continue` / `--resume <id>` resumes a past session there (`bun orch.ts sessions <project> claude --folder F` lists them), so an interactive agent may already have history. The output line names the agent, e.g. `claude` (or `claude-2` if that name is already live anywhere in Herdr).
- **Job agent:** `bun orch.ts job spawn <job-id> <project> claude [--repo-worktree]`. No extra args: job agents inherit the user's permission settings. If `~/.claude/settings.json` sets `"permissions": { "defaultMode": "auto" }` they rarely stop for permission; otherwise expect frequent permission stops, and bring each one to the user.
- **Startup trust dialog.** In a directory Claude hasn't been trusted in, it shows "Accessing workspace … Is this a project you created or one you trust?" with `❯ No, exit` selected. Herdr reports this as `blocked`, and `agent start` fails with `agent_not_ready`. Worktrees of an already-trusted repo don't show it. Never answer it yourself. Ask the user with AskUserQuestion ("Trust this folder" / "Quit", naming the pane and directory) and send only what they pick: the number shown next to that option, `herdr pane send-keys <pane> <n>`. `/open` does this for its own agents.
- **After a failed job start,** the job records the agent as `start-failed`, with its pane and worktree. Once the dialog is answered and the agent is up, run `orch job spawn <job-id> <project>` again: it adopts the live agent without creating anything.

## Hand it a task

```bash
herdr agent prompt <name> "<task text>" --wait --timeout 600000
```

- `--wait` returns at the first settled state: `idle`, `done`, or `blocked`. A timeout or `agent_prompt_stalled` doesn't prove the prompt was lost. Read the screen before resending anything.
- **Pointing it at a skill.** Resolve the skill first: `bun orch.ts skills <project> --resolve <skill>`.
  - `repo <path>`: the repo has its own copy and Claude loads it natively. Invoke it by name: `/<skill> <task>`.
  - `orchestrator <path>`: say "Read and follow the skill at `<path>`" followed by the task.
- **Job prompts always end with the stop rules** (below).

## Read state and output

```bash
herdr agent get <name>                                   # agent_status: working | idle | done | blocked
herdr agent read <name> --source recent-unwrapped --lines 200
```

If a long answer doesn't fit in what `read` recovers, ask Claude to write it as Markdown to a temp file and reply with only the path, then read that file. Use this as a fallback only, never in the first prompt.

## When it's blocked

Read the screen (`--source visible`) and tell which of these it is:
- **A question for the user.** Claude asks in prose or with a numbered choice list (AskUserQuestion). Route it as the `orchestrate-job` skill says.
- **A permission or approval dialog.** A box naming a tool call (e.g. `Bash(git push …)`, an edit), with numbered options like `1. Yes`, `2. Yes, and don't ask again …`, `3. No`. **Never answer it without the user's explicit instruction.** Show the user the agent, the project and the exact request, then send exactly their choice:
  ```bash
  herdr agent send-keys <name> 1        # or the number they chose; esc to cancel
  ```

## Stop rules for every job prompt

Paste this block verbatim at the end of every task you give a job agent:

```
Stop rules (from the orchestrator):
- Do not git push and do not open merge requests. Stop and say you are ready to push.
- Do not add or change environment variables, feature flags, secrets, runtime settings, operation contracts, permissions, gates, hooks, or anything that writes to live infrastructure. If you need one, stop and ask.
- Follow this repo's own rules (CLAUDE.md, AGENTS.md, rules files) wherever they say more than these.
- When you finish a stage, reply with a short report: what you did, the path of any document you wrote, and any open questions.
```

## Quirks

- It loads `CLAUDE.md`, `.claude/rules`, `.claude/skills` and `.claude/commands` from its working directory natively. It doesn't read `AGENTS.md` unless `CLAUDE.md` points to it.
- Auto mode can still refuse or ask before risky actions (pushes, destructive commands). Those show up as `blocked`.
- In a `--repo-worktree` job, Claude creates its own worktree using the repo's flow (e.g. a repo's own worktree command). Afterwards, record it with `orch job agent <id> <name> worktreePath=… branch=…`.
