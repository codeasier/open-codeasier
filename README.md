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

Use the same paired commands to upgrade, then restart OpenCode. An exact version avoids OpenCode reusing a stale runtime for a floating npm tag. Pair the plugin's `--global` scope with the asset installer's global default; for project scope, omit the plugin's `--global` flag and pass `--project` to the asset installer. The asset installer also prints the matching exact-version runtime command. Assets are installed under `~/.config/opencode/` or `<project>/.opencode/`. Preview asset operations with `--dry-run`; files changed after installation are never overwritten. Remove only package-owned assets with:

```bash
npx open-codeasier uninstall
npx open-codeasier uninstall --project .
```

## Commands

| Command            | Arguments                                      | Purpose                              |
| ------------------ | ---------------------------------------------- | ------------------------------------ |
| `/understand-me`   | idea or document                               | Challenge and refine an idea         |
| `/cross-review`    | `init\|setup\|[options] <target>`              | Configure or run independent reviews |
| `/issue-resolve`   | `<issue-number>`                               | Resolve an issue in a worktree       |
| `/issue-review`    | `<issue-number>`                               | Review an issue with evidence        |
| `/issue-submit`    | `<owner/repo>`                                 | Submit a confirmed templated issue   |
| `/pr-followup`     | `<pr-number> [focus]`                          | Address PR review feedback           |
| `/worktree-clean`  | none                                           | Inspect and clean safe worktrees     |
| `/docs-governance` | `[audit\|fix] [scope]`                         | Audit or repair documentation        |
| `/release-prep`    | `[version]`                                    | Prepare a repository release         |
| `/spec-write`      | `<change-description>`                         | Write a package under `specs/`       |
| `/spec-run`        | `<change-id>`                                  | Execute an approved spec package     |
| `/handoff`         | `[name]`                                       | Create or load a task handoff        |
| `/session-review`  | `<summary\|troubleshoot> <session-id> [focus]` | Review one explicit session          |

## Cross Review

Configure reviewers once in `cross-review.json`; the session command stays short. Global defaults live at `~/.config/opencode/cross-review.json`, and `<project>/.opencode/cross-review.json` overrides them per key.

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

The CLI initializer writes an empty, model-free configuration and refuses to overwrite an existing file. It never guesses which providers or models you can use. Add `--dry-run` to preview the destination without writing.

OpenCode can guide the same setup interactively. Run `/cross-review init` (local by default), `/cross-review init --global`, or ask the session to "set up cross-review". It treats `opencode models` as the authoritative source, shows the complete connected model list, and recommends reviewers and an optional judge only from that list. The recommendations favor code-review strength, complementary model families, and strong evidence synthesis, but you can choose any listed models. Nothing is written until you confirm the full selection.

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
  "maxConcurrency": 3
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

Optional per-invocation overrides keep working: `--review-models`, `--agents`, `--max-concurrency`, `--judge-model`, `--focus`, `--context`, and `--reviewer-timeout-ms`; any explicit argument wins over configuration. An optional `reviewerTimeoutMs` key in either config file sets the per-session deadline for reviewers, the gatherer, and the explicit judge (project overrides global), with the explicit `--reviewer-timeout-ms` flag taking precedence and 600000ms as the fallback. The deadline is enforced only by the asynchronous `cross_review_*` protocol; the legacy blocking `cross_review` tool accepts the shared configuration but does not enforce it. Model names are exact OpenCode `provider/model` identifiers reported by `opencode models`.

Cross-review uses a finite asynchronous protocol instead of waiting inside one custom tool call. `cross_review_start` validates models, creates isolated sessions, dispatches up to the concurrency limit with the OpenCode asynchronous prompt API, and immediately returns a persistent `runID` plus child session provenance. Target context is gathered once and shared instead of being fetched by every reviewer: when an explicit `judgeModel` is configured and no `context` is supplied, the plugin runs a read-only gathering phase in the judge session first (reported as a `gatherer` in status) and embeds the gathered output into every reviewer brief, degrading to independent fetching if gathering fails or times out. When no `judgeModel` is configured, the parent session will judge and the plugin cannot gather for you — collect the context in the parent session first and pass it as `context`. A `context` argument always skips gathering and is embedded in every reviewer brief and the judge prompt. `cross_review_status` reports visible progress — including a per-reviewer `summary` of the gatherer's, every reviewer's, and the judge's status — times out overdue work, and dispatches queued reviewers. `cross_review_cancel` stops unfinished sessions, and `cross_review_finalize` applies quorum and returns candidates for parent judging or starts and later collects an explicit judge.

Run manifests are stored outside the repository in the platform state directory, scoped to the parent session and canonical project directory. This lets a restarted plugin inspect, cancel, or finalize existing runs without dirtying the worktree. Normal status polling omits completed review text to avoid repeatedly adding it to parent context; finalization returns the complete candidates once.

Each reviewer uses the installed `cross-reviewer` agent, receives the same normalized target, and cannot access another reviewer's output. The agent denies edit, shell, and delegation permissions, while each SDK prompt also disables mutating and delegation tools. The original blocking `cross_review` tool remains available for one compatibility release, but the bundled skill does not call it.

- `--agents` and `--max-concurrency` accept 1-8 and default to 3.
- `--reviewer-timeout-ms` accepts 5000-3600000 and defaults to 600000; the config `reviewerTimeoutMs` key accepts the same range and covers reviewer, gatherer, and explicit judge sessions. A timeout is enforced by the next status or finalize reconciliation, which aborts the overdue child session and allows queued work and quorum evaluation to proceed. This applies to the asynchronous `cross_review_*` tools only; the legacy blocking `cross_review` tool does not enforce a deadline.
- `--judge-model` and the configured `judgeModel` are optional. Without one, or when an invocation supplies a blank value, the parent session verifies, deduplicates, calibrates, and consolidates findings; a configured `judgeModel` launches a read-only judge session with that explicit model, and that session first gathers the target context when none is supplied. Setting `--judge-model` overrides the configured value.
- Malformed or unavailable models fail explicitly. Reviewer failures are isolated, but a majority quorum is required; cancellation stops outstanding OpenCode reviewer sessions.

Each reviewer and judge consumes model tokens. Increasing reviewers or selecting more expensive models raises cost approximately with the number of sessions; no model silently falls back to another provider or model.

## Task Handoffs

Run `/handoff` without arguments to create or update `.agent/handoff/<name>/HANDOFF.md` from the current session and workspace. Run `/handoff <name>` in a later session to validate and load that handoff; the agent reports its understanding and waits for confirmation before continuing the task.

Handoff names contain only lowercase letters, digits, and hyphens. Handoff documents may contain repository state and task context, so review them before committing or sharing them.

## Session Safety

`session_review` calls only the OpenCode SDK session get and messages APIs for the exact supplied session ID. It returns bounded normalized evidence and does not inspect internal storage. This package has no session archive, delete, trash, purge, restore, or automatic session-selection capability.

## Development

```bash
npm ci
npm run check
```

MIT licensed.
