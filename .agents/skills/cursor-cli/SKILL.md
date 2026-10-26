---
name: cursor-cli
description: Use when the orchestrator starts, prompts, reads, or answers a Cursor CLI agent in Herdr — opening Cursor on a project, handing a job agent its task or a skill, reading its output, or handling its workspace-trust dialog.
---

# Cursor CLI agents

How the orchestrator drives a Cursor CLI (`cursor-agent`) agent running in a Herdr pane. Herdr kind: `cursor`. The `herdr` skill covers Herdr itself; this skill covers what is specific to Cursor.

## Start

- **Interactive (the user takes over):** `bun orch.ts open <project> cursor`. Cursor starts with its normal defaults.
- **Job agent:** `bun orch.ts job spawn <job-id> <project> cursor [--repo-worktree]`. Job agents launch with `--force` (run everything not explicitly denied).
  - In a **job-created worktree** they also get `--trust`. Job worktrees are new directories, and without it every one of them stops at the trust dialog.
  - In **`--repo-worktree` mode** they start in the user's own checkout **without** `--trust`, because that flag would permanently trust the user's checkout. Check that pane for the trust dialog, as for an interactive agent (below).
- The user's `~/.cursor/cli-config.json` has `approvalMode: "unrestricted"`, so the status bar shows **Run Everything** even without `--force`.

## The workspace-trust dialog (read before every first prompt)

In a directory Cursor hasn't trusted, it shows a box: **"⚠ Workspace Trust Required … Do you trust the contents of this directory? [a] Trust this workspace [q] Quit"**.

**Herdr reports this dialog as `idle`, not `blocked`.** Anything you send with `agent prompt` gets typed into the dialog: any `a` in the text trusts the workspace and any `q` quits. So before the first prompt to an interactive (`orch open`) Cursor agent:

```bash
herdr agent read <name> --source visible --lines 40
```

If the screen shows "Workspace Trust Required", don't prompt. Tell the user which pane and directory, and let them answer it, or send `a` only if they explicitly tell you to. Job agents in job-created worktrees start with `--trust` and never show it; `--repo-worktree` job agents can.

## Hand it a task

```bash
herdr agent prompt <name> "<task text>" --wait --timeout 600000
```

- `--wait` returns at the first settled state. A timeout or `agent_prompt_stalled` doesn't prove the prompt was lost. Read the screen before resending.
- **Pointing it at a skill.** Cursor doesn't load Claude skills, so **always** use the path form. Resolve it with `bun orch.ts skills <project> --resolve <skill>`, then say "Read and follow the skill at `<path>`" followed by the task.
- **Job prompts always end with the stop rules** (below).

## Read state and output

```bash
herdr agent get <name>
herdr agent read <name> --source recent-unwrapped --lines 200
```

A finished reply appears above the `→ Add a follow-up` input line. If a long answer doesn't fit, ask Cursor to write it as Markdown to a temp file and reply with only the path. Use this as a fallback only.

## When it's blocked

Read the screen and tell which it is: a question for the user (route it as the `orchestrate-job` skill says), or an approval prompt. Approval prompts are rare under Run Everything, but a deny rule or the sandbox can still raise one. **Never approve one without the user's explicit instruction.** Show them the exact request and send exactly their answer with `herdr agent send-keys <name> <key>`.

## Stop rules for every job prompt

Paste this block verbatim at the end of every task you give a job agent:

```
Stop rules (from the orchestrator):
- Do not git push and do not open merge requests. Stop and say you are ready to push.
- Do not add or change environment variables, feature flags, secrets, runtime settings, operation contracts, permissions, gates, hooks, or anything that writes to live infrastructure. If you need one, stop and ask.
- Follow this repo's own rules (AGENTS.md, .cursorrules, .cursor/rules, CLAUDE.md) wherever they say more than these.
- When you finish a stage, reply with a short report: what you did, the path of any document you wrote, and any open questions.
```

## Quirks and risk

- It loads `AGENTS.md`, `.cursorrules` and `.cursor/rules` natively, but not `.claude/skills`, so pass skills by path.
- **Nothing hard-blocks `git push`.** With Run Everything / `--force` and an empty `deny` list, Cursor will run any command, so the stop rules are the only guard. If the user wants a hard block, they can add a deny rule for `git push` to `~/.cursor/cli-config.json` themselves. Don't edit it for them.
- The status bar shows the model and the context-use percentage (e.g. `Grok 4.6 Medium Fast · 5%`). A high percentage on a long job is a reason to start a fresh agent for the next stage.
