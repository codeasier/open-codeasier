import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, rm, stat, writeFile } from "node:fs/promises";
import {
  basename,
  delimiter,
  dirname,
  isAbsolute,
  join,
  resolve,
} from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { PrSnapshotMeta } from "./pr-snapshot.js";
import { validatePrSnapshot } from "./pr-snapshot.js";
import type { PrForge } from "./pr-target.js";
import { findGitRoot } from "./config.js";
import { writeEvidencePack, type EvidencePack } from "./evidence.js";
import type { CrossReviewRun } from "./run-store.js";

const execFileAsync = promisify(execFile);

export const ADAPTER_TIMEOUT_MS = 120_000;
// Buffer above the 1MB diff contract so an oversized patch reaches the
// on-disk validator (which reports the largest hunks) instead of failing
// as a truncated exec.
export const ADAPTER_MAX_BUFFER = 16 * 1024 * 1024;
/** Absolute Node executable used when the host process cannot run adapters. */
export const ADAPTER_NODE_ENV = "OPEN_CODEASIER_NODE";
// Notes travel through argv; beyond this size spawns fail with E2BIG /
// ENAMETOOLONG depending on the platform, so reject with guidance first.
const MAX_NOTES_LENGTH = 32 * 1024;

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

export type AdapterRuntimeHost = {
  execPath: string;
  versions: { node?: string | undefined; bun?: string | undefined };
};

export type AdapterRuntimeOptions = {
  env?: NodeJS.ProcessEnv;
  host?: AdapterRuntimeHost;
  isFile?: (path: string) => Promise<boolean>;
  platform?: NodeJS.Platform;
  pathDelimiter?: string;
};

export type AdapterRuntimeResolution =
  | { ok: true; executable: string }
  | { ok: false; error: string };

function nodeCommandNames(platform: NodeJS.Platform): string[] {
  // `execFile` is shell-free, so Windows `.cmd` shims are not launchable.
  return platform === "win32" ? ["node.exe", "node"] : ["node"];
}

function nodeExecutableName(execPath: string): boolean {
  const base = basename(execPath).toLowerCase();
  return base === "node" || base === "node.exe" || base === "nodejs";
}

function hostCanRunAdapterScripts(host: AdapterRuntimeHost): boolean {
  if (host.versions.bun !== undefined && host.versions.bun.length > 0)
    return false;
  if (host.versions.node === undefined || host.versions.node.length === 0)
    return false;
  return nodeExecutableName(host.execPath);
}

async function defaultIsRuntimeFile(path: string): Promise<boolean> {
  try {
    if (!(await stat(path)).isFile()) return false;
    // POSIX execute bit: a stray non-executable `node` earlier on PATH
    // must not shadow a later working runtime. Windows file modes are
    // not a reliable execute signal.
    if (process.platform !== "win32") await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function missingAdapterRuntimeError(hostExecPath: string): string {
  return `Node.js 22+ is required to gather PR snapshots, but the host executable (${hostExecPath}) cannot run adapter scripts. Install Node.js 22+ on PATH or set ${ADAPTER_NODE_ENV} to an absolute node executable.`;
}

function adapterRuntimeLaunchError(executable: string): string {
  return `could not launch Node.js runtime at ${executable}. Install Node.js 22+ on PATH or set ${ADAPTER_NODE_ENV} to an absolute node executable.`;
}

/**
 * Choose a Node.js executable that can run the forge adapter scripts.
 * Standalone OpenCode binaries reuse `process.execPath` as themselves, so
 * the host is used only when it is actually Node.
 */
export async function resolveAdapterRuntime(
  options: AdapterRuntimeOptions = {},
): Promise<AdapterRuntimeResolution> {
  const env = options.env ?? process.env;
  const host = options.host ?? process;
  const isFile = options.isFile ?? defaultIsRuntimeFile;
  const platform = options.platform ?? process.platform;
  const pathDelimiter = options.pathDelimiter ?? delimiter;

  const override = env[ADAPTER_NODE_ENV]?.trim();
  if (override !== undefined && override.length > 0) {
    if (!isAbsolute(override))
      return {
        ok: false,
        error: `\`${ADAPTER_NODE_ENV}\` must be an absolute path to a Node.js executable`,
      };
    if (!(await isFile(override)))
      return {
        ok: false,
        error: `${ADAPTER_NODE_ENV} is not a usable Node.js executable: ${override}`,
      };
    return { ok: true, executable: override };
  }

  if (hostCanRunAdapterScripts(host) && (await isFile(host.execPath)))
    return { ok: true, executable: host.execPath };

  const pathEnv = env.PATH ?? env.Path ?? "";
  for (const directory of pathEnv.split(pathDelimiter)) {
    if (directory.length === 0) continue;
    for (const name of nodeCommandNames(platform)) {
      const candidate = join(directory, name);
      if (await isFile(candidate)) return { ok: true, executable: candidate };
    }
  }

  return { ok: false, error: missingAdapterRuntimeError(host.execPath) };
}

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

/** The path itself when it exists on disk, otherwise undefined. */
export async function existingPath(path: string): Promise<string | undefined> {
  try {
    await stat(path);
    return path;
  } catch {
    return undefined;
  }
}

function spawnError(error: unknown, executable: string): string {
  if (error instanceof Error) {
    if ((error as { killed?: boolean }).killed === true)
      return `adapter timed out after ${ADAPTER_TIMEOUT_MS}ms`;
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return adapterRuntimeLaunchError(executable);
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
 * Default adapter runner: resolves a Node.js executable, spawns the forge
 * adapter as an ESM entrypoint with `execFile` (no shell), then validates
 * the on-disk contract. Adapters live next to this module in `adapters/`.
 * A standalone OpenCode/Bun host is never reused as the adapter runtime.
 */
export function createDefaultPrAdapterRunner(
  execFileLike: ExecFileLike = execFileAsync,
  runtime: AdapterRuntimeOptions = {},
): PrAdapterRunner {
  return async (request) => {
    if (request.notes !== undefined && request.notes.length > MAX_NOTES_LENGTH)
      return {
        ok: false,
        error: `\`context\` for a pull request snapshot must be at most ${MAX_NOTES_LENGTH} characters; got ${request.notes.length}. Write large context to a file and reference it from shorter notes.`,
      };
    const resolved = await resolveAdapterRuntime(runtime);
    if (!resolved.ok)
      return {
        ok: false,
        error: `PR snapshot adapter (${request.forge}) failed: ${resolved.error}`,
      };
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
      await execFileLike(resolved.executable, args, {
        timeout: ADAPTER_TIMEOUT_MS,
        maxBuffer: ADAPTER_MAX_BUFFER,
        ...(request.gitcodeCli === undefined
          ? {}
          : { env: { ...process.env, GITCODE_CLI_PATH: request.gitcodeCli } }),
      });
    } catch (error) {
      return {
        ok: false,
        error: `PR snapshot adapter (${request.forge}) failed: ${spawnError(error, resolved.executable)}`,
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

export const PARENT_SNAPSHOT_REQUIRES_GIT_ERROR =
  "Non-PR context or evidenceDir starts require a git repository to pin an isolated detached worktree";
export const INVALID_REVIEW_REVISION_RANGE_ERROR =
  "Invalid review revision range";

export async function createParentSnapshot(input: {
  repo: string;
  target: string;
  runID: string;
  stateRoot: string;
  context?: string;
  pack?: EvidencePack;
}): Promise<NonNullable<CrossReviewRun["snapshot"]>> {
  if ((await findGitRoot(input.repo)) === undefined)
    throw new Error(PARENT_SNAPSHOT_REQUIRES_GIT_ERROR);
  const git = async (...args: string[]) =>
    (
      await execFileAsync("git", ["-C", input.repo, ...args], {
        timeout: 60_000,
        maxBuffer: 1024 * 1024,
      })
    ).stdout.trim();
  const target = input.target.trim();
  const range = /^([^\s]+?)\.{2,3}([^\s]+)$/.exec(target);
  // Any target containing `..` is reserved for a revision range. Prose
  // such as `fix ... bug` is rejected rather than silently pinning HEAD.
  if (target.includes("..") && !range)
    throw new Error(INVALID_REVIEW_REVISION_RANGE_ERROR);
  const paths = snapshotPaths(resolve(input.stateRoot), input.runID);
  try {
    if (range)
      await git(
        "rev-parse",
        "--verify",
        "--end-of-options",
        `${range[1]}^{commit}`,
      );
    const headSha = await git(
      "rev-parse",
      "--verify",
      "--end-of-options",
      `${range?.[2] ?? "HEAD"}^{commit}`,
    );
    await mkdir(dirname(paths.worktree), { recursive: true });
    await git("worktree", "add", "--detach", paths.worktree, headSha);
    // A repository may track this name, even as a symlink. Never write through it.
    await rm(paths.snapshotDir, { recursive: true, force: true });
    if (input.pack) await writeEvidencePack(paths.snapshotDir, input.pack);
    else {
      await mkdir(paths.snapshotDir);
      await writeFile(
        join(paths.snapshotDir, "meta.json"),
        JSON.stringify({
          source: "parent-pack",
          target: input.target,
          headSha,
        }),
      );
      await writeFile(
        join(paths.snapshotDir, "summary.md"),
        input.context ?? "",
      );
    }
    if (input.pack && input.context !== undefined)
      await writeFile(
        join(paths.snapshotDir, "summary.md"),
        Buffer.concat([
          input.pack.files.get("summary.md") ?? Buffer.alloc(0),
          Buffer.from(`\n\n${input.context}`),
        ]),
      );
    return {
      ...paths,
      source: "parent-pack",
      headSha,
      ...(input.pack ? { evidenceDir: input.pack.evidenceDir } : {}),
    };
  } catch (error) {
    await defaultRemoveSnapshot(paths.worktree);
    throw error;
  }
}

/**
 * Best-effort snapshot removal: `git worktree remove --force`, then delete
 * the `<state>/<runID>/` directory that contained it.
 */
export const defaultRemoveSnapshot: SnapshotRemover = async (worktree) => {
  // Resolve first: with a relative worktree (e.g. a relative stateRoot from a
  // custom embed), `-C <worktree>` changes the cwd before the positional
  // path argument is resolved, so a relative path would point inside the
  // worktree itself and the removal would fail, leaving a
  // `.git/worktrees/<id>` entry behind.
  const absolute = resolve(worktree);
  // `-C <absolute>` keeps the call independent of the plugin process cwd,
  // so removal still works when the plugin runs outside the repository;
  // otherwise the `.git/worktrees/<id>` entry lingers until a manual
  // `git worktree prune`.
  await execFileAsync(
    "git",
    ["-C", absolute, "worktree", "remove", "--force", absolute],
    {
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
    },
  ).catch(() => undefined);
  await rm(dirname(absolute), { recursive: true, force: true });
};
