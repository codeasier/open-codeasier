# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

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

[Unreleased]: https://github.com/codeasier/open-codeasier/compare/v0.2.2...HEAD
[0.2.2]: https://github.com/codeasier/open-codeasier/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/codeasier/open-codeasier/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/codeasier/open-codeasier/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/codeasier/open-codeasier/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/codeasier/open-codeasier/releases/tag/v0.1.0
