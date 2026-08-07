import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  parseCrossReviewConfig,
  projectConfigPath,
} from "../src/cross-review/config.js";
import {
  CROSS_REVIEW_CONFIG_TEMPLATE,
  CrossReviewConfigConflictError,
  initializeCrossReviewConfig,
} from "../src/cross-review/init.js";
import { resolveTarget } from "../src/installer/paths.js";

const roots: string[] = [];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "open-codeasier-init-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

describe("cross-review initializer", () => {
  it("ships a valid role-oriented starter configuration", () => {
    expect(
      parseCrossReviewConfig(
        "template",
        JSON.parse(CROSS_REVIEW_CONFIG_TEMPLATE),
      ),
    ).toMatchObject({
      reviewers: [
        { model: "provider/reviewer-model-1" },
        { model: "provider/reviewer-model-2" },
        { model: "provider/reviewer-model-3" },
      ],
      judgeModel: "provider/judge-model",
      maxConcurrency: 3,
    });
  });

  it("initializes local and global configuration paths", async () => {
    const root = await fixture();
    const project = join(root, "project");
    const local = await initializeCrossReviewConfig({
      target: resolveTarget({ project }),
      dryRun: false,
    });
    const global = await initializeCrossReviewConfig({
      target: resolveTarget({ home: root }),
      dryRun: false,
    });
    expect(local).toEqual({
      path: join(project, ".opencode", "cross-review.json"),
      scope: "project",
    });
    expect(global).toEqual({
      path: join(root, ".config", "opencode", "cross-review.json"),
      scope: "global",
    });
    await expect(readFile(local.path, "utf8")).resolves.toBe(
      CROSS_REVIEW_CONFIG_TEMPLATE,
    );
    await expect(readFile(global.path, "utf8")).resolves.toBe(
      CROSS_REVIEW_CONFIG_TEMPLATE,
    );
  });

  it("dry-runs without creating directories or files", async () => {
    const root = await fixture();
    const project = join(root, "project");
    const result = await initializeCrossReviewConfig({
      target: resolveTarget({ project }),
      dryRun: true,
    });
    expect(result.path).toBe(projectConfigPath(project));
    await expect(readFile(result.path)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("refuses to overwrite an existing configuration", async () => {
    const root = await fixture();
    const project = join(root, "project");
    const path = projectConfigPath(project);
    await mkdir(join(project, ".opencode"), { recursive: true });
    await writeFile(path, "mine\n");
    await expect(
      initializeCrossReviewConfig({
        target: resolveTarget({ project }),
        dryRun: false,
      }),
    ).rejects.toBeInstanceOf(CrossReviewConfigConflictError);
    await expect(readFile(path, "utf8")).resolves.toBe("mine\n");
  });

  it.skipIf(process.platform === "win32")(
    "refuses a symlinked configuration root",
    async () => {
      const root = await fixture();
      const project = join(root, "project");
      const outside = join(root, "outside");
      await mkdir(project);
      await mkdir(outside);
      await symlink(outside, join(project, ".opencode"));
      await expect(
        initializeCrossReviewConfig({
          target: resolveTarget({ project }),
          dryRun: false,
        }),
      ).rejects.toBeInstanceOf(CrossReviewConfigConflictError);
    },
  );
});

describe("init CLI", () => {
  it("defaults to the current local project and rejects invalid scope combinations", async () => {
    const { run } = await import("../src/cli.js");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(await run(["init", "--dry-run"])).toBe(0);
    expect(log).toHaveBeenCalledWith(
      `would-initialize: ${projectConfigPath(process.cwd())}`,
    );
    expect(await run(["init", "--local", "--global"])).toBe(2);
    expect(await run(["init", "--global", "unexpected"])).toBe(2);
  });

  it("initializes local paths with or without the explicit scope flag", async () => {
    const { run } = await import("../src/cli.js");
    const root = await fixture();
    const project = join(root, "project");
    const defaultScopeProject = join(root, "default-scope-project");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    expect(await run(["init", "--local", project])).toBe(0);
    expect(await run(["init", defaultScopeProject])).toBe(0);
    expect(log).toHaveBeenCalledWith(
      `initialized: ${projectConfigPath(project)}`,
    );
    expect(log).toHaveBeenCalledWith(
      `initialized: ${projectConfigPath(defaultScopeProject)}`,
    );
    expect(await run(["init", "--local", project])).toBe(1);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("Refusing to overwrite"),
    );
  });
});
