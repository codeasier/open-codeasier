import { execFile } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { access } from "node:fs/promises";
import {
  EVIDENCE_DIR_PROJECT_ROOT_ERROR,
  EVIDENCE_PACK_GIT_ENTRY_ERROR,
  readEvidencePack,
  writeEvidencePack,
} from "../src/cross-review/evidence.js";
import {
  createParentSnapshot,
  defaultRemoveSnapshot,
  INVALID_REVIEW_REVISION_RANGE_ERROR,
  PARENT_SNAPSHOT_REQUIRES_GIT_ERROR,
  snapshotPaths,
} from "../src/cross-review/pr-gather.js";

const exec = promisify(execFile);
const roots: string[] = [];
const snapshots: string[] = [];
afterEach(async () => {
  for (const worktree of snapshots.splice(0))
    await defaultRemoveSnapshot(worktree);
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "review-evidence-"));
  roots.push(root);
  const project = join(root, "project");
  const pack = join(project, "pack");
  await mkdir(pack, { recursive: true });
  await writeFile(join(pack, "meta.json"), '{"target":"HEAD"}');
  await writeFile(join(pack, "summary.md"), "parent evidence");
  return { root, project, pack };
}
describe("parent evidence packs", () => {
  it.each(["", " ", "/absolute", "../outside"])(
    "rejects invalid or escaping paths: %s",
    async (path) => {
      const { project } = await fixture();
      await expect(readEvidencePack(project, path)).rejects.toThrow();
    },
  );
  it.each([".", "./", "pack/.."])(
    "rejects the project root as a pack: %s",
    async (path) => {
      const { project } = await fixture();
      await expect(readEvidencePack(project, path)).rejects.toThrow(
        EVIDENCE_DIR_PROJECT_ROOT_ERROR,
      );
    },
  );
  it("rejects a pack that is or contains .git", async () => {
    const { project, pack } = await fixture();
    await mkdir(join(project, ".git"));
    await writeFile(join(project, ".git", "HEAD"), "ref: refs/heads/main");
    await expect(readEvidencePack(project, ".git")).rejects.toThrow(
      EVIDENCE_PACK_GIT_ENTRY_ERROR,
    );
    await mkdir(join(pack, ".git"));
    await writeFile(join(pack, ".git", "HEAD"), "ref: refs/heads/main");
    await expect(readEvidencePack(project, "pack")).rejects.toThrow(
      EVIDENCE_PACK_GIT_ENTRY_ERROR,
    );
  });
  it.each([
    ["meta.json", undefined],
    ["summary.md", undefined],
    ["summary.md", " \n"],
    ["meta.json", ""],
    ["meta.json", "invalid"],
    ["meta.json", "null"],
    ["meta.json", "[]"],
    ["meta.json", "{}"],
  ])("rejects missing, blank or invalid %s (%s)", async (name, contents) => {
    const { project, pack } = await fixture();
    if (name === undefined) throw new Error("Missing test filename");
    if (contents === undefined) await rm(join(pack, name));
    else await writeFile(join(pack, name), contents);
    await expect(readEvidencePack(project, "pack")).rejects.toThrow();
  });
  it("rejects symlinked packs, nested links, and escaping ancestor links", async () => {
    const { root, project, pack } = await fixture();
    await symlink(pack, join(project, "alias"));
    await expect(readEvidencePack(project, "alias")).rejects.toThrow();
    await mkdir(join(root, "outside"));
    await symlink(join(root, "outside"), join(project, "escape"));
    await expect(readEvidencePack(project, "escape")).rejects.toThrow();
    await symlink(join(pack, "summary.md"), join(pack, "linked.md"));
    await expect(readEvidencePack(project, "pack")).rejects.toThrow(/symlink/);
  });
  it("copies captured binary and nested evidence without following destination links", async () => {
    const { project, pack, root } = await fixture();
    await mkdir(join(pack, "nested"));
    await writeFile(join(pack, "nested", "data.bin"), Buffer.from([0, 255, 1]));
    const captured = await readEvidencePack(project, "pack");
    await writeFile(join(pack, "summary.md"), "changed after validation");
    const destination = join(root, "copy");
    await writeEvidencePack(destination, captured);
    expect(await readFile(join(destination, "summary.md"), "utf8")).toBe(
      "parent evidence",
    );
    expect(await readFile(join(destination, "nested", "data.bin"))).toEqual(
      Buffer.from([0, 255, 1]),
    );
    await symlink(pack, join(root, "linked"));
    await expect(
      writeEvidencePack(join(root, "linked"), captured),
    ).rejects.toThrow();
  });
  it("pins HEAD or a verified range endpoint without changing the parent checkout", async () => {
    const { project, root } = await fixture();
    const git = async (...args: string[]) =>
      (await exec("git", ["-C", project, ...args])).stdout.trim();
    await git("init");
    await git(
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "--allow-empty",
      "-m",
      "first",
    );
    const first = await git("rev-parse", "HEAD");
    await git(
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "--allow-empty",
      "-m",
      "second",
    );
    const head = await git("rev-parse", "HEAD");
    for (const [index, target] of [
      "issue #83",
      `HEAD..${first}`,
      `HEAD...${first}`,
    ].entries()) {
      const context = "large context\n".repeat(100_000);
      const snapshot = await createParentSnapshot({
        repo: project,
        target,
        stateRoot: join(root, "state"),
        runID: `run-${index}`,
        context,
      });
      snapshots.push(snapshot.worktree);
      expect(snapshot.source).toBe("parent-pack");
      expect(snapshot.forge).toBeUndefined();
      expect(snapshot.headSha).toBe(index === 0 ? head : first);
      expect(
        await readFile(join(snapshot.snapshotDir, "summary.md"), "utf8"),
      ).toBe(context);
      await expect(
        exec("git", ["-C", snapshot.worktree, "symbolic-ref", "HEAD"]),
      ).rejects.toThrow();
    }
    expect(await git("rev-parse", "HEAD")).toBe(head);
    for (const target of [
      "HEAD..not-a-ref",
      "missing..HEAD",
      "HEAD..$(touch hacked)",
      "HEAD..--help",
    ]) {
      await expect(
        createParentSnapshot({
          repo: project,
          target,
          stateRoot: join(root, "state"),
          runID: "invalid",
          context: "context",
        }),
      ).rejects.toThrow();
    }
    for (const target of ["../lib", "fix ... bug"]) {
      await expect(
        createParentSnapshot({
          repo: project,
          target,
          stateRoot: join(root, "state"),
          runID: "invalid-range",
          context: "context",
        }),
      ).rejects.toThrow(INVALID_REVIEW_REVISION_RANGE_ERROR);
    }
  });
  it("fails closed outside a git repository without creating a snapshot dir", async () => {
    const { project, root } = await fixture();
    const stateRoot = join(root, "state");
    await expect(
      createParentSnapshot({
        repo: project,
        target: "issue #83",
        stateRoot,
        runID: "nongit",
        context: "context",
      }),
    ).rejects.toThrow(PARENT_SNAPSHOT_REQUIRES_GIT_ERROR);
    await expect(
      access(snapshotPaths(stateRoot, "nongit").worktree),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
  it("removes the run directory when worktree creation fails", async () => {
    const { project, root } = await fixture();
    const git = async (...args: string[]) =>
      (await exec("git", ["-C", project, ...args])).stdout.trim();
    await git("init");
    await git(
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "--allow-empty",
      "-m",
      "first",
    );
    const stateRoot = join(root, "state");
    const { worktree } = snapshotPaths(stateRoot, "blocked");
    const runDir = join(stateRoot, ".worktrees", "blocked");
    await mkdir(runDir, { recursive: true });
    await writeFile(worktree, "not a directory");
    await expect(
      createParentSnapshot({
        repo: project,
        target: "HEAD",
        stateRoot,
        runID: "blocked",
        context: "context",
      }),
    ).rejects.toThrow();
    await expect(access(runDir)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("copies packs into a detached worktree and appends context to the copied summary only", async () => {
    const { project, root, pack } = await fixture();
    await exec("git", ["-C", project, "init"]);
    await exec("git", [
      "-C",
      project,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "--allow-empty",
      "-m",
      "first",
    ]);
    const snapshot = await createParentSnapshot({
      repo: project,
      target: "HEAD",
      stateRoot: join(root, "state"),
      runID: "pack",
      pack: await readEvidencePack(project, "pack"),
      context: "extra notes",
    });
    snapshots.push(snapshot.worktree);
    expect(snapshot.evidenceDir).toBe("pack");
    expect(
      await readFile(join(snapshot.snapshotDir, "summary.md"), "utf8"),
    ).toBe("parent evidence\n\nextra notes");
    expect(await readFile(join(pack, "summary.md"), "utf8")).toBe(
      "parent evidence",
    );
  });
});
