---
name: release-prep
description: Prepare a repository release through its discovered workflow and changelog conventions.
---

# Release Preparation

Discover release or publish workflows under `.github/workflows`, detect version files and changelogs from repository contents, and infer tag and version rules from those sources. If no release process exists, stop with the files and searches used as evidence.

When a target version is supplied, validate repository state and tags, then follow the existing release preparation flow with that version.

When no target version is supplied, do not require the user to provide one. Refresh remote refs and identify the remote default branch instead of relying on the checked-out local branch. From the discovered release convention, select the latest applicable tag that is reachable from the remote default branch. For SemVer-based releases, use version precedence rather than tag creation date alone. Analyze the commits and material changes in `<latest-applicable-tag>..<remote-default-branch>`, then recommend the next tag according to the repository's versioning rules and the impact of those changes.

Report the remote default branch, baseline tag, comparison range, proposed increment, recommended tag, and supporting evidence. Wait for explicit user confirmation before using the recommendation as the target version. Before that confirmation, do not edit files, create a worktree, commit, open a pull request, tag, push, or publish. If remote refs cannot be refreshed, the default branch or release convention cannot be determined reliably, no applicable tag exists, or the remote default branch does not lead the selected tag, stop with the evidence instead of guessing.

After a supplied or confirmed target version is available, use an isolated worktree to prepare only necessary version and changelog changes. Show the release range and proposed notes for confirmation before committing or opening a PR. Never merge, tag, publish, push, or rewrite an existing tag without separate explicit confirmation for that exact destructive or remote action. Confirmation of a recommended version does not authorize any of those actions.
