import { execFile } from "node:child_process";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  parseAdapterFlags,
  parsePrViewJson,
  prViewTarget,
} from "../src/cross-review/adapters/common.js";
import { runGithubPrSnapshot } from "../src/cross-review/adapters/github-pr-snapshot.js";
import {
  gitcodeSetupGuidance,
  runGitcodePrSnapshot,
} from "../src/cross-review/adapters/gitcode-pr-snapshot.js";
import { defaultRemoveSnapshot } from "../src/cross-review/pr-gather.js";

const execFileAsync = promisify(execFile);
const tracked = [] as string[];

afterEach(async () => {
  while (tracked.length > 0) {
    const path = tracked.pop();
    if (path === undefined) continue;
    await execFileAsync("rm", ["-rf", path]).catch(() => undefined);
  }
});

const HEAD_SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const BASE_SHA = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function prViewJson(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    number: 69,
    url: "https://github.com/org/repo/pull/69",
    title: "Add feature",
    body: "PR description body",
    baseRefName: "main",
    headRefName: "feature",
    baseRefOid: BASE_SHA,
    headRefOid: HEAD_SHA,
    ...overrides,
  });
}

/**
 * Build a real git repository with a base commit, a PR head commit, and a
 * merge base, then return command runners that route `gh` to a fake and `git`
 * to the real binary.
 */
async function fakeForgeRepo(forge: "github" | "gitcode") {
  const repo = await mkdtemp(join(tmpdir(), "pr-adapter-repo-"));
  tracked.push(repo);
  const git = (args: string[], cwd = repo) =>
    execFileAsync("git", args, { cwd, encoding: "utf8" });
  await git(["init", "-q", "--initial-branch=main"]);
  await git(["config", "user.email", "test@example.com"]);
  await git(["config", "user.name", "Test"]);
  await git(["config", "commit.gpgsign", "false"]);
  await writeFile(join(repo, "base.txt"), "base\n", "utf8");
  await git(["add", "."]);
  await git(["commit", "-q", "-m", "base"]);
  const mergeBase = (await git(["rev-parse", "HEAD"])).stdout.trim();
  // PR head: distinct tree on a side branch.
  await git(["checkout", "-q", "-b", "feature"]);
  await writeFile(join(repo, "feature.txt"), "feature\n", "utf8");
  await git(["add", "."]);
  await git(["commit", "-q", "-m", "feature"]);
  const headSha = (await git(["rev-parse", "HEAD"])).stdout.trim();
  await git(["checkout", "-q", "main"]);

  const fakeView = prViewJson({
    headRefOid: headSha,
    baseRefOid: mergeBase,
    ...(forge === "gitcode"
      ? { url: "https://gitcode.com/org/repo/pulls/69" }
      : {}),
  });

  const commands: Array<{ command: string; args: string[]; cwd?: string }> = [];
  const runCommand = async (
    command: string,
    args: string[],
    options: { cwd?: string },
  ) => {
    commands.push({
      command,
      args,
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    });
    if (command === "gh" || command.includes("gitcode")) {
      if (args[0] === "pr" && args[1] === "view")
        return { stdout: fakeView, stderr: "" };
      return {
        stdout: "",
        stderr: `fake: unhandled ${command} ${args.join(" ")}`,
      };
    }
    return execFileAsync(command, args, {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      encoding: "utf8",
    });
  };

  return {
    repo,
    git,
    runCommand,
    commands,
    headSha,
    mergeBase,
    fakeView,
  };
}

function flags(
  repo: string,
  target: string,
  worktree: string,
  snapshot: string,
) {
  return [
    "--repo",
    repo,
    "--target",
    target,
    "--worktree",
    worktree,
    "--snapshot",
    snapshot,
  ];
}

describe("parseAdapterFlags", () => {
  it("parses required and optional flags", () => {
    const parsed = parseAdapterFlags([
      "--repo",
      "/repo",
      "--target",
      "69",
      "--worktree",
      "/wt",
      "--snapshot",
      "/wt/.cross-review",
      "--notes",
      "some notes --not-a-flag",
    ]);
    expect(parsed).toEqual({
      ok: true,
      flags: {
        repo: "/repo",
        target: "69",
        worktree: "/wt",
        snapshot: "/wt/.cross-review",
        notes: "some notes --not-a-flag",
      },
    });
  });

  it("rejects unknown, missing, and duplicate flags", () => {
    expect(parseAdapterFlags(["--bogus", "x"]).ok).toBe(false);
    expect(parseAdapterFlags(["--repo"]).ok).toBe(false);
    expect(
      parseAdapterFlags([
        "--repo",
        "/a",
        "--repo",
        "/b",
        "--target",
        "t",
        "--worktree",
        "w",
        "--snapshot",
        "s",
      ]).ok,
    ).toBe(false);
    expect(parseAdapterFlags([]).ok).toBe(false);
    expect(
      parseAdapterFlags([
        "--repo",
        "--target",
        "t",
        "--worktree",
        "w",
        "--snapshot",
        "s",
      ]).ok,
    ).toBe(false);
  });
});

describe("parsePrViewJson", () => {
  it("parses and normalizes a valid view", () => {
    const view = parsePrViewJson(prViewJson(), "gh pr view");
    expect(view.number).toBe(69);
    expect(view.headRefOid).toBe(HEAD_SHA);
  });

  it("rejects invalid payloads", () => {
    expect(() => parsePrViewJson("not json", "gh pr view")).toThrow(
      "invalid JSON",
    );
    expect(() => parsePrViewJson("[]", "gh pr view")).toThrow();
    expect(() =>
      parsePrViewJson(prViewJson({ number: 0 }), "gh pr view"),
    ).toThrow("number");
    expect(() =>
      parsePrViewJson(prViewJson({ baseRefOid: "abc" }), "gh pr view"),
    ).toThrow("baseRefOid");
    expect(() =>
      parsePrViewJson(prViewJson({ title: "" }), "gh pr view"),
    ).toThrow("title");
  });
});

describe("prViewTarget", () => {
  it("reduces bare numbers and keeps URLs", () => {
    expect(prViewTarget("#69")).toBe("69");
    expect(prViewTarget("69")).toBe("69");
    expect(prViewTarget("https://github.com/org/repo/pull/69")).toBe(
      "https://github.com/org/repo/pull/69",
    );
    expect(prViewTarget("feature-branch")).toBe("feature-branch");
  });
});

describe("runGithubPrSnapshot", () => {
  it("materializes a valid snapshot from a fake gh view", async () => {
    const { repo, runCommand, headSha, mergeBase } =
      await fakeForgeRepo("github");
    const root = await mkdtemp(join(tmpdir(), "pr-adapter-out-"));
    tracked.push(root);
    const worktree = join(root, "worktree");
    const snapshot = join(worktree, ".cross-review");

    const result = await runGithubPrSnapshot(
      [
        ...flags(
          repo,
          "https://github.com/org/repo/pull/69",
          worktree,
          snapshot,
        ),
        "--notes",
        "caller notes",
      ],
      runCommand,
    );
    expect(result.exitCode).toBe(0);

    const meta = JSON.parse(
      await readFile(join(snapshot, "meta.json"), "utf8"),
    );
    expect(meta).toEqual({
      schemaVersion: 1,
      forge: "github",
      target: "https://github.com/org/repo/pull/69",
      url: "https://github.com/org/repo/pull/69",
      baseSha: mergeBase,
      headSha,
      mergeBaseSha: mergeBase,
      fetchedAt: expect.any(String),
    });
    const diff = await readFile(join(snapshot, "diff.patch"), "utf8");
    expect(diff).toContain("feature.txt");
    expect(diff).not.toContain("[...truncated...]");
    const pr = await readFile(join(snapshot, "pr.md"), "utf8");
    expect(pr).toContain("Add feature");
    expect(pr).toContain("PR description body");
    const notes = await readFile(join(snapshot, "notes.md"), "utf8");
    expect(notes).toBe("caller notes");

    // Detached HEAD at the PR head SHA.
    const head = await execFileAsync(
      "git",
      ["-C", worktree, "rev-parse", "HEAD"],
      { encoding: "utf8" },
    );
    expect(head.stdout.trim()).toBe(headSha);
    const symbolic = await execFileAsync(
      "git",
      ["-C", worktree, "symbolic-ref", "-q", "HEAD"],
      { encoding: "utf8" },
    ).catch(() => undefined);
    expect(symbolic).toBeUndefined();
    // The worktree checkout contains PR-head-only files.
    const feature = await readFile(join(worktree, "feature.txt"), "utf8");
    expect(feature).toBe("feature\n");

    // .cross-review/ is excluded via $GIT_DIR/info/exclude.
    const gitPath = await execFileAsync(
      "git",
      ["-C", worktree, "rev-parse", "--git-path", "info/exclude"],
      { encoding: "utf8" },
    );
    const exclude = await readFile(
      gitPath.stdout.trim().startsWith("/")
        ? gitPath.stdout.trim()
        : join(worktree, gitPath.stdout.trim()),
      "utf8",
    );
    expect(exclude).toContain(".cross-review/");
  });

  it("never checks out, resets, or edits the source repository", async () => {
    const { repo, runCommand, commands } = await fakeForgeRepo("github");
    const before = await execFileAsync(
      "git",
      ["-C", repo, "status", "--porcelain"],
      { encoding: "utf8" },
    );
    const root = await mkdtemp(join(tmpdir(), "pr-adapter-out-"));
    tracked.push(root);
    const worktree = join(root, "worktree");
    const snapshot = join(worktree, ".cross-review");

    const result = await runGithubPrSnapshot(
      flags(repo, "69", worktree, snapshot),
      runCommand,
    );
    expect(result.exitCode).toBe(0);

    const after = await execFileAsync(
      "git",
      ["-C", repo, "status", "--porcelain"],
      { encoding: "utf8" },
    );
    expect(after.stdout).toBe(before.stdout);
    const dangerous = commands.filter(({ command, args }) => {
      if (command !== "git") return false;
      const subcommand = args.slice(1).find((arg) => !arg.startsWith("-"));
      return (
        subcommand === "checkout" ||
        subcommand === "reset" ||
        subcommand === "clean"
      );
    });
    expect(dangerous).toEqual([]);
    const repoCurrentBranch = await execFileAsync(
      "git",
      ["-C", repo, "rev-parse", "--abbrev-ref", "HEAD"],
      { encoding: "utf8" },
    );
    expect(repoCurrentBranch.stdout.trim()).toBe("main");
  });

  it("fails when gh pr view fails", async () => {
    const repo = await mkdtemp(join(tmpdir(), "pr-adapter-repo-"));
    tracked.push(repo);
    const failing = async () => {
      throw Object.assign(new Error("gh not authenticated"), {
        stderr: "gh: not authenticated",
      });
    };
    const result = await runGithubPrSnapshot(
      flags(repo, "69", join(repo, "wt"), join(repo, "wt/.cross-review")),
      failing,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("gh pr view failed");
  });

  it("fails when gh returns invalid JSON", async () => {
    const repo = await mkdtemp(join(tmpdir(), "pr-adapter-repo-"));
    tracked.push(repo);
    const bad = async () => ({ stdout: "<html>login page</html>", stderr: "" });
    const result = await runGithubPrSnapshot(
      flags(repo, "69", join(repo, "wt"), join(repo, "wt/.cross-review")),
      bad,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("invalid JSON");
  });

  it("fails when the head commit cannot be fetched", async () => {
    const repo = await mkdtemp(join(tmpdir(), "pr-adapter-repo-"));
    tracked.push(repo);
    await execFileAsync("git", ["init", "-q", repo], { encoding: "utf8" });
    const view = prViewJson(); // SHAs absent from the empty repository
    const runCommand = async (
      command: string,
      args: string[],
      options: { cwd?: string },
    ) => {
      if (command === "gh") return { stdout: view, stderr: "" };
      return execFileAsync(command, args, {
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        encoding: "utf8",
      });
    };
    const result = await runGithubPrSnapshot(
      flags(repo, "69", join(repo, "wt"), join(repo, "wt/.cross-review")),
      runCommand,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("PR head commit");
  });
});

describe("runGitcodePrSnapshot", () => {
  it("fails with setup guidance when the CLI is missing", async () => {
    const repo = await mkdtemp(join(tmpdir(), "pr-adapter-repo-"));
    tracked.push(repo);
    let spawned = false;
    const runCommand = async () => {
      spawned = true;
      return { stdout: "", stderr: "" };
    };
    const result = await runGitcodePrSnapshot(
      flags(
        repo,
        "https://gitcode.com/org/repo/pulls/69",
        join(repo, "wt"),
        join(repo, "wt/.cross-review"),
      ),
      undefined,
      runCommand,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("gitcode-cli");
    expect(result.stderr).toContain("https://github.com/codeasier/gitcode-cli");
    expect(result.stderr).toContain("/cross-review setup");
    expect(spawned).toBe(false);
  });

  it("fails when the CLI path is relative or empty", async () => {
    const repo = await mkdtemp(join(tmpdir(), "pr-adapter-repo-"));
    tracked.push(repo);
    for (const cli of ["", "bin/gitcode", "./gitcode"]) {
      let spawned = false;
      const runCommand = async () => {
        spawned = true;
        return { stdout: "", stderr: "" };
      };
      const result = await runGitcodePrSnapshot(
        flags(repo, "69", join(repo, "wt"), join(repo, "wt/.cross-review")),
        cli,
        runCommand,
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("absolute path");
      expect(spawned).toBe(false);
    }
  });

  it("materializes a snapshot via a fake gitcode CLI and never spawns gh", async () => {
    const { repo, runCommand, commands, headSha, mergeBase } =
      await fakeForgeRepo("gitcode");
    const root = await mkdtemp(join(tmpdir(), "pr-adapter-out-"));
    tracked.push(root);
    const worktree = join(root, "worktree");
    const snapshot = join(worktree, ".cross-review");

    const result = await runGitcodePrSnapshot(
      flags(repo, "https://gitcode.com/org/repo/pulls/69", worktree, snapshot),
      "/usr/local/bin/gitcode",
      runCommand,
    );
    expect(result.exitCode).toBe(0);
    expect(commands.some(({ command }) => command === "gh")).toBe(false);
    expect(commands.some(({ command }) => command.includes("gitcode"))).toBe(
      true,
    );

    const meta = JSON.parse(
      await readFile(join(snapshot, "meta.json"), "utf8"),
    );
    expect(meta.forge).toBe("gitcode");
    expect(meta.url).toBe("https://gitcode.com/org/repo/pulls/69");
    expect(meta.headSha).toBe(headSha);
    expect(meta.mergeBaseSha).toBe(mergeBase);
  });

  it("fails when gitcode-cli pr view fails", async () => {
    const repo = await mkdtemp(join(tmpdir(), "pr-adapter-repo-"));
    tracked.push(repo);
    const failing = async () => {
      throw Object.assign(new Error("no such PR"), { stderr: "not found" });
    };
    const result = await runGitcodePrSnapshot(
      flags(repo, "70", join(repo, "wt"), join(repo, "wt/.cross-review")),
      "/usr/local/bin/gitcode",
      failing,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("gitcode-cli pr view failed");
  });
});

describe("gitcodeSetupGuidance", () => {
  it("mentions install URL and setup for a missing CLI", () => {
    const guidance = gitcodeSetupGuidance(undefined);
    expect(guidance).toContain("https://github.com/codeasier/gitcode-cli");
    expect(guidance).toContain("/cross-review setup");
  });
});

describe("ensureCommit ref hardening", () => {
  it("rejects option-like ref names from the PR view payload", async () => {
    const { repo, runCommand, mergeBase } = await fakeForgeRepo("github");
    const root = await mkdtemp(join(tmpdir(), "pr-adapter-out-"));
    tracked.push(root);
    const worktree = join(root, "worktree");

    // Force the fetch path by pointing headRefOid at an absent commit while
    // headRefName is an option-like ref. gh returns the hostile view.
    const hostileView = prViewJson({
      headRefOid: "f".repeat(40),
      headRefName: "--upload-pack=touch-pwned",
      baseRefOid: mergeBase,
    });
    const issued: string[][] = [];
    const hostileRunner = async (
      command: string,
      args: string[],
      options: { cwd?: string },
    ) => {
      if (command === "gh") return { stdout: hostileView, stderr: "" };
      if (command === "git") issued.push(args);
      return runCommand(command, args, options);
    };

    const result = await runGithubPrSnapshot(
      flags(repo, "69", worktree, join(worktree, ".cross-review")),
      hostileRunner,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("looks like a git option");
    // No git fetch may carry the hostile ref.
    const fetches = issued.filter((args) => args[2] === "fetch");
    expect(fetches).toEqual([]);
    expect(
      issued.some((args) => args.includes("--upload-pack=touch-pwned")),
    ).toBe(false);
  });

  it("fetches refspecs behind -- so a hostile ref can never be a flag", async () => {
    const { repo, commands, runCommand, mergeBase } =
      await fakeForgeRepo("github");
    const root = await mkdtemp(join(tmpdir(), "pr-adapter-out-"));
    tracked.push(root);
    const worktree = join(root, "worktree");

    // Absent head SHA forces the fetch loop; branch names are benign here.
    const absentView = prViewJson({
      headRefOid: "f".repeat(40),
      baseRefOid: mergeBase,
    });
    const fetchRunner = async (
      command: string,
      args: string[],
      options: { cwd?: string },
    ) => {
      if (command === "gh") return { stdout: absentView, stderr: "" };
      return runCommand(command, args, options);
    };
    await runGithubPrSnapshot(
      flags(repo, "69", worktree, join(worktree, ".cross-review")),
      fetchRunner,
    );
    const fetches = commands.filter(
      (entry) => entry.command === "git" && entry.args[2] === "fetch",
    );
    expect(fetches.length).toBeGreaterThan(0);
    for (const entry of fetches) {
      const dashIndex = entry.args.indexOf("--");
      expect(dashIndex).toBeGreaterThan(-1);
      expect(entry.args.slice(2, dashIndex)).toEqual(["fetch", "origin"]);
    }
  });
});

describe("defaultRemoveSnapshot path resolution", () => {
  it("removes a real worktree and its registry entry even for a relative path", async () => {
    // A relative stateRoot (custom embed) makes the worktree path relative;
    // without resolving first, `git -C <worktree> worktree remove <worktree>`
    // re-resolves the positional argument against the new cwd, fails, and
    // the fallback rm leaves a `.git/worktrees/<id>` entry behind.
    const repo = await mkdtemp(join(tmpdir(), "pr-remove-repo-"));
    tracked.push(repo);
    const git = (args: string[]) =>
      execFileAsync("git", args, { cwd: repo, encoding: "utf8" });
    await git(["init", "-q", "--initial-branch=main"]);
    await git(["config", "user.email", "test@example.com"]);
    await git(["config", "user.name", "Test"]);
    await git(["config", "commit.gpgsign", "false"]);
    await writeFile(join(repo, "base.txt"), "base\n", "utf8");
    await git(["add", "."]);
    await git(["commit", "-q", "-m", "base"]);

    const runDir = join(repo, "state", "run-id");
    const worktree = join(runDir, "worktree");
    await git(["worktree", "add", "--detach", worktree, "HEAD"]);
    expect((await git(["worktree", "list"])).stdout).toContain(worktree);

    // Hand the remover a path relative to the process cwd.
    await defaultRemoveSnapshot(relative(process.cwd(), worktree));

    // The worktree and its run directory are gone, and git's registry no
    // longer lists the entry (no manual `git worktree prune` needed).
    await expect(stat(worktree)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(runDir)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await git(["worktree", "list"])).stdout).not.toContain(worktree);
  });
});
