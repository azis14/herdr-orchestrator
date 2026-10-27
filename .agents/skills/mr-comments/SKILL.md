---
name: mr-comments
description: Use when writing a merge request or pull request review finding, the review's summary note, or a reply on a review thread (from /mr-review or the mr-fix process). Severity labels, comment shape, suggestions, the summary format and the reply style. Platform-neutral; a repo's own comment guidance overrides it.
---

# Writing MR/PR review comments and replies

Written for a general engineering reader. `bun orch.ts mr post|reply|note` does all posting and renders suggestions in the platform's syntax, so nothing here is GitLab- or GitHub-specific.

**Repo guidance wins.** If the repo has its own comment guidance (a skill or rule about review comments, e.g. its audience, tone or severity rules), follow it wherever it differs from this. Ignore its posting mechanics (API calls, scripts, suggestion fences): posting always goes through `orch mr`.

## A finding

One finding per thread. Four parts, in this order:

1. **Severity label**, then one sentence naming the problem.
2. **What triggers it and what results**: the concrete input or state, and what the user, the caller or the data ends up with.
3. **Fix**: what to change, specific enough to act on. Name the existing helper or file to reuse when there is one.
4. **Optional suggestion**, only when the fix is a few exact lines (below).

Labels: exactly one, bold, at the very start.

| Label | Use when |
|---|---|
| `**blocking:**` | Merging would cause wrong data, a security or permission hole, a crash, lost work or a broken start-up, or it breaks a rule the repo relies on. |
| `**should fix:**` | A real defect or rule break with limited reach: a missing test for changed behaviour, duplication of an existing helper, a misleading error. |
| `**nit:**` | A small improvement the author may skip. Use sparingly; never for anything the repo's linter or formatter catches. |

Rules:

- Lead with the problem. No praise, no "I noticed that…", no filler, no closing questions.
- Say what you verified (read, ran, traced) and what you only infer. Never state a guess as fact.
- State the blast radius when it isn't obvious ("this runs on every request", "only admins reach this").
- Prefer the concrete ("a guest can delete any comment") to the label ("authorization bypass").
- About 120 words, unless the suggestion needs more.

Example:

```markdown
**blocking:** A provider timeout is recorded as a successful charge.

`chargeCard` catches `TimeoutError` and returns `{ ok: true }` (verified by reading the catch at line 48), so `finalizeOrder` marks the order paid and ships it. Every timeout ships unpaid goods.

Fix: return `{ ok: false, retryable: true }`, as the other error paths in `src/payments/charge.ts` do.
```

## Suggestions

Give a suggestion as `{ "text", "above", "below" }` next to the body, never as a fenced block inside it. `text` is the full replacement for the commented line plus `above` lines before it and `below` lines after it, with the file's indentation; `above`/`below` default to 0. Never on a removed line (`side: "old"`), never for a finding that ends up in the summary, and only when it is the whole fix.

## Summary note

One per review. `orch mr post` posts it last (GitLab) or as the review body (GitHub).

```markdown
**Review summary** — reviewed <N> files at <short head sha>.

- blocking: <n> · should fix: <n> · nit: <n>
- Checks on the head: <check> <passed | failed | not run (reason)>, … (each check the repo has, e.g. lint, typecheck, tests)
- Needs owner review (CODEOWNERS): <changed paths and their owners, or "none">

**Not on a changed line**
- **should fix:** `path:line` — <one-line finding, same label and plainness as a thread>
```

- Counts cover every finding, inline or not.
- Drop the CODEOWNERS line when the repo has no CODEOWNERS file.
- Drop the "Not on a changed line" heading when there are none. Keep its spelling exactly when present: `orch mr post` adds inline comments that fail to post under that same heading.

No findings: one line, plus the checks line:

```markdown
No changes needed — reviewed <N> files at <short head sha>. <One line on what the MR does.>

- Checks on the head: …
```

## Replies (the mr-fix process)

Same plainness, shorter.

- **Fixed:** the short commit hash, then one or two sentences on what changed, and what the added test proves (e.g. "`3f2a1c9`: timeouts now return `retryable: true`; `charge.test.ts` covers a timeout and fails without the fix.").
- **Not fixed:** why, in one or two sentences, and what would settle it (a decision only the reviewer can make, the evidence the finding looks wrong, an owned path).
- **Findings from general notes:** one note listing each finding with its commit or its reason.

End every reply and note from the mr-fix process with this marker on its own last line. It is how a later run knows the thread is waiting on the reviewer:

```markdown
<!-- orch:mr-fix -->
```
