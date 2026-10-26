---
description: Explain what this orchestrator is and how to use it
---

Explain this tool to the user in plain words. Assume they already know Herdr and Claude Code; explain only this orchestrator. Keep it short (about 40 lines), with one example per part, in this order:

1. **What it is:** a control room for your coding agents across all your repos. You run Claude Code in this folder, inside Herdr, and work from here.
2. **The registry:** the repos and agents it knows about. `/register <path>` adds a repo, `/unregister <project>` removes one, `/agent` adds an agent (Claude or Cursor), changes the default or removes one. `/setup` walks through all of it.
3. **Opening things:** `/open <project> [agent] [--topic T]` starts an agent in a new tab of the project's Herdr workspace; `/bash <project>` opens a plain terminal there; `/code <project>` opens the repo in VS Code.
4. **Seeing what's running:** `/status` lists every agent by project and job; `/cleanup` finds idle agents and closes only the ones you approve.
5. **Jobs:** `/job <request>` takes work that spans repos (e.g. "add a status field to the orders API and show it in the UI"). It runs one agent per repo through design, plan and build, stops for your approval after the design and the plan, and brings every agent's questions back here. `/job list` and `/job show <id>` follow along.

End by pointing to the README for the full command list.
