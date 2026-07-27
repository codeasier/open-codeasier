# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

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

[Unreleased]: https://github.com/codeasier/open-codeasier/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/codeasier/open-codeasier/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/codeasier/open-codeasier/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/codeasier/open-codeasier/releases/tag/v0.1.0
