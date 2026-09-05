# Tasks

Dependency order. Check a box only after the work is in the tree.

- [x] 1. Rebase or merge latest `origin/main` before product edits. Confirm no existing `specs/cross-review-audit` conflict.
- [x] 2. Add read-only run-store APIs (`listByOwner`, `read`) that never save, never bump `updatedAt`, never delete, and skip corrupt files into an error list. Extend the in-memory store used by protocol tests. Cover with `tests/cross-review-store.test.ts`.
- [x] 3. Add audit message projection that reuses session-review fetch/normalize bounds but keeps user-message `id`, `model`, `agent`, and `tools`. Existing `normalize.test.ts` / `session-review` behavior stays unchanged.
- [x] 4. Implement deterministic check functions as pure units with fixture manifests + normalized sessions for: context contract, prompt model, tools-deny, messageID link, gatherer/judge session pairing, legacy tool, in-progress → `insufficient-evidence`.
- [x] 5. Implement `cross_review_audit` tool: primary-session gate, args (`parentSessionID`, optional `runID`, optional `focus`), resolve runs, fetch parent + distinct role sessions, emit bounded JSON (runs, checks, protocol timeline, role tool histograms, truncation, errors). No owner-session restriction.
- [x] 6. Register the tool in `src/plugin.ts`, `PRIMARY_TOOL_IDS`, and `READ_ONLY_TOOLS`. Update `tests/plugin.test.ts`, `tests/primary-session.test.ts`, and reviewer-tool deny fixtures that enumerate the deny map.
- [x] 7. Add `tests/cross-review-audit.test.ts` for scenarios 1–11 that do not need a live OpenCode: zero runs, legacy only, `--run-id` prefix/ambiguous, child caller, directory mismatch inclusion, corrupt + good manifest, shared gatherer/judge session fetched once.
- [x] 8. Write `skills/cross-review-audit/SKILL.md` and `commands/cross-review-audit.md`. Skill: call only `cross_review_audit`; report sections and P0–P3; forbid DB paths and `session_review` tree walks. Bump `tests/assets.test.ts` counts to 14 and assert the forbid strings.
- [x] 9. Document `/cross-review-audit` in README (command table + safety) and CHANGELOG Unreleased.
- [x] 10. Run `npm run check` and fix only in-scope failures.
