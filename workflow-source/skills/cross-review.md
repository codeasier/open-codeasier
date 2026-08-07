---
name: cross-review
description: Initialize or run configurable independent code reviewers and consolidate only verified findings.
---

# Cross Review

## Setup Mode

Treat a first argument of `init` or `setup`, or a natural-language request to set up cross-review, as setup mode rather than a review target. Accept an optional `--local` or `--global` scope and optional local project path; default to local scope and the current directory. Do not call `cross_review` in setup mode.

Run `opencode models` to discover exact connected model identifiers; if it is unavailable, ask the user to provide them. {{ASK_REQUIRED_FIELDS}}. Collect the reviewer model and focus for each reviewer, an optional judge model, and max concurrency. Use `.opencode/cross-review.json` for local scope and `~/.config/opencode/cross-review.json` for global scope.

If the destination exists, read it and require explicit confirmation before changing it. If it does not exist, run `npx open-codeasier init` with the selected scope and optional path, then replace every `provider/...` placeholder with the user's choices. Validate the completed JSON and report the path plus the short `/cross-review <target>` invocation.

## Review Mode

{{CROSS_REVIEW_CONFIG}} Accept one target plus optional `--review-models`, `--agents`, `--max-concurrency`, `--judge-model`, and `--focus` overrides. Reject unknown flags, missing values, duplicate flags, or more than one target. `--agents` and `--max-concurrency` accept 1-8. {{MODEL_NAMING}}

Normalize the target and focus once. Every reviewer must receive that exact brief, run read-only, and remain isolated from every other reviewer's output. {{CROSS_REVIEW_ORCHESTRATION}}

When no reviewer configuration exists and no `--review-models` override is given, ask the user which models to use and write a project `.opencode/cross-review.json` before calling the tool.

Require a majority quorum. Preserve each reviewer's model, status, and session provenance. Isolate individual failures; never replace an invalid or failed model silently. On cancellation, stop outstanding work and do not report a partial review as complete.

When `--judge-model` or a configured judge model is omitted, use the parent session to judge. Otherwise launch a read-only OpenCode judge session with that explicit model. Independently verify each candidate against the target, reject unsupported claims, deduplicate overlapping findings, and calibrate severity by impact and likelihood. Do not decide by reviewer vote alone.

Report verified findings first in severity order with file and line references. Follow with reviewer provenance, failed or cancelled reviewers, assumptions, and residual testing gaps. State explicitly when no findings survive verification. Mention that parallel reviews increase token usage and cost.
