# Cross-review audit

## Motivation

Cross-review now spans a parent skill session plus isolated gatherer, reviewer, and judge sessions. `session_review` can read only one explicit session and must not infer another. A one-off local audit already showed that prompt-level model, tools-deny, and isolation can be checked, and that parent protocol mistakes (missing `context` without a judge, finalize busy-wait, reviewer bash attempts) do not show up in a single-session review. This change adds a first-class audit that takes a parent session ID, walks every owned run, and reports protocol compliance plus role behavior — not finding quality.

## Scope

Add `/cross-review-audit <parent-session-id> [--run-id <id>] [focus]`.

- Plugin tool `cross_review_audit`: primary-session only, read-only, callable from a different primary session than the owner. Resolves run manifests, fetches parent and role sessions through the OpenCode SDK, and returns a bounded tree plus deterministic checks.
- Skill and command: interpret only that payload into a report (check table, per-role behavior, worst P0–P3). Never search OpenCode internal storage, never infer sessions absent from the payload, never call `session_review` to walk the tree.
- Run-store read API that lists and reads manifests without writing, locking for mutation, or bumping `updatedAt`.

Out of scope: judging review findings, mutating or cancelling runs, Codex workflow generation, OpenCode DB access, automatic session discovery without an explicit parent ID.

## Observable requirements

### Invocation

1. Command `/cross-review-audit` loads the `cross-review-audit` skill with `$ARGUMENTS`.
2. Arguments: required parent session ID; optional `--run-id`; optional trailing `focus`. Reject unknown flags, missing values, duplicate flags, or more than one parent ID.
3. `--run-id` accepts a stored UUID, or an unambiguous prefix of at least 8 hex characters among that owner's listed runs. Unknown → `RUN_NOT_FOUND`. Ambiguous prefix → `RUN_ID_AMBIGUOUS`.
4. The tool is registered on the plugin next to `session_review`, added to `PRIMARY_TOOL_IDS`, and added to `READ_ONLY_TOOLS` so gatherer/reviewer/judge prompts cannot call it.
5. `assertPrimarySession` runs before any store or SDK read of the target tree. Child callers fail closed, same wording family as `session_review`.
6. Owner-session and directory equality required by `cross_review_status|cancel|finalize` do **not** apply. Audit is read-only and may inspect another session's runs on this machine.

### Resolution

7. Default: every manifest whose `ownerSessionID` equals the supplied parent ID, sorted by `createdAt` ascending. `--run-id` filters that set.
8. Directory is recorded, not used as a hard filter. If some matching runs have a different `directory` than the caller, include them and set `directoryMismatch: true` on those runs.
9. Listing and reading manifests must not call `withRun` (that path saves and updates `updatedAt`) and must not delete files. Corrupt manifests become `errors[]` entries; they do not fail the whole audit. `errors[]` is directory-scoped: an unparseable file from the whole run-store appears even when it belongs to another owner.
10. A parent with zero manifests is a successful tool result with `runs: []` and check `runs.found` = `fail`, plus any parent protocol-tool evidence (including legacy `cross_review`). Do not throw.
11. Parent session unreadable through the SDK maps to the same safe error family as `session_review` (`SESSION_NOT_FOUND`, `SESSION_ACCESS_DENIED`, `SESSION_EMPTY`, `SDK_FAILURE`) without leaking paths or tokens. If the parent is `SESSION_NOT_FOUND` in the caller directory, try each distinct matching run directory before failing.

### Evidence

12. Reuse `fetchSessionReviewInput` / `normalizeSession` for message bounds. Audit-specific extraction must also retain, for each kept user message: `model` (`providerID`/`modelID` or equivalent), `agent`, `tools` map, and `id`. Current summary/troubleshoot normalize may keep dropping those fields.
13. Fetch the parent once and each distinct role `sessionID` once. Gatherer and judge that share a session are one fetch; split by `messageID`.
14. Do not fetch a session ID that is not the parent or a manifest role ID. Isolation is inferred from: role `parentID` equals the owner; prompt `tools.task === false`; no successful `task` tool part. If the SDK cannot list children of a role session, check `role.no_children` is `insufficient-evidence` unless a successful `task` part is present (then `fail`).
15. Parent evidence keeps every `cross_review`, `cross_review_start`, `cross_review_status`, `cross_review_cancel`, and `cross_review_finalize` tool part (input + status). Other parent messages follow existing byte/message caps. Child evidence keeps the linked user prompt and tool parts (including `invalid` / denied `bash`).
16. Never claim omitted or truncated content. Each role session and the parent carry `truncated` / omitted counts. A check that needs omitted data is `insufficient-evidence`.
17. In-progress runs (`phase` not in `completed`, `quorum-not-met`, `failed`, `cancelled`) are included. Checks about terminal wrap-up are `insufficient-evidence`. Roles that were never dispatched (`queued`, or `cancelled` without `startedAt`) yield `insufficient-evidence` on prompt-level checks; so do `cancelled`/`failed` roles whose linked user message is absent from a non-omitted session. Fail only when a dispatched, prompted role is missing or mismatched. A visible prompt-model mismatch fails even when that session is truncated; truncation only yields `insufficient-evidence` for comparisons that need the omitted region.

### Deterministic checks (tool)

Each check is `{ id, result: "pass" | "fail" | "insufficient-evidence", detail }`.

| id                                | pass when                                                                                                                        |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `runs.found`                      | at least one owner manifest, or `--run-id` resolved                                                                              |
| `run.legacy_tool.absent`          | parent has no `cross_review` (blocking) tool call                                                                                |
| `run.context_contract`            | no `judgeModel` ⇒ persisted `context` non-empty; `judgeModel` and no context ⇒ `gatherer` object exists (any gatherer status)    |
| `run.silent_model_replace.absent` | every reviewer/gatherer/judge prompt model equals the manifest `provider/model`; no extra dispatched model                       |
| `role.session.linked`             | session exists; `parentID` is the owner; title/agent match the role (`cross-reviewer`; title contains the runID prefix and role) |
| `role.prompt.messageID`           | user message `id` equals the manifest `messageID`                                                                                |
| `role.prompt.model`               | that user message model equals the manifest model                                                                                |
| `role.prompt.tools_deny`          | every key in `READ_ONLY_TOOLS` is `false` on that user message                                                                   |
| `role.orchestration.absent`       | role session has no `cross_review*` / `session_review` / `cross_review_audit` tool calls                                         |
| `role.no_children`                | see requirement 14                                                                                                               |
| `gatherer.judge_session`          | when both exist: same `sessionID`, different `messageID`                                                                         |
| `gatherer.skipped_when_context`   | persisted `context` ⇒ no gatherer object                                                                                         |

Empty `context` is omitted, matching start/gather rules.

### Behavioral evidence (tool emits, skill judges)

18. Per run, emit a compact parent protocol timeline attributed by `runID` from start outputs and status/cancel/finalize args. Unattributed calls remain on every run. Each start/status/cancel/finalize/legacy call includes time, selected args (`context` length or omitted, `timeoutAction`, `detail`, `includeOutputs`, `waitMs`, `runID` when present), and result phase/status/`runID` — not full status payloads. The emitted list is capped (first/last); omitted entries are counted and must not be invented. `run.legacy_tool.absent` stays parent-scoped over the unbounded call list.
19. Per reviewer/gatherer/judge: tool-name histogram, denied/`invalid` attempts (especially `bash`), whether the linked user text contains the shared-context marker from `reviewBrief`, and whether a final assistant text exists (`finish=tool-calls` / no text is evidence, not a finding verdict).
20. The skill does not re-fetch. It writes: executive summary; run list; check table; parent / gatherer / reviewer / judge behavior; worst severity; assumptions; residual gaps.

Severity (worst item wins):

- **P0** evidence unavailable (parent/SDK/store unreadable).
- **P1** model mismatch, tools-deny miss, isolation/parent-link break, reviewer children, silent model replace, legacy blocking tool used as the review path.
- **P2** context contract broken; reviewer wander/bash/search loop without shared context; timeout_pending resolved without a user `timeoutAction`; gatherer/judge role bleed.
- **P3** polling waste (repeated finalize while non-terminal, client-side sleep instead of `waitMs`), extra starts that did not replace a cancelled run.

### Skill and packaging

21. Skill lives at `skills/cross-review-audit/SKILL.md` with matching `commands/cross-review-audit.md` (`Load the \`cross-review-audit\` skill`). Same hand-maintained pattern as `session-review`: **not** added to `workflow-source` / Codex.
22. Skill forbids OpenCode DB paths, `~/.local/share/opencode`, globbing hidden OpenCode storage, and calling `session_review` for IDs the audit tool did not return.
23. README command table + Session Safety (or adjacent) states: audit reads local run-store + SDK sessions named by the parent ID; it does not inspect OpenCode internal storage and does not archive/delete sessions.
24. Changelog Unreleased records the feature.
25. `tests/assets.test.ts` skill/command counts become 14.

## Scenarios

1. **Happy path, no judge.** Parent collected diff, passed `context`, three reviewers, parent judged. Checks pass. Skill notes reviewers did not need bash/search to obtain the target.
2. **Missing context, no judge.** Start omitted `context`. Reviewers grep/glob and attempt `bash` (host `invalid`). `run.context_contract` fails. Skill grades P2 and cites the tool histogram.
3. **Judge + gatherer.** Manifest has `judgeModel`, no `context`, gatherer present on the judge session. `gatherer.judge_session` passes. Skill only comments on gatherer-vs-review bleed if evidence shows findings in the gatherer message.
4. **Multiple runs.** Two manifests under one owner; default report covers both in `createdAt` order. `--run-id` 8-char unique prefix returns one.
5. **Stuck run.** Phase `reviewing`, one reviewer without final text. Included; wrap-up checks `insufficient-evidence`; skill can still fail `role.prompt.model` if that prompt exists.
6. **Legacy only.** No manifests; parent called `cross_review`. `runs.found` fail, `run.legacy_tool.absent` fail if a blocking call exists. Skill explains there is no protocol tree.
7. **Zero runs, never used.** Parent readable, no protocol tools, no manifests. `runs.found` fail. Skill says this session did not use cross-review.
8. **Caller is a child.** Tool throws primary-session error and does not read the store.
9. **Foreign owner, same machine.** Another primary session audits `ses_other`. Succeeds if manifests and SDK allow.
10. **Corrupt manifest + good run.** Corrupt file in `errors[]`; good run still checked.
11. **Truncated parent polls.** Status payloads omitted by caps; timeline still lists call counts. Skill must not invent `timeoutAction` values that were omitted.

## Impact

- New plugin tool, skill, and command; installer discovers them automatically.
- `PRIMARY_TOOL_IDS` / `READ_ONLY_TOOLS` / plugin registration / plugin tests.
- Run-store interface grows read-only list/get; memory store in protocol tests must implement the new methods if the interface changes.
- `session-review` normalize either gains an audit-safe projection or audit uses a sibling extractor so existing summary/troubleshoot fixtures stay valid.
- Assets count 13 → 14. No `workflow-source` change.

## Exclusions

- Re-reviewing or scoring finding correctness, severity of the original PR, or judge vote quality.
- Extending `session_review` to infer child sessions.
- Writing, cancelling, or preserving runs.
- Reading OpenCode SQLite / session archives.
- Shipping the skill through Codex `workflow-source`.
- Changing gatherer/judge/reviewer runtime behavior (audit observes only).
- Implementing against this checkout while it is behind `origin/main` without rebasing first.

## Risks

- Terminal manifests older than seven days may already have been deleted; then only parent tool traces remain.
- Local history has almost no gatherer/judge runs; those checks will often be `insufficient-evidence` until exercised.
- Prompt `model` / `tools` field shapes must be taken from the SDK messages the tests already construct (`model: { providerID, modelID }`), not from session-level title text.
- `patch` parts inside reviewer sessions can be host git snapshots from concurrent parent edits; the skill must not treat them as reviewer writes.
