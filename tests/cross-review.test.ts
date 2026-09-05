/* eslint-disable @typescript-eslint/no-explicit-any */
import { mkdtemp, mkdir, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createCrossReviewTool,
  resolveReviewers,
  type CrossReviewClient,
} from "../src/cross-review/tool.js";
import type {
  CrossReviewConfig,
  LoadedCrossReviewConfig,
} from "../src/cross-review/config.js";

function wrapConfig(
  config: CrossReviewConfig,
  sources: LoadedCrossReviewConfig["sources"] = {
    project: "loaded",
    global: "absent",
  },
): Promise<LoadedCrossReviewConfig> {
  return Promise.resolve({
    config,
    sources,
    projectPath: "/repo/.opencode/cross-review.json",
    globalPath: "/home/.config/opencode/cross-review.json",
  });
}

const emptyConfig = (): Promise<LoadedCrossReviewConfig> =>
  wrapConfig({}, { project: "absent", global: "absent" });

function context(abort = new AbortController()) {
  return {
    sessionID: "parent",
    messageID: "message",
    agent: "build",
    directory: "/repo",
    worktree: "/repo",
    abort: abort.signal,
    metadata() {},
    async ask() {},
  } as any;
}

function client(prompt?: CrossReviewClient["session"]["prompt"]) {
  let nextID = 0;
  return {
    provider: {
      list: vi.fn().mockResolvedValue({
        data: {
          all: [
            { id: "a", models: { one: {}, two: {} } },
            { id: "b", models: { judge: {} } },
            {
              id: "unraid-wg",
              models: { "wb/kimi-k3": {}, "cx/gpt-5.6-sol": {} },
            },
          ],
          connected: ["a", "b", "unraid-wg"],
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
      prompt:
        prompt ??
        vi.fn().mockResolvedValue({
          data: { parts: [{ type: "text", text: "No findings." }] },
        }),
      abort: vi.fn().mockResolvedValue({ data: true }),
    },
  } satisfies CrossReviewClient;
}

describe("cross_review tool", () => {
  it("validates model identifiers, availability, and reviewer bounds", async () => {
    const mock = client();
    const definition = createCrossReviewTool(mock, emptyConfig);
    await expect(
      definition.execute(
        {
          target: "HEAD",
          reviewModels: ["malformed"],
        },
        context(),
      ),
    ).rejects.toThrow(
      "`reviewModels` must be 1-8 `provider/model` identifiers",
    );
    await expect(
      definition.execute(
        {
          target: "HEAD",
          reviewModels: ["a/missing"],
        },
        context(),
      ),
    ).rejects.toThrow("Unavailable model");
    expect(definition.args.agents.safeParse(9).success).toBe(false);
    expect(mock.session.create).not.toHaveBeenCalled();
  });

  it("rejects out-of-range overrides before any session is created", async () => {
    const mock = client();
    const definition = createCrossReviewTool(mock, emptyConfig);
    await expect(
      definition.execute({ target: "HEAD", agents: 9 }, context()),
    ).rejects.toThrow("`agents` must be an integer from 1 to 8");
    await expect(
      definition.execute(
        { target: "HEAD", reviewModels: ["a/one"], maxConcurrency: 9 },
        context(),
      ),
    ).rejects.toThrow("`maxConcurrency` must be an integer from 1 to 8");
    await expect(
      definition.execute(
        { target: "HEAD", reviewModels: ["malformed"] },
        context(),
      ),
    ).rejects.toThrow(
      "`reviewModels` must be 1-8 `provider/model` identifiers",
    );
    expect(mock.session.create).not.toHaveBeenCalled();
    expect(mock.provider.list).not.toHaveBeenCalled();
  });

  it("treats host type-default overrides as absent and uses configured reviewers", async () => {
    const mock = client();
    const result = await createCrossReviewTool(mock, () =>
      wrapConfig({
        reviewers: [{ model: "a/one" }, { model: "a/two" }],
        maxConcurrency: 2,
        judgeModel: "b/judge",
        focus: "from-config",
      }),
    ).execute(
      {
        target: "HEAD",
        reviewModels: [],
        agents: 0,
        maxConcurrency: 0,
      },
      context(),
    );

    const parsed = JSON.parse((result as any).output);
    expect(parsed.reviewers.map((reviewer: any) => reviewer.model)).toEqual([
      "a/one",
      "a/two",
    ]);
    expect(parsed.reviewers[0].focus).toBe("from-config");
    expect(mock.session.create).toHaveBeenCalled();
  });

  it("treats agents 0 as absent when resolving configured reviewers", () => {
    expect(
      resolveReviewers(
        { agents: 0 },
        { reviewers: [{ model: "a/one" }, { model: "a/two" }] },
      ),
    ).toEqual([{ model: "a/one" }, { model: "a/two" }]);
    expect(
      resolveReviewers(
        { reviewModels: [] },
        { reviewModels: ["a/one"], agents: 1 },
      ),
    ).toEqual([{ model: "a/one" }]);
  });

  it("never resolves an empty reviewer set", () => {
    expect(() => resolveReviewers({}, {})).toThrow(
      "No review models configured",
    );
  });

  it("rejects invocations without any configured or explicit reviewers", async () => {
    const mock = client();
    await expect(
      createCrossReviewTool(mock, emptyConfig).execute(
        { target: "HEAD" },
        context(),
      ),
    ).rejects.toThrow(
      "No review models configured: configure reviewers in .opencode/cross-review.json or pass --review-models",
    );
    expect(mock.session.create).not.toHaveBeenCalled();
  });

  it("preserves nested model paths after the provider identifier", async () => {
    const prompt = vi.fn().mockResolvedValue({
      data: { parts: [{ type: "text", text: "candidate" }] },
    });
    const mock = client(prompt);
    await createCrossReviewTool(mock, emptyConfig).execute(
      {
        target: "HEAD",
        reviewModels: ["unraid-wg/wb/kimi-k3"],
        agents: 1,
        judgeModel: "unraid-wg/cx/gpt-5.6-sol",
      },
      context(),
    );
    expect(prompt.mock.calls.map((call) => call[0].body.model)).toEqual([
      { providerID: "unraid-wg", modelID: "cx/gpt-5.6-sol" },
      { providerID: "unraid-wg", modelID: "wb/kimi-k3" },
      { providerID: "unraid-wg", modelID: "cx/gpt-5.6-sol" },
    ]);
  });

  it("treats a blank explicit judge model as parent-session judging", async () => {
    const mock = client();
    const result = await createCrossReviewTool(mock, () =>
      wrapConfig({
        reviewers: [{ model: "a/one" }],
        judgeModel: "b/judge",
      }),
    ).execute({ target: "HEAD", judgeModel: "  " }, context());

    expect(mock.session.prompt).toHaveBeenCalledTimes(1);
    expect(JSON.parse((result as any).output).judge).toMatchObject({
      model: "parent-session",
      status: "pending-parent-consolidation",
    });
  });

  it("publishes reviewer progress and child session provenance", async () => {
    const metadata = vi.fn();
    const toolContext = context();
    toolContext.metadata = metadata;

    await createCrossReviewTool(client(), emptyConfig).execute(
      {
        target: "HEAD",
        reviewModels: ["a/one"],
        agents: 2,
      },
      toolContext,
    );

    expect(metadata).toHaveBeenCalledWith({
      title: "Cross-review: 0/2 reviewers complete",
      metadata: expect.objectContaining({
        stage: "reviewing",
        reviewers: expect.arrayContaining([
          expect.objectContaining({
            sessionID: "child-1",
            status: "running",
          }),
        ]),
      }),
    });
    expect(metadata).toHaveBeenLastCalledWith({
      title: "Cross-review: complete",
      metadata: expect.objectContaining({
        stage: "completed",
        completedReviewers: 2,
        reviewers: [
          expect.objectContaining({
            sessionID: "child-1",
            status: "succeeded",
          }),
          expect.objectContaining({
            sessionID: "child-2",
            status: "succeeded",
          }),
        ],
      }),
    });
  });

  it("uses round-robin models, identical briefs, and bounded concurrency", async () => {
    let active = 0;
    let peak = 0;
    const prompt = vi.fn().mockImplementation(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return { data: { parts: [{ type: "text", text: "review" }] } };
    });
    const mock = client(prompt);
    const output = await createCrossReviewTool(mock, emptyConfig).execute(
      {
        target: "main...HEAD",
        reviewModels: ["a/one", "a/two"],
        agents: 4,
        maxConcurrency: 2,
        focus: "security",
      },
      context(),
    );
    const calls = prompt.mock.calls.map((call) => call[0]);
    expect(peak).toBe(2);
    expect(calls.map((call) => call.body.model.modelID)).toEqual([
      "one",
      "two",
      "one",
      "two",
    ]);
    expect(new Set(calls.map((call) => call.body.parts[0].text)).size).toBe(1);
    expect(calls.every((call) => call.body.agent === "cross-reviewer")).toBe(
      true,
    );
    expect(calls.every((call) => call.body.tools.bash === false)).toBe(true);
    expect(calls.every((call) => call.body.tools.edit === false)).toBe(true);
    expect(calls.every((call) => call.body.tools.task === false)).toBe(true);
    expect(calls.every((call) => call.body.tools.write === false)).toBe(true);
    expect(calls.every((call) => call.body.tools.cross_review === false)).toBe(
      true,
    );
    expect(
      calls.every((call) => call.body.tools.cross_review_start === false),
    ).toBe(true);
    expect(
      calls.every((call) => call.body.tools.cross_review_status === false),
    ).toBe(true);
    expect(
      calls.every((call) => call.body.tools.cross_review_cancel === false),
    ).toBe(true);
    expect(
      calls.every((call) => call.body.tools.cross_review_finalize === false),
    ).toBe(true);
    expect(
      calls.every((call) => call.body.tools.session_review === false),
    ).toBe(true);
    expect(JSON.parse((output as any).output)).toMatchObject({
      quorum: 3,
      judge: { model: "parent-session" },
    });
  });

  it("runs configured reviewers with per-reviewer focus and a configured judge", async () => {
    const prompt = vi.fn().mockImplementation(async (input) => ({
      data: {
        parts: [
          {
            type: "text",
            text: input.body.parts[0].text.includes("Judge")
              ? "judged"
              : "candidate",
          },
        ],
      },
    }));
    const mock = client(prompt);
    const config: CrossReviewConfig = {
      reviewers: [
        { model: "a/one", focus: "security and auth" },
        { model: "a/two", focus: "performance regressions" },
      ],
      judgeModel: "b/judge",
      maxConcurrency: 2,
    };
    const metadata = vi.fn();
    const toolContext = context();
    toolContext.metadata = metadata;
    const output = await createCrossReviewTool(mock, () =>
      wrapConfig(config),
    ).execute({ target: "main...HEAD" }, toolContext);
    const calls = prompt.mock.calls.map((call) => call[0]);
    expect(calls).toHaveLength(4);
    expect(calls[0].body.parts[0].text).toContain("context gatherer");
    expect(calls.slice(1, 3).map((call) => call.body.model.modelID)).toEqual([
      "one",
      "two",
    ]);
    expect(calls[1].body.parts[0].text).toContain("Focus: security and auth");
    expect(calls[2].body.parts[0].text).toContain(
      "Focus: performance regressions",
    );
    expect(calls[3].body.model.modelID).toBe("judge");
    const parsed = JSON.parse((output as any).output);
    expect(parsed.gatherer).toMatchObject({
      model: "b/judge",
      status: "succeeded",
    });
    expect(parsed.judge).toMatchObject({
      model: "b/judge",
      status: "succeeded",
    });
    const judgeUpdates = metadata.mock.calls
      .map(([update]) => update.metadata.judge)
      .filter((judge) => judge !== undefined);
    expect(judgeUpdates).toContainEqual({
      model: "b/judge",
      sessionID: "child-1",
      status: "running",
    });
    expect(judgeUpdates).toContainEqual({
      model: "b/judge",
      sessionID: "child-1",
      status: "succeeded",
    });
    expect(judgeUpdates.every((judge) => !("output" in judge))).toBe(true);
    expect(parsed.reviewers.map((reviewer: any) => reviewer.focus)).toEqual([
      "security and auth",
      "performance regressions",
    ]);
  });

  it("applies the shared configured focus to reviewers without their own focus", async () => {
    const prompt = vi.fn().mockResolvedValue({
      data: { parts: [{ type: "text", text: "candidate" }] },
    });
    const mock = client(prompt);
    const config: CrossReviewConfig = {
      reviewers: [{ model: "a/one" }, { model: "a/two" }],
      focus: "security and regressions",
    };
    await createCrossReviewTool(mock, () => wrapConfig(config)).execute(
      { target: "HEAD" },
      context(),
    );
    const calls = prompt.mock.calls.map((call) => call[0]);
    expect(calls).toHaveLength(2);
    expect(
      calls.every((call) =>
        call.body.parts[0].text.includes("Focus: security and regressions"),
      ),
    ).toBe(true);
  });

  it("resolves configured reviewModels round-robin across configured agents", async () => {
    const prompt = vi.fn().mockResolvedValue({
      data: { parts: [{ type: "text", text: "candidate" }] },
    });
    const mock = client(prompt);
    const config: CrossReviewConfig = {
      reviewModels: ["a/one"],
      agents: 4,
    };
    await createCrossReviewTool(mock, () => wrapConfig(config)).execute(
      { target: "HEAD" },
      context(),
    );
    const calls = prompt.mock.calls.map((call) => call[0]);
    expect(calls).toHaveLength(4);
    expect(calls.every((call) => call.body.model.modelID === "one")).toBe(true);
  });

  it("lets explicit arguments override configuration", async () => {
    const prompt = vi.fn().mockResolvedValue({
      data: { parts: [{ type: "text", text: "candidate" }] },
    });
    const mock = client(prompt);
    const config: CrossReviewConfig = {
      reviewers: [
        { model: "a/one", focus: "configured focus" },
        { model: "a/two", focus: "configured focus" },
      ],
      judgeModel: "b/judge",
      maxConcurrency: 1,
    };
    await createCrossReviewTool(mock, () => wrapConfig(config)).execute(
      {
        target: "HEAD",
        reviewModels: ["a/two"],
        agents: 1,
        focus: "override focus",
      },
      context(),
    );
    const calls = prompt.mock.calls.map((call) => call[0]);
    expect(calls).toHaveLength(3);
    expect(calls[0].body.model.modelID).toBe("judge");
    expect(calls[0].body.parts[0].text).toContain("context gatherer");
    expect(calls[1].body.model.modelID).toBe("two");
    expect(calls[1].body.parts[0].text).toContain("Focus: override focus");
    expect(calls[2].body.model.modelID).toBe("judge");
  });

  it("uses an explicit agent count with configured reviewers", async () => {
    const prompt = vi.fn().mockResolvedValue({
      data: { parts: [{ type: "text", text: "candidate" }] },
    });
    const mock = client(prompt);
    const config: CrossReviewConfig = {
      reviewers: [{ model: "a/one" }, { model: "a/two" }],
    };
    const result = await createCrossReviewTool(mock, () =>
      wrapConfig(config),
    ).execute({ target: "HEAD", agents: 1 }, context());
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(JSON.parse((result as any).output).reviewers).toHaveLength(1);
  });

  it("isolates failures when quorum survives and runs an explicit judge", async () => {
    let call = 0;
    const prompt = vi.fn().mockImplementation(async () => {
      call += 1;
      if (call === 3) throw new Error("reviewer unavailable");
      return {
        data: {
          parts: [{ type: "text", text: call === 5 ? "judged" : "candidate" }],
        },
      };
    });
    const result = await createCrossReviewTool(
      client(prompt),
      emptyConfig,
    ).execute(
      {
        target: "HEAD",
        reviewModels: ["a/one"],
        agents: 3,
        maxConcurrency: 1,
        judgeModel: "b/judge",
      },
      context(),
    );
    const parsed = JSON.parse((result as any).output);
    expect(parsed.reviewers.map((reviewer: any) => reviewer.status)).toEqual([
      "succeeded",
      "failed",
      "succeeded",
    ]);
    expect(parsed.judge).toMatchObject({
      model: "b/judge",
      status: "succeeded",
      output: "judged",
    });
    expect(prompt.mock.calls[4]?.[0].body.tools).toMatchObject({
      bash: false,
      edit: false,
      task: false,
      write: false,
      cross_review: false,
      cross_review_start: false,
      cross_review_status: false,
      cross_review_cancel: false,
      cross_review_finalize: false,
      session_review: false,
    });
  });

  it("reports reviewer provenance when failures prevent quorum", async () => {
    const mock = client(
      vi.fn().mockRejectedValue(new Error("provider request failed")),
    );
    const result = await createCrossReviewTool(mock, emptyConfig).execute(
      {
        target: "HEAD",
        reviewModels: ["a/one"],
        agents: 3,
        maxConcurrency: 2,
      },
      context(),
    );
    const parsed = JSON.parse((result as any).output);
    expect(parsed).toMatchObject({
      status: "quorum-not-met",
      quorum: 2,
    });
    expect(parsed.reviewers).toHaveLength(3);
    expect(parsed.reviewers[0]).toMatchObject({
      model: "a/one",
      sessionID: "child-1",
      status: "failed",
      error: "provider request failed",
    });
  });

  it("does not count message errors or empty outputs toward quorum", async () => {
    const prompt = vi
      .fn()
      .mockResolvedValueOnce({
        data: {
          info: {
            error: {
              name: "ProviderAuthError",
              data: { message: "credentials rejected" },
            },
          },
          parts: [],
        },
      })
      .mockResolvedValueOnce({ data: { parts: [] } })
      .mockResolvedValueOnce({
        data: { parts: [{ type: "text", text: "candidate" }] },
      });
    const result = await createCrossReviewTool(
      client(prompt),
      emptyConfig,
    ).execute(
      {
        target: "HEAD",
        reviewModels: ["a/one"],
        agents: 3,
        maxConcurrency: 1,
      },
      context(),
    );
    const parsed = JSON.parse((result as any).output);
    expect(parsed.status).toBe("quorum-not-met");
    expect(parsed.reviewers).toMatchObject([
      {
        status: "failed",
        error:
          "Reviewer prompt failed: ProviderAuthError: credentials rejected",
      },
      { status: "failed", error: "Reviewer prompt returned no text output" },
      { status: "succeeded", output: "candidate" },
    ]);
  });

  it("marks message-level aborts as cancelled", async () => {
    const prompt = vi
      .fn()
      .mockResolvedValueOnce({
        data: {
          info: {
            error: {
              name: "MessageAbortedError",
              data: { message: "review stopped" },
            },
          },
          parts: [],
        },
      })
      .mockResolvedValue({
        data: { parts: [{ type: "text", text: "candidate" }] },
      });
    const result = await createCrossReviewTool(
      client(prompt),
      emptyConfig,
    ).execute(
      {
        target: "HEAD",
        reviewModels: ["a/one"],
        agents: 3,
        maxConcurrency: 1,
      },
      context(),
    );
    expect(JSON.parse((result as any).output).reviewers[0]).toMatchObject({
      status: "cancelled",
      error: "Reviewer prompt failed: MessageAbortedError: review stopped",
    });
  });

  it("fails closed when the judge returns a message-level error", async () => {
    const prompt = vi
      .fn()
      .mockResolvedValueOnce({
        data: { parts: [{ type: "text", text: "candidate" }] },
      })
      .mockResolvedValueOnce({
        data: { parts: [{ type: "text", text: "candidate" }] },
      })
      .mockResolvedValueOnce({
        data: {
          info: {
            error: {
              name: "MessageOutputLengthError",
              data: { message: "output limit reached" },
            },
          },
          parts: [],
        },
      });
    await expect(
      createCrossReviewTool(client(prompt), emptyConfig).execute(
        {
          target: "HEAD",
          reviewModels: ["a/one"],
          agents: 1,
          judgeModel: "b/judge",
        },
        context(),
      ),
    ).rejects.toThrow("Judge prompt failed: MessageOutputLengthError");
  });

  it("embeds parent-gathered context in reviewer and judge briefs without gathering", async () => {
    const prompt = vi.fn().mockResolvedValue({
      data: { parts: [{ type: "text", text: "candidate" }] },
    });
    const mock = client(prompt);
    await createCrossReviewTool(mock, emptyConfig).execute(
      {
        target: "HEAD",
        context: "shared diff context",
        reviewModels: ["a/one"],
        agents: 1,
        judgeModel: "b/judge",
      },
      context(),
    );
    const calls = prompt.mock.calls.map((call) => call[0]);
    expect(calls).toHaveLength(2);
    expect(calls[0].body.parts[0].text).toContain("shared diff context");
    expect(calls[1].body.parts[0].text).toContain("shared diff context");
  });

  it("degrades to independent fetching when gathering fails", async () => {
    const prompt = vi
      .fn()
      .mockRejectedValueOnce(new Error("gather failed"))
      .mockResolvedValue({
        data: { parts: [{ type: "text", text: "candidate" }] },
      });
    const mock = client(prompt);
    const result = await createCrossReviewTool(mock, emptyConfig).execute(
      {
        target: "HEAD",
        reviewModels: ["a/one"],
        agents: 1,
        judgeModel: "b/judge",
      },
      context(),
    );
    const parsed = JSON.parse((result as any).output);
    expect(parsed.gatherer).toMatchObject({
      model: "b/judge",
      status: "failed",
    });
    expect(parsed.reviewers[0].status).toBe("succeeded");
    expect(prompt.mock.calls[1]?.[0].body.parts[0].text).not.toContain(
      "gather failed",
    );
    expect(parsed.judge).toMatchObject({
      model: "b/judge",
      status: "succeeded",
    });
  });

  it("treats an empty context as not provided and still gathers", async () => {
    const prompt = vi.fn().mockResolvedValue({
      data: { parts: [{ type: "text", text: "candidate" }] },
    });
    const mock = client(prompt);
    const definition = createCrossReviewTool(mock, emptyConfig);
    expect(definition.args.context.safeParse("").success).toBe(false);
    await definition.execute(
      {
        target: "HEAD",
        context: "",
        reviewModels: ["a/one"],
        agents: 1,
        judgeModel: "b/judge",
      },
      context(),
    );
    const calls = prompt.mock.calls.map((call) => call[0]);
    expect(calls).toHaveLength(3);
    expect(calls[0].body.parts[0].text).toContain("context gatherer");
  });

  it("aborts child sessions when the parent is cancelled", async () => {
    const abort = new AbortController();
    const prompt = vi.fn().mockImplementation(
      ({ signal }: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => reject(new Error("aborted")),
            {
              once: true,
            },
          );
          abort.abort();
        }),
    );
    const mock = client(prompt);
    await expect(
      createCrossReviewTool(mock, emptyConfig).execute(
        {
          target: "HEAD",
          reviewModels: ["a/one"],
          agents: 3,
          maxConcurrency: 1,
        },
        context(abort),
      ),
    ).rejects.toThrow("cancelled");
    expect(mock.session.abort).toHaveBeenCalledWith({
      path: { id: "child-1" },
      query: { directory: "/repo" },
    });
    expect(mock.session.create).toHaveBeenCalledTimes(1);
  });

  it("does not start when cancellation happened before execution", async () => {
    const abort = new AbortController();
    abort.abort();
    const mock = client();
    await expect(
      createCrossReviewTool(mock, emptyConfig).execute(
        { target: "HEAD", reviewModels: ["a/one"] },
        context(abort),
      ),
    ).rejects.toThrow("cancelled");
    expect(mock.provider.list).not.toHaveBeenCalled();
    expect(mock.session.create).not.toHaveBeenCalled();
  });

  it("aborts a session created while cancellation is in flight", async () => {
    const abort = new AbortController();
    const mock = client();
    mock.session.create.mockImplementationOnce(async () => {
      abort.abort();
      return { data: { id: "child-in-flight" } };
    });
    await expect(
      createCrossReviewTool(mock, emptyConfig).execute(
        {
          target: "HEAD",
          reviewModels: ["a/one"],
          agents: 1,
        },
        context(abort),
      ),
    ).rejects.toThrow("cancelled");
    expect(mock.session.abort).toHaveBeenCalledWith({
      path: { id: "child-in-flight" },
      query: { directory: "/repo" },
    });
    expect(mock.session.prompt).not.toHaveBeenCalled();
  });

  it("warns when the project config is absent and global config is used", async () => {
    const mock = client();
    const result = await createCrossReviewTool(
      mock,
      wrapConfig.bind(
        null,
        { reviewers: [{ model: "a/one" }] },
        {
          project: "absent",
          global: "loaded",
        },
      ),
    ).execute({ target: "HEAD", agents: 1 }, context());
    const parsed = JSON.parse((result as any).output);
    expect(parsed.warning).toContain(
      "project config not found at /repo/.opencode/cross-review.json",
    );
    expect(parsed.warning).toContain(
      "using global config at /home/.config/opencode/cross-review.json",
    );
    expect(parsed.target).toBe("HEAD");
    expect(parsed.judge).toMatchObject({ model: "parent-session" });
    expect((result as any).metadata.configSources).toEqual({
      project: "absent",
      global: "loaded",
    });
    expect((result as any).metadata.projectConfigPath).toBe(
      "/repo/.opencode/cross-review.json",
    );
    expect((result as any).metadata.globalConfigPath).toBe(
      "/home/.config/opencode/cross-review.json",
    );
  });

  it("warns when both project and global configs are absent", async () => {
    const mock = client();
    const result = await createCrossReviewTool(mock, emptyConfig).execute(
      { target: "HEAD", reviewModels: ["a/one"], agents: 1 },
      context(),
    );
    const parsed = JSON.parse((result as any).output);
    expect(parsed.warning).toContain(
      "no cross-review config found at /repo/.opencode/cross-review.json",
    );
    expect((result as any).metadata.configSources).toEqual({
      project: "absent",
      global: "absent",
    });
  });

  it("rejects invocations from child sessions with a parentID", async () => {
    const mock = client();
    mock.session.get.mockResolvedValue({
      data: { id: "parent", parentID: "root-parent-session" },
    });
    await expect(
      createCrossReviewTool(mock, emptyConfig).execute(
        { target: "HEAD", reviewModels: ["a/one"], agents: 1 },
        context(),
      ),
    ).rejects.toThrow("cross_review can only be invoked from primary sessions");
    expect(mock.session.create).not.toHaveBeenCalled();
    expect(mock.provider.list).not.toHaveBeenCalled();
  });

  it("rejects invocations when session inspection is unavailable", async () => {
    const mock = client();
    (mock.session as { get?: unknown }).get = undefined;
    await expect(
      createCrossReviewTool(mock, emptyConfig).execute(
        { target: "HEAD", reviewModels: ["a/one"], agents: 1 },
        context(),
      ),
    ).rejects.toThrow(
      "cross_review can only be invoked from primary sessions: session inspection is unavailable",
    );
    expect(mock.session.create).not.toHaveBeenCalled();
  });

  it("omits the warning and structured sources from output when the project config loads", async () => {
    const mock = client();
    const result = await createCrossReviewTool(mock, () =>
      wrapConfig({ reviewers: [{ model: "a/one" }] }),
    ).execute({ target: "HEAD", agents: 1 }, context());
    const parsed = JSON.parse((result as any).output);
    expect(parsed.warning).toBeUndefined();
    expect(parsed.target).toBe("HEAD");
    expect((result as any).metadata.configSources).toEqual({
      project: "loaded",
      global: "absent",
    });
  });
});

describe("cross_review tool PR snapshot path", () => {
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

  function legacyPrTool(
    mock: CrossReviewClient,
    options: {
      classify?: any;
      runPrAdapter?: any;
      removeSnapshot?: any;
      loadConfig?: () => Promise<LoadedCrossReviewConfig>;
    } = {},
  ) {
    const runPrAdapter = options.runPrAdapter ?? okAdapter();
    const removeSnapshot =
      options.removeSnapshot ?? vi.fn().mockResolvedValue(undefined);
    const tool = createCrossReviewTool(
      mock,
      options.loadConfig ?? emptyConfig,
      {
        classifyTarget:
          options.classify ??
          vi.fn().mockResolvedValue({ kind: "pr", forge: "github" }),
        runPrAdapter,
        stateRoot: "/state",
        removeSnapshot,
      },
    );
    return { tool, runPrAdapter, removeSnapshot };
  }

  it("runs the adapter, binds sessions to the snapshot, and cleans up on success", async () => {
    const mock = client();
    const { tool, runPrAdapter, removeSnapshot } = legacyPrTool(mock);

    const result = await tool.execute(
      {
        target: "https://github.com/org/repo/pull/69",
        reviewModels: ["a/one"],
        agents: 1,
        judgeModel: "b/judge",
      },
      context(),
    );

    expect(runPrAdapter).toHaveBeenCalledWith(
      expect.objectContaining({
        forge: "github",
        target: "https://github.com/org/repo/pull/69",
        stateRoot: "/state",
      }),
    );
    // No gatherer LLM session: one reviewer + one judge.
    expect(mock.session.create).toHaveBeenCalledTimes(2);
    for (const call of mock.session.create.mock.calls)
      expect(call[0].query.directory).toBe(WORKTREE);
    for (const call of mock.session.prompt.mock.calls)
      expect(call[0].query.directory).toBe(WORKTREE);
    const parsed = JSON.parse((result as any).output);
    expect(parsed.gatherer).toBeUndefined();
    // Reviewer brief points at the snapshot, not embedded context.
    const brief = mock.session.prompt.mock.calls[0][0].body.parts[0].text;
    expect(brief).toContain("isolated git worktree snapshot");
    expect(brief).not.toContain("Shared target context");
    expect(removeSnapshot).toHaveBeenCalledWith(WORKTREE);
  });

  it("forwards context as notes and never embeds it in briefs", async () => {
    const mock = client();
    const { tool, runPrAdapter } = legacyPrTool(mock);

    await tool.execute(
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
    const brief = mock.session.prompt.mock.calls[0][0].body.parts[0].text;
    expect(brief).not.toContain("watch the auth rewrite");
    expect(brief).not.toContain("Shared target context");
  });

  it("fails before reviewer sessions on adapter failure and retains the snapshot", async () => {
    const mock = client();
    const failing = vi.fn().mockResolvedValue({
      ok: false,
      error: "gh not authenticated",
      snapshotPath: "/state/failed/worktree",
    });
    const { tool, removeSnapshot } = legacyPrTool(mock, {
      runPrAdapter: failing,
    });

    await expect(
      tool.execute(
        {
          target: "https://github.com/org/repo/pull/69",
          reviewModels: ["a/one"],
          agents: 1,
        },
        context(),
      ),
    ).rejects.toThrow(
      "gh not authenticated (snapshot retained at /state/failed/worktree)",
    );
    expect(mock.session.create).not.toHaveBeenCalled();
    expect(removeSnapshot).not.toHaveBeenCalled();
  });

  it("keeps legacy targets unchanged", async () => {
    const mock = client();
    const legacyClassify = vi.fn().mockResolvedValue({ kind: "legacy" });
    const { tool, runPrAdapter, removeSnapshot } = legacyPrTool(mock, {
      classify: legacyClassify,
    });

    const result = await tool.execute(
      {
        target: "main...HEAD",
        reviewModels: ["a/one"],
        agents: 1,
        judgeModel: "b/judge",
      },
      context(),
    );

    expect(runPrAdapter).not.toHaveBeenCalled();
    expect(removeSnapshot).not.toHaveBeenCalled();
    // Legacy gather phase: gatherer session first, then reviewer, then judge.
    expect(mock.session.create.mock.calls[0][0].query.directory).toBe("/repo");
    const parsed = JSON.parse((result as any).output);
    expect(parsed.gatherer).toMatchObject({ status: "succeeded" });
  });
});

describe("cross_review tool snapshot leak recovery", () => {
  it("persists a terminal failed manifest for a retained adapter snapshot", async () => {
    const mock = client();
    const root = await mkdtemp(join(tmpdir(), "legacy-pr-manifest-"));
    const WORKTREE = join(root, "worktree");
    await mkdir(WORKTREE, { recursive: true });
    const failing = vi.fn().mockResolvedValue({
      ok: false,
      error: "gh not authenticated",
      snapshotPath: WORKTREE,
    });
    const removeSnapshot = vi.fn().mockResolvedValue(undefined);
    const tool = createCrossReviewTool(mock, emptyConfig, {
      classifyTarget: vi
        .fn()
        .mockResolvedValue({ kind: "pr", forge: "github" }),
      runPrAdapter: failing,
      stateRoot: root,
      removeSnapshot,
    });

    await expect(
      tool.execute(
        {
          target: "https://github.com/org/repo/pull/69",
          reviewModels: ["a/one"],
          agents: 1,
        },
        context(),
      ),
    ).rejects.toThrow("gh not authenticated");

    // The failed manifest exists so the 7-day terminal cleanup can find it.
    const manifests = (await readdir(root)).filter((name) =>
      name.endsWith(".json"),
    );
    expect(manifests.length).toBe(1);
    const manifest = JSON.parse(
      await readFile(join(root, manifests[0] as string), "utf8"),
    );
    expect(manifest.phase).toBe("failed");
    expect(manifest.snapshot.worktree).toBe(WORKTREE);
    expect(removeSnapshot).not.toHaveBeenCalled();
  });

  it("persists a failed manifest when quorum is not met after a snapshot", async () => {
    // The single reviewer's prompt fails, so quorum (1) is never met.
    const mock = client(
      vi.fn().mockRejectedValue(new Error("provider request failed")),
    );
    const root = await mkdtemp(join(tmpdir(), "legacy-pr-quorum-"));
    const WORKTREE = join(root, "worktree");
    const okAdapter = vi.fn().mockResolvedValue({
      ok: true,
      worktree: WORKTREE,
      snapshotDir: join(WORKTREE, ".cross-review"),
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
    const removeSnapshot = vi.fn().mockResolvedValue(undefined);
    const tool = createCrossReviewTool(mock, emptyConfig, {
      classifyTarget: vi
        .fn()
        .mockResolvedValue({ kind: "pr", forge: "github" }),
      runPrAdapter: okAdapter,
      stateRoot: root,
      removeSnapshot,
    });
    const result = await tool.execute(
      {
        target: "https://github.com/org/repo/pull/69",
        reviewModels: ["a/one"],
        agents: 1,
      },
      context(),
    );
    const parsed = JSON.parse((result as any).output);
    expect(parsed.status).toBe("quorum-not-met");
    expect(removeSnapshot).not.toHaveBeenCalled();

    const manifests = (await readdir(root)).filter((name) =>
      name.endsWith(".json"),
    );
    expect(manifests.length).toBe(1);
    const manifest = JSON.parse(
      await readFile(join(root, manifests[0] as string), "utf8"),
    );
    expect(manifest.phase).toBe("failed");
    expect(manifest.snapshot.worktree).toBe(WORKTREE);
  });
});
