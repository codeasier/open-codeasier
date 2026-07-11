---
name: issue-submit
description: Discover a remote repository's issue templates and submit a confirmed issue.
---

# Issue Submit

Require one `owner/repo`. Use `gh api` to inspect `.github/ISSUE_TEMPLATE`, a legacy `.github/ISSUE_TEMPLATE.md`, and `config.yml`. Present available forms, templates, contact links, and a blank issue when permitted. Use the question tool to collect each required field, preserving defaults, labels, and assignees. Preview the complete title and body. Run `gh issue create` only after explicit user confirmation, then return its URL. Never create local files or modify source.
