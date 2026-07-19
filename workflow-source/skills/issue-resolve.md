---
name: issue-resolve
description: Resolve one repository issue safely in an isolated git worktree.
---

# Issue Resolve

Require exactly one issue number. Read the issue and inspect the current implementation before changing code. Create an isolated worktree under the repository's `.worktrees` directory, implement the smallest correct fix using the project's conventions, and add regression tests. Run focused checks followed by the relevant full checks. Summarize the worktree, changed behavior, and verification; do not push unless the user explicitly requests it.
