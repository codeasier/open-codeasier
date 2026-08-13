import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  globalConfigPath,
  loadCrossReviewConfig,
  parseCrossReviewConfig,
  projectConfigPath,
} from "../src/cross-review/config.js";

const temporaryRoots: string[] = [];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "open-codeasier-config-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

describe("cross-review configuration", () => {
  it("parses a flat reviewModels configuration", () => {
    const config = parseCrossReviewConfig("test", {
      reviewModels: ["a/one", "b/two"],
      agents: 4,
      maxConcurrency: 2,
      judgeModel: "a/one",
      focus: "security",
      reviewerTimeoutMs: 900_000,
    });
    expect(config).toEqual({
      reviewModels: ["a/one", "b/two"],
      agents: 4,
      maxConcurrency: 2,
      judgeModel: "a/one",
      focus: "security",
      reviewerTimeoutMs: 900_000,
    });
  });

  it("parses a reviewers array with optional per-reviewer focus", () => {
    const config = parseCrossReviewConfig("test", {
      reviewers: [
        { model: "unraid-wg/wb/kimi-k3", focus: "security" },
        { model: "b/two" },
      ],
      judgeModel: "unraid-wg-resp/cx/gpt-5.6-sol",
    });
    expect(config).toEqual({
      reviewers: [
        { model: "unraid-wg/wb/kimi-k3", focus: "security" },
        { model: "b/two" },
      ],
      judgeModel: "unraid-wg-resp/cx/gpt-5.6-sol",
    });
  });

  it("rejects unknown keys, ambiguous reviewer sources, and out-of-range bounds", () => {
    expect(() =>
      parseCrossReviewConfig("test", { reviewers: [], extra: 1 }),
    ).toThrow(/unknown keys: extra/);
    expect(() =>
      parseCrossReviewConfig("test", {
        reviewers: [{ model: "a/one" }],
        reviewModels: ["a/one"],
      }),
    ).toThrow(/only one of `reviewers` or `reviewModels`/);
    expect(() => parseCrossReviewConfig("test", { reviewers: [] })).toThrow(
      /`reviewers` must be 1-8/,
    );
    expect(() =>
      parseCrossReviewConfig("test", { reviewModels: ["not-a-model"] }),
    ).toThrow(/`reviewModels` must be 1-8/);
    expect(() =>
      parseCrossReviewConfig("test", { reviewModels: ["a//one"] }),
    ).toThrow(/`reviewModels` must be 1-8/);
    expect(() =>
      parseCrossReviewConfig("test", { reviewModels: ["a/one"], agents: 9 }),
    ).toThrow(/`agents` must be an integer from 1 to 8/);
    expect(() =>
      parseCrossReviewConfig("test", {
        reviewModels: ["a/one"],
        maxConcurrency: 0,
      }),
    ).toThrow(/`maxConcurrency` must be an integer from 1 to 8/);
    expect(() =>
      parseCrossReviewConfig("test", {
        reviewModels: ["a/one"],
        judgeModel: 1,
      }),
    ).toThrow(/`judgeModel` must be a `provider\/model` identifier/);
    expect(() =>
      parseCrossReviewConfig("test", { reviewModels: ["a/one"], focus: 1 }),
    ).toThrow(/`focus` must be a string/);
    expect(() =>
      parseCrossReviewConfig("test", {
        reviewModels: ["a/one"],
        reviewerTimeoutMs: 4_999,
      }),
    ).toThrow(/`reviewerTimeoutMs` must be an integer from 5000 to 3600000/);
    expect(() =>
      parseCrossReviewConfig("test", {
        reviewModels: ["a/one"],
        reviewerTimeoutMs: 3_600_001,
      }),
    ).toThrow(/`reviewerTimeoutMs` must be an integer from 5000 to 3600000/);
    expect(() =>
      parseCrossReviewConfig("test", {
        reviewModels: ["a/one"],
        reviewerTimeoutMs: 600_000.5,
      }),
    ).toThrow(/`reviewerTimeoutMs` must be an integer from 5000 to 3600000/);
    expect(() =>
      parseCrossReviewConfig("test", {
        reviewModels: ["a/one"],
        reviewerTimeoutMs: "600000",
      }),
    ).toThrow(/`reviewerTimeoutMs` must be an integer from 5000 to 3600000/);
    expect(() =>
      parseCrossReviewConfig("test", {
        reviewModels: ["a/one"],
        reviewerTimeoutMs: 5_000,
      }),
    ).not.toThrow();
  });

  it("loads an empty config when no files exist", async () => {
    const root = await fixture();
    const loaded = await loadCrossReviewConfig(root, root);
    expect(loaded.config).toEqual({});
    expect(loaded.sources).toEqual({ project: "absent", global: "absent" });
    expect(loaded.projectPath).toBe(projectConfigPath(root));
    expect(loaded.globalPath).toBe(globalConfigPath(root));
  });

  it("loads only the project config when the global file is absent", async () => {
    const root = await fixture();
    await mkdir(join(root, ".opencode"), { recursive: true });
    await writeFile(
      projectConfigPath(root),
      JSON.stringify({ reviewers: [{ model: "a/one" }] }),
    );
    const loaded = await loadCrossReviewConfig(root, root);
    expect(loaded.config).toEqual({ reviewers: [{ model: "a/one" }] });
    expect(loaded.sources).toEqual({ project: "loaded", global: "absent" });
  });

  it("lets project keys override global defaults", async () => {
    const root = await fixture();
    await mkdir(join(root, ".config", "opencode"), { recursive: true });
    await writeFile(
      globalConfigPath(root),
      JSON.stringify({
        reviewModels: ["a/one", "b/two"],
        agents: 3,
        judgeModel: "a/one",
        reviewerTimeoutMs: 900_000,
      }),
    );
    await mkdir(join(root, ".opencode"), { recursive: true });
    await writeFile(
      projectConfigPath(root),
      JSON.stringify({ agents: 5, judgeModel: "b/two" }),
    );
    const loaded = await loadCrossReviewConfig(root, root);
    expect(loaded.config).toEqual({
      reviewModels: ["a/one", "b/two"],
      agents: 5,
      judgeModel: "b/two",
      reviewerTimeoutMs: 900_000,
    });
    expect(loaded.sources).toEqual({ project: "loaded", global: "loaded" });
  });

  it("lets a project reviewerTimeoutMs override the global value", async () => {
    const root = await fixture();
    await mkdir(join(root, ".config", "opencode"), { recursive: true });
    await writeFile(
      globalConfigPath(root),
      JSON.stringify({
        reviewModels: ["a/one"],
        reviewerTimeoutMs: 900_000,
      }),
    );
    await mkdir(join(root, ".opencode"), { recursive: true });
    await writeFile(
      projectConfigPath(root),
      JSON.stringify({ reviewerTimeoutMs: 1_200_000 }),
    );
    const loaded = await loadCrossReviewConfig(root, root);
    expect(loaded.config).toEqual({
      reviewModels: ["a/one"],
      reviewerTimeoutMs: 1_200_000,
    });
    expect(loaded.sources).toEqual({ project: "loaded", global: "loaded" });
  });

  it("replaces the global reviewer source when the project overrides it", async () => {
    const root = await fixture();
    await mkdir(join(root, ".config", "opencode"), { recursive: true });
    await writeFile(
      globalConfigPath(root),
      JSON.stringify({ reviewModels: ["a/one"] }),
    );
    await mkdir(join(root, ".opencode"), { recursive: true });
    await writeFile(
      projectConfigPath(root),
      JSON.stringify({ reviewers: [{ model: "b/two", focus: "security" }] }),
    );
    const loaded = await loadCrossReviewConfig(root, root);
    expect(loaded.config).toEqual({
      reviewers: [{ model: "b/two", focus: "security" }],
    });
    expect(loaded.sources).toEqual({ project: "loaded", global: "loaded" });
  });

  it("lets project reviewModels replace global reviewers", async () => {
    const root = await fixture();
    await mkdir(join(root, ".config", "opencode"), { recursive: true });
    await writeFile(
      globalConfigPath(root),
      JSON.stringify({ reviewers: [{ model: "a/one" }] }),
    );
    await mkdir(join(root, ".opencode"), { recursive: true });
    await writeFile(
      projectConfigPath(root),
      JSON.stringify({ reviewModels: ["b/two"] }),
    );
    const loaded = await loadCrossReviewConfig(root, root);
    expect(loaded.config).toEqual({ reviewModels: ["b/two"] });
    expect(loaded.sources).toEqual({ project: "loaded", global: "loaded" });
  });

  it("rejects malformed JSON and invalid config shapes with the file path", async () => {
    const root = await fixture();
    await mkdir(join(root, ".opencode"), { recursive: true });
    await writeFile(projectConfigPath(root), "{ invalid");
    await expect(loadCrossReviewConfig(root, root)).rejects.toThrow(
      /Invalid JSON in .*cross-review\.json/,
    );
    await rm(projectConfigPath(root));
    await writeFile(projectConfigPath(root), JSON.stringify({ agents: 9 }));
    await expect(loadCrossReviewConfig(root, root)).rejects.toThrow(
      /Invalid cross-review config .*cross-review\.json/,
    );
  });

  it("resolves the project config from the enclosing git repository root", async () => {
    const repoRoot = await fixture();
    const subDir = join(repoRoot, "packages", "nested", "deeper");
    await mkdir(join(repoRoot, ".git"), { recursive: true });
    await mkdir(subDir, { recursive: true });
    await mkdir(join(repoRoot, ".opencode"), { recursive: true });
    await writeFile(
      projectConfigPath(repoRoot),
      JSON.stringify({ reviewers: [{ model: "a/one" }] }),
    );
    await mkdir(join(repoRoot, ".config", "opencode"), { recursive: true });
    await writeFile(
      globalConfigPath(repoRoot),
      JSON.stringify({ reviewers: [{ model: "b/global" }] }),
    );
    const loaded = await loadCrossReviewConfig(subDir, repoRoot);
    expect(loaded.config).toEqual({ reviewers: [{ model: "a/one" }] });
    expect(loaded.sources).toEqual({ project: "loaded", global: "loaded" });
    expect(loaded.projectPath).toBe(projectConfigPath(repoRoot));
  });

  it("reports the project config as absent when the git root has no config file", async () => {
    const repoRoot = await fixture();
    const subDir = join(repoRoot, "packages", "nested");
    await mkdir(join(repoRoot, ".git"), { recursive: true });
    await mkdir(subDir, { recursive: true });
    await mkdir(join(repoRoot, ".config", "opencode"), { recursive: true });
    await writeFile(
      globalConfigPath(repoRoot),
      JSON.stringify({ reviewers: [{ model: "b/global" }] }),
    );
    const loaded = await loadCrossReviewConfig(subDir, repoRoot);
    expect(loaded.config).toEqual({ reviewers: [{ model: "b/global" }] });
    expect(loaded.sources).toEqual({ project: "absent", global: "loaded" });
    expect(loaded.projectPath).toBe(projectConfigPath(repoRoot));
  });

  it("treats directories outside any git repository as project-absent", async () => {
    const outside = await fixture();
    const home = await fixture();
    await mkdir(join(home, ".config", "opencode"), { recursive: true });
    await writeFile(
      globalConfigPath(home),
      JSON.stringify({ reviewers: [{ model: "b/global" }] }),
    );
    const loaded = await loadCrossReviewConfig(outside, home);
    expect(loaded.config).toEqual({ reviewers: [{ model: "b/global" }] });
    expect(loaded.sources).toEqual({ project: "absent", global: "loaded" });
    expect(loaded.projectPath).toBe(projectConfigPath(outside));
    expect(loaded.globalPath).toBe(globalConfigPath(home));
  });

  it("resolves linked worktrees through the shared git directory", async () => {
    const mainRoot = await fixture();
    const worktreeRoot = await fixture();
    const gitDirectory = join(mainRoot, ".git", "worktrees", "linked");
    const subDir = join(worktreeRoot, "packages", "nested");
    await mkdir(gitDirectory, { recursive: true });
    await writeFile(join(gitDirectory, "commondir"), "../..\n");
    await writeFile(join(worktreeRoot, ".git"), `gitdir: ${gitDirectory}\n`);
    await mkdir(subDir, { recursive: true });
    await mkdir(join(mainRoot, ".opencode"), { recursive: true });
    await writeFile(
      projectConfigPath(mainRoot),
      JSON.stringify({ reviewers: [{ model: "a/one" }] }),
    );
    const loaded = await loadCrossReviewConfig(subDir, mainRoot);
    expect(loaded.config).toEqual({ reviewers: [{ model: "a/one" }] });
    expect(loaded.sources).toEqual({ project: "loaded", global: "absent" });
    expect(loaded.projectPath).toBe(projectConfigPath(mainRoot));
  });

  it("prefers a linked worktree's own project config", async () => {
    const mainRoot = await fixture();
    const worktreeRoot = await fixture();
    const gitDirectory = join(mainRoot, ".git", "worktrees", "linked");
    await mkdir(gitDirectory, { recursive: true });
    await writeFile(join(gitDirectory, "commondir"), "../..\n");
    await writeFile(join(worktreeRoot, ".git"), `gitdir: ${gitDirectory}\n`);
    await mkdir(join(mainRoot, ".opencode"), { recursive: true });
    await writeFile(
      projectConfigPath(mainRoot),
      JSON.stringify({ reviewers: [{ model: "a/main" }] }),
    );
    await mkdir(join(worktreeRoot, ".opencode"), { recursive: true });
    await writeFile(
      projectConfigPath(worktreeRoot),
      JSON.stringify({ reviewers: [{ model: "a/worktree" }] }),
    );
    const loaded = await loadCrossReviewConfig(worktreeRoot, mainRoot);
    expect(loaded.config).toEqual({ reviewers: [{ model: "a/worktree" }] });
    expect(loaded.projectPath).toBe(projectConfigPath(worktreeRoot));
  });
});
