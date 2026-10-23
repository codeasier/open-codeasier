import type { ToolContext } from "@opencode-ai/plugin";
import type { Part, UserMessage } from "@opencode-ai/sdk";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { createCrossReviewInvocationGuard } from "../src/cross-review/invocation.js";
import { createCrossReviewProtocolTools } from "../src/cross-review/protocol.js";
import { createCrossReviewTool } from "../src/cross-review/tool.js";
import type { CrossReviewRunStore } from "../src/cross-review/run-store.js";
import type { CrossReviewConfirmation } from "../src/cross-review/confirmation.js";

async function fixture() {
  const client = {
    provider: {
      list: vi.fn().mockResolvedValue({
        data: {
          all: [{ id: "p", models: { reviewer: {}, judge: {} } }],
          connected: ["p"],
        },
      }),
    },
    session: {
      get: vi.fn().mockResolvedValue({ data: { id: "parent" } }),
      message: vi.fn().mockResolvedValue({
        data: {
          info: {
            id: "assistant",
            sessionID: "parent",
            role: "assistant",
            parentID: "user",
          },
        },
      }),
      create: vi.fn(),
      prompt: vi.fn(),
      promptAsync: vi.fn(),
      status: vi.fn(),
      messages: vi.fn(),
      abort: vi.fn(),
    },
  };
  const guard = createCrossReviewInvocationGuard(client);
  const context: ToolContext = {
    sessionID: "parent",
    messageID: "assistant",
    directory: "/repo",
    worktree: "/repo",
    agent: "build",
    abort: new AbortController().signal,
    metadata() {},
    // Simulate an automatic/remembered permission allow. It cannot confirm startup.
    ask: vi.fn(() => Effect.void),
  };
  const config = {
    reviewers: [{ model: "p/reviewer" }],
    judgeModel: "p/judge",
    maxConcurrency: 1,
  };
  const loadConfig = vi.fn(async () => ({
    config,
    sources: { project: "loaded" as const, global: "absent" as const },
    projectPath: "/repo/.opencode/cross-review.json",
    globalPath: "/home/.config/opencode/cross-review.json",
  }));
  const runPrAdapter = vi
    .fn()
    .mockRejectedValue(new Error("adapter boundary reached"));
  const store: CrossReviewRunStore = {
    create: vi.fn(),
    withRun: vi.fn(),
    read: vi.fn(),
    listByOwner: vi.fn(),
    cleanupExpiredRuns: vi.fn(),
  };
  const { assertInvocation, prepareConfirmation, confirmStart } = guard;
  const tools = createCrossReviewProtocolTools(client, {
    loadConfig,
    store,
    assertInvocation,
    prepareConfirmation,
    confirmStart,
    classifyTarget: async () => ({ kind: "pr", forge: "github" }),
    runPrAdapter,
    canonicalize: async (directory) => directory,
  });
  const legacy = createCrossReviewTool(client, loadConfig, {
    assertInvocation,
    confirmStart,
    classifyTarget: async () => ({ kind: "pr", forge: "github" }),
    runPrAdapter,
  });
  await guard["chat.message"](
    { sessionID: "parent" },
    {
      message: { id: "user", sessionID: "parent", role: "user" } as UserMessage,
      parts: [{ type: "text", text: "/cross-review #42" }] as Part[],
    },
  );
  const preview = async () => {
    const result = await tools.cross_review_config.execute(
      { target: "#42" },
      context,
    );
    return (
      JSON.parse(typeof result === "string" ? result : result.output) as {
        confirmation: CrossReviewConfirmation;
      }
    ).confirmation;
  };
  const approve = async () => {
    const confirmation = await preview();
    const args = { questions: confirmation.questions };
    await guard["tool.execute.before"](
      { tool: "question", sessionID: "parent", callID: "q" },
      { args },
    );
    await guard["tool.execute.after"](
      { tool: "question", sessionID: "parent", callID: "q", args },
      {
        title: "Question answered",
        output: "",
        metadata: { answers: [["Start cross-review"]] },
      },
    );
  };
  return {
    client,
    context,
    config,
    tools,
    legacy,
    store,
    runPrAdapter,
    preview,
    approve,
  };
}

describe.each(["async", "legacy"] as const)(
  "%s start confirmation enforcement",
  (entry) => {
    const start = (f: Awaited<ReturnType<typeof fixture>>) =>
      entry === "async"
        ? f.tools.cross_review_start.execute({ target: "#42" }, f.context)
        : f.legacy.execute({ target: "#42" }, f.context);

    it("blocks a command with no startup answer even when permission would auto-allow", async () => {
      const f = await fixture();
      await f.preview();
      await expect(start(f)).rejects.toThrow(
        "fresh explicit user confirmation",
      );
      expect(f.context.ask).not.toHaveBeenCalled();
      expect(f.runPrAdapter).not.toHaveBeenCalled();
      expect(f.client.session.create).not.toHaveBeenCalled();
      expect(f.store.create).not.toHaveBeenCalled();
    });

    it("allows the confirmed plan through permission once, before reaching snapshot I/O", async () => {
      const f = await fixture();
      await f.approve();
      await expect(start(f)).rejects.toThrow("adapter boundary reached");
      expect(f.context.ask).toHaveBeenCalledOnce();
      expect(f.runPrAdapter).toHaveBeenCalledOnce();
      await expect(start(f)).rejects.toThrow(
        "fresh explicit user confirmation",
      );
      expect(f.runPrAdapter).toHaveBeenCalledOnce();
    });

    it("requires a new answer if configuration changes between preview and start", async () => {
      const f = await fixture();
      await f.approve();
      f.config.judgeModel = "p/reviewer";
      await expect(start(f)).rejects.toThrow(
        "fresh explicit user confirmation",
      );
      expect(f.context.ask).not.toHaveBeenCalled();
      expect(f.runPrAdapter).not.toHaveBeenCalled();
      expect(f.store.create).not.toHaveBeenCalled();
    });

    it("rechecks confirmation if a new preview arrives while permission is pending", async () => {
      const f = await fixture();
      await f.approve();
      f.context.ask = vi.fn(() =>
        Effect.promise(async () => {
          await f.preview();
        }),
      );
      await expect(start(f)).rejects.toThrow(
        "confirmation is no longer current",
      );
      expect(f.context.ask).toHaveBeenCalledOnce();
      expect(f.runPrAdapter).not.toHaveBeenCalled();
      expect(f.client.session.create).not.toHaveBeenCalled();
      expect(f.store.create).not.toHaveBeenCalled();
    });
  },
);
