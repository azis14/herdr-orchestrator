---
description: Show every agent across Herdr workspaces, by project and job
allowed-tools: Bash(bun /home/user/orchestrator/orch.ts status:*), Bash(bun /home/user/orchestrator/orch.ts job list:*)
---

Run `bun /home/user/orchestrator/orch.ts status` and show the table.

Then run `bun /home/user/orchestrator/orch.ts job list`. For each job not at stage `done`, add one line: the job id, its stage, and what it's waiting on (an agent that is working, an agent that is blocked, or the user's approval at `design-review`, `plan-review` or `integrate`).
