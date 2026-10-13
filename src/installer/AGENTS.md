# AGENTS.md — src/installer/ (asset installer)

Parent scope: [../AGENTS.md](../AGENTS.md) (runtime build target); repository overview in [../../AGENTS.md](../../AGENTS.md).

This subsystem owns the deployment lifecycle of the packaged markdown assets (`skills/`, `commands/`, `agents/` as shipped in the npm tarball): discovering them, copying them to an OpenCode config root, tracking ownership, and removing only what it owns.

## Files

| File | Responsibility |
| --- | --- |
| `paths.ts` | Scope resolution: project scope → `<project>/.opencode`, global scope (default) → `<home>/.config/opencode` (`resolveTarget`) |
| `assets.ts` | `discoverAssets()` scans the packaged `skills/`, `commands/`, `agents/` directories; keeps only paths matching `skills/<name>/SKILL.md`, `commands/<name>.md`, or `agents/<name>.md` and records source + sha256 |
| `manifest.ts` | Install manifest at `<target-root>/.open-codeasier/installed-assets.json`: `{ schemaVersion: 1, packageVersion, files: [{ path, sha256 }] }`, strictly validated; `atomicWrite` helper (temp + rename) |
| `install.ts` | `installAssets` / `uninstallAssets` and the `AssetConflictError` safety model |

`cli.ts` (in `../`) is the only caller: `install` reads the packaged `package.json` for the version (so the printed `opencode plugin open-codeasier@<version>` command always matches the running package) and, for project scope, prints the correct working directory for that command.

## Install lifecycle and invariants

- **Ownership is everything.** Before writing, each existing target file must either be absent or be listed in the prior manifest with an unchanged sha256. A file that exists but is not manifest-owned, or whose hash drifted from the manifest, raises `AssetConflictError` — user-edited assets are never overwritten. The same rule protects uninstall and the removal of assets that disappeared from the package between versions.
- Symlinks are rejected at every path segment from the target root down (both install and uninstall), so a symlinked `skills/` or `SKILL.md` cannot redirect writes.
- The manifest is rewritten after every successful install to the exact packaged set (path + sha256); `uninstall` removes manifest-listed files only when their hashes still match, prunes now-empty parent directories, and deletes the manifest.
- `--dry-run` computes and reports the same `written`/`removed`/`unchanged` result without touching the filesystem.
- `init` (cross-review config creation, `../cross-review/init.ts`) writes into the same resolved target roots and follows the same conflict discipline: it creates `{}` with an exclusive `open(path, "wx")` and refuses to overwrite an existing or unsafe path.

## Tests

`tests/installer.test.ts` (install/uninstall semantics, conflict and symlink rejection, CLI argument parser for `install`/`uninstall`) and `tests/assets.test.ts` (packaged asset discovery against the repository). Run with `npx vitest run tests/installer.test.ts`. CI additionally exercises the real installed tarball end-to-end (install, import `open-codeasier/server`, uninstall under a temp `HOME`) — see `.github/workflows/ci.yml`.
