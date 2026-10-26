---
description: Add an agent, change the default agent, or remove one
argument-hint: add <claude|cursor> | default <name> | remove <name>
allowed-tools: Bash(bun orch.ts agent:*), Bash(bun orch.ts setup:*)
---

With no arguments, run `bun orch.ts setup` and show its Agents section.

Otherwise run `bun orch.ts agent $ARGUMENTS` and report its output. If it refuses (the default agent, an agent a project uses as its default, or one an unfinished job uses), show the message as is: it names what's in the way and how to clear it.
