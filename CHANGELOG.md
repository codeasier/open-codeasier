# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.2.9] - 2026-08-15

### Changed

- Cut the token cost of the `cross_review_status` polling loop. The default
  status result is now compact (`runID`, `phase`, `quorum`, `counts`,
  `readyToFinalize`, `pollAfterMs`, and the per-reviewer text `summary`),
  omitting the full `target` and per-reviewer objects; request the full
  fields with `detail: true` or `includeOutputs: true` (`includeOutputs`
  implies `detail`), and `cross_review_finalize` still returns the complete
  candidates once. The recommended poll interval now settles to 10s while
  sessions are running, stays at 3s while the gatherer or any session is
  starting, and shortens near a session deadline, so a review that used to
  poll every 3 seconds now spends far fewer tokens on repeated status
  payloads. The bundled skill and workflow instructions direct the parent
  session to wait at least `pollAfterMs` between polls and to avoid copying
  the status payload into the conversation.

## [0.2.8] - 2026-08-14

### Added

- Gather the target context once and share it with every reviewer instead of
  letting each reviewer fetch it independently. With a configured
  `judgeModel` and no supplied `context`, cross-review runs a read-only
  gathering phase in the judge session first (reported as a `gatherer` in
  `cross_review_status`), embeds the gathered output into every reviewer
  brief, and degrades to independent fetching when gathering fails or times
  out. An optional `context` argument (collected by the parent session when
  no `judgeModel` is configured) skips the gathering phase and is embedded in
  reviewer briefs and the judge prompt. Run manifests migrate from schema
  version 1 to 2 on load.

## [0.2.7] - 2026-08-14

### Added

- Support an optional `reviewerTimeoutMs` key (5000-3600000, default 600000)
  in project and global cross-review configuration, collected during guided
  setup, so a team can pin the reviewer and judge deadline instead of passing
  `--reviewer-timeout-ms` on every invocation.

### Fixed

- Surface each reviewer's own progress in `cross_review_status` through a
  readable per-reviewer `summary` of every reviewer's and the judge's status.
- Keep cross-review setup on the destination's existing `reviewers` or
  `reviewModels` format instead of writing a conflicting `reviewers` array
  into a flat `reviewModels` config.

## [0.2.6] - 2026-08-13

### Fixed

- Fix cross-review failing all reviewers because `promptAsync` received an
  invalid message ID, and migrate legacy cross-review message IDs to valid
  ones so existing runs keep working.

## [0.2.5] - 2026-08-13

### Fixed

- Replace metadata-only cross-review progress with resumable asynchronous
  start, status, cancel, and finalize tools, including bounded reviewer
  execution, persisted child-session provenance, timeout handling, and
  two-phase explicit judging.

## [0.2.4] - 2026-08-11

### Fixed

- Keep runtime plugin and workflow asset upgrades on the same exact package
  version and scope, and print the matching runtime command after asset installs.
- Stop cross-review with versioned recovery guidance when its runtime tool is
  unavailable instead of improvising a fallback.
- Report live cross-review progress and child-session provenance through tool
  metadata so long-running reviewers and judges remain observable.
- Treat an explicitly blank `judgeModel` as parent-session judging instead of
  rejecting it as an invalid model identifier.

## [0.2.3] - 2026-08-09

### Fixed

- Restrict the `cross-reviewer` subagent to explicit code/change review and
  cross-review judging instead of routine self-checks or report verification.
- Accept nested cross-review model IDs with multiple `/` segments (e.g.
  `unraid-wg/wb/Claude-k3`) in `reviewers`, `reviewModels`, and `judgeModel`
  instead of rejecting them as malformed `provider/model` identifiers.
- Resolve the cross-review project config from the enclosing git repository
  root instead of the session working directory, so a project's local
  `.opencode/cross-review.json` is honored when a session is launched from a
  subdirectory or worktree that does not carry its own config.
- Surface a structured `configSources` (`project` and `global`, each
  `loaded` or `absent`) plus the resolved project and global paths
  in cross-review tool metadata, and prepend a `warning` field to the tool
  output when the project config was not loaded so callers can detect a
  silent fallback to the global config.

## [0.2.2] - 2026-08-08

### Fixed

- Build distributable artifacts automatically before packing or publishing so
  the CLI and server exports are included in npm packages.

## [0.2.1] - 2026-08-08

### Added

- Add an OpenCode-only `cross-review` workflow with configurable isolated
  reviewer models, bounded concurrency, quorum handling, and provenance.
- Add a read-only reviewer agent and SDK session orchestration with explicit
  model validation and tool restrictions.
- Read `cross-review` configuration from project `.opencode/cross-review.json`
  and global `~/.config/opencode/cross-review.json` so sessions only pass a
  target, with per-reviewer `focus` support and optional per-invocation
  overrides.
- Add `init [--local|--global] [project]` scaffolding (local/current-directory
  defaults) and guided OpenCode-session setup for role-oriented cross-review
  configuration without overwriting existing user files.

### Changed

- Make the cross-review initializer model-free. Guided setup now lists the
  user's connected models and recommends reviewers and a judge only from that
  discovered list before asking for confirmation.

## [0.2.0] - 2026-07-27

### Added

- Add a canonical shared workflow source and deterministic generator for
  OpenCode and Codex skills.
- Add the `/handoff` workflow for creating, updating, and resuming task handoff
  documents across agent sessions.

### Changed

- Enforce generated workflow consistency in CI and strengthen placeholder,
  frontmatter, and symlink safety validation.
- Include the handoff skill and command in packaged installation assets and
  public documentation.

## [0.1.1] - 2026-07-12

### Changed

- Lower the minimum supported OpenCode version to 1.14.49.

## [0.1.0] - 2026-07-11

### Added

- Add OpenCode-native workflow skills and commands for issue, pull request,
  release, specification, documentation, and worktree workflows.
- Add a read-only, SDK-backed session review tool.
- Add project and global installation support for packaged workflow assets.

[Unreleased]: https://github.com/codeasier/open-codeasier/compare/v0.2.8...HEAD
[0.2.9]: https://github.com/codeasier/open-codeasier/compare/v0.2.8...v0.2.9
[0.2.8]: https://github.com/codeasier/open-codeasier/compare/v0.2.7...v0.2.8
[0.2.7]: https://github.com/codeasier/open-codeasier/compare/v0.2.6...v0.2.7
[0.2.6]: https://github.com/codeasier/open-codeasier/compare/v0.2.5...v0.2.6
[0.2.5]: https://github.com/codeasier/open-codeasier/compare/v0.2.4...v0.2.5
[0.2.4]: https://github.com/codeasier/open-codeasier/compare/v0.2.3...v0.2.4
[0.2.3]: https://github.com/codeasier/open-codeasier/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/codeasier/open-codeasier/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/codeasier/open-codeasier/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/codeasier/open-codeasier/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/codeasier/open-codeasier/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/codeasier/open-codeasier/releases/tag/v0.1.0
