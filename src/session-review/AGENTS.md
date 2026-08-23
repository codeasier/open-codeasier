# AGENTS.md — src/session-review/ (session_review tool)

Parent scope: [../AGENTS.md](../AGENTS.md) (runtime build target); repository overview in [../../AGENTS.md](../../AGENTS.md).

This subsystem implements the `session_review` tool registered in `../plugin.ts`: a read-only, SDK-backed reader for exactly one OpenCode session that returns bounded, normalized evidence for the `session-review` skill (`/session-review` command).

## Files

| File | Responsibility |
| --- | --- |
| `tool.ts` | Tool definition: args `sessionID` (min length 1), `mode` (`summary` \| `troubleshoot`), optional `focus` (max 2000 chars); returns JSON output plus truncation metadata |
| `fetch.ts` | The only SDK boundary: `session.get` + `session.messages` for the exact supplied ID; maps failures to typed errors |
| `errors.ts` | `SessionReviewError` with codes `SESSION_NOT_FOUND`, `SESSION_ACCESS_DENIED`, `SESSION_EMPTY`, `RESPONSE_TOO_LARGE`, `SDK_FAILURE` |
| `schema.ts` | `NormalizedSession` model and `DEFAULT_LIMITS` |
| `normalize.ts` | Message/part normalization, size budgeting, and mode-dependent selection order |

## Behavior contract

- **Read-only and exact.** Only the two SDK read calls above are ever made; there is no session archive, delete, search, or automatic session selection (README "Session Safety"). A `SessionReviewError` is returned as tool output (`<code>: <message>`, with the code in `metadata.error`) rather than thrown; anything else propagates.
- Error mapping in `fetch.ts`: HTTP 404 / `NotFoundError` → `SESSION_NOT_FOUND`; 401/403 → `SESSION_ACCESS_DENIED`; a session with zero messages → `SESSION_EMPTY`; other SDK faults → `SDK_FAILURE`.
- Normalization keeps only `user` and `assistant` messages, rewrites parts into `text` / `reasoning` / `tool` / `file` / `unknown` shapes, and clamps tool inputs (depth 6, 100 keys, 4000-byte strings, 20000-byte serialized cap).
- Size budget (`schema.ts` `DEFAULT_LIMITS`): at most 200 messages, 200000 bytes total output, 20000 bytes per part. Selection order differs by mode so the most useful evidence survives truncation: `troubleshoot` walks messages newest-first; `summary` alternates from both ends toward the middle. Messages are added until a budget would break, and the result reports `totalMessages` / `includedMessages` / `omittedMessages` / `retainedMessageIDs` / `truncated`. If even the minimal result exceeds `maxBytes`, `RESPONSE_TOO_LARGE` is raised.
- The `focus` argument is carried through to the output for downstream reporting; it does not change what is read.

## Tests

`tests/session-review.test.ts` (SDK boundary and error mapping) and `tests/normalize.test.ts` (limits, ordering, truncation metadata). Run with `npx vitest run tests/session-review.test.ts`.
