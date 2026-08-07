/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it, vi } from "vitest";
import {
  createCrossReviewTool,
  type CrossReviewClient,
} from "../src/cross-review/tool.js";

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
          ],
          connected: ["a", "b"],
        },
      }),
    },
    session: {
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
    const definition = createCrossReviewTool(mock);
    await expect(
      definition.execute(
        {
          target: "HEAD",
          reviewModels: ["malformed"],
          agents: 3,
          maxConcurrency: 3,
        },
        context(),
      ),
    ).rejects.toThrow("Invalid model identifier");
    await expect(
      definition.execute(
        {
          target: "HEAD",
          reviewModels: ["a/missing"],
          agents: 3,
          maxConcurrency: 3,
        },
        context(),
      ),
    ).rejects.toThrow("Unavailable model");
    expect(definition.args.agents.safeParse(9).success).toBe(false);
    expect(mock.session.create).not.toHaveBeenCalled();
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
    const output = await createCrossReviewTool(mock).execute(
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
    expect(JSON.parse((output as any).output)).toMatchObject({
      quorum: 3,
      judge: { model: "parent-session" },
    });
  });

  it("isolates failures when quorum survives and runs an explicit judge", async () => {
    let call = 0;
    const prompt = vi.fn().mockImplementation(async () => {
      call += 1;
      if (call === 2) throw new Error("reviewer unavailable");
      return {
        data: {
          parts: [{ type: "text", text: call === 4 ? "judged" : "candidate" }],
        },
      };
    });
    const result = await createCrossReviewTool(client(prompt)).execute(
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
    expect(prompt.mock.calls[3]?.[0].body.tools).toMatchObject({
      bash: false,
      edit: false,
      task: false,
      write: false,
    });
  });

  it("reports reviewer provenance when failures prevent quorum", async () => {
    const mock = client(
      vi.fn().mockRejectedValue(new Error("provider request failed")),
    );
    const result = await createCrossReviewTool(mock).execute(
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
      createCrossReviewTool(mock).execute(
        {
          target: "HEAD",
          reviewModels: ["a/one"],
          agents: 1,
          maxConcurrency: 1,
        },
        context(abort),
      ),
    ).rejects.toThrow("cancelled");
    expect(mock.session.abort).toHaveBeenCalledWith({
      path: { id: "child-1" },
      query: { directory: "/repo" },
    });
  });
});
