---
mrReview:
  skill: docs/review/SKILL.md   # repo-relative, read from the MR head checkout
  mode: read-only               # the only mode supported
  model: null                   # reserved
  checks: null                  # reserved
---
# shop-api: notes for the orchestrator

Copy this to `registry/projects/<project-name>.md` (local, git-ignored). Free-form notes:
conventions, gotchas, MRs not to merge.

## mr-review

Review with the repo's review skill in its read-only mode: report findings, change nothing.
Infer the ticket from the MR title or branch (`SHOP-123`). Payment code under `src/billing/`
needs a test for every changed branch.
