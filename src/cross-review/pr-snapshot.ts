import { execFile } from "node:child_process";
import { readFile, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const PR_SNAPSHOT_SCHEMA_VERSION = 1;
export const MAX_DIFF_PATCH_BYTES = 1_000_000;
export const TRUNCATION_MARKER = "[...truncated...]";

export type PrSnapshotForge = "github" | "gitcode";

export type PrSnapshotMeta = {
  schemaVersion: typeof PR_SNAPSHOT_SCHEMA_VERSION;
  forge: PrSnapshotForge;
  target: string;
  url: string;
  baseSha: string;
  headSha: string;
  mergeBaseSha: string;
  fetchedAt: string;
};

export type PrSnapshotValidation =
  | { ok: true; meta: PrSnapshotMeta }
  | { ok: false; error: string };

const SHA_40 = /^[0-9a-fA-F]{40}$/;
const FORGES = new Set<PrSnapshotForge>(["github", "gitcode"]);

export type RevParseHead = (
  worktree: string,
) => Promise<{ stdout: string; stderr: string }>;

async function defaultRevParseHead(worktree: string) {
  return execFileAsync("git", ["-C", worktree, "rev-parse", "HEAD"], {
    encoding: "utf8",
    timeout: 10_000,
  });
}

function parseMeta(raw: string, path: string): PrSnapshotMeta {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid JSON in ${path}: ${(error as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null)
    throw new Error(`Invalid ${path}: expected a JSON object`);
  const meta = parsed as Record<string, unknown>;
  if (meta.schemaVersion !== PR_SNAPSHOT_SCHEMA_VERSION)
    throw new Error(
      `Invalid ${path}: unsupported schemaVersion ${JSON.stringify(meta.schemaVersion)}`,
    );
  if (
    typeof meta.forge !== "string" ||
    !FORGES.has(meta.forge as PrSnapshotForge)
  )
    throw new Error(`Invalid ${path}: forge must be "github" or "gitcode"`);
  for (const field of ["target", "url", "fetchedAt"] as const) {
    if (typeof meta[field] !== "string" || (meta[field] as string).length === 0)
      throw new Error(`Invalid ${path}: ${field} must be a non-empty string`);
  }
  const sha = (field: "baseSha" | "headSha" | "mergeBaseSha"): string => {
    const value = meta[field];
    if (typeof value !== "string" || !SHA_40.test(value))
      throw new Error(
        `Invalid ${path}: ${field} must be a 40-hex commit SHA, got ${JSON.stringify(value)}`,
      );
    return value.toLowerCase();
  };
  return {
    schemaVersion: PR_SNAPSHOT_SCHEMA_VERSION,
    forge: meta.forge as PrSnapshotForge,
    target: meta.target as string,
    url: meta.url as string,
    baseSha: sha("baseSha"),
    headSha: sha("headSha"),
    mergeBaseSha: sha("mergeBaseSha"),
    fetchedAt: meta.fetchedAt as string,
  };
}

/**
 * Summarize the largest per-file hunks of an oversized patch so the error
 * points at what dominates the byte budget.
 */
export function largestDiffHunks(diff: string, limit = 5): string[] {
  const sections: Array<{ path: string; bytes: number }> = [];
  const parts = diff.split(/^(?=diff --git )/m);
  for (const part of parts) {
    if (part.length === 0) continue;
    const match = /^diff --git a\/(\S+) b\/(\S+)/.exec(part);
    const path = match?.[2] ?? "(header)";
    sections.push({ path, bytes: Buffer.byteLength(part, "utf8") });
  }
  sections.sort((a, b) => b.bytes - a.bytes);
  return sections
    .slice(0, limit)
    .map((section) => `${section.path}: ${section.bytes} bytes`);
}

async function fileSize(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function validatePrSnapshot(
  worktree: string,
  options: { revParseHead?: RevParseHead } = {},
): Promise<PrSnapshotValidation> {
  const revParseHead = options.revParseHead ?? defaultRevParseHead;
  try {
    let resolvedWorktree: string;
    try {
      resolvedWorktree = await realpath(worktree);
    } catch (error) {
      return {
        ok: false,
        error: `Snapshot worktree unavailable: ${(error as Error).message}`,
      };
    }

    const snapshotDir = join(worktree, ".cross-review");
    const metaPath = join(snapshotDir, "meta.json");
    const diffPath = join(snapshotDir, "diff.patch");
    const prPath = join(snapshotDir, "pr.md");

    let meta: PrSnapshotMeta;
    try {
      meta = parseMeta(await readFile(metaPath, "utf8"), metaPath);
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }

    let headSha: string;
    try {
      const revParse = await revParseHead(resolvedWorktree);
      headSha = revParse.stdout.trim();
    } catch (error) {
      return {
        ok: false,
        error: `Snapshot worktree HEAD unavailable: ${errorMessage(error)}`,
      };
    }
    if (headSha.toLowerCase() !== meta.headSha)
      return {
        ok: false,
        error: `Snapshot worktree HEAD ${headSha} does not match meta.json headSha ${meta.headSha}`,
      };

    const diffBytes = await fileSize(diffPath);
    if (diffBytes === undefined)
      return { ok: false, error: `Missing snapshot file: ${diffPath}` };
    if (diffBytes === 0)
      return { ok: false, error: `Snapshot diff.patch is empty: ${diffPath}` };
    if (diffBytes > MAX_DIFF_PATCH_BYTES) {
      const diff = await readFile(diffPath, "utf8").catch(() => "");
      const hunks = largestDiffHunks(diff);
      return {
        ok: false,
        error: `Snapshot diff.patch exceeds ${MAX_DIFF_PATCH_BYTES} bytes (${diffBytes} bytes); largest file hunks: ${hunks.join(", ")}`,
      };
    }
    const diff = await readFile(diffPath, "utf8");
    if (diff.includes(TRUNCATION_MARKER))
      return {
        ok: false,
        error: `Snapshot diff.patch contains a truncation placeholder: ${diffPath}`,
      };

    const prBytes = await fileSize(prPath);
    if (prBytes === undefined)
      return { ok: false, error: `Missing snapshot file: ${prPath}` };

    return { ok: true, meta };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  return String(error);
}
