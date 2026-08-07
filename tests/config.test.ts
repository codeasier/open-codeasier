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
    });
    expect(config).toEqual({
      reviewModels: ["a/one", "b/two"],
      agents: 4,
      maxConcurrency: 2,
      judgeModel: "a/one",
      focus: "security",
    });
  });

  it("parses a reviewers array with optional per-reviewer focus", () => {
    const config = parseCrossReviewConfig("test", {
      reviewers: [{ model: "a/one", focus: "security" }, { model: "b/two" }],
    });
    expect(config).toEqual({
      reviewers: [{ model: "a/one", focus: "security" }, { model: "b/two" }],
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
  });

  it("loads an empty config when no files exist", async () => {
    const root = await fixture();
    await expect(loadCrossReviewConfig(root, root)).resolves.toEqual({});
  });

  it("loads only the project config when the global file is absent", async () => {
    const root = await fixture();
    await mkdir(join(root, ".opencode"), { recursive: true });
    await writeFile(
      projectConfigPath(root),
      JSON.stringify({ reviewers: [{ model: "a/one" }] }),
    );
    await expect(loadCrossReviewConfig(root, root)).resolves.toEqual({
      reviewers: [{ model: "a/one" }],
    });
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
      }),
    );
    await mkdir(join(root, ".opencode"), { recursive: true });
    await writeFile(
      projectConfigPath(root),
      JSON.stringify({ agents: 5, judgeModel: "b/two" }),
    );
    await expect(loadCrossReviewConfig(root, root)).resolves.toEqual({
      reviewModels: ["a/one", "b/two"],
      agents: 5,
      judgeModel: "b/two",
    });
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
    await expect(loadCrossReviewConfig(root, root)).resolves.toEqual({
      reviewers: [{ model: "b/two", focus: "security" }],
    });
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
    await expect(loadCrossReviewConfig(root, root)).resolves.toEqual({
      reviewModels: ["b/two"],
    });
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
});
