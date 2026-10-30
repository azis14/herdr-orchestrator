---
description: Explain what this orchestrator is and how to use it
---

Explain this tool to the user in plain words. Assume they already know Herdr and Claude Code; explain only this orchestrator. Keep it short (about 40 lines), with one example per part, in this order:

1. **What it is:** a control room for your coding agents across all your repos. You run Claude Code in this folder, inside Herdr, and work from here.
2. **The registry:** the repos and agents it knows about. `/register <path>` adds a repo, `/unregister <project>` removes one, `/agent` adds an agent (Claude, Cursor or OMP), changes the default or removes one. `/orch-setup` walks through all of it.
3. **Opening things:** `/open <project> [agent] [--topic T]` starts an agent in a new tab of the project's Herdr workspace; `--continue` picks up the newest session and `--resume` lets you pick a past one. If the project has worktrees, it first asks which folder. `/bash <project>` opens a plain terminal there; `/code <project>` opens the repo in VS Code.
4. **Seeing what's running:** `/status` lists every agent by project and job; `/cleanup` finds idle agents and closes only the ones you approve.
5. **Jobs:** `/job <request>` takes work that spans repos (e.g. "add a status field to the orders API and show it in the UI"). It runs one agent per repo through design, plan and build, stops for your approval after the design and the plan, and brings every agent's questions back here. `/job list` and `/job show <id>` follow along.
6. **Reviewing and fixing MRs/PRs:** `/mr-review <project> <id>` (or the MR/PR URL) has reviewer agents check a GitLab MR or GitHub PR in the background (you stay free, and can start another review), verifies each finding, and posts the survivors as inline comments (`--dry-run` shows them here instead). Lint and tests are left to CI unless you add `--checks`. `/mr-fix <project> <id> [agent]` opens an agent on the MR's branch to fix the open threads, then commits, pushes, replies and resolves them. Invoking either is your approval to post or push.

Mention that whenever a command needs a choice (a project, a folder, a session, which agents to close, approving a design), it shows a picker instead of asking them to type.

End by pointing to the README for the full command list.
