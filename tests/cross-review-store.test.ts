import { mkdir, mkdtemp, readFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FileCrossReviewRunStore,
  RUN_SCHEMA_VERSION,
  defaultCrossReviewStateDirectory,
  type CrossReviewRun,
} from "../src/cross-review/run-store.js";

const RUN_ID = "00000000-0000-4000-8000-000000000001";

function run(): CrossReviewRun {
  return {
    schemaVersion: RUN_SCHEMA_VERSION,
    runID: RUN_ID,
    directory: "/repo",
    ownerSessionID: "parent",
    createdAt: 1,
    updatedAt: 1,
    phase: "reviewing",
    target: "HEAD",
    brief: "brief",
    quorum: 1,
    maxConcurrency: 1,
    reviewerTimeoutMs: 5_000,
    configSources: { project: "loaded", global: "absent" },
    projectConfigPath: "/repo/.opencode/cross-review.json",
    globalConfigPath: "/home/.config/opencode/cross-review.json",
    reviewers: [
      {
        reviewer: 1,
        model: "a/one",
        sessionID: "child-1",
        messageID: "message-1",
        status: "queued",
      },
    ],
  };
}

describe("cross-review run store", () => {
  it("selects a state directory outside the repository on each platform", () => {
    expect(
      defaultCrossReviewStateDirectory(
        { XDG_STATE_HOME: "/state" },
        "linux",
        "/home/me",
      ),
    ).toBe("/state/open-codeasier/cross-review");
    expect(defaultCrossReviewStateDirectory({}, "darwin", "/home/me")).toBe(
      "/home/me/Library/Application Support/open-codeasier/cross-review",
    );
    expect(
      defaultCrossReviewStateDirectory(
        { LOCALAPPDATA: "C:\\state" },
        "win32",
        "C:\\Users\\me",
      ),
    ).toContain("open-codeasier");
  });

  it("persists updates across store instances", async () => {
    const root = await mkdtemp(join(tmpdir(), "cross-review-store-"));
    const first = new FileCrossReviewRunStore(root, () => 10);
    await first.create(run());
    await first.withRun(RUN_ID, async (stored, save) => {
      const reviewer = stored.reviewers[0];
      if (reviewer === undefined) throw new Error("Missing reviewer");
      reviewer.status = "running";
      await save();
    });

    const second = new FileCrossReviewRunStore(root, () => 20);
    const status = await second.withRun(RUN_ID, async (stored) => {
      const reviewer = stored.reviewers[0];
      if (reviewer === undefined) throw new Error("Missing reviewer");
      return Promise.resolve(reviewer.status);
    });

    expect(status).toBe("running");
    const persisted = JSON.parse(
      await readFile(join(root, `${RUN_ID}.json`), "utf8"),
    );
    expect(persisted.updatedAt).toBe(20);
  });

  it("rejects malformed run IDs before resolving filesystem paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "cross-review-store-"));
    const store = new FileCrossReviewRunStore(root);
    await expect(
      store.withRun("../../escape", async () => Promise.resolve()),
    ).rejects.toThrow("Invalid cross-review run ID");
  });

  it("serializes concurrent recovery of the same stale lock", async () => {
    const root = await mkdtemp(join(tmpdir(), "cross-review-store-"));
    const initial = new FileCrossReviewRunStore(root);
    await initial.create(run());
    const lockPath = join(root, `${RUN_ID}.lock`);
    await mkdir(lockPath);
    const stale = new Date(Date.now() - 61_000);
    await utimes(lockPath, stale, stale);
    const first = new FileCrossReviewRunStore(root);
    const second = new FileCrossReviewRunStore(root);
    const increment = async (stored: CrossReviewRun) => {
      const reviewer = stored.reviewers[0];
      if (reviewer === undefined) throw new Error("Missing reviewer");
      await new Promise((resolve) => setTimeout(resolve, 10));
      reviewer.reviewer += 1;
    };

    await Promise.all([
      first.withRun(RUN_ID, increment),
      second.withRun(RUN_ID, increment),
    ]);

    const reviewerNumber = await first.withRun(RUN_ID, async (stored) => {
      const reviewer = stored.reviewers[0];
      if (reviewer === undefined) throw new Error("Missing reviewer");
      return Promise.resolve(reviewer.reviewer);
    });
    expect(reviewerNumber).toBe(3);
  });
});
