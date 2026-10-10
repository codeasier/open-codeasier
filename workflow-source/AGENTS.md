# AGENTS.md — workflow-source/ (canonical workflow templates)

Parent scope: repository root ([../AGENTS.md](../AGENTS.md)).

This directory is the **source of truth for the shared workflow skills**; the `skills/` and `agents/` markdown at the repository root is generated from it and must never be edited by hand. Per `docs/superpowers/specs/2026-07-19-shared-workflow-source-design.md`, these templates are shared with the `codeasier/codex-codeasier` repository, which commits its own rendered copies and records the generating commit SHA — treat changes here as cross-repo contract changes.

## Layout

| Path | Contents |
| --- | --- |
| `skills/<name>.md` | One template per skill, with YAML frontmatter and `{{PLACEHOLDER}}` tokens |
| `platforms/opencode.json` | OpenCode profile: values for every placeholder (e.g. `CROSS_REVIEW_ORCHESTRATION`, `MODEL_NAMING`, `ASK_REQUIRED_FIELDS`, `RESOLVE_AMBIGUITY`) |
| `platforms/codex.json` | Codex profile with only `ASK_REQUIRED_FIELDS` and `RESOLVE_AMBIGUITY` — rendering fails if a template uses a key the target profile lacks, which works because the OpenCode-specific keys are used only by `skills/cross-review.md` and that skill is excluded on codex |
| `agents/cross-reviewer.md` | Body-only instructions for the reviewer/judge subagent; the generator prepends fixed frontmatter (`mode: subagent`, deny `edit`/`bash`/`task`) |

## Generator contract (`../scripts/generate-workflows.mjs`)

- The skill set is a hard contract: `expectedSkills` in the script lists exactly the 12 templates (`cross-review`, `docs-governance`, `handoff`, `issue-resolve`, `issue-review`, `issue-submit`, `pr-followup`, `release-prep`, `spec-run`, `spec-write`, `understand-me`, `worktree-clean`). Adding, renaming, or removing a skill requires updating that array, the template directory, and (for OpenCode) the matching hand-maintained `../commands/<name>.md` wrapper together.
- `npm run workflows:generate` renders `--platform opencode --target .` into the repository root: `skills/<name>/SKILL.md` for all 12 plus `agents/cross-reviewer.md`. The `codex` platform excludes `cross-review` and writes under `plugins/codex-codeasier/skills` in the target repo.
- Validation enforced at generation time: placeholder names must match `[A-Z][A-Z0-9_]*` with no nesting or stray braces; every placeholder must exist in the profile as a string, and every profile key must be used (unused keys are an error); rendered frontmatter must have `name` equal to the file name and a `description`, with plain scalar values only; the agent template may not contain placeholders at all.
- `npm run workflows:check` (wrapper `../scripts/check-workflows.mjs`) re-renders and fails listing any stale generated file. It runs in CI both standalone and inside `npm run check` — a template change without regeneration fails the build.

## What is NOT generated here

`../commands/*.md` (all 13 thin "Load the `<name>` skill" wrappers) and `../skills/session-review/SKILL.md` are hand-maintained by design — the shared-source design doc explicitly leaves OpenCode `session-review` and commands out of the shared set. Edit those directly, not through the generator.

## Tests

`tests/workflow-generator.test.ts` covers rendering, profile, and validation behavior. Run with `npx vitest run tests/workflow-generator.test.ts`.
