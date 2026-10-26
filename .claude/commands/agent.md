---
description: Add an agent, change the default agent, or remove one
argument-hint: add [claude|cursor] | default [name] | remove [name]
allowed-tools: Bash(bun orch.ts agent:*), Bash(bun orch.ts setup:*), AskUserQuestion
---

With no arguments, run `bun orch.ts setup` and show its Agents section.

If a subcommand has no name, ask with AskUserQuestion, from `bun orch.ts setup --json`: for `add`, the agents not registered yet (description: installed, or "not found" with its install command); for `default` and `remove`, the registered agents (marking the current default). Then run it with the picked name.

Otherwise run `bun orch.ts agent $ARGUMENTS` and report its output. If it refuses (the default agent, an agent a project uses as its default, or one an unfinished job uses), show the message as is: it names what's in the way and how to clear it.
