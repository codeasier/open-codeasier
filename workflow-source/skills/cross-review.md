---
name: cross-review
description: Initialize or run configurable independent code reviewers and consolidate only verified findings.
---

# Cross Review

## Setup Mode

Treat a first argument of `init` or `setup`, or a natural-language request to set up cross-review, as setup mode rather than a review target. Accept an optional `--local` or `--global` scope and optional local project path; default to local scope and the current directory. Do not call any `cross_review_*` tool in setup mode.

Run `opencode models` before proposing any configuration and treat its output as the authoritative list of connected, exact model identifiers. If it is unavailable or empty, ask the user to provide the available identifiers and do not write a configuration until they do. Do not infer choices from `opencode.json`, hard-code model identifiers, invent placeholders, or limit the user to a predefined provider or model family.

Show the complete discovered list, grouped by provider, before asking the user to choose. Then recommend a reviewer set and an optional judge drawn only from that list. Explain each recommendation briefly: favor strong code reasoning, complementary model families or providers, and distinct review perspectives; avoid selecting aliases of the same underlying model when diverse alternatives exist. Recommend the strongest available evidence-synthesis model for judging, or the parent session when no separate judge is clearly better. Make clear that these are suggestions and that any discovered models may be selected. Mention the token-cost and concurrency tradeoff.

{{ASK_REQUIRED_FIELDS}} only after presenting the list and recommendations. Ask the user to accept or modify the exact reviewer and judge identifiers, then collect an optional focus for each reviewer and max concurrency. Use `.opencode/cross-review.json` for local scope and `~/.config/opencode/cross-review.json` for global scope. Do not write until the user confirms the complete selection.

If the destination exists, read it and require explicit confirmation before changing it. If it does not exist, run `npx open-codeasier init` with the selected scope and optional path after confirmation; this creates an empty, model-free configuration. Write only the user's confirmed exact identifiers, omit `judgeModel` when the parent session should judge, validate the completed JSON, and report the path plus the short `/cross-review <target>` invocation.

## Review Mode

Before parsing or reviewing the target, confirm that `cross_review_start`, `cross_review_status`, `cross_review_cancel`, and `cross_review_finalize` are all available in the current session. If any are unavailable, stop immediately; do not use the legacy blocking `cross_review`, substitute task agents, run manual parallel reviews, or use another tool. Look first for a project `.opencode/.open-codeasier/installed-assets.json` that owns `skills/cross-review/SKILL.md`, then for the global `~/.config/opencode/.open-codeasier/installed-assets.json`. Read `packageVersion` from the first matching package-owned manifest and report the exact matching runtime command: `opencode plugin open-codeasier@<packageVersion> --force` for project assets or `opencode plugin open-codeasier@<packageVersion> --global --force` for global assets. Tell the user to restart OpenCode afterward. If neither manifest supplies a valid package version, tell the user to reinstall the runtime plugin and workflow assets at the same exact version and scope. Do not inspect OpenCode's private cache layout.

{{CROSS_REVIEW_CONFIG}} Accept one target plus optional `--review-models`, `--agents`, `--max-concurrency`, `--judge-model`, `--focus`, and `--reviewer-timeout-ms` overrides. Reject unknown flags, missing values, duplicate flags, or more than one target. `--agents` and `--max-concurrency` accept 1-8; `--reviewer-timeout-ms` accepts 5000-3600000. {{MODEL_NAMING}}

Normalize the target and focus once. Every reviewer must receive that exact brief, run read-only, and remain isolated from every other reviewer's output. {{CROSS_REVIEW_ORCHESTRATION}}

When no reviewer configuration exists and no `--review-models` override is given, ask the user which models to use and write a project `.opencode/cross-review.json` before calling the tool.

Require a majority quorum. Preserve each reviewer's model, status, and session provenance. Isolate individual failures; never replace an invalid or failed model silently. On cancellation, stop outstanding work and do not report a partial review as complete.

Treat each finite `status` or `finalize` result as visible progress. Continue polling while reviewers or an explicit judge are active, using the returned `pollAfterMs` as the minimum interval and avoiding a tight loop. Call `finalize` when reviewers are terminal; when it starts an explicit judge, resume status polling and call `finalize` again after the judge becomes terminal. If the parent request is cancelled after a run starts, call `cross_review_cancel` with its `runID` when execution resumes. Never start a second run to replace a slow reviewer.

When `--judge-model` or a configured judge model is omitted, use the parent session to judge. Otherwise launch a read-only OpenCode judge session with that explicit model. Independently verify each candidate against the target, reject unsupported claims, deduplicate overlapping findings, and calibrate severity by impact and likelihood. Do not decide by reviewer vote alone.

Report verified findings first in severity order with file and line references. Follow with reviewer provenance, failed or cancelled reviewers, assumptions, and residual testing gaps. State explicitly when no findings survive verification. Mention that parallel reviews increase token usage and cost.
