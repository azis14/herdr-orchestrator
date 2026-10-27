---
description: First-time setup - pick your agents and register your repos
allowed-tools: Bash(bun orch.ts setup:*), Bash(bun orch.ts agent:*), Bash(bun orch.ts project add:*), Bash(bun orch.ts project add-self), Bash(ls:*), Read, Glob, AskUserQuestion
---

Set this orchestrator up for the user. It's safe to run again: change only what they pick, never start over.

1. Run `bun orch.ts setup --json`.
2. If a prerequisite (`bun`, `herdr`, `git`) is missing, or `insideHerdr` is false, say what's missing, point to the README's Prerequisites section, and stop.
3. If `registry.exists` is true, first run `bun orch.ts project add-self` (it adds the orchestrator only if it's missing) and show its one-line result. Then show the registered agents (marking the default) and projects, and ask what they want to change. Do only that.
4. Agents: ask with AskUserQuestion (multiSelect), one option per agent in `agents`. For an installed one, the description says it's installed (and registered, if it is). For one that isn't found, label it "not found" and put its `install` command in the description; if they pick it anyway, tell them to install it first and skip it. Run `bun orch.ts agent add <name>` for each picked agent that isn't registered yet.
5. If more than one agent is registered, ask with AskUserQuestion which one is the default, then run `bun orch.ts agent default <name>`.
   If no agent is registered after this (none picked, or only ones that aren't installed), say they need to install one first and stop.
6. Run `bun orch.ts project add-self` and keep its one-line result for the summary. It registers the orchestrator repo itself and never asks anything; if it skipped, show why.
7. Projects: ask for the path of a repo to register. Register it by following the steps in `.claude/commands/register.md`. Then ask for the next one, until they say they're done.
8. Finish with a one-line summary (agents, default, the orchestrator's `add-self` result, projects) and suggest `/intro`.
