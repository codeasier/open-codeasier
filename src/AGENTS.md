# AGENTS.md — src/ (runtime plugin and CLI)

Parent scope: repository root ([../AGENTS.md](../AGENTS.md)). This directory is the single TypeScript build target that produces the compiled runtime distributed as `open-codeasier`.

## Build target

- `tsconfig.json` (repository root) compiles everything under `src/` to `dist/`: `rootDir: src`, `outDir: dist`, target ES2022, module/moduleResolution `NodeNext`, `strict` plus `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`, and `declaration: true` (this is what makes `dist/plugin.d.ts` shippable as the types for the `./server` export).
- Build with `npm run build`; `npm run typecheck` is the no-emit variant. `prepack` runs the build so published tarballs always contain `dist/`.
- There is no bundler, code-splitting, or second build config: `dist/` mirrors `src/` file-for-file. Relative imports must keep the `.js` extension (NodeNext ESM).
- The only runtime dependencies are `@opencode-ai/plugin`, `@opencode-ai/sdk` (pinned `1.14.49`, matching `engines.opencode`), and `proper-lockfile` (used by the cross-review run store). Everything else in `package.json` is dev-only.

## Entry points

| File | Kind | Registered as |
| --- | --- | --- |
| `plugin.ts` | OpenCode plugin entry | Package export `./server` → `dist/plugin.js`; `default` module has id `open-codeasier`. `server()` returns the tool map: `cross_review` (legacy blocking) + `cross_review_start` / `cross_review_status` / `cross_review_cancel` / `cross_review_finalize` (from `cross-review/protocol.ts`) and `session_review` (from `session-review/tool.ts`). Adding a tool means adding it here — nothing else registers tools. |
| `cli.ts` | CLI bin | `open-codeasier` → `dist/cli.js`. Subcommands: `init [--local\|--global] [path] [--dry-run]`, `install [--project <dir>] [--dry-run]`, `uninstall [--project <dir>] [--dry-run]`. Exports `run(argv)` for tests; the real entry guard compares `realpath(process.argv[1])` so importing the module never executes the CLI. Exit code 2 = usage error, 1 = conflict error, 0 = success. |

Both entries are thin: `plugin.ts` only wires tool factories to the injected OpenCode `client`; `cli.ts` only parses arguments and calls subsystem functions. All behavior lives in the three subsystems below.

## Subsystems

| Directory | Boundary | Details |
| --- | --- | --- |
| `cross-review/` | Largest subsystem: cross-review protocol, config, persistent run store, guided init, legacy tool | [cross-review/AGENTS.md](cross-review/AGENTS.md) |
| `installer/` | Deployment lifecycle of the packaged markdown assets (discover, manifest, install, uninstall) | [installer/AGENTS.md](installer/AGENTS.md) |
| `session-review/` | `session_review` tool: read-only SDK boundary plus normalization to bounded evidence | [session-review/AGENTS.md](session-review/AGENTS.md) |

Note the deliberate reuse across subsystems: `cli.ts` uses `cross-review/config.ts` (`findGitRoot`) and `cross-review/init.ts` for `init`, and `installer/*` for `install`/`uninstall`; `installer/init` writes the config into the same target roots the installer manages (`~/.config/opencode` / `<project>/.opencode`).

## Tests

Vitest (node environment, `vitest.config.ts`) runs `tests/*.test.ts` from the repository root; suites import these sources directly (`../src/...`), so no build step is required. Mapping:

| Test file(s) | Covers |
| --- | --- |
| `tests/plugin.test.ts` | `plugin.ts` tool registration |
| `tests/cross-review.test.ts`, `tests/cross-review-protocol.test.ts`, `tests/cross-review-store.test.ts`, `tests/config.test.ts`, `tests/init.test.ts` | `cross-review/*` (legacy tool, async protocol, run store, config merge, CLI init) |
| `tests/installer.test.ts`, `tests/assets.test.ts` | `installer/*` (install/uninstall, CLI parser, packaged-asset discovery) |
| `tests/session-review.test.ts`, `tests/normalize.test.ts` | `session-review/*` |
| `tests/workflow-generator.test.ts` | `scripts/generate-workflows.mjs` (see [../workflow-source/AGENTS.md](../workflow-source/AGENTS.md)) |

Run one suite with `npx vitest run tests/<file>.test.ts`. Error-handling convention to preserve when editing: `session-review` converts its typed errors into tool output, while `cross-review` throws for invalid usage so OpenCode surfaces the failure.
