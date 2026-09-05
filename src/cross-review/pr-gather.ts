import { execFile } from "node:child_process";
import { stat, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { PrSnapshotMeta } from "./pr-snapshot.js";
import { validatePrSnapshot } from "./pr-snapshot.js";
import type { PrForge } from "./pr-target.js";

const execFileAsync = promisify(execFile);

export const ADAPTER_TIMEOUT_MS = 120_000;
// Buffer above the 1MB diff contract so an oversized patch reaches the
// on-disk validator (which reports the largest hunks) instead of failing
// as a truncated exec.
const ADAPTER_MAX_BUFFER = 16 * 1024 * 1024;

export type PrAdapterRequest = {
  forge: PrForge;
  /** User repository git root; the adapter may fetch but never mutates it. */
  repo: string;
  target: string;
  runID: string;
  stateRoot: string;
  notes?: string;
  gitcodeCli?: string;
};

export type PrAdapterResult =
  | {
      ok: true;
      worktree: string;
      snapshotDir: string;
      meta: PrSnapshotMeta;
    }
  | { ok: false; error: string; snapshotPath?: string | undefined };

export type PrAdapterRunner = (
  request: PrAdapterRequest,
) => Promise<PrAdapterResult>;

export type ExecFileLike = (
  file: string,
  args: string[],
  options: {
    timeout?: number;
    maxBuffer?: number;
    env?: NodeJS.ProcessEnv;
  },
) => Promise<{ stdout: string; stderr: string }>;

export function snapshotPaths(stateRoot: string, runID: string) {
  const worktree = join(stateRoot, runID, "worktree");
  return { worktree, snapshotDir: join(worktree, ".cross-review") };
}

function adapterScriptPath(forge: PrForge) {
  return fileURLToPath(
    new URL(
      forge === "github"
        ? "./adapters/github-pr-snapshot.js"
        : "./adapters/gitcode-pr-snapshot.js",
      import.meta.url,
    ),
  );
}

async function existingPath(path: string): Promise<string | undefined> {
  try {
    await stat(path);
    return path;
  } catch {
    return undefined;
  }
}

function spawnError(error: unknown): string {
  if (error instanceof Error) {
    if ((error as { killed?: boolean }).killed === true)
      return `adapter timed out after ${ADAPTER_TIMEOUT_MS}ms`;
    const stderr = (error as { stderr?: string }).stderr;
    const detail =
      stderr !== undefined && stderr.trim().length > 0
        ? stderr.trim()
        : error.message;
    return detail;
  }
  return String(error);
}

/**
 * Default adapter runner: spawns the forge adapter as a Node ESM entrypoint
 * with `execFile(process.execPath, …)` (no shell), then validates the
 * on-disk contract. Adapters live next to this module in `adapters/`.
 */
export function createDefaultPrAdapterRunner(
  execFileLike: ExecFileLike = execFileAsync,
): PrAdapterRunner {
  return async (request) => {
    const { worktree, snapshotDir } = snapshotPaths(
      request.stateRoot,
      request.runID,
    );
    const args = [
      adapterScriptPath(request.forge),
      "--repo",
      request.repo,
      "--target",
      request.target,
      "--worktree",
      worktree,
      "--snapshot",
      snapshotDir,
      ...(request.notes === undefined ? [] : ["--notes", request.notes]),
    ];
    try {
      await execFileLike(process.execPath, args, {
        timeout: ADAPTER_TIMEOUT_MS,
        maxBuffer: ADAPTER_MAX_BUFFER,
        ...(request.gitcodeCli === undefined
          ? {}
          : { env: { ...process.env, GITCODE_CLI_PATH: request.gitcodeCli } }),
      });
    } catch (error) {
      return {
        ok: false,
        error: `PR snapshot adapter (${request.forge}) failed: ${spawnError(error)}`,
        snapshotPath: await existingPath(worktree),
      };
    }
    const validation = await validatePrSnapshot(worktree);
    if (!validation.ok)
      return {
        ok: false,
        error: `PR snapshot contract validation failed: ${validation.error}`,
        snapshotPath: worktree,
      };
    return {
      ok: true,
      worktree,
      snapshotDir,
      meta: validation.meta,
    };
  };
}

export type SnapshotRemover = (worktree: string) => Promise<void>;

/**
 * Best-effort snapshot removal: `git worktree remove --force`, then delete
 * the `<state>/<runID>/` directory that contained it.
 */
export const defaultRemoveSnapshot: SnapshotRemover = async (worktree) => {
  await execFileAsync("git", ["worktree", "remove", "--force", worktree], {
    timeout: 60_000,
    maxBuffer: 1024 * 1024,
  }).catch(() => undefined);
  await rm(dirname(worktree), { recursive: true, force: true });
};
