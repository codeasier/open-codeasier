---
name: cross-review-audit
description: Audit one explicit cross-review parent session for protocol compliance and role behavior.
---

# Cross-Review Audit

Parse `$ARGUMENTS` as `<parent-session-id> [--run-id <id>] [focus]`. Require exactly one parent session ID. Reject unknown flags, missing flag values, duplicate flags, or a second parent ID. `--run-id` is optional; any leftover text is optional `focus`.

Call only `cross_review_audit` with that parent session ID and optional `runID` / `focus`. Treat the returned JSON as the complete available evidence. Never search OpenCode internal storage, never glob `~/.local/share/opencode`, never open OpenCode DB paths, and never infer a session the payload did not name. Do not call `session_review` for IDs the audit tool did not return. Do not treat `patch` parts as reviewer writes.

If the tool returns `SESSION_NOT_FOUND`, `SESSION_ACCESS_DENIED`, `SESSION_EMPTY`, or `SDK_FAILURE`, grade **P0** and stop. If it returns `RUN_NOT_FOUND` or `RUN_ID_AMBIGUOUS`, report that resolution error and stop.

Write a report from the payload only:

1. Executive Summary
2. Run list
3. Check table (`id`, result, detail, run, role)
4. Parent protocol behavior (timeline counts and selected args; never invent omitted `timeoutAction` or other omitted fields)
5. Gatherer / reviewer / judge behavior (tool histograms, denied or `invalid` attempts, shared-context marker, final assistant text or `finish=tool-calls`)
6. Worst severity
7. Assumptions
8. Residual gaps

Do not score finding quality, original-PR severity, or judge vote correctness.

Severity (worst item wins):

- **P0** evidence unavailable (parent, SDK, or store unreadable).
- **P1** model mismatch, tools-deny miss, isolation or parent-link break, reviewer children, silent model replace, or legacy blocking `cross_review` used as the review path.
- **P2** context contract broken; reviewer wander, bash, or search loop without shared context; `timeout_pending` resolved without a user `timeoutAction`; gatherer/judge role bleed.
- **P3** polling waste (repeated finalize while non-terminal, client-side sleep instead of `waitMs`), extra starts that did not replace a cancelled run.

If `runs.found` failed and a blocking `cross_review` call exists, explain that there is no protocol tree. If `runs.found` failed and there are no protocol tools, say this session did not use cross-review. Never claim omitted or truncated content.
