import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  largestDiffHunks,
  MAX_DIFF_PATCH_BYTES,
  validatePrSnapshot,
} from "../src/cross-review/pr-snapshot.js";

const HEAD_SHA = "a".repeat(40);
const BASE_SHA = "b".repeat(40);
const MERGE_BASE_SHA = "c".repeat(40);

function validMeta(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    forge: "github",
    target: "https://github.com/org/repo/pull/69",
    url: "https://github.com/org/repo/pull/69",
    baseSha: BASE_SHA,
    headSha: HEAD_SHA,
    mergeBaseSha: MERGE_BASE_SHA,
    fetchedAt: "2026-09-05T00:00:00.000Z",
    ...overrides,
  };
}

async function fixture(
  meta: Record<string, unknown> | string = validMeta(),
  diff:
    | string
    | null = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-a\n+b\n",
  pr: string | null = "# PR 69\n\nSummary of the pull request.\n",
) {
  const worktree = await mkdtemp(join(tmpdir(), "pr-snapshot-"));
  const snapshotDir = join(worktree, ".cross-review");
  await mkdir(snapshotDir, { recursive: true });
  if (typeof meta === "string")
    await writeFile(join(snapshotDir, "meta.json"), meta, "utf8");
  else
    await writeFile(
      join(snapshotDir, "meta.json"),
      JSON.stringify(meta),
      "utf8",
    );
  if (diff !== null)
    await writeFile(join(snapshotDir, "diff.patch"), diff, "utf8");
  if (pr !== null) await writeFile(join(snapshotDir, "pr.md"), pr, "utf8");
  return worktree;
}

function revParse(output: string) {
  return async () => ({ stdout: output, stderr: "" });
}

describe("validatePrSnapshot", () => {
  it("accepts a valid snapshot and returns normalized meta", async () => {
    const worktree = await fixture(
      validMeta({ headSha: HEAD_SHA.toUpperCase() }),
    );
    const result = await validatePrSnapshot(worktree, {
      revParseHead: revParse(`${HEAD_SHA}\n`),
    });
    expect(result).toEqual({ ok: true, meta: validMeta() });
  });

  it("fails when meta.json is missing", async () => {
    const worktree = await mkdtemp(join(tmpdir(), "pr-snapshot-empty-"));
    const result = await validatePrSnapshot(worktree, {
      revParseHead: revParse(`${HEAD_SHA}\n`),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("meta.json");
  });

  it("fails on invalid meta.json JSON", async () => {
    const worktree = await fixture("not json{");
    const result = await validatePrSnapshot(worktree, {
      revParseHead: revParse(`${HEAD_SHA}\n`),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("Invalid JSON");
  });

  it("fails on unsupported schemaVersion", async () => {
    const worktree = await fixture(validMeta({ schemaVersion: 2 }));
    const result = await validatePrSnapshot(worktree, {
      revParseHead: revParse(`${HEAD_SHA}\n`),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("schemaVersion");
  });

  it("fails on an unknown forge", async () => {
    const worktree = await fixture(validMeta({ forge: "gitlab" }));
    const result = await validatePrSnapshot(worktree, {
      revParseHead: revParse(`${HEAD_SHA}\n`),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("forge");
  });

  it("fails when a SHA is not 40 hex characters", async () => {
    for (const field of ["baseSha", "headSha", "mergeBaseSha"]) {
      const worktree = await fixture(validMeta({ [field]: "abc123" }));
      const result = await validatePrSnapshot(worktree, {
        revParseHead: revParse(`${HEAD_SHA}\n`),
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain(field);
    }
  });

  it("fails when required string fields are missing", async () => {
    for (const field of ["target", "url", "fetchedAt"]) {
      const worktree = await fixture(validMeta({ [field]: "" }));
      const result = await validatePrSnapshot(worktree, {
        revParseHead: revParse(`${HEAD_SHA}\n`),
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain(field);
    }
  });

  it("fails when worktree HEAD does not match headSha", async () => {
    const worktree = await fixture();
    const result = await validatePrSnapshot(worktree, {
      revParseHead: revParse(`${"d".repeat(40)}\n`),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("does not match");
  });

  it("fails when rev-parse itself fails", async () => {
    const worktree = await fixture();
    const result = await validatePrSnapshot(worktree, {
      revParseHead: async () => {
        throw new Error("not a git repository");
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("HEAD unavailable");
  });

  it("fails when diff.patch is missing", async () => {
    const worktree = await fixture(validMeta(), null);
    const result = await validatePrSnapshot(worktree, {
      revParseHead: revParse(`${HEAD_SHA}\n`),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("diff.patch");
  });

  it("fails when diff.patch is empty", async () => {
    const worktree = await fixture(validMeta(), "");
    const result = await validatePrSnapshot(worktree, {
      revParseHead: revParse(`${HEAD_SHA}\n`),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("empty");
  });

  it("fails when diff.patch exceeds the byte cap and lists largest hunks", async () => {
    const bigFile = "x".repeat(600_000);
    const otherFile = "y".repeat(450_000);
    const diff = [
      "diff --git a/src/big.ts b/src/big.ts\n--- a/src/big.ts\n+++ b/src/big.ts\n@@ -1 +1 @@\n",
      bigFile,
      "\ndiff --git a/src/other.ts b/src/other.ts\n--- a/src/other.ts\n+++ b/src/other.ts\n@@ -1 +1 @@\n",
      otherFile,
      "\n",
    ].join("");
    const worktree = await fixture(validMeta(), diff);
    const result = await validatePrSnapshot(worktree, {
      revParseHead: revParse(`${HEAD_SHA}\n`),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain(`exceeds ${MAX_DIFF_PATCH_BYTES} bytes`);
      expect(result.error).toContain("src/big.ts");
      expect(result.error).toContain("src/other.ts");
      expect(result.error.indexOf("src/big.ts")).toBeLessThan(
        result.error.indexOf("src/other.ts"),
      );
    }
  });

  it("fails when diff.patch contains a truncation placeholder", async () => {
    const worktree = await fixture(
      validMeta(),
      "diff --git a/a b/a\n@@ -1 +1 @@\n-old\n[...truncated...]\n",
    );
    const result = await validatePrSnapshot(worktree, {
      revParseHead: revParse(`${HEAD_SHA}\n`),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("truncation placeholder");
  });

  it("fails when pr.md is missing", async () => {
    const worktree = await fixture(validMeta(), "diff --git a/a b/a\n", null);
    const result = await validatePrSnapshot(worktree, {
      revParseHead: revParse(`${HEAD_SHA}\n`),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("pr.md");
  });

  it("fails when the worktree directory does not exist", async () => {
    const result = await validatePrSnapshot(
      join(tmpdir(), "pr-snapshot-does-not-exist"),
      { revParseHead: revParse(`${HEAD_SHA}\n`) },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("unavailable");
  });
});

describe("largestDiffHunks", () => {
  it("sorts file sections by size descending and caps the list", () => {
    const diff = [
      "diff --git a/src/small.ts b/src/small.ts\n@@ -1 +1 @@\n-s\n",
      "diff --git a/src/huge.ts b/src/huge.ts\n@@ -1 +1 @@\n",
      "h".repeat(500),
      "\n",
    ].join("");
    const hunks = largestDiffHunks(diff);
    expect(hunks[0]).toContain("src/huge.ts");
    expect(hunks.length).toBe(2);
  });
});
