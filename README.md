# open-codeasier

OpenCode-native workflow skills, configurable cross-review orchestration, cross-session task handoffs, and a read-only SDK-backed session review tool. Adapted from [codeasier/claude-codeasier](https://github.com/codeasier/claude-codeasier), with no runtime dependency on that repository.

## Requirements

- Node.js 22 or newer
- OpenCode 1.14.49 or newer

## Install

Resolve the published version once, then install the runtime plugin and workflow assets at the same exact version and scope. For a global install:

```bash
VERSION="$(npm view open-codeasier version)"
opencode plugin "open-codeasier@$VERSION" --global --force
npx "open-codeasier@$VERSION" install
```

For an install limited to the current project:

```bash
VERSION="$(npm view open-codeasier version)"
opencode plugin "open-codeasier@$VERSION" --force
npx "open-codeasier@$VERSION" install --project .
```

Use the same paired commands to upgrade, then restart OpenCode. An exact version avoids OpenCode reusing a stale runtime for a floating npm tag. Pair the plugin's `--global` scope with the asset installer's global default; for project scope, omit the plugin's `--global` flag and pass `--project` to the asset installer. The asset installer also prints the matching exact-version runtime command. Assets are installed under `~/.config/opencode/` or `<project>/.opencode/`. `npx open-codeasier install` does not update `~/.agents`. If `~/.agents/skills/cross-review` exists and differs from the packaged skill, `install` and `init` refuse until that shadow is removed or replaced with the packaged `skills/cross-review/SKILL.md`. Preview asset operations with `--dry-run`; files changed after installation are never overwritten. Remove only package-owned assets with:

```bash
npx open-codeasier uninstall
npx open-codeasier uninstall --project .
```

## Commands

| Command               | Arguments                                      | Purpose                              |
| --------------------- | ---------------------------------------------- | ------------------------------------ |
| `/understand-me`      | idea or document                               | Challenge and refine an idea         |
| `/cross-review`       | `init\|setup\|[options] <target>`              | Configure or run independent reviews |
| `/issue-resolve`      | `<issue-number>`                               | Resolve an issue in a worktree       |
| `/issue-review`       | `<issue-number>`                               | Review an issue with evidence        |
| `/issue-submit`       | `<owner/repo>`                                 | Submit a confirmed templated issue   |
| `/pr-followup`        | `<pr-number> [focus]`                          | Address PR review feedback           |
| `/worktree-clean`     | none                                           | Inspect and clean safe worktrees     |
| `/docs-governance`    | `[audit\|fix] [scope]`                         | Audit or repair documentation        |
| `/release-prep`       | `[version]`                                    | Prepare a repository release         |
| `/spec-write`         | `<change-description>`                         | Write a package under `specs/`       |
| `/spec-run`           | `<change-id>`                                  | Execute an approved spec package     |
| `/handoff`            | `[name]`                                       | Create or load a task handoff        |
| `/session-review`     | `<summary\|troubleshoot> <session-id> [focus]` | Review one explicit session          |
| `/cross-review-audit` | `<parent-session-id> [--run-id <id>] [focus]`  | Audit a cross-review parent session  |

## Cross Review

Configure reviewers once in `cross-review.json`; the session command stays short. The project config at `<project>/.opencode/cross-review.json` is used exclusively when present, without reading the global file; only when it is absent does the tool fall back to `~/.config/opencode/cross-review.json`.

Create a starter configuration at either scope:

```bash
# Current project (--local is the default)
npx open-codeasier init
npx open-codeasier init --local

# Another project (the path defaults to the current directory)
npx open-codeasier init /path/to/project
npx open-codeasier init --local /path/to/project

# Current user
npx open-codeasier init --global
```

The CLI initializer writes an empty, model-free configuration and refuses to overwrite an existing file. It never guesses which providers or models you can use. It prints a next-step that the file is `{}`, to use only one of `reviewers` or `reviewModels`, and then to run `npx open-codeasier validate <path>`. Add `--dry-run` to preview the destination without writing.

After editing a configuration, validate it exactly the way the runtime parses it:

```bash
npx open-codeasier validate                  # project config found from the current directory
npx open-codeasier validate /path/to/cross-review.json
```

It prints `valid: <path>` and exits 0, or the exact validation error and exits 1. Note the value shapes: `reviewers` is an array of `{ "model", "focus"? }` objects, while `reviewModels` is a flat array of `provider/model` strings; a flat string array under the `reviewers` key is rejected. An optional `gitcodeCli` key must be an absolute path.

Locate a usable gitcode-cli binary (PATH, then `~/miniconda3` / `~/anaconda3` including env `bin`/`Scripts`; `--version` output must contain `gitcode`):

```bash
npx open-codeasier detect-gitcode
```

It prints `found: <absolute-path>` and exits 0, or install guidance and exits 1.

OpenCode can guide the same setup interactively. Run `/cross-review init` (local by default), `/cross-review init --global`, or ask the session to "set up cross-review". It treats `opencode models` as the authoritative source, shows the complete connected model list, and recommends reviewers and an optional judge only from that list. The recommendations favor code-review strength, complementary model families, and strong evidence synthesis, but you can choose any listed models. Guided setup also asks whether GitCode support is needed and, when it is, runs `detect-gitcode` to persist `gitcodeCli`. Nothing is written until you confirm the full selection, and the guided flow validates the written file with `npx open-codeasier validate` before reporting success.

Configuration shape after guided setup (model values are schematic, not defaults):

```json
{
  "reviewers": [
    {
      "model": "<provider>/<reviewer-model>",
      "focus": "correctness and behavior"
    },
    {
      "model": "<provider>/<reviewer-model>",
      "focus": "security and authentication"
    },
    {
      "model": "<provider>/<reviewer-model>",
      "focus": "performance and behavioral regressions"
    }
  ],
  "judgeModel": "<provider>/<judge-model>",
  "maxConcurrency": 3,
  "gitcodeCli": "/absolute/path/to/gitcode"
}
```

Then run reviews with only a target:

```text
/cross-review main...HEAD
```

A `reviewers` array defines the exact reviewer set and gives each reviewer its own optional `focus`. A flat alternative uses `reviewModels` (assigned round-robin across `agents`, which defaults to 3) plus one shared `focus`:

```json
{
  "reviewModels": ["<provider>/<model>", "<provider>/<model>"],
  "agents": 4,
  "judgeModel": "<provider>/<judge-model>",
  "focus": "security and regressions"
}
```

Optional per-invocation overrides keep working: `--review-models`, `--agents`, `--max-concurrency`, `--judge-model`, `--focus`, `--context`, and `--reviewer-timeout-ms`; any explicit argument wins over configuration. An empty `reviewModels` array or a `0` for `agents`, `maxConcurrency`, or `reviewerTimeoutMs` is treated as omitted (host type-defaults) and falls back to the loaded config; a blank `judgeModel` still means parent-session judging, and an explicit empty `focus` is not collapsed into that heuristic. An optional `reviewerTimeoutMs` key in the effective config file sets the per-session deadline for reviewers, the gatherer, and the explicit judge, with the explicit `--reviewer-timeout-ms` flag taking precedence and 600000ms as the fallback. An optional `gitcodeCli` key stores the absolute path of [gitcode-cli](https://github.com/codeasier/gitcode-cli). GitHub and GitCode pull-request targets (a `/pull/<number>` URL, `#<number>`, `PR#<number>`, or `PR <number>` with a matching remote) are materialized by the plugin as an isolated snapshot worktree at the PR head — no LLM gatherer and no fetched `context` needed; for GitCode PRs the plugin invokes the configured `gitcodeCli` directly (missing or unusable CLI fails with setup guidance, never falling back to `gh`), while GitHub PRs keep using `gh`. A supplied `context` for a PR is written to `notes.md` inside the snapshot. For GitCode issue targets (not PRs), the parent session uses that CLI to fetch issue details (`issue view`) and passes them as `context`; GitHub issue targets still use `gh`. The deadline is enforced only by the asynchronous `cross_review_*` protocol; the legacy blocking `cross_review` tool accepts the shared configuration but does not enforce it. Model names are exact OpenCode `provider/model` identifiers reported by `opencode models`.

Cross-review uses a finite asynchronous protocol instead of waiting inside one custom tool call. Before starting, `cross_review_config` previews the resolved configuration (`sources`, paths, per-reviewer models, judge, limits, quorum, and any missing-project `warning`) without creating sessions, so the effective config is confirmed first. `cross_review_start` validates models, creates isolated sessions, dispatches up to the concurrency limit with the OpenCode asynchronous prompt API, and returns a persistent `runID` plus child session provenance, a compact `config` resolution block (`sources`, `projectConfigPath`, `globalConfigPath`), and a `warning` when the project config was missing. For classified GitHub or GitCode pull-request targets, start first materializes the snapshot (adapter or contract validation failure rejects the run before any reviewer session exists; adapter errors include the retained snapshot path when available), then binds every reviewer and judge session to that snapshot worktree directory. Status reports the gatherer as `kind: "adapter"` with no model or session. PR reviewers read the worktree plus the `.cross-review/` contract files the prompt lists for that run (`meta.json`, `diff.patch`, `pr.md`; `notes.md` and `materials/` only when those inputs were supplied).

An optional `/cross-review --evidence-dir <project-relative-directory> <target>` passes `evidenceDir` to `cross_review_start`, not to configuration or `cross_review_config`. The parent must stage the pack before start: `summary.md` must be nonblank and `meta.json` must parse as a nonempty JSON object; supporting files may be included. The path must stay within the canonical project directory as a dedicated subdirectory; absolute or blank paths, the project root (`.`), escapes, `.git` entries, symlinks, and entries other than regular files or directories are rejected. The plugin validates and captures the pack bytes and copies them into the isolated snapshot before creating or dispatching child sessions, so later source-pack edits do not change the review. For PRs, the pack is attached under `.cross-review/materials/`, preserving the adapter's authoritative metadata and complete `diff.patch`; the parent must not fetch a replacement PR diff.

For non-PR targets, parent-gathered `context` or `evidenceDir` skips the LLM gatherer and requires a git repository so the plugin can create a detached snapshot at the range's right-hand commit, or `HEAD` for other targets. A start outside a repository fails with a dedicated error before any child session exists; there is no embedded-context fallback. Any target containing `..` is reserved for a git revision range (`base..head` or `base...head`); other strings that contain `..` (for example `fix ... bug` or `../lib`) are rejected rather than silently pinning `HEAD`. The pack is copied to `.cross-review/`; `context` alone creates `meta.json` and `summary.md`, while `context` with a pack is appended to its copied `summary.md`. Reviewers and the explicit judge read these files instead of receiving embedded context. Uncommitted parent-checkout changes are not copied: stage the exact diff and any required file contents in the pack. All snapshot children are bound to that snapshot directory and must not use another checkout as evidence. Only a non-PR start with neither `context` nor `evidenceDir` runs a read-only gathering phase in the configured judge session, embedding its output into reviewer briefs and degrading to independent fetching if gathering fails or the user aborts it after timeout. Without a `judgeModel`, that start is rejected before reviewer creation; the parent must gather evidence first. This file-backed parent-evidence behavior belongs to `cross_review_start`; the legacy blocking tool does not accept `evidenceDir`.

`cross_review_status` reports visible progress through `counts`, a per-reviewer `summary`, and `pollAfterMs`, detects overdue work, and dispatches queued reviewers. An overdue session enters `timeout_pending` without being aborted and returns `actionRequired`; ask the user to preserve or abort it before sending `timeoutAction`. Polling omits completed review text by default; request `detail: true` or `includeOutputs: true` only when needed. `cross_review_cancel` stops unfinished sessions, and `cross_review_finalize` applies quorum and returns candidates for parent judging or starts and later collects an explicit judge. Finalize rejects while gathering, reviewers, or the judge are active, or a timeout decision is pending, so it cannot be used as a poll. Parent-session finalize returns `pending-parent-consolidation` and retains the snapshot for verification until explicit cancel or the 7-day expired-run cleanup. Successful explicit-judge finalization removes the snapshot; failed runs retain it until cancel or expired-run cleanup. Complete parent verification before cancelling for cleanup; after that judging, ask whether to clean up with `cross_review_cancel` or keep the snapshot. Do not offer reuse. Expired-run cleanup is best-effort: manifests whose `updatedAt` is older than 7 days, including abandoned non-terminal runs, are removed with their snapshot worktrees on plugin load, finalize, cancel, and when a new run is created.

Run manifests are stored outside the repository at `~/.open-codeasier/cross-review/<runID>.json`, scoped to the parent session and canonical project directory. Snapshot worktrees live beside them at `~/.open-codeasier/cross-review/.worktrees/<runID>/worktree`. Set `OPEN_CODEASIER_STATE_HOME` to replace the home parent (`$OPEN_CODEASIER_STATE_HOME/cross-review`). Previous platform roots (`$XDG_STATE_HOME/open-codeasier/cross-review`, `~/Library/Application Support/open-codeasier/cross-review`, `%LOCALAPPDATA%/open-codeasier/cross-review`, and `~/.local/state/open-codeasier/cross-review`) are still scanned for status, cancel, finalize, audit, and expired-run cleanup, so existing runs are not orphaned; released manifests (no live snapshot worktree) are moved to the new root. Live git worktrees are not moved. This lets a restarted plugin inspect, cancel, or finalize existing runs without dirtying the worktree.

Parent-session judging reads the snapshot from the user's repository workspace. Home expansion does not make that path in-workspace, so add this one-time OpenCode permission (`~` expands on every platform, including to `%USERPROFILE%` on Windows). Do not widen it to `~/.config/opencode/**`. An explicit `judgeModel` binds the judge to the snapshot and does not need the rule.

```json
{
  "permission": {
    "external_directory": {
      "~/.open-codeasier/cross-review/**": "allow"
    }
  }
}
```

Manual `rm -rf ~/.open-codeasier/cross-review/.worktrees/` leaves stale `.git/worktrees/<id>` admin entries in the source repository — follow with `git worktree prune`. `cross_review_cancel` and the 7-day expired-run cleanup already remove those entries. Normal status polling omits completed review text to avoid repeatedly adding it to parent context; finalization returns the complete candidates once.

Each reviewer uses the installed `cross-reviewer` agent, receives the same normalized target, and cannot access another reviewer's output. The agent denies edit, shell, and delegation permissions, while each SDK prompt also disables mutating and delegation tools. The original blocking `cross_review` tool remains available for one compatibility release, but the bundled skill does not call it.

### Cross-review authorization

Cross-review is an explicit opt-in workflow: request `/cross-review` or independent multi-model review. An ordinary code/PR review request should continue as ordinary review. The orchestration skill is primary-session only; accidentally loading it in a child session must not block that child's original task.

Both `cross_review_start` and legacy `cross_review` execute an OpenCode permission request before creating snapshots, persisting runs, or starting children. Local target classification and shared-evidence checks run first so a request that cannot succeed does not consume an approval. The request names cross-review, the target, resolved reviewer models/count, judge, and additional token usage and cost. Denial or cancellation prevents the start; configuration-preview confirmation alone does not authorize it. The permission Effect must run in the host tool fiber (OpenCode 1.14.49); a fiber-less invocation fails closed instead of showing a prompt. The plugin inserts these defaults before existing user rules to override OpenCode's built-in wildcard allow:

```json
{
  "permission": {
    "cross_review_start": "ask",
    "cross_review": "ask"
  }
}
```

OpenCode's effective permission policy remains authoritative. Existing user rules keep their order (last match wins), including explicit `permission: "allow"`, `"*": "allow"`, or `"cross_review*": "allow"`; agent/session rules and remembered approvals can also override these defaults. To require prompts despite a broad user allow, place the two specific ask rules after it and remove conflicting agent/session or remembered approvals. Set both keys to `"deny"` to disable starts or `"allow"` to deliberately authorize them without a prompt. This enforces permission policy, not a semantic check of the original user prompt. Requests use an empty `always` list so approving one start does not grant future starts. Quit and restart OpenCode after changing permissions or installing updated runtime/workflow assets.

### Run limits and failures

- `--agents` and `--max-concurrency` accept 1-8 and default to 3.
- `--reviewer-timeout-ms` accepts 5000-3600000 and defaults to 600000; the config `reviewerTimeoutMs` key accepts the same range and covers reviewer, gatherer, and explicit judge sessions. The next status or finalize reconciliation detects an overdue child session but does not abort it: the session enters `timeout_pending` until the user chooses `preserve` or `abort`. Preserve extends the same session's deadline by one configured timeout period so its eventual output can still count; abort marks it `timed_out` and allows queued work and quorum evaluation to proceed. Abort also terminates previously preserved sessions still running inside their extension, and an ambiguous preserved dispatch with no visible message is redispatched instead of idling. The decision applies to timeouts that arise during a `waitMs` long-poll window as well. This applies to the asynchronous `cross_review_*` tools only; the legacy blocking `cross_review` tool does not enforce a deadline.
- `cross_review_status` is compact by default to keep the polling loop cheap: it returns `runID`, `phase`, `quorum`, `counts`, `readyToFinalize` (true when reviewers are terminal, the explicit judge is terminal, or the run is already in a terminal phase), `pollAfterMs`, a per-reviewer text `summary`, and `actionRequired` when a timeout decision is pending, and omits the full `target` (truncated to 80 characters), per-reviewer objects, and the `config` resolution block. Pass `timeoutAction: "preserve"` or `timeoutAction: "abort"` only after `actionRequired` (or to abort a previously preserved session); a stray value is ignored with a warning. Pass `detail: true` for the full per-reviewer state and config paths or `includeOutputs: true` to also read review text; `includeOutputs` implies `detail`. It accepts an optional `waitMs` (0-60000, default 30000) for server-side long polling: when work is active, the tool holds the call and polls in a lightweight loop, returning as soon as any reviewer state changes, the run reaches a final phase, a timeout requires a decision, or the wait expires. The returned `pollAfterMs` is omitted while a timeout decision is pending, 3s while the gatherer or any session is still starting, 10s in the steady state, and shortens near a session deadline.
- `--judge-model` and the configured `judgeModel` are optional. Without one, or when an invocation supplies a blank value, the parent session verifies, deduplicates, calibrates, and consolidates findings, and a non-PR start must pass parent-gathered `context` or `evidenceDir`; a configured `judgeModel` launches a read-only judge session with that explicit model, gathering first only for non-PR targets with neither form of parent evidence. Setting `--judge-model` overrides the configured value.
- Malformed or unavailable models fail explicitly. Reviewer failures are isolated, but a majority quorum is required; cancellation stops outstanding OpenCode reviewer sessions.

Each reviewer and judge consumes model tokens. Increasing reviewers or selecting more expensive models raises cost approximately with the number of sessions; no model silently falls back to another provider or model.

## Task Handoffs

Run `/handoff` without arguments to create or update `.agent/handoff/<name>/HANDOFF.md` from the current session and workspace. Run `/handoff <name>` in a later session to validate and load that handoff; the agent reports its understanding and waits for confirmation before continuing the task.

Handoff names contain only lowercase letters, digits, and hyphens. Handoff documents may contain repository state and task context, so review them before committing or sharing them.

## Session Safety

The `cross_review_audit` check `run.evidence_contract` recognizes persisted nonblank context, a successful adapter snapshot, or a copied parent-pack snapshot as shared evidence. Without shared evidence, a configured judge must have a gatherer. A PR adapter that failed before any reviewer existed is reported by `adapter.gather` instead (a blocking `cross_review` persist that omitted `adapterGatherer` is `insufficient-evidence`, not a broken evidence contract). `role.session.directory` compares the SDK session directory of each role with the snapshot worktree. These checks use persisted run metadata and SDK session records, not a fresh validation of snapshot files that may already have been cleaned up.

`session_review` calls only the OpenCode SDK session get and messages APIs for the exact supplied session ID. It returns bounded normalized evidence and does not inspect internal storage. `cross_review_audit` reads the local cross-review run-store plus OpenCode SDK sessions named by the parent session ID. It does not inspect OpenCode internal storage and does not archive or delete sessions. Corrupt manifests from the whole run-store directory appear in `errors[]` even when they belong to another owner. This package has no session archive, delete, trash, purge, restore, or automatic session-selection capability.

## Development

```bash
npm ci
npm run check
```

MIT licensed.
