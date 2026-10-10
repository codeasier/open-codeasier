# AGENTS.md — open-codeasier

`open-codeasier` is a single npm package (ESM, MIT, `package.json` version 0.2.9) that ships an OpenCode plugin plus workflow assets. It requires Node.js >= 22 and OpenCode >= 1.14.49 (`engines` in `package.json`). Runtime dependencies are exactly three: `@opencode-ai/plugin` and `@opencode-ai/sdk` (both pinned `1.14.49`) and `proper-lockfile`.

## Architecture: three distribution surfaces, one package

The package is consumed through three distinct surfaces that are versioned together but installed differently:

1. **Runtime plugin (TypeScript, compiled).** `src/` is compiled by `tsc` into `dist/` (never committed). The package export `./server` points to `dist/plugin.js`, whose default module registers plugin id `open-codeasier` and six tools: the legacy blocking `cross_review`, the asynchronous protocol `cross_review_start` / `cross_review_status` / `cross_review_cancel` / `cross_review_finalize`, and `session_review` (`src/plugin.ts`). Users install it with `opencode plugin open-codeasier@<version> [--global] --force`.
2. **Asset installer CLI.** The `open-codeasier` bin (`dist/cli.js`, `src/cli.ts`) provides `init`, `install [--project <dir>] [--dry-run]`, and `uninstall [--project <dir>] [--dry-run]`. It copies the packaged markdown assets into `~/.config/opencode/` (global default) or `<project>/.opencode/` (project scope) and tracks ownership in `<target>/.open-codeasier/installed-assets.json`.
3. **Workflow assets (markdown, shipped in the tarball).** `skills/`, `commands/`, and `agents/` are listed in `package.json` `files` and are what the installer distributes. See "Generated vs. hand-maintained" below — most of them are build artifacts of `workflow-source/`.

Data flow at runtime: an OpenCode session invokes `/cross-review` or `/session-review` (commands that load the matching skill) → the skill instructs the session to call the plugin tools → the cross-review tools create and reconcile isolated child sessions through the OpenCode SDK client and persist run manifests in an OS state directory outside the repository; `session_review` reads exactly one session read-only.

## Repository layout and generated vs. hand-maintained files

| Path | Role | Edit directly? |
| --- | --- | --- |
| `src/` | Runtime plugin + CLI source, one `tsc` build target → `dist/` | Yes — see [src/AGENTS.md](src/AGENTS.md) |
| `workflow-source/` | Canonical skill/agent templates + per-platform profiles | Yes — see [workflow-source/AGENTS.md](workflow-source/AGENTS.md) |
| `skills/<name>/SKILL.md` | Packaged skill assets; the 12 shared skills are **generated** from `workflow-source/` by `npm run workflows:generate` | No (except `skills/session-review/SKILL.md`, which is hand-maintained) |
| `agents/cross-reviewer.md` | Reviewer/judge subagent definition; **generated** from `workflow-source/agents/cross-reviewer.md` (frontmatter added by the generator) | No |
| `commands/<name>.md` | Thin command wrappers ("Load the `<name>` skill and follow it with these arguments: $ARGUMENTS") — all 13 are hand-maintained, not generated | Yes |
| `scripts/` | `generate-workflows.mjs` (generator) and `check-workflows.mjs` (CI check wrapper) | Yes |
| `tests/` | Vitest suites at repo root, importing `../src/*.ts` directly | Yes |
| `docs/superpowers/` | Design docs and plans (e.g. the shared-workflow-source design) | Yes |
| `.github/workflows/ci.yml` | CI (see below) | Yes |

**Critical invariant:** to change a generated skill or the reviewer agent, edit `workflow-source/` and run `npm run workflows:generate`, then commit the regenerated `skills/` / `agents/` output in the same change. `npm run workflows:check` fails on stale generated files and runs in CI, in `npm run check`, and as a standalone CI step before `npm run check`.

## Commands

All commands run from the repository root (no workspace/monorepo tooling):

| Command | What it does |
| --- | --- |
| `npm ci` | Install dependencies |
| `npm run check` | Full gate: `workflows:check` → `format:check` (prettier) → `lint` (eslint) → `typecheck` (`tsc --noEmit`) → `test` (`vitest run`) → `build` |
| `npm run build` | `tsc -p tsconfig.json`, emits `dist/` (also runs automatically on `prepack`) |
| `npm run typecheck` | Type-check without emitting |
| `npm test` | `vitest run` over `tests/` |
| `npm run lint` / `npm run format` / `npm run format:check` | ESLint / Prettier |
| `npm run workflows:generate` | Regenerate `skills/` + `agents/` from `workflow-source/` |
| `npm run workflows:check` | Fail if generated files are stale |

Focus a single test file with `npx vitest run tests/<file>.test.ts` (e.g. `npx vitest run tests/cross-review-protocol.test.ts`); filter by test name with `-t "<pattern>"`. Tests import TypeScript sources directly, so no build is needed to run them. Do not run `npm publish` or the installer against a real `~/.config/opencode` when iterating; use `--dry-run` / temp `HOME` as CI does.

## CI (`.github/workflows/ci.yml`)

Two jobs on Node 22, triggered by pushes and PRs to `main`:

- `check` — `npm ci`, `npm run workflows:check`, `npm run check`, then a packed-package smoke test: `npm pack`, verify `package/dist/plugin.js` and the session-review skill/command are in the tarball, `import('open-codeasier/server')` in a temp install, run the `install`/`uninstall` bin against a temp `HOME`, and assert the assets appear and disappear.
- `minimum-opencode` — installs `opencode-ai` at the exact minimum from `engines.opencode`, loads this package's plugin through `OPENCODE_CONFIG`, and asserts the plugin loads without "failed to load plugin".

## Cross-cutting rules

- Relative imports in `src/` use explicit `.js` suffixes (NodeNext ESM resolution); compiled output mirrors `src/` one-to-one with no bundler.
- Model identifiers are exact OpenCode `provider/model` strings validated against the live provider list; there is no silent fallback between models (`src/cross-review/protocol.ts`, `workflow-source/platforms/opencode.json`).
- Releases follow Keep-a-Changelog `CHANGELOG.md` + semver; history shows `release/vX.Y.Z` branches merged with `chore: prepare vX.Y.Z release` commits — update `package.json` `version` and `CHANGELOG.md` together.
- Documentation language for this repo is English (matching `README.md`).

## Scope-specific guides

| Guide | Scope |
| --- | --- |
| [src/AGENTS.md](src/AGENTS.md) | TypeScript runtime: build target, entry points, test mapping |
| [src/cross-review/AGENTS.md](src/cross-review/AGENTS.md) | Cross-review subsystem: async protocol, run store, config |
| [src/installer/AGENTS.md](src/installer/AGENTS.md) | Asset installer: scopes, manifest, conflict rules |
| [src/session-review/AGENTS.md](src/session-review/AGENTS.md) | `session_review` tool: SDK boundary, normalization limits |
| [workflow-source/AGENTS.md](workflow-source/AGENTS.md) | Canonical workflow templates, platform profiles, generator contract |
