# Checklist

Mark only after verification on the implementation branch.

## Tool and store

- [x] `cross_review_audit` is registered, listed in `PRIMARY_TOOL_IDS`, and denied in `READ_ONLY_TOOLS`.
- [x] Child session invocation fails with a primary-session error and does not read the run store.
- [x] A non-owner primary session can audit another `ownerSessionID` on the same machine.
- [x] `listByOwner` / `read` do not change manifest `updatedAt` or delete files.
- [x] Corrupt manifests appear in `errors[]` and do not hide sibling good runs.
- [x] Default result includes every owner run by `createdAt`; `--run-id` UUID and unique ≥8 hex prefix filter; unknown / ambiguous prefixes error as specified.
- [x] Zero manifests still return a successful payload with `runs.found` = `fail`.
- [x] Parent SDK failures use `SESSION_*` / `SDK_FAILURE` codes without path or token leakage.

## Checks

- [x] Prompt-level model and `READ_ONLY_TOOLS` deny are evaluated on the linked user message, not session title.
- [x] Empty `context` is treated as omitted for `run.context_contract` and `gatherer.skipped_when_context`.
- [x] Gatherer + judge sharing one session are fetched once; `gatherer.judge_session` checks same `sessionID` and different `messageID`.
- [x] In-progress phase marks wrap-up checks `insufficient-evidence` without dropping prompt-level checks that have evidence.
- [x] Parent blocking `cross_review` calls fail `run.legacy_tool.absent`.
- [x] Truncated or omitted messages force `insufficient-evidence` rather than a guessed `pass`.

## Skill and docs

- [x] `/cross-review-audit` command loads `cross-review-audit` exactly once.
- [x] Skill forbids OpenCode internal storage and using `session_review` to walk unaudited IDs.
- [x] Skill is not added to `workflow-source` / `expectedSkills`.
- [x] Assets tests expect 14 skills and 14 commands.
- [x] README and Unreleased changelog describe the command and the run-store + SDK evidence boundary.
- [x] `npm run check` passes.

## Explicitly not required

- [x] No live gatherer/judge OpenCode run is required for merge if fixtures cover those checks.
- [x] Finding-quality / meta-review of reviewer comments is absent from the report template.
