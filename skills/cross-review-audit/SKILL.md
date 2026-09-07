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
2. Run list (phase, `finalStatus`, evidence source from `snapshot.source` / `adapterGatherer` / `hasContext`, `judgeModel` or parent judging)
3. Check table (`id`, result, detail, run, role)
4. Parent protocol behavior (timeline counts, `protocolCallCount` / `protocolTimelineOmitted`, and selected args; never invent omitted `timeoutAction` or other omitted fields). Grade polling from counts, not only the capped list. Per-run timelines are attributed by `runID`; unattributed calls may appear on every run. Note whether a `cross_review_config` preview preceded the first `cross_review_start`. Timeline results carry `readyToFinalize`, `actionRequired` (roles that entered `timeout_pending`), and `warning` (for example a stray `timeoutAction`); rejected calls carry `error`. Grade the timeout decision from those fields plus each role's `timeoutDetectedAt` / `timeoutExtensions`: a status with `actionRequired` should be followed by exactly one status with `timeoutAction`, and a `timeoutAction` on a poll whose result carries the stray warning was pre-sent. A `cross_review_cancel` after `completed` is snapshot cleanup, not a cancelled review.
5. Gatherer / reviewer / judge behavior (tool histograms, denied or `invalid` attempts, shared-context marker from the embed sentence or snapshot worktree language, final assistant text or `finish=tool-calls`). `hasSharedContextMarker` means the prompt named shared evidence, not that those files were read. When the LLM gatherer is `failed`, `timed_out`, or `cancelled`, the run degraded to independent fetching by design and reviewers legitimately lack the marker. `adapterGatherer` is the PR snapshot adapter: no model, no session, and never a reviewer slot.
6. Worst severity
7. Assumptions
8. Residual gaps

Do not score finding quality, original-PR severity, or judge vote correctness.

Severity (worst item wins):

- **P0** evidence unavailable (parent, SDK, or store unreadable).
- **P1** model mismatch, tools-deny miss (a write tool absent or any `READ_ONLY_TOOLS` key enabled), `role.session.directory` or parent-link break, reviewer children, silent model replace, or legacy blocking `cross_review` used as the review path.
- **P2** `run.evidence_contract` broken (neither persisted shared evidence nor a judge gatherer); reviewer wander, bash, or search loop without shared evidence; `timeout_pending` resolved without a user `timeoutAction`; gatherer/judge role bleed; a PR target started with a large `contextLength` (the parent fetched the diff itself).
- **P3** polling waste (repeated finalize while non-terminal, client-side sleep instead of `waitMs`), extra starts that did not replace a cancelled or failed run, a missing `cross_review_config` preview.

`adapter.gather` fail is a `gh` / gitcode-cli or network failure that stopped the run before any reviewer existed; report it with its error in the run list, not as a protocol break, and grade the parent only on what it did next. A `role.prompt.tools_deny` pass whose detail lists absent primary-session-gated keys means the prompt predates those keys; it is not a finding. If `runs.found` failed and a blocking `cross_review` call exists, explain that there is no protocol tree. If `runs.found` failed and there are no protocol tools, say this session did not use cross-review. Never claim omitted or truncated content. Treat `errors[]` as directory-scoped: a corrupt manifest from the whole run-store can appear even when it belongs to another owner. Prompt-level fails on `queued` or never-started `cancelled` roles are not protocol breaks.
