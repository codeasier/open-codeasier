/* eslint-disable @typescript-eslint/no-explicit-any */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createCrossReviewProtocolTools,
  type AsyncCrossReviewClient,
} from "../src/cross-review/protocol.js";
import type {
  CrossReviewRun,
  CrossReviewRunStore,
  SaveRun,
} from "../src/cross-review/run-store.js";
import { FileCrossReviewRunStore } from "../src/cross-review/run-store.js";
import type { LoadedCrossReviewConfig } from "../src/cross-review/config.js";

const RUN_ID = "00000000-0000-4000-8000-000000000001";

class MemoryRunStore implements CrossReviewRunStore {
  readonly runs = new Map<string, CrossReviewRun>();

  async create(run: CrossReviewRun) {
    this.runs.set(run.runID, structuredClone(run));
  }

  async withRun<T>(
    runID: string,
    action: (run: CrossReviewRun, save: SaveRun) => Promise<T>,
  ) {
    const run = this.runs.get(runID);
    if (run === undefined)
      throw new Error(`Cross-review run not found: ${runID}`);
    const save = async () => {
      this.runs.set(runID, structuredClone(run));
    };
    const result = await action(run, save);
    await save();
    return result;
  }
}

function loadedConfig(): Promise<LoadedCrossReviewConfig> {
  return Promise.resolve({
    config: {},
    sources: { project: "loaded", global: "absent" },
    projectPath: "/repo/.opencode/cross-review.json",
    globalPath: "/home/.config/opencode/cross-review.json",
  });
}

function context(sessionID = "parent", abort = new AbortController()) {
  return {
    sessionID,
    messageID: "message",
    agent: "build",
    directory: "/repo",
    worktree: "/repo",
    abort: abort.signal,
    metadata() {},
    async ask() {},
  } as any;
}

type TestMessage = {
  info: {
    role: "user" | "assistant";
    time: { created: number; completed?: number };
    error?: unknown;
    finish?: string;
  };
  parts: Array<{ type: string; text?: string }>;
};

function completed(text: string, created = 10): TestMessage[] {
  return [
    {
      info: {
        role: "assistant",
        time: { created, completed: created + 1 },
        finish: "stop",
      },
      parts: [{ type: "text", text }],
    },
  ];
}

function failed(name: string, message: string): TestMessage[] {
  return [
    {
      info: {
        role: "assistant",
        time: { created: 10, completed: 11 },
        error: { name, data: { message } },
      },
      parts: [],
    },
  ];
}

function mockClient() {
  let nextID = 0;
  const statuses: Record<string, any> = {};
  const messages = new Map<string, TestMessage[]>();
  const client = {
    provider: {
      list: vi.fn().mockResolvedValue({
        data: {
          all: [
            { id: "a", models: { one: {}, two: {} } },
            { id: "b", models: { judge: {} } },
          ],
          connected: ["a", "b"],
        },
      }),
    },
    session: {
      create: vi.fn().mockImplementation(async () => ({
        data: { id: `child-${++nextID}` },
      })),
      promptAsync: vi.fn().mockResolvedValue({ data: undefined }),
      status: vi.fn().mockImplementation(async () => ({
        data: { ...statuses },
      })),
      messages: vi.fn().mockImplementation(async (input) => ({
        data: messages.get(input.path.id) ?? [],
      })),
      abort: vi.fn().mockResolvedValue({ data: true }),
    },
  } satisfies AsyncCrossReviewClient;
  return { client, statuses, messages };
}

function protocol(
  client: AsyncCrossReviewClient,
  store: CrossReviewRunStore,
  now: () => number = () => 1_000,
) {
  return createCrossReviewProtocolTools(client, {
    store,
    loadConfig: loadedConfig,
    now,
    createRunID: () => RUN_ID,
    canonicalize: async (directory) => directory,
  });
}

function output(result: unknown) {
  return JSON.parse((result as { output: string }).output);
}

describe("asynchronous cross-review protocol", () => {
  it("starts reviewer sessions without waiting for model completion", async () => {
    const { client } = mockClient();
    const tools = protocol(client, new MemoryRunStore());

    const started = output(
      await tools.cross_review_start.execute(
        {
          target: "HEAD",
          reviewModels: ["a/one"],
          agents: 3,
          maxConcurrency: 2,
        },
        context(),
      ),
    );

    expect(started).toMatchObject({
      runID: RUN_ID,
      phase: "reviewing",
      quorum: 2,
      counts: { starting: 2, queued: 1 },
    });
    expect(
      started.reviewers.map((reviewer: any) => reviewer.sessionID),
    ).toEqual(["child-1", "child-2", "child-3"]);
    expect(client.session.promptAsync).toHaveBeenCalledTimes(2);
    expect(client.session.promptAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          messageID: expect.stringMatching(/^msg_[0-9a-f-]+$/),
          agent: "cross-reviewer",
          model: { providerID: "a", modelID: "one" },
          tools: expect.objectContaining({
            bash: false,
            edit: false,
            task: false,
          }),
        }),
      }),
    );
  });

  it("returns a cancelled run when the parent aborts during dispatch", async () => {
    const abort = new AbortController();
    const { client } = mockClient();
    client.session.promptAsync.mockImplementation(async () => {
      abort.abort();
      throw new Error("request aborted");
    });
    client.session.abort.mockResolvedValue({ data: false });
    const tools = protocol(client, new MemoryRunStore());

    const started = output(
      await tools.cross_review_start.execute(
        {
          target: "HEAD",
          reviewModels: ["a/one"],
          agents: 2,
          maxConcurrency: 2,
        },
        context("parent", abort),
      ),
    );

    expect(started.phase).toBe("cancelled");
    expect(started.reviewers.map((reviewer: any) => reviewer.status)).toEqual([
      "cancelled",
      "cancelled",
    ]);
    expect(started.reviewers[0].error).toContain("abort unconfirmed");
    expect(client.session.abort).toHaveBeenCalledTimes(4);
  });

  it("reconciles completion and fills the next concurrency slot", async () => {
    const { client, statuses, messages } = mockClient();
    const store = new MemoryRunStore();
    const tools = protocol(client, store);
    await tools.cross_review_start.execute(
      {
        target: "HEAD",
        reviewModels: ["a/one", "a/two"],
        agents: 3,
        maxConcurrency: 2,
      },
      context(),
    );
    statuses["child-2"] = { type: "busy" };
    messages.set("child-1", completed("first review"));

    const status = output(
      await tools.cross_review_status.execute({ runID: RUN_ID }, context()),
    );

    expect(status.counts).toEqual({ succeeded: 1, running: 1, starting: 1 });
    expect(status.reviewers[0]).not.toHaveProperty("output");
    expect(status.pollAfterMs).toBe(3_000);
    expect(status.summary).toContain("1 succeeded of 3");
    expect(status.summary).toContain("1 running of 3");
    expect(status.summary).toContain("1 starting of 3");
    expect(status.summary).toContain("a/one — succeeded");
    expect(status.summary).toContain("poll again after");
    expect(client.session.promptAsync).toHaveBeenCalledTimes(3);
    expect(client.session.promptAsync).toHaveBeenLastCalledWith(
      expect.objectContaining({ path: { id: "child-3" } }),
    );

    const withOutput = output(
      await tools.cross_review_status.execute(
        { runID: RUN_ID, includeOutputs: true },
        context(),
      ),
    );
    expect(withOutput.reviewers[0].output).toBe("first review");
  });

  it("maps provider retries without consuming another slot", async () => {
    const { client, statuses } = mockClient();
    const tools = protocol(client, new MemoryRunStore());
    await tools.cross_review_start.execute(
      {
        target: "HEAD",
        reviewModels: ["a/one"],
        agents: 2,
        maxConcurrency: 1,
      },
      context(),
    );
    statuses["child-1"] = {
      type: "retry",
      attempt: 2,
      message: "rate limited",
      next: 9_000,
    };

    const status = output(
      await tools.cross_review_status.execute({ runID: RUN_ID }, context()),
    );

    expect(status.reviewers[0]).toMatchObject({
      status: "retrying",
      retry: { attempt: 2, message: "rate limited", next: 9_000 },
    });
    expect(status.reviewers[1].status).toBe("queued");
    expect(client.session.promptAsync).toHaveBeenCalledTimes(1);
  });

  it("times out an overdue reviewer and advances quorum work", async () => {
    let timestamp = 1_000;
    const { client } = mockClient();
    const tools = protocol(client, new MemoryRunStore(), () => timestamp);
    await tools.cross_review_start.execute(
      {
        target: "HEAD",
        reviewModels: ["a/one"],
        agents: 2,
        maxConcurrency: 1,
        reviewerTimeoutMs: 5_000,
      },
      context(),
    );
    timestamp = 6_001;

    const status = output(
      await tools.cross_review_status.execute({ runID: RUN_ID }, context()),
    );

    expect(status.reviewers.map((reviewer: any) => reviewer.status)).toEqual([
      "timed_out",
      "starting",
    ]);
    expect(client.session.abort).toHaveBeenCalledWith(
      expect.objectContaining({ path: { id: "child-1" } }),
    );
    expect(client.session.promptAsync).toHaveBeenCalledTimes(2);
  });

  it("uses the configured reviewerTimeoutMs when no flag is given", async () => {
    const { client } = mockClient();
    const store = new MemoryRunStore();
    const tools = createCrossReviewProtocolTools(client, {
      store,
      loadConfig: () =>
        Promise.resolve({
          config: {
            reviewModels: ["a/one"],
            reviewerTimeoutMs: 900_000,
          },
          sources: { project: "loaded", global: "absent" },
          projectPath: "/repo/.opencode/cross-review.json",
          globalPath: "/home/.config/opencode/cross-review.json",
        }),
      now: () => 1_000,
      createRunID: () => RUN_ID,
      canonicalize: async (directory) => directory,
    });
    await tools.cross_review_start.execute(
      { target: "HEAD", reviewModels: ["a/one"], agents: 1 },
      context(),
    );
    expect(store.runs.get(RUN_ID)?.reviewerTimeoutMs).toBe(900_000);
  });

  it("lets an explicit reviewerTimeoutMs flag override configuration", async () => {
    const { client } = mockClient();
    const store = new MemoryRunStore();
    const tools = createCrossReviewProtocolTools(client, {
      store,
      loadConfig: () =>
        Promise.resolve({
          config: {
            reviewModels: ["a/one"],
            reviewerTimeoutMs: 900_000,
          },
          sources: { project: "loaded", global: "absent" },
          projectPath: "/repo/.opencode/cross-review.json",
          globalPath: "/home/.config/opencode/cross-review.json",
        }),
      now: () => 1_000,
      createRunID: () => RUN_ID,
      canonicalize: async (directory) => directory,
    });
    await tools.cross_review_start.execute(
      {
        target: "HEAD",
        reviewModels: ["a/one"],
        agents: 1,
        reviewerTimeoutMs: 5_000,
      },
      context(),
    );
    expect(store.runs.get(RUN_ID)?.reviewerTimeoutMs).toBe(5_000);
  });

  it("defaults reviewerTimeoutMs to 600000 without config or flag", async () => {
    const { client } = mockClient();
    const store = new MemoryRunStore();
    const tools = protocol(client, store);
    await tools.cross_review_start.execute(
      { target: "HEAD", reviewModels: ["a/one"], agents: 1 },
      context(),
    );
    expect(store.runs.get(RUN_ID)?.reviewerTimeoutMs).toBe(600_000);
  });

  it("terminates a timeout without dispatching queued work when abort is unconfirmed", async () => {
    let timestamp = 1_000;
    const { client } = mockClient();
    client.session.abort.mockResolvedValueOnce({ data: false });
    const tools = protocol(client, new MemoryRunStore(), () => timestamp);
    await tools.cross_review_start.execute(
      {
        target: "HEAD",
        reviewModels: ["a/one"],
        agents: 2,
        maxConcurrency: 1,
        reviewerTimeoutMs: 5_000,
      },
      context(),
    );
    timestamp = 6_001;

    const status = output(
      await tools.cross_review_status.execute({ runID: RUN_ID }, context()),
    );

    expect(status.reviewers[0]).toMatchObject({
      status: "timed_out",
      error: expect.stringContaining("abort unconfirmed"),
    });
    expect(status.reviewers[1]).toMatchObject({
      status: "cancelled",
      error: expect.stringContaining("could not be confirmed stopped"),
    });
    expect(client.session.promptAsync).toHaveBeenCalledTimes(1);
  });

  it("collects a completed reviewer before applying its deadline", async () => {
    let timestamp = 1_000;
    const { client, messages } = mockClient();
    client.session.abort.mockResolvedValue({ data: false });
    const tools = protocol(client, new MemoryRunStore(), () => timestamp);
    await tools.cross_review_start.execute(
      {
        target: "HEAD",
        reviewModels: ["a/one"],
        agents: 1,
        reviewerTimeoutMs: 5_000,
      },
      context(),
    );
    messages.set("child-1", completed("finished before polling"));
    timestamp = 6_001;

    const finalized = output(
      await tools.cross_review_finalize.execute({ runID: RUN_ID }, context()),
    );

    expect(finalized.reviewers[0]).toMatchObject({
      status: "succeeded",
      output: "finished before polling",
    });
    expect(client.session.abort).not.toHaveBeenCalled();
  });

  it("retries an ambiguous dispatch with the same message ID", async () => {
    let timestamp = 1_000;
    const { client } = mockClient();
    client.session.promptAsync
      .mockRejectedValueOnce(new Error("response lost"))
      .mockResolvedValue({ data: undefined });
    client.session.abort.mockRejectedValueOnce(new Error("abort unavailable"));
    const tools = protocol(client, new MemoryRunStore(), () => timestamp);
    const started = output(
      await tools.cross_review_start.execute(
        { target: "HEAD", reviewModels: ["a/one"], agents: 1 },
        context(),
      ),
    );
    expect(started.reviewers[0]).toMatchObject({
      status: "starting",
      error: expect.stringContaining("response lost"),
    });
    timestamp += 15_001;

    await tools.cross_review_status.execute({ runID: RUN_ID }, context());

    expect(client.session.promptAsync).toHaveBeenCalledTimes(2);
    const first =
      client.session.promptAsync.mock.calls.at(0)?.[0].body.messageID;
    const second =
      client.session.promptAsync.mock.calls.at(1)?.[0].body.messageID;
    expect(first).toBeDefined();
    expect(second).toBe(first);
  });

  it("migrates legacy message IDs before reviewer redispatch", async () => {
    let timestamp = 1_000;
    const { client } = mockClient();
    const store = new MemoryRunStore();
    const tools = protocol(client, store, () => timestamp);
    await tools.cross_review_start.execute(
      { target: "HEAD", reviewModels: ["a/one"], agents: 1 },
      context(),
    );

    const run = store.runs.get(RUN_ID);
    if (run === undefined) throw new Error("test run was not created");
    const reviewer = run.reviewers[0];
    if (reviewer === undefined)
      throw new Error("test reviewer was not created");
    reviewer.messageID = "00000000-0000-4000-8000-000000000002";
    timestamp += 15_001;

    await tools.cross_review_status.execute({ runID: RUN_ID }, context());

    expect(
      client.session.promptAsync.mock.calls.at(-1)?.[0].body.messageID,
    ).toBe("msg_00000000-0000-4000-8000-000000000002");
    expect(store.runs.get(RUN_ID)?.reviewers[0]?.messageID).toBe(
      "msg_00000000-0000-4000-8000-000000000002",
    );
  });

  it("times out an ambiguous dispatch instead of retrying forever", async () => {
    let timestamp = 1_000;
    const { client } = mockClient();
    client.session.promptAsync
      .mockRejectedValueOnce(new Error("response lost"))
      .mockResolvedValue({ data: undefined });
    client.session.abort.mockRejectedValueOnce(new Error("abort unavailable"));
    const tools = protocol(client, new MemoryRunStore(), () => timestamp);
    await tools.cross_review_start.execute(
      {
        target: "HEAD",
        reviewModels: ["a/one"],
        agents: 1,
        reviewerTimeoutMs: 30_000,
      },
      context(),
    );
    // Redispatch within the grace window, then advance well past the original
    // deadline. The reviewer must time out rather than keep re-dispatching with
    // a fresh deadline each poll.
    timestamp += 15_001;
    await tools.cross_review_status.execute({ runID: RUN_ID }, context());
    const callsAfterRedispatch = client.session.promptAsync.mock.calls.length;
    expect(callsAfterRedispatch).toBe(2);
    timestamp += 100_000;
    await tools.cross_review_status.execute({ runID: RUN_ID }, context());
    const callsAfterDeadline = client.session.promptAsync.mock.calls.length;

    const status = output(
      await tools.cross_review_status.execute({ runID: RUN_ID }, context()),
    );
    expect(status.reviewers[0]).toMatchObject({
      status: "timed_out",
      error: expect.stringContaining("timed out"),
    });
    expect(callsAfterDeadline).toBe(callsAfterRedispatch);
  });

  it("collects a completed busy reviewer before timing it out", async () => {
    let timestamp = 1_000;
    const { client, statuses, messages } = mockClient();
    const tools = protocol(client, new MemoryRunStore(), () => timestamp);
    await tools.cross_review_start.execute(
      {
        target: "HEAD",
        reviewModels: ["a/one"],
        agents: 1,
        reviewerTimeoutMs: 5_000,
      },
      context(),
    );
    statuses["child-1"] = { type: "busy" };
    messages.set("child-1", completed("output ready at deadline"));
    timestamp = 6_001;

    const status = output(
      await tools.cross_review_status.execute(
        { runID: RUN_ID, includeOutputs: true },
        context(),
      ),
    );

    expect(status.reviewers[0]).toMatchObject({
      status: "succeeded",
      output: "output ready at deadline",
    });
    expect(client.session.abort).not.toHaveBeenCalled();
  });

  it("finalizes terminal reviewers even when the status API fails", async () => {
    const { client, messages } = mockClient();
    client.session.status.mockRejectedValue(new Error("status unavailable"));
    const tools = protocol(client, new MemoryRunStore());
    await tools.cross_review_start.execute(
      { target: "HEAD", reviewModels: ["a/one"], agents: 1 },
      context(),
    );
    messages.set("child-1", completed("candidate despite status failure"));

    const finalized = output(
      await tools.cross_review_finalize.execute({ runID: RUN_ID }, context()),
    );

    expect(finalized).toMatchObject({
      phase: "completed",
      reviewers: [
        { status: "succeeded", output: "candidate despite status failure" },
      ],
    });
    expect(finalized.pollAfterMs).toBeUndefined();
  });

  it("isolates child message lookup failures from other reviewer progress", async () => {
    const { client, messages } = mockClient();
    const tools = protocol(client, new MemoryRunStore());
    await tools.cross_review_start.execute(
      {
        target: "HEAD",
        reviewModels: ["a/one"],
        agents: 2,
        maxConcurrency: 2,
      },
      context(),
    );
    messages.set("child-2", completed("candidate"));
    client.session.messages.mockImplementation(async (input) =>
      input.path.id === "child-1"
        ? { error: { name: "NotFoundError" } }
        : { data: messages.get(input.path.id) ?? [] },
    );

    const status = output(
      await tools.cross_review_status.execute({ runID: RUN_ID }, context()),
    );

    expect(status.reviewers[0]).toMatchObject({
      status: "starting",
      error: expect.stringContaining("status unavailable"),
    });
    expect(status.reviewers[1].status).toBe("succeeded");
  });

  it("resumes a persisted run through a fresh protocol instance", async () => {
    const { client, messages } = mockClient();
    const store = new MemoryRunStore();
    await protocol(client, store).cross_review_start.execute(
      { target: "HEAD", reviewModels: ["a/one"], agents: 1 },
      context(),
    );
    messages.set("child-1", completed("resumed review"));

    const resumed = protocol(client, store);
    const status = output(
      await resumed.cross_review_status.execute(
        { runID: RUN_ID, includeOutputs: true },
        context(),
      ),
    );

    expect(status.reviewers[0]).toMatchObject({
      status: "succeeded",
      output: "resumed review",
    });
  });

  it("serializes concurrent polling without double-dispatching queued work", async () => {
    const { client, statuses, messages } = mockClient();
    const root = await mkdtemp(join(tmpdir(), "cross-review-protocol-"));
    const store = new FileCrossReviewRunStore(root, () => 1_000);
    const first = protocol(client, store);
    const second = protocol(client, store);
    await first.cross_review_start.execute(
      {
        target: "HEAD",
        reviewModels: ["a/one"],
        agents: 3,
        maxConcurrency: 2,
      },
      context(),
    );
    statuses["child-2"] = { type: "busy" };
    messages.set("child-1", completed("candidate"));

    await Promise.all([
      first.cross_review_status.execute({ runID: RUN_ID }, context()),
      second.cross_review_status.execute({ runID: RUN_ID }, context()),
    ]);

    expect(client.session.promptAsync).toHaveBeenCalledTimes(3);
    expect(
      client.session.promptAsync.mock.calls.filter(
        ([input]) => input.path.id === "child-3",
      ),
    ).toHaveLength(1);
  });

  it("cancels only an owned run and remains idempotent", async () => {
    const { client } = mockClient();
    const store = new MemoryRunStore();
    const tools = protocol(client, store);
    await tools.cross_review_start.execute(
      {
        target: "HEAD",
        reviewModels: ["a/one"],
        agents: 2,
        maxConcurrency: 1,
      },
      context(),
    );

    await expect(
      tools.cross_review_cancel.execute({ runID: RUN_ID }, context("other")),
    ).rejects.toThrow("not owned by this session");
    const first = output(
      await tools.cross_review_cancel.execute({ runID: RUN_ID }, context()),
    );
    const second = output(
      await tools.cross_review_cancel.execute({ runID: RUN_ID }, context()),
    );

    expect(first.phase).toBe("cancelled");
    expect(first.reviewers.map((reviewer: any) => reviewer.status)).toEqual([
      "cancelled",
      "cancelled",
    ]);
    expect(second).toEqual(first);
    expect(client.session.abort).toHaveBeenCalledTimes(1);
  });

  it("reports cancellation with a warning when child abort is unconfirmed", async () => {
    const { client } = mockClient();
    client.session.abort.mockResolvedValueOnce({ data: false });
    const tools = protocol(client, new MemoryRunStore());
    await tools.cross_review_start.execute(
      { target: "HEAD", reviewModels: ["a/one"], agents: 1 },
      context(),
    );

    const cancelled = output(
      await tools.cross_review_cancel.execute({ runID: RUN_ID }, context()),
    );
    expect(cancelled.phase).toBe("cancelled");
    expect(cancelled.reviewers[0]).toMatchObject({
      status: "cancelled",
      error: expect.stringContaining("abort unconfirmed"),
    });
  });

  it("finalizes successful reviewers for parent-session judging", async () => {
    const { client, messages } = mockClient();
    const tools = protocol(client, new MemoryRunStore());
    await tools.cross_review_start.execute(
      { target: "HEAD", reviewModels: ["a/one"], agents: 1 },
      context(),
    );
    messages.set("child-1", completed("candidate"));

    const finalized = output(
      await tools.cross_review_finalize.execute({ runID: RUN_ID }, context()),
    );

    expect(finalized).toMatchObject({
      phase: "completed",
      judge: {
        model: "parent-session",
        status: "pending-parent-consolidation",
      },
      reviewers: [{ status: "succeeded", output: "candidate" }],
    });
  });

  it("runs an explicit judge in a second asynchronous phase exactly once", async () => {
    const { client, messages } = mockClient();
    const tools = protocol(client, new MemoryRunStore());
    await tools.cross_review_start.execute(
      {
        target: "HEAD",
        reviewModels: ["a/one"],
        agents: 1,
        judgeModel: "b/judge",
      },
      context(),
    );
    messages.set("child-1", completed("candidate"));

    const judging = output(
      await tools.cross_review_finalize.execute({ runID: RUN_ID }, context()),
    );
    expect(judging).toMatchObject({
      phase: "judging",
      judge: { model: "b/judge", sessionID: "child-2", status: "starting" },
    });
    expect(client.session.create).toHaveBeenCalledTimes(2);
    expect(client.session.promptAsync).toHaveBeenCalledTimes(2);
    expect(
      client.session.promptAsync.mock.calls.every(([input]) =>
        /^msg_[0-9a-f-]+$/.test(input.body.messageID),
      ),
    ).toBe(true);
    messages.set("child-2", completed("verified finding"));

    const finalized = output(
      await tools.cross_review_finalize.execute({ runID: RUN_ID }, context()),
    );
    const repeated = output(
      await tools.cross_review_finalize.execute({ runID: RUN_ID }, context()),
    );

    expect(finalized).toMatchObject({
      phase: "completed",
      judge: { status: "succeeded", output: "verified finding" },
    });
    expect(repeated).toEqual(finalized);
    expect(client.session.create).toHaveBeenCalledTimes(2);
    expect(client.session.promptAsync).toHaveBeenCalledTimes(2);
  });

  it("migrates legacy message IDs before judge dispatch", async () => {
    const { client, messages } = mockClient();
    const store = new MemoryRunStore();
    const tools = protocol(client, store);
    await tools.cross_review_start.execute(
      {
        target: "HEAD",
        reviewModels: ["a/one"],
        agents: 1,
        judgeModel: "b/judge",
      },
      context(),
    );
    const run = store.runs.get(RUN_ID);
    if (run === undefined || run.judge === undefined)
      throw new Error("test judge run was not created");
    run.judge.messageID = "00000000-0000-4000-8000-000000000003";
    messages.set("child-1", completed("candidate"));

    await tools.cross_review_finalize.execute({ runID: RUN_ID }, context());

    expect(
      client.session.promptAsync.mock.calls.at(-1)?.[0].body.messageID,
    ).toBe("msg_00000000-0000-4000-8000-000000000003");
    expect(store.runs.get(RUN_ID)?.judge?.messageID).toBe(
      "msg_00000000-0000-4000-8000-000000000003",
    );
  });

  it("preserves async prompt validation errors", async () => {
    const { client } = mockClient();
    client.session.promptAsync.mockResolvedValueOnce({
      error: {
        name: "BadRequestError",
        data: { message: "Invalid message ID" },
      },
    });
    const tools = protocol(client, new MemoryRunStore());

    const started = output(
      await tools.cross_review_start.execute(
        { target: "HEAD", reviewModels: ["a/one"], agents: 1 },
        context(),
      ),
    );

    expect(started.reviewers[0]).toMatchObject({
      status: "failed",
      error: "Reviewer 1 prompt failed: BadRequestError: Invalid message ID",
    });
  });

  it("reports quorum failure after all reviewers become terminal", async () => {
    const { client, messages } = mockClient();
    const tools = protocol(client, new MemoryRunStore());
    await tools.cross_review_start.execute(
      {
        target: "HEAD",
        reviewModels: ["a/one"],
        agents: 3,
        maxConcurrency: 3,
      },
      context(),
    );
    messages.set("child-1", completed("candidate"));
    messages.set("child-2", failed("APIError", "unavailable"));
    messages.set("child-3", failed("ProviderAuthError", "denied"));

    const finalized = output(
      await tools.cross_review_finalize.execute({ runID: RUN_ID }, context()),
    );

    expect(finalized).toMatchObject({
      phase: "quorum-not-met",
      status: "quorum-not-met",
      quorum: 2,
    });
    expect(finalized.reviewers.map((reviewer: any) => reviewer.status)).toEqual(
      ["succeeded", "failed", "failed"],
    );
  });
});
