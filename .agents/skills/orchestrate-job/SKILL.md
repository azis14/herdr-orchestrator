---
name: orchestrate-job
description: Use when the user hands the orchestrator a piece of work that spans one or more registered projects (e.g. "change X in the API and the UI"), or asks to list, resume, check on, or update a job. Drives one agent per repo through design → plan → build with central reporting, cross-repo question answering, and approval stops.
---

# Orchestrate a cross-project job

You are the orchestrator. Agents work in their repos; you hold the full picture, answer what one repo can learn from another, and bring the user only what needs them. The user should never have to visit an agent's pane.

Mechanics go through the script (`bun orch.ts …`, run from the orchestrator root, written `orch` below). Judgment stays with you. For driving each agent, use the `claude-code` or `cursor-cli` skill; for Herdr itself, the `herdr` skill.

Job record: `jobs/<id>/job.json` (state, agents), `summary.md` (what the user reads), `log.md` (every routed question and answer, every instruction forwarded).

## Hard rules

- Never answer an agent's permission or approval dialog without the user's explicit instruction. Show them the exact request and send exactly their answer.
- Never push, open a merge request, or merge unless the repo's own rule says to at that point, or the user says so.
- Where a repo reserves a sign-off for a **named maintainer** (per that repo's rules), pause that agent and tell the user whose approval is needed. Neither you nor the user substitutes for it.
- Repo rules win. A repo's `CLAUDE.md`, `AGENTS.md`, rules files and repo skills override the mechanics here wherever they speak.
- Never close a workspace, tab or pane, or remove a worktree, that this job didn't create, and ask the user before removing the ones it did.

## 1. Start a job

1. Agree with the user on the projects involved and a short slug.
2. `orch job new <slug> --title "<title>" --request "<the user's request, in their words>" --projects a,b`
3. For each project, read the context files listed in `registry/projects.json`, then decide:
   - **Worktree mode.** If the repo defines its own worktree flow (e.g. a repo command that creates its worktree), use `--repo-worktree`. Otherwise use the default, a fresh herdr worktree off `origin/dev` on `feature/<job-id>`.
   - **Required ids.** If the repo's flow needs a REQ/SPEC/TASK id, ask the user for it now.
   - **Agent.** Claude unless the user named Cursor for this job or project.
4. `orch job spawn <id> <project> [agent] [--repo-worktree]` for each project, **one at a time** (each spawn rewrites `job.json`). Never add `--trust` (Herdr repository trust) unless the user asked; if Herdr refuses for trust, ask the user.
   - Job agent names are `<project>-<slug>-<hash>`, unique per job. If a spawn fails with `start-failed` (e.g. a startup trust dialog), the pane and worktree are already recorded. Resolve the dialog with the user, then run `job spawn` again to adopt the agent.
5. Tell the user what was spawned (`orch status`).

## 2. Design

- Resolve the skill per repo: `orch skills <project> --resolve brainstorming`. Prompt each agent as its agent skill says: the job request, the other repos in the job and their roles, "write the design where this repo's conventions put designs", and the stop rules.
- When an agent reports its design, record it: `orch job agent <id> <name> designPath=<path> status=designed`.

## 3. Question routing loop (all stages)

Wait on agents (`herdr agent wait <name> --timeout …`, or poll `orch status --json` across them). When one is `blocked` or has stopped with a question, read its screen and classify:

| What it is | What you do |
|---|---|
| A question about **another repo** in the job ("what does this endpoint return?") | Answer from that repo: ask its agent (`herdr agent prompt`) or read its code. Relay the answer and `orch job log` it. |
| That answer is a **guess**, not confirmed in code | Take it to the user as a suggested answer. |
| **Intent, scope or priority** ("should this paginate?") | Take it to the user. Batch questions across agents, tagged `[project]`, most important first. A question with a set of options (the agent's own multiple choice) goes as AskUserQuestion with those options. Forward each answer to the asking agent, attributed to the user, and log it. |
| A **permission or approval dialog** | Take it to the user with AskUserQuestion: the agent, the project and the exact request in the question, the dialog's own options as the options. Send only the option they pick. |
| A **gate reserved for named maintainers** | Pause it and tell the user whose approval is needed. |

When the user gives new instructions for any agent, forward them with `herdr agent prompt` and log them.

## 4. Summary

Fill `jobs/<id>/summary.md` as you go:
- **Designs:** link each repo's design.
- **Cross-repo contract:** what the providing repo will expose (endpoints, payload shapes, events) and what the consuming repo expects, side by side, with mismatches flagged. This is the part the user would miss by reading the designs separately.
- **Questions answered across repos / by the user:** a short list pointing into `log.md`.
- **Open items.**

## 5. Approval stop: designs

`orch job stage <id> design-review`. Present the summary and the design links, then ask with AskUserQuestion: "Approve" / "Request changes" / "Stop here". On "Approve" → `orch job stage <id> plan`. On "Request changes", ask what to change (free text), forward it to the agents and loop. On "Stop here", leave the job at its stage.

## 6. Plan

Resolve `writing-plans` per repo and prompt each agent to plan from its approved design. Record `planPath=`, add the plans to the summary, then `orch job stage <id> plan-review` → ask the same "Approve" / "Request changes" / "Stop here" question → on "Approve", `orch job stage <id> build`.

## 7. Build

- **Order:** the repo that provides the contract builds first (e.g. the API before the UI). When it's done, read the real request/response shapes from its code and give them to the consuming repo's agent, not the design's guess.
- **Worktree setup:** copy env files and run installs only where that repo's rules say to. Otherwise, if an agent can't run or test something without them, bring that to the user as a question instead of working around it.
- Record commits, test results and any divergence from the design under **Build results**.

## 8. Integrate

`orch job stage <id> integrate`. For each repo, follow its push/MR rule if it has one; if it has none, ask the user whether to push and open an MR (a yes/no AskUserQuestion). Then ask before cleaning up (also yes/no), and finish with `orch job stage <id> done`.

**Cleanup scope:** close a job agent's workspace only if its record has `createdWorkspace: true`. Otherwise the workspace is the user's (e.g. a repo-worktree job's), so close only the record's `tabId`. Remove a worktree only if the job created it (`mode: herdr-worktree`); a `repo-worktree` worktree follows the repo's own cleanup flow.

## 9. Resume

On a new session or `/job resume <id>`: run `orch job list`. For each job not at `done`, compare `job.json` against `orch status --json`. An agent whose pane is gone gets `orch job agent <id> <name> status=stopped`. Then `orch job spawn <id> <project>` reopens its recorded worktree in a new workspace and keeps its recorded design/plan paths; no new branch is created. An agent that `/cleanup` stopped also has `sessionId` and `lastCwd` in its record: `job spawn` reopens it in `lastCwd` and resumes its conversation (the output ends `resumed session <id>`, or `(fresh: no session to resume)`). It already has its context, so tell it what's next; don't re-brief it. If `job spawn` prints the fresh note, the agent has no memory of the job: re-brief it from `summary.md` and `log.md`. "resumed session X" only means the agent started: if the agent shows no memory of the job, its session id is in `log.md`, so re-brief it from `summary.md` and `log.md`. Re-read `summary.md` and the tail of `log.md` before acting.
