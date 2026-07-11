# open-codeasier

OpenCode-native workflow skills plus a read-only, SDK-backed session review tool. Adapted from [codeasier/claude-codeasier](https://github.com/codeasier/claude-codeasier), with no runtime dependency on that repository.

## Requirements

- Node.js 22 or newer
- OpenCode compatible with `@opencode-ai/plugin` and `@opencode-ai/sdk` 1.17.18

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

| Command                | Arguments                                      | Purpose                            |
| ---------------------- | ---------------------------------------------- | ---------------------------------- |
| `/cce-understand-me`   | idea or document                               | Challenge and refine an idea       |
| `/cce-issue-resolve`   | `<issue-number>`                               | Resolve an issue in a worktree     |
| `/cce-issue-review`    | `<issue-number>`                               | Review an issue with evidence      |
| `/cce-issue-submit`    | `<owner/repo>`                                 | Submit a confirmed templated issue |
| `/cce-pr-followup`     | `<pr-number> [focus]`                          | Address PR review feedback         |
| `/cce-worktree-clean`  | none                                           | Inspect and clean safe worktrees   |
| `/cce-docs-governance` | `[audit\|fix] [scope]`                         | Audit or repair documentation      |
| `/cce-release-prep`    | `<version>`                                    | Prepare a repository release       |
| `/cce-spec-write`      | `<change-description>`                         | Write a package under `specs/`     |
| `/cce-spec-run`        | `<change-id>`                                  | Execute an approved spec package   |
| `/cce-session-review`  | `<summary\|troubleshoot> <session-id> [focus]` | Review one explicit session        |

## Session Safety

`cce_session_review` calls only the OpenCode SDK session get and messages APIs for the exact supplied session ID. It returns bounded normalized evidence and does not inspect internal storage. This package has no session archive, delete, trash, purge, restore, or automatic session-selection capability.

## Development

```bash
npm ci
npm run check
```

MIT licensed.
