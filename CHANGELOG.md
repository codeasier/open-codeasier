# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

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

[Unreleased]: https://github.com/codeasier/open-codeasier/compare/v0.2.4...HEAD
[0.2.4]: https://github.com/codeasier/open-codeasier/compare/v0.2.3...v0.2.4
[0.2.3]: https://github.com/codeasier/open-codeasier/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/codeasier/open-codeasier/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/codeasier/open-codeasier/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/codeasier/open-codeasier/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/codeasier/open-codeasier/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/codeasier/open-codeasier/releases/tag/v0.1.0
