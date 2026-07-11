---
name: cce-spec-run
description: Execute an approved spec package and maintain verified task and checklist progress.
---

# Spec Run

Identify exactly one package under `specs/<change-id>` and read `spec.md`, `tasks.md`, and `checklist.md` before implementation. Stop if required files are missing or requirements contradict. Execute tasks in dependency order with tests first where practical. Mark task checkboxes only after implementation and checklist items only after verification. If a check fails, preserve or add corrective work, fix it within scope, and rerun it. Finish with implemented scope, changed files, progress, exact verification results, and remaining work.
