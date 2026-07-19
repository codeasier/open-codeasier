---
name: release-prep
description: Prepare a repository release through its discovered workflow and changelog conventions.
---

# Release Preparation

Require a target version. Discover release or publish workflows under `.github/workflows`, detect version files and changelogs from repository contents, and infer tag/version rules from those sources. If no release process exists, stop with the files and searches used as evidence. Validate repository state and tags, then use an isolated worktree to prepare only necessary version and changelog changes. Show the release range and proposed notes for confirmation before committing or opening a PR. Never merge, tag, publish, push, or rewrite an existing tag without separate explicit confirmation for that exact destructive or remote action.
