import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sha256 } from "../src/installer/assets.js";
import {
  AssetConflictError,
  installAssets,
  uninstallAssets,
} from "../src/installer/install.js";
import { resolveTarget } from "../src/installer/paths.js";

const roots: string[] = [];
afterEach(async () =>
  Promise.all(
    roots
      .splice(0)
      .map((root) =>
        import("node:fs/promises").then((fs) =>
          fs.rm(root, { recursive: true, force: true }),
        ),
      ),
  ),
);

async function fixture(content = "one") {
  const root = await mkdtemp(join(tmpdir(), "oce-"));
  roots.push(root);
  const source = join(root, "source.md");
  await writeFile(source, content);
  return {
    root,
    source,
    asset: {
      source,
      relativeTarget: "commands/test.md" as const,
      sha256: sha256(content),
    },
  };
}

describe("asset installer", () => {
  it("resolves global and project targets", () => {
    expect(resolveTarget({ home: "/home/me" })).toEqual({
      root: join("/home/me", ".config", "opencode"),
      scope: "global",
    });
    expect(resolveTarget({ project: "project" })).toEqual({
      root: join(resolve("project"), ".opencode"),
      scope: "project",
    });
  });
  it("installs, preserves, upgrades, removes stale assets, and uninstalls", async () => {
    const f = await fixture();
    const target = resolveTarget({ project: join(f.root, "project") });
    expect(
      await installAssets({
        target,
        assets: [f.asset],
        packageVersion: "1",
        dryRun: false,
      }),
    ).toMatchObject({ written: [f.asset.relativeTarget] });
    expect(
      await installAssets({
        target,
        assets: [f.asset],
        packageVersion: "1",
        dryRun: false,
      }),
    ).toMatchObject({ unchanged: [f.asset.relativeTarget] });
    await writeFile(f.source, "two");
    const upgraded = { ...f.asset, sha256: sha256("two") };
    expect(
      await installAssets({
        target,
        assets: [upgraded],
        packageVersion: "2",
        dryRun: false,
      }),
    ).toMatchObject({ written: [f.asset.relativeTarget] });
    expect(
      await readFile(join(target.root, f.asset.relativeTarget), "utf8"),
    ).toBe("two");
    expect(
      await installAssets({
        target,
        assets: [],
        packageVersion: "3",
        dryRun: false,
      }),
    ).toMatchObject({ removed: [f.asset.relativeTarget] });
    await installAssets({
      target,
      assets: [upgraded],
      packageVersion: "4",
      dryRun: false,
    });
    expect(await uninstallAssets({ target, dryRun: false })).toEqual({
      removed: [f.asset.relativeTarget],
    });
  });
  it("refuses unowned and modified files", async () => {
    const f = await fixture();
    const target = resolveTarget({ project: join(f.root, "project") });
    await import("node:fs/promises").then((fs) =>
      fs.mkdir(join(target.root, "commands"), { recursive: true }),
    );
    await writeFile(join(target.root, f.asset.relativeTarget), "mine");
    await expect(
      installAssets({
        target,
        assets: [f.asset],
        packageVersion: "1",
        dryRun: false,
      }),
    ).rejects.toBeInstanceOf(AssetConflictError);
  });
  it("refuses an identical unowned file", async () => {
    const f = await fixture();
    const target = resolveTarget({ project: join(f.root, "project") });
    await mkdir(join(target.root, "commands"), { recursive: true });
    await writeFile(join(target.root, f.asset.relativeTarget), "one");
    await expect(
      installAssets({
        target,
        assets: [f.asset],
        packageVersion: "1",
        dryRun: false,
      }),
    ).rejects.toBeInstanceOf(AssetConflictError);
  });
  it.each([
    "commands/../outside.md",
    "/commands/x.md",
    "skills/x/other.md",
    "commands/x/y.md",
    "commands/UPPER.md",
    "skills/.hidden/SKILL.md",
  ])("rejects invalid manifest path %s", async (path) => {
    const f = await fixture();
    const target = resolveTarget({ project: join(f.root, "project") });
    await mkdir(join(target.root, ".open-codeasier"), { recursive: true });
    await writeFile(
      join(target.root, ".open-codeasier", "installed-assets.json"),
      JSON.stringify({
        schemaVersion: 1,
        packageVersion: "1",
        files: [{ path, sha256: sha256("x") }],
      }),
    );
    await expect(uninstallAssets({ target, dryRun: false })).rejects.toThrow(
      "Invalid open-codeasier asset path",
    );
  });
  it("rejects symlinked target parents and leaves", async () => {
    const f = await fixture();
    const outside = join(f.root, "outside");
    await mkdir(outside);
    for (const leaf of [false, true]) {
      const target = resolveTarget({
        project: join(f.root, leaf ? "leaf" : "parent"),
      });
      await mkdir(target.root, { recursive: true });
      if (leaf) {
        await mkdir(join(target.root, "commands"));
        await symlink(
          join(outside, "x.md"),
          join(target.root, f.asset.relativeTarget),
        );
      } else await symlink(outside, join(target.root, "commands"));
      await expect(
        installAssets({
          target,
          assets: [f.asset],
          packageVersion: "1",
          dryRun: false,
        }),
      ).rejects.toBeInstanceOf(AssetConflictError);
    }
  });
  it("reads all sources before mutating targets", async () => {
    const f = await fixture();
    const target = resolveTarget({ project: join(f.root, "project") });
    const missing = {
      ...f.asset,
      source: join(f.root, "missing.md"),
      relativeTarget: "commands/missing.md" as const,
    };
    await expect(
      installAssets({
        target,
        assets: [f.asset, missing],
        packageVersion: "1",
        dryRun: false,
      }),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      readFile(join(target.root, f.asset.relativeTarget)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("dry-runs without mutation", async () => {
    const f = await fixture();
    const target = resolveTarget({ project: join(f.root, "project") });
    expect(
      await installAssets({
        target,
        assets: [f.asset],
        packageVersion: "1",
        dryRun: true,
      }),
    ).toMatchObject({ written: [f.asset.relativeTarget] });
    await expect(
      readFile(join(target.root, f.asset.relativeTarget)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("CLI parser", () => {
  it("rejects unknown commands and options", async () => {
    const { run } = await import("../src/cli.js");
    expect(await run(["unknown"])).toBe(2);
    expect(await run(["install", "--unknown"])).toBe(2);
  });
});
