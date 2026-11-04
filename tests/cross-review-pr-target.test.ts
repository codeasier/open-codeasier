import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  classifyPrTarget,
  classifyPrTargetInRepository,
  hostFromRemoteUrl,
  orderFetchRemotesForPr,
  remotesFromVerboseOutput,
  remoteUrlsFromVerboseOutput,
  repoSlugFromPrUrl,
  repoSlugFromRemoteUrl,
} from "../src/cross-review/pr-target.js";

const execFileAsync = promisify(execFile);

async function initRepoWithRemote(url: string): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "pr-target-repo-"));
  await execFileAsync("git", ["init", "-q", repo], { encoding: "utf8" });
  await execFileAsync("git", ["-C", repo, "remote", "add", "origin", url], {
    encoding: "utf8",
  });
  return repo;
}

const GITHUB_REMOTES = [
  "https://github.com/org/repo.git",
  "git@github.com:org/repo.git",
];
const GITCODE_REMOTES = ["https://gitcode.com/org/repo.git"];
const MIXED_REMOTES = [
  "https://github.com/org/repo.git",
  "https://gitcode.com/org/repo.git",
];
const GITLAB_REMOTES = ["https://gitlab.com/org/repo.git"];

describe("classifyPrTarget", () => {
  it("classifies GitHub pull request URLs", () => {
    expect(
      classifyPrTarget("https://github.com/org/repo/pull/69", GITLAB_REMOTES),
    ).toEqual({ kind: "pr", forge: "github" });
    expect(classifyPrTarget("http://github.com/org/repo/pull/69", [])).toEqual({
      kind: "pr",
      forge: "github",
    });
    expect(
      classifyPrTarget("https://www.github.com/org/repo/pull/69", []),
    ).toEqual({ kind: "pr", forge: "github" });
    expect(classifyPrTarget("https://GITHUB.COM/org/repo/pull/69", [])).toEqual(
      { kind: "pr", forge: "github" },
    );
    expect(
      classifyPrTarget("https://github.com/org/repo/pull/69/files", []),
    ).toEqual({ kind: "pr", forge: "github" });
    expect(classifyPrTarget("https://github.com/org/repo/pull/", [])).toEqual({
      kind: "pr",
      forge: "github",
    });
  });

  it("classifies GitCode pull request URLs", () => {
    expect(
      classifyPrTarget("https://gitcode.com/org/repo/pulls/70", []),
    ).toEqual({ kind: "pr", forge: "gitcode" });
    expect(
      classifyPrTarget("https://gitcode.com/org/repo/pull/70", []),
    ).toEqual({ kind: "pr", forge: "gitcode" });
  });

  it("keeps a GitHub URL GitHub even when remotes are GitCode", () => {
    expect(
      classifyPrTarget("https://github.com/org/repo/pull/69", GITCODE_REMOTES),
    ).toEqual({ kind: "pr", forge: "github" });
  });

  it("keeps a GitCode URL GitCode even when remotes are GitHub", () => {
    expect(
      classifyPrTarget("https://gitcode.com/org/repo/pulls/70", GITHUB_REMOTES),
    ).toEqual({ kind: "pr", forge: "gitcode" });
  });

  it("keeps issue URLs on the legacy path", () => {
    expect(
      classifyPrTarget("https://github.com/org/repo/issues/5", GITHUB_REMOTES),
    ).toEqual({ kind: "legacy" });
    expect(
      classifyPrTarget(
        "https://gitcode.com/org/repo/issues/5",
        GITCODE_REMOTES,
      ),
    ).toEqual({ kind: "legacy" });
  });

  it("keeps non-PR GitHub and GitCode URLs on the legacy path", () => {
    expect(
      classifyPrTarget("https://github.com/org/repo", GITHUB_REMOTES),
    ).toEqual({ kind: "legacy" });
    expect(
      classifyPrTarget(
        "https://github.com/org/repo/commit/a".repeat(1) + "b1c2d3e",
        GITHUB_REMOTES,
      ),
    ).toEqual({ kind: "legacy" });
    expect(
      classifyPrTarget("https://gitcode.com/org/repo", GITCODE_REMOTES),
    ).toEqual({ kind: "legacy" });
  });

  it("keeps other forges on the legacy path even with PR-like paths", () => {
    expect(
      classifyPrTarget("https://gitlab.com/org/repo/pull/1", GITLAB_REMOTES),
    ).toEqual({ kind: "legacy" });
    expect(classifyPrTarget("https://gitee.com/org/repo/pulls/1", [])).toEqual({
      kind: "legacy",
    });
  });

  it("keeps git ranges on the legacy path", () => {
    expect(classifyPrTarget("main...HEAD", MIXED_REMOTES)).toEqual({
      kind: "legacy",
    });
    expect(classifyPrTarget("v1.0..v2.0", GITHUB_REMOTES)).toEqual({
      kind: "legacy",
    });
  });

  it("classifies bare numbers as PRs when remotes agree on one forge", () => {
    expect(classifyPrTarget("123", GITHUB_REMOTES)).toEqual({
      kind: "pr",
      forge: "github",
    });
    expect(classifyPrTarget("#123", GITHUB_REMOTES)).toEqual({
      kind: "pr",
      forge: "github",
    });
    expect(classifyPrTarget("PR#116", GITHUB_REMOTES)).toEqual({
      kind: "pr",
      forge: "github",
    });
    expect(classifyPrTarget("pr #116", GITHUB_REMOTES)).toEqual({
      kind: "pr",
      forge: "github",
    });
    expect(classifyPrTarget("PR 116", GITCODE_REMOTES)).toEqual({
      kind: "pr",
      forge: "gitcode",
    });
    expect(classifyPrTarget("42", GITCODE_REMOTES)).toEqual({
      kind: "pr",
      forge: "gitcode",
    });
  });

  it("fails closed for bare numbers with mixed remotes", () => {
    const result = classifyPrTarget("42", MIXED_REMOTES);
    expect(result).toEqual({
      kind: "error",
      message: expect.stringContaining("Cannot classify"),
    });
    if (result.kind === "error") expect(result.message).toContain("github.com");
  });

  it("fails closed for bare numbers with unknown remotes", () => {
    expect(classifyPrTarget("42", GITLAB_REMOTES)).toEqual({
      kind: "error",
      message: expect.stringContaining("Cannot classify"),
    });
  });

  it("fails closed for bare numbers with no remotes", () => {
    expect(classifyPrTarget("42", [])).toEqual({
      kind: "error",
      message: expect.stringContaining("Cannot classify"),
    });
    expect(classifyPrTarget("PR#116", [])).toEqual({
      kind: "error",
      message: expect.stringContaining("no git remotes were found"),
    });
  });

  it("fails closed for bare numbers when a remote host is unresolvable", () => {
    expect(
      classifyPrTarget("42", [
        "https://github.com/org/repo.git",
        "/local/backup",
      ]),
    ).toMatchObject({ kind: "error" });
  });

  it("keeps non-PR local refs on the legacy path regardless of remotes", () => {
    expect(classifyPrTarget("HEAD", MIXED_REMOTES)).toEqual({ kind: "legacy" });
    expect(classifyPrTarget("main", [])).toEqual({ kind: "legacy" });
    expect(
      classifyPrTarget("a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0", []),
    ).toEqual({ kind: "legacy" });
  });

  it("keeps zero and non-numeric bare targets on the legacy path", () => {
    expect(classifyPrTarget("0", GITHUB_REMOTES)).toEqual({ kind: "legacy" });
    expect(classifyPrTarget("#0", GITHUB_REMOTES)).toEqual({ kind: "legacy" });
    expect(classifyPrTarget("pr-123", GITHUB_REMOTES)).toEqual({
      kind: "legacy",
    });
    expect(classifyPrTarget("PR116", GITHUB_REMOTES)).toEqual({
      kind: "legacy",
    });
    expect(classifyPrTarget("pull#116", GITHUB_REMOTES)).toEqual({
      kind: "legacy",
    });
    expect(classifyPrTarget("MR#116", GITHUB_REMOTES)).toEqual({
      kind: "legacy",
    });
  });
});

describe("hostFromRemoteUrl", () => {
  it("extracts hosts from absolute URLs", () => {
    expect(hostFromRemoteUrl("https://github.com/org/repo.git")).toBe(
      "github.com",
    );
    expect(hostFromRemoteUrl("ssh://git@github.com/org/repo.git")).toBe(
      "github.com",
    );
    expect(hostFromRemoteUrl("http://gitcode.com/org/repo")).toBe(
      "gitcode.com",
    );
  });

  it("extracts hosts from SCP-like URLs", () => {
    expect(hostFromRemoteUrl("git@github.com:org/repo.git")).toBe("github.com");
    expect(hostFromRemoteUrl("gitcode.com:org/repo.git")).toBe("gitcode.com");
  });

  it("returns undefined for local paths", () => {
    expect(hostFromRemoteUrl("/local/backup")).toBeUndefined();
    expect(hostFromRemoteUrl("C:\\repo")).toBeUndefined();
    expect(hostFromRemoteUrl("./relative")).toBeUndefined();
    expect(hostFromRemoteUrl("")).toBeUndefined();
  });
});

describe("repoSlugFromPrUrl", () => {
  it("extracts owner/repo from GitHub and GitCode pull request URLs", () => {
    expect(
      repoSlugFromPrUrl("https://gitcode.com/Ascend/msinsight/pull/1370"),
    ).toBe("ascend/msinsight");
    expect(repoSlugFromPrUrl("https://github.com/org/repo/pull/5")).toBe(
      "org/repo",
    );
  });
});

describe("repoSlugFromRemoteUrl", () => {
  it("extracts owner/repo from HTTPS and SCP-style remotes", () => {
    expect(
      repoSlugFromRemoteUrl("https://gitcode.com/Ascend/msinsight.git"),
    ).toBe("ascend/msinsight");
    expect(repoSlugFromRemoteUrl("git@gitcode.com:Ascend/msinsight.git")).toBe(
      "ascend/msinsight",
    );
    expect(
      repoSlugFromRemoteUrl("https://gitcode.com/codeasier/msinsight"),
    ).toBe("codeasier/msinsight");
  });
});

describe("remotesFromVerboseOutput", () => {
  it("deduplicates remotes by name", () => {
    expect(
      remotesFromVerboseOutput(
        [
          "origin\thttps://gitcode.com/codeasier/msinsight.git (fetch)",
          "origin\thttps://gitcode.com/codeasier/msinsight.git (push)",
          "upstream\thttps://gitcode.com/Ascend/msinsight.git (fetch)",
          "upstream\thttps://gitcode.com/Ascend/msinsight.git (push)",
        ].join("\n"),
      ),
    ).toEqual([
      {
        name: "origin",
        url: "https://gitcode.com/codeasier/msinsight.git",
      },
      {
        name: "upstream",
        url: "https://gitcode.com/Ascend/msinsight.git",
      },
    ]);
  });

  it("keeps local remote URLs that contain spaces", () => {
    expect(
      remotesFromVerboseOutput(
        [
          "origin\thttps://gitcode.com/codeasier/msinsight.git (fetch)",
          "origin\thttps://gitcode.com/codeasier/msinsight.git (push)",
          "upstream\t/tmp/upstream repo (fetch)",
          "upstream\t/tmp/upstream repo (push)",
        ].join("\n"),
      ),
    ).toEqual([
      {
        name: "origin",
        url: "https://gitcode.com/codeasier/msinsight.git",
      },
      { name: "upstream", url: "/tmp/upstream repo" },
    ]);
  });

  it("ranks by the fetch URL when push URLs differ", () => {
    expect(
      remotesFromVerboseOutput(
        [
          "origin\thttps://github.com/fork/repo.git (fetch)",
          "origin\thttps://github.com/fork/repo.git (push)",
          "source\thttps://github.com/org/repo.git (fetch)",
          "source\thttps://github.com/fork/repo.git (push)",
        ].join("\n"),
      ),
    ).toEqual([
      { name: "origin", url: "https://github.com/fork/repo.git" },
      { name: "source", url: "https://github.com/org/repo.git" },
    ]);
  });

  it("does not let a later push URL replace an earlier fetch URL", () => {
    expect(
      remotesFromVerboseOutput(
        [
          "source\thttps://github.com/fork/repo.git (push)",
          "source\thttps://github.com/org/repo.git (fetch)",
          "source\thttps://github.com/other/repo.git (push)",
        ].join("\n"),
      ),
    ).toEqual([{ name: "source", url: "https://github.com/org/repo.git" }]);
  });
});

describe("orderFetchRemotesForPr", () => {
  it("prefers the remote matching the PR repository, then upstream, then origin", () => {
    const remotes = remotesFromVerboseOutput(
      [
        "origin\thttps://gitcode.com/codeasier/msinsight.git (fetch)",
        "upstream\thttps://gitcode.com/Ascend/msinsight.git (fetch)",
      ].join("\n"),
    );
    expect(
      orderFetchRemotesForPr(
        remotes,
        "https://gitcode.com/Ascend/msinsight/pull/1370",
      ),
    ).toEqual(["upstream", "origin"]);
  });

  it("falls back to origin when no remotes are configured", () => {
    expect(
      orderFetchRemotesForPr(
        [],
        "https://gitcode.com/Ascend/msinsight/pull/1370",
      ),
    ).toEqual(["origin"]);
  });

  it("prefers the remote whose fetch URL matches the PR host and repo", () => {
    const remotes = remotesFromVerboseOutput(
      [
        "origin\thttps://github.com/fork/repo.git (fetch)",
        "origin\thttps://github.com/fork/repo.git (push)",
        "source\thttps://github.com/org/repo.git (fetch)",
        "source\thttps://github.com/fork/repo.git (push)",
      ].join("\n"),
    );
    expect(
      orderFetchRemotesForPr(remotes, "https://github.com/org/repo/pull/1"),
    ).toEqual(["source", "origin"]);
  });

  it("does not treat a same owner/repo on another host as a match", () => {
    const remotes = remotesFromVerboseOutput(
      [
        "origin\thttps://gitcode.com/org/repo.git (fetch)",
        "upstream\thttps://github.com/org/repo.git (fetch)",
      ].join("\n"),
    );
    expect(
      orderFetchRemotesForPr(remotes, "https://github.com/org/repo/pull/1"),
    ).toEqual(["upstream", "origin"]);
  });

  it("matches HTTPS, www, and SCP-style remotes on the same host", () => {
    expect(
      orderFetchRemotesForPr(
        remotesFromVerboseOutput(
          "origin\tgit@github.com:org/repo.git (fetch)\n",
        ),
        "https://www.github.com/org/repo/pull/1",
      ),
    ).toEqual(["origin"]);
  });
});

describe("remoteUrlsFromVerboseOutput", () => {
  it("parses fetch and push lines from git remote -v output", () => {
    expect(
      remoteUrlsFromVerboseOutput(
        [
          "origin\thttps://github.com/org/repo.git (fetch)",
          "origin\thttps://github.com/org/repo.git (push)",
          "upstream\tgit@github.com:other/repo.git (fetch)",
          "upstream\tgit@github.com:other/repo.git (push)",
        ].join("\n"),
      ),
    ).toEqual([
      "https://github.com/org/repo.git",
      "https://github.com/org/repo.git",
      "git@github.com:other/repo.git",
      "git@github.com:other/repo.git",
    ]);
  });

  it("ignores blank and malformed lines", () => {
    expect(remoteUrlsFromVerboseOutput("")).toEqual([]);
    expect(remoteUrlsFromVerboseOutput("not a remote line\n\n\t\n")).toEqual(
      [],
    );
  });

  it("keeps URLs that contain spaces", () => {
    expect(
      remoteUrlsFromVerboseOutput(
        "upstream\t/tmp/upstream repo (fetch)\nupstream\t/tmp/upstream repo (push)\n",
      ),
    ).toEqual(["/tmp/upstream repo", "/tmp/upstream repo"]);
  });
});

describe("classifyPrTargetInRepository", () => {
  it("classifies bare numbers against real repository remotes (GitHub)", async () => {
    const repo = await initRepoWithRemote("https://github.com/org/repo.git");
    expect(await classifyPrTargetInRepository("42", repo)).toEqual({
      kind: "pr",
      forge: "github",
    });
    expect(await classifyPrTargetInRepository("#42", repo)).toEqual({
      kind: "pr",
      forge: "github",
    });
    expect(await classifyPrTargetInRepository("PR#42", repo)).toEqual({
      kind: "pr",
      forge: "github",
    });
    expect(await classifyPrTargetInRepository("pr #42", repo)).toEqual({
      kind: "pr",
      forge: "github",
    });
  });

  it("classifies bare numbers against real repository remotes (GitCode)", async () => {
    const repo = await initRepoWithRemote("git@gitcode.com:org/repo.git");
    expect(await classifyPrTargetInRepository("7", repo)).toEqual({
      kind: "pr",
      forge: "gitcode",
    });
  });

  it("fails closed for bare numbers in a repository without remotes", async () => {
    const repo = await mkdtemp(join(tmpdir(), "pr-target-bare-"));
    await execFileAsync("git", ["init", "-q", repo], { encoding: "utf8" });
    const result = await classifyPrTargetInRepository("42", repo);
    expect(result.kind).toBe("error");
    if (result.kind === "error")
      expect(result.message).toContain("no git remotes were found");
  });

  it("fails closed for bare numbers on a non-forge remote", async () => {
    const repo = await initRepoWithRemote("https://gitlab.com/org/repo.git");
    const result = await classifyPrTargetInRepository("42", repo);
    expect(result.kind).toBe("error");
    if (result.kind === "error")
      expect(result.message).toContain("neither clearly GitHub nor GitCode");
  });

  it("classifies URLs and git ranges without inspecting remotes", async () => {
    const repo = await initRepoWithRemote("https://gitlab.com/org/repo.git");
    expect(
      await classifyPrTargetInRepository(
        "https://github.com/org/repo/pull/69",
        repo,
      ),
    ).toEqual({ kind: "pr", forge: "github" });
    expect(await classifyPrTargetInRepository("main...HEAD", repo)).toEqual({
      kind: "legacy",
    });
    expect(await classifyPrTargetInRepository("PR116", repo)).toEqual({
      kind: "legacy",
    });
    expect(await classifyPrTargetInRepository("pr-123", repo)).toEqual({
      kind: "legacy",
    });
  });
});
