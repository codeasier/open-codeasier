---
name: cce-worktree-clean
description: Inspect git worktrees and remove only those proven safe to delete.
---

# Worktree Clean

Fetch the remote before analysis. Enumerate worktrees and inspect staged, unstaged, and untracked files. Compare patches against `origin/main` using merge-base diff and use `git cherry` when squash merging may explain commit divergence. A worktree is safe only when it has no local changes, no untracked files, and no unmerged patch. List safe and risky worktrees with evidence. Obtain explicit confirmation immediately before every worktree removal; never remove a risky worktree.
