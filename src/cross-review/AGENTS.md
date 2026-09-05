# AGENTS.md — src/cross-review/ (cross-review subsystem)

Parent scope: [../AGENTS.md](../AGENTS.md) (runtime build target); repository overview in [../../AGENTS.md](../../AGENTS.md).

## Files

| File | Responsibility |
| --- | --- |
| `config.ts` | Load, validate, and merge `cross-review.json`; git-root discovery (`findGitRoot`, linked-worktree-aware `findSharedGitRoot`) |
| `init.ts` | CLI `init` command: create an empty model-free `{}` config; refuse to overwrite (`CrossReviewConfigConflictError`) |
| `tool.ts` | Legacy blocking `cross_review` tool **and** shared helpers used by the async protocol: `REVIEWER_AGENT`, `READ_ONLY_TOOLS`, `splitModel`, brief builders (`reviewBrief`/`gatherBrief`), `responseData`, config warning |
| `protocol.ts` | Async `cross_review_start` / `status` / `cancel` / `finalize` state machine over OpenCode child sessions |
| `run-store.ts` | Persistent run manifests: locking, atomic writes, schema migration, retention cleanup |

`tool.ts` is deliberately the shared layer: changing briefs, read-only tool flags, or model splitting changes both the legacy tool and the async protocol. The legacy blocking tool is retained for one compatibility release; the bundled skill must not call it (`workflow-source/skills/cross-review.md` says so explicitly).

## Configuration (`config.ts`)

- Project config: `<git-root>/.opencode/cross-review.json`; global: `~/.config/opencode/cross-review.json`. Project keys override global per key; a project `reviewers` or `reviewModels` also deletes the counterpart key from the merged result so the two are never combined.
- Allowed keys are exactly: `reviewers`, `reviewModels`, `agents`, `maxConcurrency`, `judgeModel`, `focus`, `reviewerTimeoutMs`. Unknown keys, JSON syntax errors, `reviewers` + `reviewModels` together, and out-of-range values are hard errors (`parseCrossReviewConfig`).
- Bounds enforced in both config and tool args: `agents`/`maxConcurrency` 1–8, `reviewerTimeoutMs` 5000–3600000, reviewers 1–8, model IDs must match `provider/model...`.
- `findGitRoot` walks up to the nearest `.git` (directory or file); for linked worktrees, `findSharedGitRoot` follows `gitdir:`/`commondir` so the config is found at the main checkout.

## Async protocol (`protocol.ts`)

A finite state machine where **polling is what advances a run** — `cross_review_status` and `cross_review_finalize` both call `reconcile`, which dispatches queued reviewers up to `maxConcurrency`, reads child session status/messages, and enforces deadlines.

- Phases: `gathering` → `reviewing` → `judging` → terminal (`completed`, `quorum-not-met`, `failed`, `cancelled`). Quorum is `floor(reviewers/2) + 1`.
- With an explicit `judgeModel` and no `context`, the judge session first runs a read-only **gatherer** prompt; its output is embedded into every reviewer brief. Gathering is an optimization: on gatherer failure or timeout the run degrades to independent fetching (`transitionToReviewing`). The judge later shares that same session, so its outcome is resolved via `info.parentID` linkage to its own user message, never a sibling response.
- An explicit `context` argument always skips gathering and is embedded in every brief plus the judge prompt; an **empty string counts as not provided** and must not disable gathering.
- Reviewers are isolated: each gets its own session and brief, `READ_ONLY_TOOLS` disables `bash`/`edit`/`patch`/`task`/`write`, and no reviewer sees another's output.
- Models are validated against `provider.list` at `start` (provider connected and model exists); an unavailable model is an error — never a silent fallback.
- Deadlines (`reviewerTimeoutMs`, default 600000) cover reviewer, gatherer, and judge sessions, enforced by the next reconcile (abort + mark `timed_out`, keep queued work going). Ambiguous dispatches (no visible message after `STARTING_GRACE_MS` = 15s) are re-queued with the **original deadline preserved** so they cannot retry forever.
- Poll cost control: `pollAfterMs` is 3s while anything is starting or in `gathering`, 10s steady state, and shortens within 30s of a deadline. Default `status` output is compact (`runID`, `phase`, `quorum`, `counts`, `readyToFinalize`, `pollAfterMs`, per-reviewer text `summary`, target truncated to 80 chars); `detail: true` / `includeOutputs: true` expand it, and `finalize` returns the full candidates exactly once (`finalResult` is cached and replayed).
- Time injection (`options.now`, `createRunID`, `canonicalize`, `store`, `loadConfig`) exists for tests — keep new logic deterministic through these seams.

## Run store (`run-store.ts`)

- One JSON manifest per run, stored **outside the repository** in the platform state directory: `$XDG_STATE_HOME/open-codeasier/cross-review`, else `~/Library/Application Support/open-codeasier/cross-review` (darwin), `%LOCALAPPDATA%\open-codeasier\cross-review` (win32), else `~/.local/state/open-codeasier/cross-review`. This lets a restarted plugin inspect/cancel/finalize runs without dirtying the worktree.
- Writes are atomic (temp file + rename, mode 0600) under a `proper-lockfile` file lock plus an in-process promise lock; stale locks expire after 60s. All mutations go through `withRun(runID, action)`, which re-reads, lets the action mutate + `save()`, and persists once at the end.
- `schemaVersion` is 2; older manifests are upgraded on read (message IDs get a `msg_` prefix via `migrateMessageIDs` in `protocol.ts`).
- Terminal runs older than 7 days are pruned opportunistically after `create`.
- Ownership: every `status`/`cancel`/`finalize` verifies `ownerSessionID` and the canonicalized (realpath) project directory match the calling session; otherwise it errors (`assertAuthorized`).

## Tests

`tests/cross-review.test.ts` (legacy tool), `tests/cross-review-protocol.test.ts` (async lifecycle, uses the real `FileCrossReviewRunStore` against `mkdtemp`), `tests/cross-review-store.test.ts` (locking/retention), `tests/config.test.ts` (merge/validation), `tests/init.test.ts` (CLI init + parser). Run e.g. `npx vitest run tests/cross-review-protocol.test.ts`.
