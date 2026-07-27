# open-codeasier

OpenCode-native workflow skills, cross-session task handoffs, and a read-only SDK-backed session review tool. Adapted from [codeasier/claude-codeasier](https://github.com/codeasier/claude-codeasier), with no runtime dependency on that repository.

## Requirements

- Node.js 22 or newer
- OpenCode 1.14.49 or newer

## Install

Install the runtime plugin with OpenCode:

```bash
opencode plugin open-codeasier
```

Install skills and commands globally:

```bash
npx open-codeasier install
```

Install them only for the current project:

```bash
npx open-codeasier install --project .
```

Preview operations with `--dry-run`. Upgrade by rerunning `install`; files changed after installation are never overwritten. Remove only package-owned assets with:

```bash
npx open-codeasier uninstall
npx open-codeasier uninstall --project .
```

## Commands

| Command            | Arguments                                      | Purpose                            |
| ------------------ | ---------------------------------------------- | ---------------------------------- |
| `/understand-me`   | idea or document                               | Challenge and refine an idea       |
| `/issue-resolve`   | `<issue-number>`                               | Resolve an issue in a worktree     |
| `/issue-review`    | `<issue-number>`                               | Review an issue with evidence      |
| `/issue-submit`    | `<owner/repo>`                                 | Submit a confirmed templated issue |
| `/pr-followup`     | `<pr-number> [focus]`                          | Address PR review feedback         |
| `/worktree-clean`  | none                                           | Inspect and clean safe worktrees   |
| `/docs-governance` | `[audit\|fix] [scope]`                         | Audit or repair documentation      |
| `/release-prep`    | `<version>`                                    | Prepare a repository release       |
| `/spec-write`      | `<change-description>`                         | Write a package under `specs/`     |
| `/spec-run`        | `<change-id>`                                  | Execute an approved spec package   |
| `/handoff`         | `[name]`                                       | Create or load a task handoff      |
| `/session-review`  | `<summary\|troubleshoot> <session-id> [focus]` | Review one explicit session        |

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
