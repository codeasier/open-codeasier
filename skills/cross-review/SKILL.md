---
name: cross-review
description: Run configurable independent code reviewers and consolidate only verified findings.
---

# Cross Review

Accept one target plus optional `--review-models`, `--agents`, `--max-concurrency`, `--judge-model`, and `--focus`. Reject unknown flags, missing values, duplicate flags, or more than one target. `--agents` defaults to 3 and must be 1-8. `--max-concurrency` defaults to 3 and must be 1-8. Require at least one comma-separated review model and assign models round-robin when there are fewer models than reviewers. Use exact OpenCode `provider/model` identifiers from `opencode models`; malformed, disconnected, or unavailable models are errors.

Normalize the target and focus once. Every reviewer must receive that exact brief, run read-only, and remain isolated from every other reviewer's output. Call `cross_review` with the normalized arguments. The tool validates model availability, creates isolated reviewer sessions, and enforces bounded concurrency.

Require a majority quorum. Preserve each reviewer's model, status, and session provenance. Isolate individual failures; never replace an invalid or failed model silently. On cancellation, stop outstanding work and do not report a partial review as complete.

When `--judge-model` is omitted, use the parent session to judge. Otherwise launch a read-only OpenCode judge session with that explicit model. Independently verify each candidate against the target, reject unsupported claims, deduplicate overlapping findings, and calibrate severity by impact and likelihood. Do not decide by reviewer vote alone.

Report verified findings first in severity order with file and line references. Follow with reviewer provenance, failed or cancelled reviewers, assumptions, and residual testing gaps. State explicitly when no findings survive verification. Mention that parallel reviews increase token usage and cost.
