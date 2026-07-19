# Shared Workflow Source Design

## Goal

Make `open-codeasier` the single authoritative source for the ten repository workflow skills shared with `codex-codeasier`, while preserving platform-native generated files in both repositories.

The first phase removes hand-maintained OpenCode/Codex workflow duplication without changing workflow behavior, adding Claude support, or introducing a general workflow DSL.

## Scope

The shared source covers exactly these skills:

- `docs-governance`
- `issue-resolve`
- `issue-review`
- `issue-submit`
- `pr-followup`
- `release-prep`
- `spec-run`
- `spec-write`
- `understand-me`
- `worktree-clean`

The following remain outside the shared source:

- OpenCode `session-review`
- OpenCode runtime, SDK integration, installer, and commands
- Codex marketplace and plugin manifests
- All Claude Code skills, hooks, session management, and packaging
- Release automation and automatic cross-repository pull requests

## Ownership Model

`codeasier/open-codeasier` owns the canonical workflow templates, platform profiles, generator, and generator tests.

`codeasier/codex-codeasier` commits generated Skill files so that the Codex marketplace remains self-contained. It also records the exact full commit SHA of `open-codeasier` used to generate those files.

Generated files remain normal readable Markdown and are included in published artifacts. Consumers do not need the source repository or generator at installation time.

## Source Layout

Add the following files to `open-codeasier`:

```text
workflow-source/
  skills/
    docs-governance.md
    issue-resolve.md
    issue-review.md
    issue-submit.md
    pr-followup.md
    release-prep.md
    spec-run.md
    spec-write.md
    understand-me.md
    worktree-clean.md
  platforms/
    opencode.json
    codex.json
scripts/
  generate-workflows.mjs
  check-workflows.mjs
```

Add an upstream lock file to `codex-codeasier`:

```text
workflow-source.lock.json
```

The lock file contains:

```json
{
  "repository": "codeasier/open-codeasier",
  "commit": "<40-character-commit-sha>",
  "generator": "scripts/generate-workflows.mjs"
}
```

The repository and generator fields are fixed identities. The commit must be a full 40-character hexadecimal Git commit SHA; branches, tags, abbreviated SHAs, and mutable references are invalid.

## Template Format

Canonical files are Markdown templates close to the final Skill files. They retain frontmatter, headings, and workflow prose in one readable document.

Only explicit platform wording uses placeholders. For the first phase, the expected differences are the user-interaction phrases in `issue-submit` and `spec-write`. For example:

```text
{{ASK_REQUIRED_FIELDS}}
{{RESOLVE_AMBIGUITY}}
```

Platform profiles map each allowed placeholder to literal Markdown text. Profiles cannot contain executable expressions, includes, conditionals, filesystem paths, or arbitrary JavaScript.

The generator must reject:

- Unknown placeholders in a template
- Missing values in the selected platform profile
- Profile values that are not strings
- Unused profile keys
- A canonical Skill set different from the exact ten names in scope
- Duplicate Skill names
- Invalid or missing `name` and `description` frontmatter after rendering

This restricted format avoids introducing a workflow language before there is a demonstrated need for one. A later phase may add structured invariants without changing the generated target layout.

## Generated Targets

For the OpenCode profile, generate:

```text
open-codeasier/skills/<skill-name>/SKILL.md
```

For the Codex profile, generate:

```text
codex-codeasier/plugins/codex-codeasier/skills/<skill-name>/SKILL.md
```

OpenCode `commands/*.md` remain hand-maintained in the first phase. They are thin argument-forwarding wrappers, and generating them does not materially reduce current duplication.

The generator updates only the exact ten expected target files. It must not recursively delete directories, remove extra Skills, alter manifests, or modify unrelated files. Existing repository validation remains responsible for reporting an unexpected target Skill set.

## Generator Interface

The generator is a dependency-free Node.js 22 script with an explicit interface suitable for both local use and CI. It accepts:

- A platform: `opencode` or `codex`
- A source root, defaulting to the `open-codeasier` repository root
- A target root
- A mode: write or check

Write mode renders and atomically replaces only changed target files. Check mode performs all rendering and validation in memory, compares expected bytes with target files, reports every mismatch, and never writes.

Output must be deterministic:

- Skills are processed in lexical order.
- Generated files use LF line endings.
- Every generated file ends with one newline.
- No timestamps, local paths, branch names, or environment-dependent values appear in output.

The separate `check-workflows.mjs` entry point may delegate to the generator library or invoke the same internal implementation. It must not duplicate rendering logic.

## Synchronization Flow

An OpenCode workflow change follows this sequence:

1. Edit the canonical template or platform profile in `open-codeasier`.
2. Run the generator for the OpenCode profile.
3. Run OpenCode tests and generation consistency checks.
4. Merge the OpenCode change.
5. Update `workflow-source.lock.json` in `codex-codeasier` to the merged full commit SHA.
6. Check out that exact OpenCode commit and generate the Codex profile into the Codex repository.
7. Run Codex generation consistency and existing marketplace validation.
8. Review and merge the Codex change separately.

The two-repository sequence intentionally allows `open-codeasier` to merge first. Until the Codex update merges, Codex continues publishing its previous self-contained generated files. It is stale but not broken.

## CI Design

### OpenCode CI

OpenCode CI runs the generator in check mode for the OpenCode profile before the existing package checks. CI fails when:

- A canonical template is invalid.
- A platform profile is incomplete or contains an unexpected key.
- A generated OpenCode Skill differs from the committed target.
- The shared source does not contain exactly the expected ten Skills.

Generator unit tests run through the existing npm test command and cover rendering, validation, and deterministic output.

### Codex CI

Codex CI performs these steps:

1. Validate `workflow-source.lock.json` locally before using it.
2. Check out `codeasier/open-codeasier` at the exact locked commit into a temporary sibling directory.
3. Run the locked repository's dependency-free generator in check mode with the Codex repository as target.
4. Run the existing `node scripts/validate.mjs` marketplace and Skill validation.

The checkout must not use the current OpenCode branch or tag. CI does not run `npm install`, package lifecycle scripts, or arbitrary commands discovered from the Codex repository. It runs only the generator path fixed by the lock schema from the pinned OpenCode commit.

The GitHub Actions job needs read access to the public upstream repository. If the upstream later becomes private, authentication changes are a separate operational decision and are not part of this design.

## Validation And Tests

The implementation adds tests for:

- Rendering all ten Skills for both profiles
- Rejecting unknown placeholders
- Rejecting missing and unused profile keys
- Rejecting an unexpected or duplicate canonical Skill
- Rejecting invalid rendered frontmatter
- Producing byte-identical output across repeated runs
- Preserving LF line endings and one trailing newline
- Keeping the eight currently identical OpenCode/Codex Skills byte-identical
- Limiting expected platform differences to `issue-submit` and `spec-write`
- Preventing Codex output from containing `opencode`, `question tool`, `session-review`, or `session_review`
- Validating the Codex upstream lock schema and full commit SHA

The existing Codex validator remains the final platform-boundary check. The generator tests do not replace marketplace, plugin manifest, exact Skill set, or forbidden-capability validation.

## Error Handling

Generator and check failures must identify:

- The platform
- The Skill or profile involved
- The invalid placeholder or field
- The target path for output mismatches

Check mode reports all generated-file mismatches in one run instead of stopping at the first mismatch. Structural source errors may stop generation because subsequent output would not be trustworthy.

Write mode stages all rendered contents and validates every source and output before changing a target file. This prevents a malformed later template from leaving a partially regenerated target set.

## Security And Trust Boundary

The Codex repository treats the locked OpenCode commit as trusted source code. Pinning makes execution reproducible and ensures a mutable upstream branch cannot change a Codex CI run.

The first phase does not attempt to sandbox the generator. The controls are:

- Full commit pinning
- Fixed upstream repository identity
- Fixed generator path
- No dependency installation
- No package lifecycle execution
- Read-only generation check in Codex CI
- Human review when updating the lock commit

If third-party workflow sources are supported later, this trust model must be revisited before reuse.

## Rollout

The implementation should land in two independent changes:

1. `open-codeasier`: add canonical sources, profiles, generator, tests, generated OpenCode Skills, and CI check.
2. `codex-codeasier`: add the upstream lock, regenerate Codex Skills from the merged OpenCode commit, and add pinned cross-repository CI verification.

The first OpenCode change should preserve the current rendered bytes for all ten OpenCode Skills. The first Codex change should preserve the current rendered bytes for all ten Codex Skills. Any behavioral text change must be reviewed as a separate workflow-policy change rather than hidden inside the extraction.

## Future Work

Later phases may:

- Add Claude Code as a generated target with Claude-specific frontmatter and detailed references
- Add machine-readable workflow actions and safety invariants
- Generate OpenCode command wrappers
- Extract the Session Review analysis and normalized-session contracts
- Automate creation of a Codex synchronization pull request
- Move the source to a dedicated `workflow-core` repository if more consumers justify it

These extensions are not required for the first phase and must not complicate its template format or acceptance criteria.

## Acceptance Criteria

- `open-codeasier` is the documented and enforced authority for the ten shared workflows.
- Both repositories retain platform-native, readable, self-contained Skill files.
- The initial extraction produces no byte changes to existing Skill files.
- OpenCode CI detects stale or invalid generated OpenCode Skills.
- Codex records a full pinned OpenCode commit and CI detects stale or invalid generated Codex Skills.
- The two expected interaction wording differences remain explicit platform profile values.
- OpenCode `session-review` and all platform runtimes and manifests remain outside the shared source.
- Existing OpenCode and Codex validation and packaging checks continue to pass.
