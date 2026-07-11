---
name: session-review
description: Review one explicit OpenCode session as a workflow summary or evidence-based troubleshooting report.
---

# Session Review

Call `session_review` with the exact session ID, mode, and optional focus. Treat the returned normalized messages as the complete available evidence. Never search OpenCode internal storage or infer another session. Build a timeline from user, assistant, reasoning, tool, and error evidence; separate facts from inferences and state when truncation weakens a conclusion.

For `summary`, identify goals, outcomes, stages, decisions, reusable capabilities, automation boundaries, and maturity: L1 ad hoc, L2 repeatable, L3 template-ready, or L4 product-ready. Output Executive Summary, Timeline, Evidence Table, Workflow Breakdown, Decision Points, Capability Candidates, Standardization Guidance, and Risks / Unknowns.

For `troubleshoot`, identify the stopped stage, last useful and failed actions, primary and secondary causes, tool-call quality, and minimum recovery step. Grade P0 unavailable evidence, P1 blocked main flow, P2 degraded progress, or P3 non-blocking defect. Output Executive Summary, Timeline, Evidence Table, Root Cause Analysis, Tooling Review, Recovery Playbook, and Risks / Unknowns.

Always include session ID, optional focus, message range, and truncation status. Never claim access to omitted content.
