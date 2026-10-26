---
description: Start or continue a cross-project job across registered repos
argument-hint: <request> | list | show <id> | resume <id>
---

Load the `orchestrate-job` skill, then act on the arguments: `$ARGUMENTS`

- `list`: run `bun orch.ts job list` and show it.
- `show <id>`: show the job's stage, its agents and their status, and `jobs/<id>/summary.md`.
- `resume <id>`: follow the skill's Resume section, then continue the job from its current stage.
- Anything else is a new request: follow the skill's "Start a job" section.
