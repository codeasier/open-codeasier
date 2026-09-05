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

function globalFallbackConfig(): Promise<LoadedCrossReviewConfig> {
  return Promise.resolve({
    config: {},
    sources: { project: "absent", global: "loaded" },
    projectPath: "/repo/.opencode/cross-review.json",
    globalPath: "/home/.config/opencode/cross-review.json",
  });
}

const PROJECT_CONFIG_BLOCK = {
  sources: { project: "loaded", global: "absent" },
  projectConfigPath: "/repo/.opencode/cross-review.json",
  globalConfigPath: "/home/.config/opencode/cross-review.json",
};

const GLOBAL_FALLBACK_WARNING =
  "warning: project config not found at /repo/.opencode/cross-review.json; using global config at /home/.config/opencode/cross-review.json";

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
    id?: string;
    parentID?: string;
    role: "user" | "assistant";
    time: { created: number; completed?: number };
    error?: unknown;
    finish?: string;
  };
  parts: Array<{ type: string; text?: string }>;
};

function userMessage(id: string, created = 1): TestMessage {
  return {
    info: { id, role: "user", time: { created } },
    parts: [],
  };
}

function assistantMessage(
  parentID: string,
  text: string,
  created = 10,
): TestMessage {
  return {
    info: {
      parentID,
      role: "assistant",
      time: { created, completed: created + 1 },
      finish: "stop",
    },
    parts: [{ type: "text", text }],
  };
}

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
      get: vi.fn().mockImplementation(async (input) => ({
        data: { id: input.path.id },
      })),
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
  loadConfig: () => Promise<LoadedCrossReviewConfig> = loadedConfig,
  defaultWaitMs = 0,
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>,
) {
  return createCrossReviewProtocolTools(client, {
    store,
    loadConfig,
    now,
    createRunID: () => RUN_ID,
    canonicalize: async (directory) => directory,
    defaultWaitMs,
    ...(sleep !== undefined ? { sleep } : {}),
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
            cross_review: false,
            cross_review_start: false,
            cross_review_status: false,
            cross_review_cancel: false,
            cross_review_finalize: false,
            session_review: false,
          }),
        }),
      }),
    );
  });

  it("rejects out-of-range overrides without creating sessions or a run", async () => {
    const { client } = mockClient();
    const store = new MemoryRunStore();
    const tools = protocol(client, store);
    await expect(
      tools.cross_review_start.execute(
        { target: "HEAD", reviewModels: ["a/one"], agents: 9 },
        context(),
      ),
    ).rejects.toThrow("`agents` must be an integer from 1 to 8");
    await expect(
      tools.cross_review_start.execute(
        { target: "HEAD", reviewModels: ["a/one"], maxConcurrency: 9 },
        context(),
      ),
    ).rejects.toThrow("`maxConcurrency` must be an integer from 1 to 8");
    await expect(
      tools.cross_review_start.execute(
        { target: "HEAD", reviewModels: ["a/one"], reviewerTimeoutMs: 1 },
        context(),
      ),
    ).rejects.toThrow(
      "`reviewerTimeoutMs` must be an integer from 5000 to 3600000",
    );
    await expect(
      tools.cross_review_start.execute(
        { target: "HEAD", reviewModels: ["malformed"] },
        context(),
      ),
    ).rejects.toThrow(
      "`reviewModels` must be 1-8 `provider/model` identifiers",
    );
    expect(client.session.create).not.toHaveBeenCalled();
    expect(client.provider.list).not.toHaveBeenCalled();
    expect(store.runs.size).toBe(0);
  });

  it("treats host type-default overrides as absent and uses project config", async () => {
    const { client } = mockClient();
    const store = new MemoryRunStore();
    const tools = protocol(
      client,
      store,
      () => 1_000,
      () =>
        Promise.resolve({
          config: {
            reviewers: [{ model: "a/one" }, { model: "a/two" }],
            agents: 3,
            maxConcurrency: 2,
            judgeModel: "b/judge",
            focus: "from-config",
            reviewerTimeoutMs: 900_000,
          },
          sources: { project: "loaded", global: "absent" },
          projectPath: "/repo/.opencode/cross-review.json",
          globalPath: "/home/.config/opencode/cross-review.json",
        }),
    );

    const started = output(
      await tools.cross_review_start.execute(
        {
          target: "PR #72",
          context: "already gathered",
          reviewModels: [],
          agents: 0,
          maxConcurrency: 0,
          reviewerTimeoutMs: 0,
          focus: "",
          judgeModel: "",
        },
        context(),
      ),
    );

    expect(started.config).toEqual(PROJECT_CONFIG_BLOCK);
    expect(started.reviewers.map((reviewer: any) => reviewer.model)).toEqual([
      "a/one",
      "a/two",
    ]);
    expect(started.reviewers.map((reviewer: any) => reviewer.focus)).toEqual([
      "",
      "",
    ]);
    expect(started.judge).toBeUndefined();
    const run = store.runs.get(RUN_ID);
    expect(run?.maxConcurrency).toBe(2);
    expect(run?.reviewerTimeoutMs).toBe(900_000);
    expect(run?.judgeModel).toBeUndefined();
    expect(run?.brief).toContain("Focus: \n");
    expect(client.session.create).toHaveBeenCalledTimes(2);
  });

  it("falls back to config when only empty reviewModels is supplied", async () => {
    const { client } = mockClient();
    const store = new MemoryRunStore();
    const tools = protocol(client, store);
    await expect(
      tools.cross_review_start.execute(
        { target: "HEAD", reviewModels: [] },
        context(),
      ),
    ).rejects.toThrow("No review models configured");
    expect(store.runs.size).toBe(0);
  });

  it("surfaces config resolution on start without a fallback warning", async () => {
    const { client } = mockClient();
    const started = await protocol(
      client,
      new MemoryRunStore(),
    ).cross_review_start.execute(
      { target: "HEAD", reviewModels: ["a/one"], agents: 1 },
      context(),
    );

    expect(output(started)).toMatchObject({
      config: PROJECT_CONFIG_BLOCK,
    });
    expect(output(started)).not.toHaveProperty("warning");
    expect(
      (started as { metadata: Record<string, unknown> }).metadata,
    ).toMatchObject({
      runID: RUN_ID,
      phase: "reviewing",
      configSources: PROJECT_CONFIG_BLOCK.sources,
      projectConfigPath: PROJECT_CONFIG_BLOCK.projectConfigPath,
      globalConfigPath: PROJECT_CONFIG_BLOCK.globalConfigPath,
    });
  });

  it("echoes the config fallback warning on start and detailed status only", async () => {
    const { client } = mockClient();
    const tools = protocol(
      client,
      new MemoryRunStore(),
      () => 1_000,
      globalFallbackConfig,
    );

    const started = output(
      await tools.cross_review_start.execute(
        { target: "HEAD", reviewModels: ["a/one"], agents: 1 },
        context(),
      ),
    );
    expect(started.config).toEqual({
      sources: { project: "absent", global: "loaded" },
      projectConfigPath: "/repo/.opencode/cross-review.json",
      globalConfigPath: "/home/.config/opencode/cross-review.json",
    });
    expect(started.warning).toBe(GLOBAL_FALLBACK_WARNING);

    const compactResult = await tools.cross_review_status.execute(
      { runID: RUN_ID },
      context(),
    );
    const compact = output(compactResult);
    expect(compact).not.toHaveProperty("config");
    expect(compact).not.toHaveProperty("warning");
    expect(
      (compactResult as { metadata: Record<string, unknown> }).metadata,
    ).toEqual({
      runID: RUN_ID,
      phase: "reviewing",
    });

    const detailed = output(
      await tools.cross_review_status.execute(
        { runID: RUN_ID, detail: true },
        context(),
      ),
    );
    expect(detailed.config).toEqual(started.config);
    expect(detailed.warning).toBe(GLOBAL_FALLBACK_WARNING);
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
    expect(status).not.toHaveProperty("reviewers");
    expect(status).not.toHaveProperty("target");
    expect(status).not.toHaveProperty("config");
    expect(status).not.toHaveProperty("warning");
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

    const detailed = output(
      await tools.cross_review_status.execute(
        { runID: RUN_ID, detail: true },
        context(),
      ),
    );
    expect(detailed.reviewers[0]).not.toHaveProperty("output");
    expect(detailed.target).toBe("HEAD");
    expect(detailed.config).toEqual(PROJECT_CONFIG_BLOCK);

    const withOutput = output(
      await tools.cross_review_status.execute(
        { runID: RUN_ID, includeOutputs: true },
        context(),
      ),
    );
    expect(withOutput.reviewers[0].output).toBe("first review");
  });

  it("returns longer poll intervals once every reviewer is running", async () => {
    const { client, statuses } = mockClient();
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
    statuses["child-1"] = { type: "busy" };
    statuses["child-2"] = { type: "busy" };

    const status = output(
      await tools.cross_review_status.execute({ runID: RUN_ID }, context()),
    );
    expect(status.counts).toEqual({ running: 2 });
    expect(status.pollAfterMs).toBe(10_000);
  });

  it("truncates the target in the compact status summary", async () => {
    const longTarget = `fix: ${"y".repeat(200)}`;
    const { client } = mockClient();
    const tools = protocol(client, new MemoryRunStore());
    await tools.cross_review_start.execute(
      { target: longTarget, reviewModels: ["a/one"], agents: 1 },
      context(),
    );

    const status = output(
      await tools.cross_review_status.execute({ runID: RUN_ID }, context()),
    );
    expect(status.summary).toContain("fix: ");
    expect(status.summary).toContain("...");
    expect(status.summary).not.toContain("y".repeat(200));
    expect((status.summary.match(/y/g) ?? []).length).toBeLessThan(80);

    const detailed = output(
      await tools.cross_review_status.execute(
        { runID: RUN_ID, detail: true },
        context(),
      ),
    );
    expect(detailed.target).toBe(longTarget);
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
      await tools.cross_review_status.execute(
        { runID: RUN_ID, detail: true },
        context(),
      ),
    );

    expect(status.reviewers[0]).toMatchObject({
      status: "retrying",
      retry: { attempt: 2, message: "rate limited", next: 9_000 },
    });
    expect(status.reviewers[1].status).toBe("queued");
    expect(client.session.promptAsync).toHaveBeenCalledTimes(1);
  });

  it("pauses an overdue reviewer for a timeout decision", async () => {
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
      await tools.cross_review_status.execute(
        { runID: RUN_ID, detail: true },
        context(),
      ),
    );

    expect(status.reviewers.map((reviewer: any) => reviewer.status)).toEqual([
      "timeout_pending",
      "queued",
    ]);
    expect(status.actionRequired).toMatchObject({
      type: "timeout",
      sessions: [
        {
          role: "reviewer",
          reviewer: 1,
          model: "a/one",
          sessionID: "child-1",
        },
      ],
      options: ["preserve", "abort"],
    });
    expect(status.pollAfterMs).toBeUndefined();
    expect(status.summary).toContain("timeout decision required");
    expect(client.session.abort).not.toHaveBeenCalled();
    expect(client.session.promptAsync).toHaveBeenCalledTimes(1);
  });

  it("preserves an overdue reviewer and later collects its output", async () => {
    let timestamp = 1_000;
    const { client, statuses, messages } = mockClient();
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
    statuses["child-1"] = { type: "busy" };
    timestamp = 6_001;

    await tools.cross_review_status.execute({ runID: RUN_ID }, context());
    const preserved = output(
      await tools.cross_review_status.execute(
        { runID: RUN_ID, detail: true, timeoutAction: "preserve" },
        context(),
      ),
    );

    expect(preserved.reviewers[0]).toMatchObject({
      status: "running",
      timeoutDetectedAt: 6_001,
      timeoutExtensions: 1,
      deadlineAt: 11_001,
    });
    expect(preserved.reviewers[1].status).toBe("queued");
    expect(preserved).not.toHaveProperty("actionRequired");
    expect(client.session.abort).not.toHaveBeenCalled();

    delete statuses["child-1"];
    messages.set("child-1", completed("late but useful review"));
    timestamp = 7_000;
    const completedStatus = output(
      await tools.cross_review_status.execute(
        { runID: RUN_ID, includeOutputs: true },
        context(),
      ),
    );
    expect(completedStatus.reviewers[0]).toMatchObject({
      status: "succeeded",
      output: "late but useful review",
      timeoutExtensions: 1,
    });
    expect(completedStatus.reviewers[1].status).toBe("starting");
    expect(client.session.promptAsync).toHaveBeenCalledTimes(2);
  });

  it("aborts an overdue reviewer and advances queued work on request", async () => {
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
      await tools.cross_review_status.execute(
        { runID: RUN_ID, detail: true, timeoutAction: "abort" },
        context(),
      ),
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

  it("aborts a preserved reviewer early within its extension", async () => {
    let timestamp = 1_000;
    const { client, statuses } = mockClient();
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
    statuses["child-1"] = { type: "busy" };
    timestamp = 6_001;

    await tools.cross_review_status.execute({ runID: RUN_ID }, context());
    const preserved = output(
      await tools.cross_review_status.execute(
        { runID: RUN_ID, detail: true, timeoutAction: "preserve" },
        context(),
      ),
    );
    expect(preserved.reviewers[0].status).toBe("running");

    // Still within the extended deadline (11_001): an explicit abort must
    // terminate the session instead of being silently ignored.
    timestamp = 7_000;
    const aborted = output(
      await tools.cross_review_status.execute(
        { runID: RUN_ID, detail: true, timeoutAction: "abort" },
        context(),
      ),
    );

    expect(aborted.reviewers.map((reviewer: any) => reviewer.status)).toEqual([
      "timed_out",
      "starting",
    ]);
    expect(client.session.abort).toHaveBeenCalledWith(
      expect.objectContaining({ path: { id: "child-1" } }),
    );
    expect(client.session.promptAsync).toHaveBeenCalledTimes(2);
  });

  it("redispatches an ambiguous preserved reviewer instead of idling", async () => {
    let timestamp = 1_000;
    const { client } = mockClient();
    const tools = protocol(client, new MemoryRunStore(), () => timestamp);
    await tools.cross_review_start.execute(
      {
        target: "HEAD",
        reviewModels: ["a/one"],
        agents: 1,
        reviewerTimeoutMs: 20_000,
      },
      context(),
    );
    timestamp = 22_000;

    await tools.cross_review_status.execute({ runID: RUN_ID }, context());
    await tools.cross_review_status.execute(
      { runID: RUN_ID, timeoutAction: "preserve" },
      context(),
    );
    expect(client.session.promptAsync).toHaveBeenCalledTimes(1);

    // The preserved session still shows no message: re-queue the same
    // message ID instead of idling until the extended deadline.
    timestamp = 23_000;
    await tools.cross_review_status.execute({ runID: RUN_ID }, context());

    expect(client.session.promptAsync).toHaveBeenCalledTimes(2);
    const first =
      client.session.promptAsync.mock.calls.at(0)?.[0].body.messageID;
    const second =
      client.session.promptAsync.mock.calls.at(1)?.[0].body.messageID;
    expect(first).toBeDefined();
    expect(second).toBe(first);
  });

  it("does not leave a transient fetch error on a preserved reviewer", async () => {
    let timestamp = 1_000;
    const { client, statuses } = mockClient();
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
    client.session.messages.mockRejectedValueOnce(new Error("network down"));
    timestamp = 6_001;

    const preserved = output(
      await tools.cross_review_status.execute(
        { runID: RUN_ID, detail: true, timeoutAction: "preserve" },
        context(),
      ),
    );

    expect(preserved.reviewers[0]).toMatchObject({
      status: "running",
      timeoutExtensions: 1,
    });
    expect(preserved.reviewers[0].error).toBeUndefined();
    expect(preserved.summary).not.toContain("status unavailable");
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
      await tools.cross_review_status.execute(
        { runID: RUN_ID, detail: true, timeoutAction: "abort" },
        context(),
      ),
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
      await tools.cross_review_status.execute(
        { runID: RUN_ID, detail: true, timeoutAction: "abort" },
        context(),
      ),
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
      await tools.cross_review_status.execute(
        { runID: RUN_ID, detail: true },
        context(),
      ),
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

  it("includes the config warning when an explicit judge fails", async () => {
    const { client, messages } = mockClient();
    const tools = protocol(
      client,
      new MemoryRunStore(),
      () => 1_000,
      globalFallbackConfig,
    );
    await tools.cross_review_start.execute(
      {
        target: "HEAD",
        context: "already gathered",
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
    expect(judging.phase).toBe("judging");
    messages.set("child-2", failed("APIError", "judge unavailable"));

    const finalized = output(
      await tools.cross_review_finalize.execute({ runID: RUN_ID }, context()),
    );

    expect(finalized).toMatchObject({
      phase: "failed",
      status: "judge-failed",
      warning: GLOBAL_FALLBACK_WARNING,
    });
  });

  it("gathers context through the judge session before dispatching reviewers", async () => {
    const { client, messages } = mockClient();
    const tools = protocol(client, new MemoryRunStore());
    const started = output(
      await tools.cross_review_start.execute(
        {
          target: "HEAD",
          reviewModels: ["a/one"],
          agents: 1,
          judgeModel: "b/judge",
        },
        context(),
      ),
    );

    expect(started.phase).toBe("gathering");
    expect(started.gatherer).toMatchObject({
      model: "b/judge",
      sessionID: "child-2",
      status: "starting",
    });
    expect(started.reviewers[0].status).toBe("queued");
    expect(client.session.create).toHaveBeenCalledTimes(2);
    expect(client.session.promptAsync).toHaveBeenCalledTimes(1);
    expect(client.session.promptAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        path: { id: "child-2" },
        body: expect.objectContaining({
          model: { providerID: "b", modelID: "judge" },
        }),
      }),
    );
    expect(
      client.session.promptAsync.mock.calls.at(0)?.[0].body.parts[0].text,
    ).toContain("context gatherer");

    messages.set("child-2", completed("gathered diff"));
    const status = output(
      await tools.cross_review_status.execute(
        { runID: RUN_ID, includeOutputs: true },
        context(),
      ),
    );

    expect(status.phase).toBe("reviewing");
    expect(status.gatherer).toMatchObject({
      status: "succeeded",
      output: "gathered diff",
    });
    expect(status.reviewers[0].status).toBe("starting");
    const reviewerText =
      client.session.promptAsync.mock.calls.at(-1)?.[0].body.parts[0].text;
    expect(reviewerText).toContain("gathered diff");

    messages.set("child-1", completed("candidate"));
    const judging = output(
      await tools.cross_review_finalize.execute({ runID: RUN_ID }, context()),
    );
    expect(judging.phase).toBe("judging");
    expect(client.session.promptAsync.mock.calls.at(-1)?.[0].path.id).toBe(
      "child-2",
    );
    const judgeText =
      client.session.promptAsync.mock.calls.at(-1)?.[0].body.parts[0].text;
    expect(judgeText).toContain("Act as the read-only cross-review judge");
    expect(judgeText).not.toContain("gathered diff");
  });

  it("accepts parent-gathered context and skips the gathering phase", async () => {
    const { client, messages } = mockClient();
    const tools = protocol(client, new MemoryRunStore());
    const started = output(
      await tools.cross_review_start.execute(
        {
          target: "HEAD",
          context: "parent context",
          reviewModels: ["a/one"],
          agents: 1,
          judgeModel: "b/judge",
        },
        context(),
      ),
    );

    expect(started.phase).toBe("reviewing");
    expect(started.gatherer).toBeUndefined();
    expect(client.session.promptAsync).toHaveBeenCalledTimes(1);
    expect(
      client.session.promptAsync.mock.calls.at(0)?.[0].body.parts[0].text,
    ).toContain("parent context");

    messages.set("child-1", completed("candidate"));
    const judging = output(
      await tools.cross_review_finalize.execute({ runID: RUN_ID }, context()),
    );
    expect(judging.phase).toBe("judging");
    const judgeText =
      client.session.promptAsync.mock.calls.at(-1)?.[0].body.parts[0].text;
    expect(judgeText).toContain("parent context");
  });

  it("degrades to independent fetching when gathering fails", async () => {
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
    messages.set("child-2", failed("APIError", "gather unavailable"));

    const status = output(
      await tools.cross_review_status.execute(
        { runID: RUN_ID, includeOutputs: true },
        context(),
      ),
    );

    expect(status.phase).toBe("reviewing");
    expect(status.gatherer).toMatchObject({ status: "failed" });
    expect(status.reviewers[0].status).toBe("starting");
    const reviewerText =
      client.session.promptAsync.mock.calls.at(-1)?.[0].body.parts[0].text;
    expect(reviewerText).not.toContain("gather unavailable");

    messages.set("child-1", completed("candidate"));
    const judging = output(
      await tools.cross_review_finalize.execute({ runID: RUN_ID }, context()),
    );
    expect(judging.phase).toBe("judging");
  });

  it("times out a stuck gatherer and degrades to reviewing", async () => {
    let timestamp = 1_000;
    const { client } = mockClient();
    const tools = protocol(client, new MemoryRunStore(), () => timestamp);
    await tools.cross_review_start.execute(
      {
        target: "HEAD",
        reviewModels: ["a/one"],
        agents: 1,
        judgeModel: "b/judge",
        reviewerTimeoutMs: 5_000,
      },
      context(),
    );
    timestamp = 6_001;

    const status = output(
      await tools.cross_review_status.execute(
        { runID: RUN_ID, detail: true, timeoutAction: "abort" },
        context(),
      ),
    );

    expect(status.phase).toBe("reviewing");
    expect(status.gatherer).toMatchObject({
      status: "timed_out",
      error: expect.stringContaining("timed out"),
    });
    expect(status.reviewers[0].status).toBe("starting");
    expect(client.session.abort).toHaveBeenCalledWith(
      expect.objectContaining({ path: { id: "child-2" } }),
    );
  });

  it("preserves an overdue gatherer and uses its eventual context", async () => {
    let timestamp = 1_000;
    const { client, statuses, messages } = mockClient();
    const tools = protocol(client, new MemoryRunStore(), () => timestamp);
    await tools.cross_review_start.execute(
      {
        target: "HEAD",
        reviewModels: ["a/one"],
        agents: 1,
        judgeModel: "b/judge",
        reviewerTimeoutMs: 5_000,
      },
      context(),
    );
    statuses["child-2"] = { type: "busy" };
    timestamp = 6_001;

    const pending = output(
      await tools.cross_review_status.execute(
        { runID: RUN_ID, detail: true },
        context(),
      ),
    );
    expect(pending.phase).toBe("gathering");
    expect(pending.gatherer.status).toBe("timeout_pending");
    expect(pending.actionRequired.sessions).toEqual([
      { role: "gatherer", model: "b/judge", sessionID: "child-2" },
    ]);
    expect(client.session.abort).not.toHaveBeenCalled();

    const preserved = output(
      await tools.cross_review_status.execute(
        { runID: RUN_ID, detail: true, timeoutAction: "preserve" },
        context(),
      ),
    );
    expect(preserved.gatherer).toMatchObject({
      status: "running",
      timeoutExtensions: 1,
      deadlineAt: 11_001,
    });

    delete statuses["child-2"];
    messages.set("child-2", completed("late gathered context"));
    timestamp = 7_000;
    const reviewing = output(
      await tools.cross_review_status.execute(
        { runID: RUN_ID, includeOutputs: true },
        context(),
      ),
    );
    expect(reviewing.phase).toBe("reviewing");
    expect(reviewing.gatherer).toMatchObject({
      status: "succeeded",
      output: "late gathered context",
    });
    expect(
      client.session.promptAsync.mock.calls.at(-1)?.[0].body.parts[0].text,
    ).toContain("late gathered context");
  });

  it("aborts a preserved gatherer early and degrades to reviewing", async () => {
    let timestamp = 1_000;
    const { client, statuses } = mockClient();
    const tools = protocol(client, new MemoryRunStore(), () => timestamp);
    await tools.cross_review_start.execute(
      {
        target: "HEAD",
        reviewModels: ["a/one"],
        agents: 1,
        judgeModel: "b/judge",
        reviewerTimeoutMs: 5_000,
      },
      context(),
    );
    statuses["child-2"] = { type: "busy" };
    timestamp = 6_001;

    await tools.cross_review_status.execute({ runID: RUN_ID }, context());
    await tools.cross_review_status.execute(
      { runID: RUN_ID, timeoutAction: "preserve" },
      context(),
    );

    // Still within the extended deadline (11_001): abort the preserved
    // gatherer instead of waiting for the new deadline.
    timestamp = 7_000;
    const aborted = output(
      await tools.cross_review_status.execute(
        { runID: RUN_ID, detail: true, timeoutAction: "abort" },
        context(),
      ),
    );

    expect(aborted.phase).toBe("reviewing");
    expect(aborted.gatherer).toMatchObject({ status: "timed_out" });
    expect(aborted.reviewers[0].status).toBe("starting");
    expect(client.session.abort).toHaveBeenCalledWith(
      expect.objectContaining({ path: { id: "child-2" } }),
    );
  });

  it("degrades to reviewing when gatherer dispatch fails", async () => {
    const { client } = mockClient();
    client.session.promptAsync.mockRejectedValueOnce(
      new Error("gather dispatch lost"),
    );
    const tools = protocol(client, new MemoryRunStore());

    const started = output(
      await tools.cross_review_start.execute(
        {
          target: "HEAD",
          reviewModels: ["a/one"],
          agents: 1,
          judgeModel: "b/judge",
        },
        context(),
      ),
    );

    expect(started.phase).toBe("reviewing");
    expect(started.gatherer).toMatchObject({
      status: "failed",
      error: "gather dispatch lost",
    });
    expect(started.reviewers[0].status).toBe("starting");
    expect(client.session.promptAsync).toHaveBeenCalledTimes(2);
  });

  it("does not cancel a terminal gatherer", async () => {
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
    messages.set("child-2", completed("gathered context"));

    const progressed = output(
      await tools.cross_review_status.execute(
        { runID: RUN_ID, detail: true },
        context(),
      ),
    );
    expect(progressed.gatherer).toMatchObject({
      status: "succeeded",
    });
    expect(store.runs.get(RUN_ID)?.gatherer?.output).toBe("gathered context");

    const cancelled = output(
      await tools.cross_review_cancel.execute({ runID: RUN_ID }, context()),
    );

    expect(cancelled.phase).toBe("cancelled");
    expect(cancelled.gatherer).toMatchObject({ status: "succeeded" });
    expect(store.runs.get(RUN_ID)?.gatherer?.output).toBe("gathered context");
    expect(store.runs.get(RUN_ID)?.gatherer?.error).toBeUndefined();
    expect(cancelled.reviewers[0].status).toBe("cancelled");
  });

  it("treats an empty context as not provided and still gathers", async () => {
    const { client } = mockClient();
    const tools = protocol(client, new MemoryRunStore());

    const started = output(
      await tools.cross_review_start.execute(
        {
          target: "HEAD",
          context: "",
          reviewModels: ["a/one"],
          agents: 1,
          judgeModel: "b/judge",
        },
        context(),
      ),
    );

    expect(started.phase).toBe("gathering");
    expect(started.gatherer).toBeDefined();
    expect(
      client.session.promptAsync.mock.calls.at(0)?.[0].body.parts[0].text,
    ).toContain("context gatherer");
  });

  it("truncates an oversized gathered context in reviewer briefs", async () => {
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
    const oversized = `start-${"x".repeat(100_100)}-end`;
    messages.set("child-2", completed(oversized));

    const status = output(
      await tools.cross_review_status.execute({ runID: RUN_ID }, context()),
    );
    expect(status.phase).toBe("reviewing");
    const reviewerText =
      client.session.promptAsync.mock.calls.at(-1)?.[0].body.parts[0].text;
    expect(reviewerText).toContain("start-");
    expect(reviewerText).toContain("[...context truncated");
    expect(reviewerText).not.toContain("-end");
  });

  it("rejects an empty context through the argument schema", async () => {
    const { client } = mockClient();
    const tools = protocol(client, new MemoryRunStore());
    expect(tools.cross_review_start.args.context.safeParse("").success).toBe(
      false,
    );
  });

  it("cancels an active gatherer session", async () => {
    const { client } = mockClient();
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

    const cancelled = output(
      await tools.cross_review_cancel.execute({ runID: RUN_ID }, context()),
    );

    expect(cancelled.phase).toBe("cancelled");
    expect(cancelled.gatherer).toMatchObject({ status: "cancelled" });
    expect(client.session.abort).toHaveBeenCalledWith(
      expect.objectContaining({ path: { id: "child-2" } }),
    );
  });

  it("does not mistake the gatherer response for the judge outcome", async () => {
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
    if (
      run === undefined ||
      run.gatherer === undefined ||
      run.judge === undefined
    )
      throw new Error("test run was not created");
    messages.set("child-2", [
      userMessage(run.gatherer.messageID),
      assistantMessage(run.gatherer.messageID, "gathered diff"),
    ]);

    let status = output(
      await tools.cross_review_status.execute(
        { runID: RUN_ID, includeOutputs: true },
        context(),
      ),
    );
    expect(status.phase).toBe("reviewing");
    expect(status.gatherer).toMatchObject({
      status: "succeeded",
      output: "gathered diff",
    });

    messages.set("child-1", completed("candidate"));
    const judging = output(
      await tools.cross_review_finalize.execute({ runID: RUN_ID }, context()),
    );
    expect(judging.phase).toBe("judging");

    // The judge has not responded yet: the gatherer's assistant message must
    // not resolve the judge outcome.
    status = output(
      await tools.cross_review_finalize.execute({ runID: RUN_ID }, context()),
    );
    expect(status.phase).toBe("judging");
    expect(status.judge.status).toBe("starting");

    // The judge response arrives, linked to its own user message.
    const judgeMessages = messages.get("child-2");
    if (judgeMessages === undefined) throw new Error("missing judge messages");
    judgeMessages.push(
      assistantMessage(run.judge.messageID, "verified finding", 20),
    );
    const finalized = output(
      await tools.cross_review_finalize.execute(
        { runID: RUN_ID, includeOutputs: true },
        context(),
      ),
    );
    expect(finalized.phase).toBe("completed");
    expect(finalized.judge).toMatchObject({
      status: "succeeded",
      output: "verified finding",
    });
    expect(finalized.reviewers[0]).toMatchObject({
      status: "succeeded",
      output: "candidate",
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
    expect(client.session.promptAsync).toHaveBeenCalledTimes(1);
    messages.set("child-2", completed("gathered context"));

    const progressed = output(
      await tools.cross_review_finalize.execute({ runID: RUN_ID }, context()),
    );
    expect(progressed.phase).toBe("reviewing");
    expect(client.session.promptAsync).toHaveBeenCalledTimes(2);
    messages.set("child-1", completed("candidate"));

    const judging = output(
      await tools.cross_review_finalize.execute({ runID: RUN_ID }, context()),
    );
    expect(judging).toMatchObject({
      phase: "judging",
      judge: { model: "b/judge", sessionID: "child-2", status: "starting" },
    });
    expect(client.session.create).toHaveBeenCalledTimes(2);
    expect(client.session.promptAsync).toHaveBeenCalledTimes(3);
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
    expect(client.session.promptAsync).toHaveBeenCalledTimes(3);
  });

  it("preserves an overdue judge and later finalizes its output", async () => {
    let timestamp = 1_000;
    const { client, statuses, messages } = mockClient();
    const tools = protocol(client, new MemoryRunStore(), () => timestamp);
    await tools.cross_review_start.execute(
      {
        target: "HEAD",
        context: "shared context",
        reviewModels: ["a/one"],
        agents: 1,
        judgeModel: "b/judge",
        reviewerTimeoutMs: 5_000,
      },
      context(),
    );
    messages.set("child-1", completed("candidate"));
    await tools.cross_review_finalize.execute({ runID: RUN_ID }, context());
    statuses["child-2"] = { type: "busy" };
    timestamp = 6_001;

    const pending = output(
      await tools.cross_review_status.execute(
        { runID: RUN_ID, detail: true },
        context(),
      ),
    );
    expect(pending.phase).toBe("judging");
    expect(pending.judge.status).toBe("timeout_pending");
    expect(pending.actionRequired.sessions).toEqual([
      { role: "judge", model: "b/judge", sessionID: "child-2" },
    ]);

    await tools.cross_review_status.execute(
      { runID: RUN_ID, timeoutAction: "preserve" },
      context(),
    );
    expect(client.session.abort).not.toHaveBeenCalled();

    delete statuses["child-2"];
    messages.set("child-2", completed("late verified finding"));
    timestamp = 7_000;
    const finalized = output(
      await tools.cross_review_finalize.execute({ runID: RUN_ID }, context()),
    );
    expect(finalized).toMatchObject({
      phase: "completed",
      judge: {
        status: "succeeded",
        output: "late verified finding",
        timeoutExtensions: 1,
      },
    });
  });

  it("aborts a preserved judge early within its extension", async () => {
    let timestamp = 1_000;
    const { client, statuses, messages } = mockClient();
    const tools = protocol(client, new MemoryRunStore(), () => timestamp);
    await tools.cross_review_start.execute(
      {
        target: "HEAD",
        context: "shared context",
        reviewModels: ["a/one"],
        agents: 1,
        judgeModel: "b/judge",
        reviewerTimeoutMs: 5_000,
      },
      context(),
    );
    messages.set("child-1", completed("candidate"));
    await tools.cross_review_finalize.execute({ runID: RUN_ID }, context());
    statuses["child-2"] = { type: "busy" };
    timestamp = 6_001;

    await tools.cross_review_status.execute({ runID: RUN_ID }, context());
    await tools.cross_review_status.execute(
      { runID: RUN_ID, timeoutAction: "preserve" },
      context(),
    );

    // Still within the extended deadline (11_001): an explicit abort must
    // terminate the preserved judge instead of being silently ignored.
    timestamp = 7_000;
    const aborted = output(
      await tools.cross_review_status.execute(
        { runID: RUN_ID, detail: true, timeoutAction: "abort" },
        context(),
      ),
    );

    expect(aborted.phase).toBe("judging");
    expect(aborted.judge).toMatchObject({ status: "timed_out" });
    expect(client.session.abort).toHaveBeenCalledWith(
      expect.objectContaining({ path: { id: "child-2" } }),
    );
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
    messages.set("child-2", completed("gathered context"));
    await tools.cross_review_finalize.execute({ runID: RUN_ID }, context());
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

  it("rejects cross_review_start from child sessions with a parentID", async () => {
    const { client } = mockClient();
    client.session.get = vi.fn().mockResolvedValue({
      data: { id: "child-session", parentID: "root-parent-session" },
    });
    const tools = protocol(client, new MemoryRunStore());

    await expect(
      tools.cross_review_start.execute(
        { target: "HEAD", reviewModels: ["a/one"], agents: 1 },
        context("child-session"),
      ),
    ).rejects.toThrow(
      "cross_review_start can only be invoked from primary sessions",
    );
    expect(client.session.create).not.toHaveBeenCalled();
  });

  it("rejects cross_review_start when session inspection is unavailable", async () => {
    const { client } = mockClient();
    (client.session as { get?: unknown }).get = undefined;
    const tools = protocol(client, new MemoryRunStore());

    await expect(
      tools.cross_review_start.execute(
        { target: "HEAD", reviewModels: ["a/one"], agents: 1 },
        context(),
      ),
    ).rejects.toThrow(
      "cross_review_start can only be invoked from primary sessions: session inspection is unavailable",
    );
    expect(client.session.create).not.toHaveBeenCalled();
  });

  it("attaches the underlying session inspection error", async () => {
    const { client } = mockClient();
    client.session.get = vi.fn().mockResolvedValue({
      error: { name: "APIError", data: { message: "unavailable" } },
    });
    const tools = protocol(client, new MemoryRunStore());

    await expect(
      tools.cross_review_start.execute(
        { target: "HEAD", reviewModels: ["a/one"], agents: 1 },
        context(),
      ),
    ).rejects.toThrow("Session inspection failed: unavailable");
    expect(client.session.create).not.toHaveBeenCalled();
  });

  it("allows cross_review_start from primary sessions without a parentID", async () => {
    const { client } = mockClient();
    client.session.get = vi.fn().mockResolvedValue({
      data: { id: "primary-session" },
    });
    const tools = protocol(client, new MemoryRunStore());

    const started = output(
      await tools.cross_review_start.execute(
        { target: "HEAD", reviewModels: ["a/one"], agents: 1 },
        context("primary-session"),
      ),
    );
    expect(started.runID).toBe(RUN_ID);
    expect(client.session.get).toHaveBeenCalledWith(
      expect.objectContaining({
        path: { id: "primary-session" },
        query: { directory: "/repo" },
      }),
    );
  });

  describe("waitMs long polling in cross_review_status", () => {
    it("returns immediately without waiting when waitMs is 0", async () => {
      const { client, statuses } = mockClient();
      let slept = false;
      const sleepMock = vi.fn().mockImplementation(async () => {
        slept = true;
      });
      const tools = protocol(
        client,
        new MemoryRunStore(),
        () => 1_000,
        loadedConfig,
        30_000, // defaultWaitMs is 30s
        sleepMock,
      );
      await tools.cross_review_start.execute(
        { target: "HEAD", reviewModels: ["a/one"], agents: 1 },
        context(),
      );
      statuses["child-1"] = { type: "busy" };

      const status = output(
        await tools.cross_review_status.execute(
          { runID: RUN_ID, waitMs: 0 },
          context(),
        ),
      );
      expect(status.counts).toEqual({ running: 1 });
      expect(sleepMock).not.toHaveBeenCalled();
      expect(slept).toBe(false);
    });

    it("returns immediately without waiting when run is already terminal or readyToFinalize", async () => {
      const { client, messages } = mockClient();
      const sleepMock = vi.fn();
      const tools = protocol(
        client,
        new MemoryRunStore(),
        () => 1_000,
        loadedConfig,
        30_000,
        sleepMock,
      );
      await tools.cross_review_start.execute(
        { target: "HEAD", reviewModels: ["a/one"], agents: 1 },
        context(),
      );
      messages.set("child-1", completed("done"));

      const status = output(
        await tools.cross_review_status.execute(
          { runID: RUN_ID, waitMs: 30_000 },
          context(),
        ),
      );
      expect(status.readyToFinalize).toBe(true);
      expect(status.counts).toEqual({ succeeded: 1 });
      expect(sleepMock).not.toHaveBeenCalled();
    });

    it("wakes up early as soon as a reviewer changes state", async () => {
      const { client, statuses, messages } = mockClient();
      let currentTime = 1_000;
      let sleepCallCount = 0;
      const sleepMock = vi.fn().mockImplementation(async (ms: number) => {
        sleepCallCount++;
        currentTime += ms;
        if (sleepCallCount === 2) {
          // On second sleep tick, reviewer finishes: session is no longer busy, and assistant completed message arrives
          delete statuses["child-1"];
          messages.set("child-1", completed("finished review"));
        }
      });
      const tools = protocol(
        client,
        new MemoryRunStore(),
        () => currentTime,
        loadedConfig,
        30_000,
        sleepMock,
      );
      await tools.cross_review_start.execute(
        { target: "HEAD", reviewModels: ["a/one"], agents: 1 },
        context(),
      );
      statuses["child-1"] = { type: "busy" };

      const status = output(
        await tools.cross_review_status.execute(
          { runID: RUN_ID, waitMs: 30_000 },
          context(),
        ),
      );
      expect(sleepCallCount).toBe(2);
      expect(status.counts).toEqual({ succeeded: 1 });
      expect(status.readyToFinalize).toBe(true);
    });

    it("applies timeoutAction to timeouts that arise while waiting", async () => {
      const { client } = mockClient();
      let currentTime = 1_000;
      const sleepMock = vi.fn().mockImplementation(async (ms: number) => {
        currentTime += ms;
      });
      const tools = protocol(
        client,
        new MemoryRunStore(),
        () => currentTime,
        loadedConfig,
        30_000,
        sleepMock,
      );
      await tools.cross_review_start.execute(
        {
          target: "HEAD",
          reviewModels: ["a/one"],
          agents: 1,
          reviewerTimeoutMs: 5_000,
        },
        context(),
      );

      const status = output(
        await tools.cross_review_status.execute(
          {
            runID: RUN_ID,
            detail: true,
            waitMs: 10_000,
            timeoutAction: "abort",
          },
          context(),
        ),
      );

      // The deadline (6_000) passes inside the wait window: the same call
      // must abort instead of parking the session in timeout_pending.
      expect(status.reviewers[0]).toMatchObject({ status: "timed_out" });
      expect(client.session.abort).toHaveBeenCalledWith(
        expect.objectContaining({ path: { id: "child-1" } }),
      );
      expect(sleepMock).toHaveBeenCalled();
    });

    it("exits and returns status when waitMs timeout expires without state change", async () => {
      const { client, statuses } = mockClient();
      let currentTime = 1_000;
      const sleepMock = vi.fn().mockImplementation(async (ms: number) => {
        currentTime += ms;
      });
      const tools = protocol(
        client,
        new MemoryRunStore(),
        () => currentTime,
        loadedConfig,
        0,
        sleepMock,
      );
      await tools.cross_review_start.execute(
        { target: "HEAD", reviewModels: ["a/one"], agents: 1 },
        context(),
      );
      statuses["child-1"] = { type: "busy" };

      const status = output(
        await tools.cross_review_status.execute(
          { runID: RUN_ID, waitMs: 9_000 },
          context(),
        ),
      );
      expect(status.counts).toEqual({ running: 1 });
      expect(sleepMock).toHaveBeenCalledTimes(3); // 3_000 * 3 = 9_000
    });

    it("aborts promptly when context.abort fires during wait", async () => {
      const { client, statuses } = mockClient();
      const abort = new AbortController();
      let currentTime = 1_000;
      const sleepMock = vi.fn().mockImplementation(async (ms: number) => {
        currentTime += ms;
        abort.abort();
      });
      const tools = protocol(
        client,
        new MemoryRunStore(),
        () => currentTime,
        loadedConfig,
        0,
        sleepMock,
      );
      await tools.cross_review_start.execute(
        { target: "HEAD", reviewModels: ["a/one"], agents: 1 },
        context(),
      );
      statuses["child-1"] = { type: "busy" };

      await expect(
        tools.cross_review_status.execute(
          { runID: RUN_ID, waitMs: 30_000 },
          context("parent", abort),
        ),
      ).rejects.toThrow("Cross-review cancelled");
    });

    it("releases lock between sleep ticks so cancel can execute", async () => {
      const { client, statuses } = mockClient();
      const root = await mkdtemp(join(tmpdir(), "cross-review-wait-lock-"));
      const store = new FileCrossReviewRunStore(root, () => 1_000);
      let currentTime = 1_000;
      let tick = 0;
      const sleepMock = vi.fn().mockImplementation(async (ms: number) => {
        tick++;
        currentTime += ms;
        if (tick === 1) {
          // Concurrent cancel while status is waiting in sleep!
          const cancelProtocol = protocol(
            client,
            store,
            () => currentTime,
            loadedConfig,
            0,
          );
          await cancelProtocol.cross_review_cancel.execute(
            { runID: RUN_ID },
            context(),
          );
        }
      });

      const statusProtocol = protocol(
        client,
        store,
        () => currentTime,
        loadedConfig,
        0,
        sleepMock,
      );
      await statusProtocol.cross_review_start.execute(
        { target: "HEAD", reviewModels: ["a/one"], agents: 1 },
        context(),
      );
      statuses["child-1"] = { type: "busy" };

      const status = output(
        await statusProtocol.cross_review_status.execute(
          { runID: RUN_ID, waitMs: 30_000 },
          context(),
        ),
      );
      expect(status.phase).toBe("cancelled");
      expect(status.counts).toEqual({ cancelled: 1 });
    });
  });
});

describe("cross_review_config preview", () => {
  function previewConfig(): Promise<LoadedCrossReviewConfig> {
    return Promise.resolve({
      config: {
        reviewers: [{ model: "a/one", focus: "security" }, { model: "a/two" }],
        judgeModel: "b/judge",
        maxConcurrency: 2,
        reviewerTimeoutMs: 900_000,
      },
      sources: { project: "loaded", global: "absent" },
      projectPath: "/repo/.opencode/cross-review.json",
      globalPath: "/home/.config/opencode/cross-review.json",
    });
  }

  function globalPreviewConfig(): Promise<LoadedCrossReviewConfig> {
    return Promise.resolve({
      config: { reviewModels: ["a/one"] },
      sources: { project: "absent", global: "loaded" },
      projectPath: "/repo/.opencode/cross-review.json",
      globalPath: "/home/.config/opencode/cross-review.json",
    });
  }

  it("previews the resolved config without creating sessions", async () => {
    const { client } = mockClient();
    const tools = protocol(
      client,
      new MemoryRunStore(),
      () => 1_000,
      previewConfig,
    );

    const previewed = await tools.cross_review_config.execute({}, context());
    const preview = output(previewed);

    expect(preview.config).toEqual(PROJECT_CONFIG_BLOCK);
    expect(preview).not.toHaveProperty("warning");
    expect(preview.reviewers).toEqual([
      { reviewer: 1, model: "a/one", focus: "security" },
      { reviewer: 2, model: "a/two" },
    ]);
    expect(preview.quorum).toBe(2);
    expect(preview.judge).toEqual({ model: "b/judge" });
    expect(preview.maxConcurrency).toBe(2);
    expect(preview.reviewerTimeoutMs).toBe(900_000);
    expect(
      (previewed as { metadata: Record<string, unknown> }).metadata,
    ).toMatchObject({
      configSources: PROJECT_CONFIG_BLOCK.sources,
      projectConfigPath: PROJECT_CONFIG_BLOCK.projectConfigPath,
      globalConfigPath: PROJECT_CONFIG_BLOCK.globalConfigPath,
    });
    expect(client.session.create).not.toHaveBeenCalled();
    expect(client.provider.list).toHaveBeenCalled();
  });

  it("echoes the global fallback warning with parent-session judging", async () => {
    const { client } = mockClient();
    const tools = protocol(
      client,
      new MemoryRunStore(),
      () => 1_000,
      globalPreviewConfig,
    );

    const preview = output(
      await tools.cross_review_config.execute({}, context()),
    );

    expect(preview.config).toEqual({
      sources: { project: "absent", global: "loaded" },
      projectConfigPath: "/repo/.opencode/cross-review.json",
      globalConfigPath: "/home/.config/opencode/cross-review.json",
    });
    expect(preview.warning).toBe(GLOBAL_FALLBACK_WARNING);
    expect(preview.reviewers).toHaveLength(3);
    expect(
      preview.reviewers.every((reviewer: any) => reviewer.model === "a/one"),
    ).toBe(true);
    expect(preview.quorum).toBe(2);
    expect(preview.judge).toEqual({ model: "parent-session" });
    expect(preview.maxConcurrency).toBe(3);
    expect(preview.reviewerTimeoutMs).toBe(600_000);
    expect(client.session.create).not.toHaveBeenCalled();
  });

  it("applies explicit overrides in preview without persisting a run", async () => {
    const { client } = mockClient();
    const store = new MemoryRunStore();
    const tools = protocol(client, store, () => 1_000, previewConfig);

    const preview = output(
      await tools.cross_review_config.execute(
        { reviewModels: ["a/one"], agents: 1, focus: "override focus" },
        context(),
      ),
    );

    expect(preview.reviewers).toEqual([
      { reviewer: 1, model: "a/one", focus: "override focus" },
    ]);
    expect(preview.quorum).toBe(1);
    expect(store.runs.size).toBe(0);
    expect(client.session.create).not.toHaveBeenCalled();
  });

  it("matches start resolution for the same inputs", async () => {
    const { client: previewClient } = mockClient();
    const preview = output(
      await protocol(
        previewClient,
        new MemoryRunStore(),
        () => 1_000,
        previewConfig,
      ).cross_review_config.execute({}, context()),
    );

    const { client } = mockClient();
    const started = output(
      await protocol(
        client,
        new MemoryRunStore(),
        () => 1_000,
        previewConfig,
      ).cross_review_start.execute(
        { target: "HEAD", reviewModels: ["a/one", "a/two"], agents: 2 },
        context(),
      ),
    );
    const { client: reClient } = mockClient();
    const rePreview = output(
      await protocol(
        reClient,
        new MemoryRunStore(),
        () => 1_000,
        previewConfig,
      ).cross_review_config.execute(
        { reviewModels: ["a/one", "a/two"], agents: 2 },
        context(),
      ),
    );

    expect(preview.reviewers).toEqual([
      { reviewer: 1, model: "a/one", focus: "security" },
      { reviewer: 2, model: "a/two" },
    ]);
    expect(rePreview.reviewers.map((reviewer: any) => reviewer.model)).toEqual(
      started.reviewers.map((reviewer: any) => reviewer.model),
    );
    expect(rePreview.quorum).toBe(started.quorum);
  });

  it("rejects preview without any configured or explicit reviewers", async () => {
    const { client } = mockClient();
    const tools = protocol(client, new MemoryRunStore());

    await expect(
      tools.cross_review_config.execute({}, context()),
    ).rejects.toThrow("No review models configured");
    expect(client.session.create).not.toHaveBeenCalled();
  });

  it("rejects out-of-range preview overrides before provider discovery", async () => {
    const { client } = mockClient();
    const tools = protocol(client, new MemoryRunStore());

    await expect(
      tools.cross_review_config.execute({ agents: 9 }, context()),
    ).rejects.toThrow("`agents` must be an integer from 1 to 8");
    await expect(
      tools.cross_review_config.execute(
        { reviewModels: ["a/one"], reviewerTimeoutMs: 1 },
        context(),
      ),
    ).rejects.toThrow(
      "`reviewerTimeoutMs` must be an integer from 5000 to 3600000",
    );
    expect(client.session.create).not.toHaveBeenCalled();
    expect(client.provider.list).not.toHaveBeenCalled();
  });

  it("treats host type-default preview overrides as absent", async () => {
    const { client } = mockClient();
    const tools = protocol(
      client,
      new MemoryRunStore(),
      () => 1_000,
      previewConfig,
    );

    const preview = output(
      await tools.cross_review_config.execute(
        {
          reviewModels: [],
          agents: 0,
          maxConcurrency: 0,
          reviewerTimeoutMs: 0,
        },
        context(),
      ),
    );

    expect(preview.reviewers).toEqual([
      { reviewer: 1, model: "a/one", focus: "security" },
      { reviewer: 2, model: "a/two" },
    ]);
    expect(preview.judge).toEqual({ model: "b/judge" });
    expect(preview.maxConcurrency).toBe(2);
    expect(preview.reviewerTimeoutMs).toBe(900_000);
    expect(client.session.create).not.toHaveBeenCalled();
  });

  it("rejects unavailable preview models without creating sessions", async () => {
    const { client } = mockClient();
    const tools = protocol(client, new MemoryRunStore());

    await expect(
      tools.cross_review_config.execute(
        { reviewModels: ["a/missing"], agents: 1 },
        context(),
      ),
    ).rejects.toThrow("Unavailable model: a/missing");
    expect(client.session.create).not.toHaveBeenCalled();
  });

  it("rejects preview from child sessions with a parentID", async () => {
    const { client } = mockClient();
    client.session.get = vi.fn().mockResolvedValue({
      data: { id: "child-session", parentID: "root-parent-session" },
    });
    const tools = protocol(client, new MemoryRunStore());

    await expect(
      tools.cross_review_config.execute({}, context("child-session")),
    ).rejects.toThrow(
      "cross_review_config can only be invoked from primary sessions",
    );
    expect(client.session.create).not.toHaveBeenCalled();
  });
});

describe("cross-review PR snapshot protocol", () => {
  const WORKTREE = "/state/run/worktree";
  const SNAPSHOT_DIR = `${WORKTREE}/.cross-review`;

  function okAdapter() {
    return vi.fn().mockResolvedValue({
      ok: true,
      worktree: WORKTREE,
      snapshotDir: SNAPSHOT_DIR,
      meta: {
        schemaVersion: 1,
        forge: "github",
        target: "https://github.com/org/repo/pull/69",
        url: "https://github.com/org/repo/pull/69",
        baseSha: "a".repeat(40),
        headSha: "b".repeat(40),
        mergeBaseSha: "c".repeat(40),
        fetchedAt: "2026-09-05T00:00:00.000Z",
      },
    });
  }

  function prProtocol(
    client: AsyncCrossReviewClient,
    store: CrossReviewRunStore,
    classifyTarget: (target: string, directory: string) => Promise<any>,
    runPrAdapter = okAdapter(),
    removeSnapshot: (worktree: string) => Promise<void> = vi.fn(),
    loadConfig: () => Promise<LoadedCrossReviewConfig> = loadedConfig,
  ) {
    // Child sessions report themselves bound to the snapshot worktree so
    // the S10 directory assertion passes; hostile-binding tests override
    // `session.get` themselves.
    client.session.get = vi
      .fn()
      .mockImplementation(async (input: any) =>
        input.path.id.startsWith("child-")
          ? { data: { id: input.path.id, directory: WORKTREE } }
          : { data: { id: input.path.id } },
      );
    const tools = createCrossReviewProtocolTools(client, {
      store,
      loadConfig,
      now: () => 1_000,
      createRunID: () => RUN_ID,
      canonicalize: async (directory) => directory,
      defaultWaitMs: 0,
      classifyTarget,
      runPrAdapter,
      stateRoot: "/state",
      removeSnapshot,
    });
    return { tools, runPrAdapter, removeSnapshot };
  }

  it("runs the adapter and binds reviewer sessions to the snapshot worktree (S1)", async () => {
    const { client, messages } = mockClient();
    const store = new MemoryRunStore();
    const classify = vi.fn().mockResolvedValue({ kind: "pr", forge: "github" });
    const { tools, runPrAdapter } = prProtocol(
      client,
      store,
      classify,
      okAdapter(),
    );

    const started = output(
      await tools.cross_review_start.execute(
        {
          target: "https://github.com/org/repo/pull/69",
          reviewModels: ["a/one"],
          agents: 1,
          judgeModel: "b/judge",
        },
        context(),
      ),
    );

    expect(runPrAdapter).toHaveBeenCalledWith(
      expect.objectContaining({
        forge: "github",
        target: "https://github.com/org/repo/pull/69",
        runID: RUN_ID,
        stateRoot: "/state",
      }),
    );
    // PR runs never create an LLM gatherer session: one reviewer + one judge.
    expect(client.session.create).toHaveBeenCalledTimes(2);
    for (const call of client.session.create.mock.calls)
      expect(call[0].query.directory).toBe(WORKTREE);
    expect(started.phase).toBe("reviewing");
    expect(started.gatherer).toMatchObject({
      kind: "adapter",
      forge: "github",
    });
    expect(started.snapshot).toMatchObject({
      worktree: WORKTREE,
      forge: "github",
    });

    const run = store.runs.get(RUN_ID);
    expect(run?.snapshot).toMatchObject({ worktree: WORKTREE });
    expect(run?.gatherer).toBeUndefined();
    expect(run?.adapterGatherer).toMatchObject({
      kind: "adapter",
      status: "succeeded",
    });

    // Reviewer prompts use the snapshot directory and the snapshot brief.
    const prompt = client.session.promptAsync.mock.calls[0][0];
    expect(prompt.query.directory).toBe(WORKTREE);
    expect(prompt.body.parts[0].text).toContain(
      "isolated git worktree snapshot",
    );
    expect(prompt.body.parts[0].text).not.toContain("Shared target context");

    messages.set("child-1", completed("snapshot review"));
    const status = output(
      await tools.cross_review_status.execute(
        { runID: RUN_ID, includeOutputs: true },
        context(),
      ),
    );
    expect(status.reviewers[0]).toMatchObject({
      status: "succeeded",
      output: "snapshot review",
    });
    expect(client.session.messages.mock.calls[0][0].query.directory).toBe(
      WORKTREE,
    );
  });

  it("forwards caller context as adapter notes without embedding it in briefs (S2)", async () => {
    const { client } = mockClient();
    const classify = vi.fn().mockResolvedValue({ kind: "pr", forge: "github" });
    const { tools, runPrAdapter } = prProtocol(
      client,
      new MemoryRunStore(),
      classify,
    );

    await tools.cross_review_start.execute(
      {
        target: "https://github.com/org/repo/pull/69",
        reviewModels: ["a/one"],
        agents: 1,
        context: "watch the auth rewrite",
      },
      context(),
    );

    expect(runPrAdapter).toHaveBeenCalledWith(
      expect.objectContaining({ notes: "watch the auth rewrite" }),
    );
    const brief =
      client.session.promptAsync.mock.calls[0][0].body.parts[0].text;
    expect(brief).not.toContain("watch the auth rewrite");
    expect(brief).not.toContain("Shared target context");
  });

  it("routes gitcode PRs to the adapter with gitcodeCli (S3)", async () => {
    const { client } = mockClient();
    const gitcodeConfig = () =>
      Promise.resolve({
        config: { gitcodeCli: "/opt/bin/gitcode" },
        sources: { project: "loaded", global: "absent" },
        projectPath: "/repo/.opencode/cross-review.json",
        globalPath: "/home/.config/opencode/cross-review.json",
      } as LoadedCrossReviewConfig);
    const classify = vi
      .fn()
      .mockResolvedValue({ kind: "pr", forge: "gitcode" });
    const { tools, runPrAdapter } = prProtocol(
      client,
      new MemoryRunStore(),
      classify,
      okAdapter(),
      vi.fn(),
      gitcodeConfig,
    );

    await tools.cross_review_start.execute(
      {
        target: "https://gitcode.com/org/repo/pull/5",
        reviewModels: ["a/one"],
        agents: 1,
      },
      context(),
    );

    expect(runPrAdapter).toHaveBeenCalledWith(
      expect.objectContaining({
        forge: "gitcode",
        gitcodeCli: "/opt/bin/gitcode",
      }),
    );
  });

  it("persists a failed run, retains the snapshot, and creates no sessions on adapter failure (S5)", async () => {
    const { client } = mockClient();
    const store = new MemoryRunStore();
    const classify = vi.fn().mockResolvedValue({ kind: "pr", forge: "github" });
    const failing = vi.fn().mockResolvedValue({
      ok: false,
      error: "gh not authenticated",
      snapshotPath: WORKTREE,
    });
    const { tools, removeSnapshot } = prProtocol(
      client,
      store,
      classify,
      failing,
    );

    await expect(
      tools.cross_review_start.execute(
        {
          target: "https://github.com/org/repo/pull/69",
          reviewModels: ["a/one"],
          agents: 1,
        },
        context(),
      ),
    ).rejects.toThrow(
      "gh not authenticated (snapshot retained at /state/run/worktree)",
    );
    expect(client.session.create).not.toHaveBeenCalled();
    expect(removeSnapshot).not.toHaveBeenCalled();
    const run = store.runs.get(RUN_ID);
    expect(run).toMatchObject({
      phase: "failed",
      reviewers: [],
    });
    // The manifest pins the runner-reported retained path (reality), not
    // the derived stateRoot/runID layout, so cleanup removes the right
    // directory even with a custom adapter runner.
    expect(run?.snapshot).toMatchObject({
      worktree: WORKTREE,
    });
    expect(run?.adapterGatherer).toMatchObject({
      kind: "adapter",
      status: "failed",
    });
  });

  it("rejects unknown forges before any adapter or session activity (S8)", async () => {
    const { client } = mockClient();
    const store = new MemoryRunStore();
    const classify = vi
      .fn()
      .mockResolvedValue({ kind: "error", message: "unknown forge" });
    const { tools, runPrAdapter } = prProtocol(client, store, classify);

    await expect(
      tools.cross_review_start.execute(
        { target: "#42", reviewModels: ["a/one"], agents: 1 },
        context(),
      ),
    ).rejects.toThrow("unknown forge");
    expect(runPrAdapter).not.toHaveBeenCalled();
    expect(client.session.create).not.toHaveBeenCalled();
    expect(store.runs.size).toBe(0);
  });

  it("keeps legacy targets on the LLM gatherer path", async () => {
    const { client } = mockClient();
    const classify = vi.fn().mockResolvedValue({ kind: "legacy" });
    const { tools, runPrAdapter } = prProtocol(
      client,
      new MemoryRunStore(),
      classify,
    );

    const started = output(
      await tools.cross_review_start.execute(
        {
          target: "main...HEAD",
          reviewModels: ["a/one"],
          agents: 1,
          judgeModel: "b/judge",
        },
        context(),
      ),
    );

    expect(runPrAdapter).not.toHaveBeenCalled();
    expect(started.phase).toBe("gathering");
    expect(client.session.create).toHaveBeenCalledTimes(2);
    expect(client.session.create.mock.calls[0][0].query.directory).toBe(
      "/repo",
    );
  });

  it("removes the snapshot worktree on cancel (S9)", async () => {
    const { client } = mockClient();
    const classify = vi.fn().mockResolvedValue({ kind: "pr", forge: "github" });
    const removeSnapshot = vi.fn().mockResolvedValue(undefined);
    const { tools } = prProtocol(
      client,
      new MemoryRunStore(),
      classify,
      okAdapter(),
      removeSnapshot,
    );
    await tools.cross_review_start.execute(
      {
        target: "https://github.com/org/repo/pull/69",
        reviewModels: ["a/one"],
        agents: 1,
      },
      context(),
    );

    const cancelled = output(
      await tools.cross_review_cancel.execute({ runID: RUN_ID }, context()),
    );

    expect(cancelled.phase).toBe("cancelled");
    expect(removeSnapshot).toHaveBeenCalledWith(WORKTREE);
    // Active child sessions are aborted against the snapshot directory.
    expect(client.session.abort).toHaveBeenCalledWith(
      expect.objectContaining({
        path: { id: "child-1" },
        query: { directory: WORKTREE },
      }),
    );
  });

  it("removes the snapshot worktree on successful finalize (S9)", async () => {
    const { client, messages } = mockClient();
    const classify = vi.fn().mockResolvedValue({ kind: "pr", forge: "github" });
    const removeSnapshot = vi.fn().mockResolvedValue(undefined);
    const { tools } = prProtocol(
      client,
      new MemoryRunStore(),
      classify,
      okAdapter(),
      removeSnapshot,
    );
    await tools.cross_review_start.execute(
      {
        target: "https://github.com/org/repo/pull/69",
        reviewModels: ["a/one"],
        agents: 1,
      },
      context(),
    );
    messages.set("child-1", completed("done"));

    const finalized = output(
      await tools.cross_review_finalize.execute({ runID: RUN_ID }, context()),
    );

    expect(finalized.phase).toBe("completed");
    expect(removeSnapshot).toHaveBeenCalledWith(WORKTREE);
  });

  it("retains the snapshot when quorum is not met", async () => {
    const { client, messages } = mockClient();
    const classify = vi.fn().mockResolvedValue({ kind: "pr", forge: "github" });
    const removeSnapshot = vi.fn().mockResolvedValue(undefined);
    const { tools } = prProtocol(
      client,
      new MemoryRunStore(),
      classify,
      okAdapter(),
      removeSnapshot,
    );
    await tools.cross_review_start.execute(
      {
        target: "https://github.com/org/repo/pull/69",
        reviewModels: ["a/one"],
        agents: 1,
      },
      context(),
    );
    messages.set(
      "child-1",
      failed("APIError", { message: "rate limited" } as any),
    );

    const finalized = output(
      await tools.cross_review_finalize.execute({ runID: RUN_ID }, context()),
    );

    expect(finalized.phase).toBe("quorum-not-met");
    expect(removeSnapshot).not.toHaveBeenCalled();
  });

  it("fails closed and cleans the orphan when the runtime binds the child elsewhere (S10)", async () => {
    const { client } = mockClient();
    const classify = vi.fn().mockResolvedValue({ kind: "pr", forge: "github" });
    const store = new MemoryRunStore();
    const removeSnapshot = vi.fn().mockResolvedValue(undefined);
    const { tools } = prProtocol(
      client,
      store,
      classify,
      okAdapter(),
      removeSnapshot,
    );
    // Hostile binding, installed after prProtocol's cooperative default.
    client.session.get = vi
      .fn()
      .mockImplementation(async (input: any) =>
        input.path.id.startsWith("child-")
          ? { data: { id: input.path.id, directory: "/elsewhere" } }
          : { data: { id: input.path.id } },
      );

    await expect(
      tools.cross_review_start.execute(
        {
          target: "https://github.com/org/repo/pull/69",
          reviewModels: ["a/one"],
          agents: 1,
        },
        context(),
      ),
    ).rejects.toThrow("refusing to review the wrong checkout");
    // The orphan snapshot is removed because no manifest references it.
    expect(removeSnapshot).toHaveBeenCalledWith(WORKTREE);
    expect(store.runs.size).toBe(0);
    expect(client.session.abort).toHaveBeenCalledWith(
      expect.objectContaining({
        path: { id: "child-1" },
        query: { directory: WORKTREE },
      }),
    );
  });

  it("includes the adapter gatherer in final results for PR runs", async () => {
    const { client, messages } = mockClient();
    const classify = vi.fn().mockResolvedValue({ kind: "pr", forge: "github" });
    const removeSnapshot = vi.fn().mockResolvedValue(undefined);
    const { tools } = prProtocol(
      client,
      new MemoryRunStore(),
      classify,
      okAdapter(),
      removeSnapshot,
    );
    await tools.cross_review_start.execute(
      {
        target: "https://github.com/org/repo/pull/69",
        reviewModels: ["a/one"],
        agents: 1,
      },
      context(),
    );
    messages.set("child-1", completed("reviewer verdict"));

    const finalized = output(
      await tools.cross_review_finalize.execute({ runID: RUN_ID }, context()),
    );

    // The final result reports the adapter gatherer exactly as status does.
    expect(finalized.gatherer).toMatchObject({ kind: "adapter" });
    expect(finalized.gatherer.model).toBeUndefined();
    expect(removeSnapshot).toHaveBeenCalledWith(WORKTREE);
  });
});

describe("PR snapshot fail-closed gaps", () => {
  const WORKTREE = "/state/run/worktree";

  function okAdapter() {
    return vi.fn().mockResolvedValue({
      ok: true,
      worktree: WORKTREE,
      snapshotDir: `${WORKTREE}/.cross-review`,
      meta: {
        schemaVersion: 1,
        forge: "github",
        target: "https://github.com/org/repo/pull/69",
        url: "https://github.com/org/repo/pull/69",
        baseSha: "a".repeat(40),
        headSha: "b".repeat(40),
        mergeBaseSha: "c".repeat(40),
        fetchedAt: "2026-09-05T00:00:00.000Z",
      },
    });
  }

  function prTools(
    sessionGet: (input: any) => Promise<any>,
    loaded: () => Promise<LoadedCrossReviewConfig> = loadedConfig,
  ) {
    const { client } = mockClient();
    client.session.get = vi.fn().mockImplementation(sessionGet);
    const store = new MemoryRunStore();
    const removeSnapshot = vi.fn().mockResolvedValue(undefined);
    const tools = createCrossReviewProtocolTools(client, {
      store,
      loadConfig: loaded,
      now: () => 1_000,
      createRunID: () => RUN_ID,
      canonicalize: async (directory) => directory,
      defaultWaitMs: 0,
      classifyTarget: vi
        .fn()
        .mockResolvedValue({ kind: "pr", forge: "github" }),
      runPrAdapter: okAdapter(),
      stateRoot: "/state",
      removeSnapshot,
    });
    return { client, store, tools, removeSnapshot };
  }

  it("fails closed when a child session reports no bound directory", async () => {
    const { tools, removeSnapshot, store } = prTools(async (input) => ({
      data: { id: input.path.id },
    }));
    await expect(
      tools.cross_review_start.execute(
        {
          target: "https://github.com/org/repo/pull/69",
          reviewModels: ["a/one"],
          agents: 1,
        },
        context(),
      ),
    ).rejects.toThrow("reports no bound directory");
    // Orphan snapshot is cleaned because no manifest persisted.
    expect(removeSnapshot).toHaveBeenCalledWith(WORKTREE);
    expect(store.runs.size).toBe(0);
  });

  it("fails closed when the judge session is bound elsewhere", async () => {
    const { tools, removeSnapshot, store } = prTools(async (input) => ({
      data: {
        id: input.path.id,
        // child-1 is the reviewer (cooperative), child-2 is the judge.
        ...(input.path.id === "child-2"
          ? { directory: "/elsewhere" }
          : { directory: WORKTREE }),
      },
    }));
    await expect(
      tools.cross_review_start.execute(
        {
          target: "https://github.com/org/repo/pull/69",
          reviewModels: ["a/one"],
          agents: 1,
          judgeModel: "b/judge",
        },
        context(),
      ),
    ).rejects.toThrow("refusing to review the wrong checkout");
    expect(removeSnapshot).toHaveBeenCalledWith(WORKTREE);
    expect(store.runs.size).toBe(0);
  });
});
