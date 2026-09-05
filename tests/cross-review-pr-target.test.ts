import { describe, expect, it } from "vitest";
import {
  classifyPrTarget,
  hostFromRemoteUrl,
  remoteUrlsFromVerboseOutput,
} from "../src/cross-review/pr-target.js";

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
});
