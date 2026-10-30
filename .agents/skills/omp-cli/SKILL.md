---
name: omp-cli
description: Use when the orchestrator starts, prompts, reads, or answers an OMP (Oh My Pi) agent in Herdr — opening OMP on a project, handing a job agent its task or a skill, reading its output, or handling it when it is blocked.
---

# OMP agents

How the orchestrator drives an Oh My Pi (`omp`) agent running in a Herdr pane. Herdr kind: `omp`. The `herdr` skill covers Herdr itself; this skill covers what is specific to OMP.

## Start

- **Interactive (the user takes over):** `bun orch.ts open <project> omp`. Opens a new tab in the project's workspace and starts OMP with its normal defaults. The output names the agent `omp` (or `omp-2` if that name is already live anywhere in Herdr).
- **Job agent:** `bun orch.ts job spawn <job-id> <project> omp [--repo-worktree]`. Job agents launch with `--approval-mode yolo`, so they auto-approve `read`/`write`/`exec` tool calls and rarely stop for permission.
- **No workspace-trust dialog.** OMP has no Claude/Cursor-style "trust this folder" prompt on startup. The OMP Herdr integration (`herdr integration install omp`) reports the agent's lifecycle state (`working`/`idle`/`blocked`) and session identity over Herdr's socket API, so Herdr reads state from the integration rather than the screen.

## Hand it a task

```bash
herdr agent prompt <name> "<task text>" --wait --timeout 600000
```

- `--wait` returns at the first settled state: `idle`, `done`, or `blocked`. A timeout or `agent_prompt_stalled` doesn't prove the prompt was lost. Read the screen before resending anything.
- **Pointing it at a skill.** Resolve the skill first: `bun orch.ts skills <project> --resolve <skill>`.
  - `repo <path>`: OMP loads `.claude/skills` and `.agents/skills` natively, so it already has the repo's copy. Invoke it by name: `/skill:<skill> <task>`.
  - `orchestrator <path>`: say "Read and follow the skill at `<path>`" followed by the task.
- **Job prompts always end with the stop rules** (below).

## Read state and output

```bash
herdr agent get <name>                                   # working | idle | done | blocked
herdr agent read <name> --source recent-unwrapped --lines 200
```

If a long answer doesn't fit in what `read` recovers, ask OMP to write it as Markdown to a temp file and reply with only the path, then read that file. Use this as a fallback only, never in the first prompt.

## When it's blocked

`blocked` means someone is needed: a question for the user, or an approval prompt a `tools.approval` policy forced (yolo auto-approves everything else). Read the screen (`herdr agent read <name> --source visible`) and tell which:

- **A question for the user** (the `ask` tool, or prose): route it as the `orchestrate-job` skill says.
- **An approval prompt**: **never answer it without the user's explicit instruction.** Show them the agent, the project and the exact request, then send exactly their answer with `herdr agent send-keys <name> <key>`.

## Stop rules for every job prompt

Paste this block verbatim at the end of every task you give a job agent:

```
Stop rules (from the orchestrator):
- Do not git push and do not open merge requests. Stop and say you are ready to push.
- Do not add or change environment variables, feature flags, secrets, runtime settings, operation contracts, permissions, gates, hooks, or anything that writes to live infrastructure. If you need one, stop and ask.
- Follow this repo's own rules (AGENTS.md, CLAUDE.md, rules files) wherever they say more than these.
- When you finish a stage, reply with a short report: what you did, the path of any document you wrote, and any open questions.
```

## Quirks and risk

- OMP's default approval mode is already `yolo`; job agents pass `--approval-mode yolo` explicitly so a stricter `tools.approvalMode` in `~/.omp/agent/config.yml` can't make them stall.
- Even in yolo, a user `tools.approval.<tool>: prompt` or `deny` policy is honored, so a job agent can still block on a tool you told it to prompt for. That's the one place a yolo job agent asks for approval.
- It loads `AGENTS.md` and `.agents/skills`/`.claude/skills` natively from its working directory.
- **Nothing hard-blocks `git push`.** With yolo, OMP will run any command, so the stop rules are the only guard. If you want a hard block, set `tools.approval.git: deny` (or `prompt`) in OMP's config yourself. Don't edit it for them.
- A high context-use on a long job is a reason to start a fresh agent for the next stage.
