---
description: Review a GitLab merge request or GitHub pull request of a registered project and post the findings on it
argument-hint: "<MR/PR URL | project id> [--dry-run]"
model: opus
effort: high
allowed-tools: Bash(bun orch.ts mr:*), Bash(bun orch.ts skills:*), Bash(git:*), Read, Grep, Glob, Agent, AskUserQuestion
---

Review the MR/PR in `$ARGUMENTS`: its URL, or a registered project and an id (`shop-api 42`, `shop-api !42`, `shop-ui #7`), plus `--dry-run` to post nothing and show every comment in chat instead. Invoking this command is the approval to post. If `$ARGUMENTS` names no MR, show the usage line above and stop.

Load the `reviewing-mrs` skill and follow it with that reference and flag.

If `bun orch.ts mr show` says several projects have the MR's origin, ask which one with AskUserQuestion: one option per project name in the error (more than 4: 3 per page plus "More…"). Never pick for the user. Then run it again with `<project> <id>`, the id being the number from the URL, and carry on.

If no registered project matches the URL, show the error (it names the host and path) and suggest `/register`.
