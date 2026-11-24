import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import plugin from "../src/plugin.js";
import {
  applySessionActivity,
  createV1Client,
} from "../src/opencode-v2/client.js";
import { toV1Messages } from "../src/opencode-v2/messages.js";
import type { V2Host, V2ToolDefinition } from "../src/opencode-v2/host.js";
import { FileCrossReviewRunStore } from "../src/cross-review/run-store.js";

describe("OpenCode V2 messages", () => {
  it("links an assistant reply to the preceding user message", () => {
    const messages = toV1Messages("ses", [
      { type: "user", id: "user", time: { created: 1 }, text: "review" },
      {
        type: "assistant",
        id: "assistant",
        time: { created: 2, completed: 3 },
        finish: "stop",
        content: [{ type: "text", text: "done" }],
      },
    ]);
    expect(messages).toMatchObject([
      { info: { id: "user", role: "user", sessionID: "ses" } },
      {
        info: {
          id: "assistant",
          role: "assistant",
          parentID: "user",
          finish: "stop",
          time: { completed: 3 },
        },
        parts: [{ type: "text", text: "done" }],
      },
    ]);
  });
});

describe("OpenCode V2 client", () => {
  it("dispatches a child prompt without waiting and records denied tools", async () => {
    const restricted = new Map<string, ReadonlySet<string>>();
    const prompt = vi.fn().mockResolvedValue({ id: "msg" });
    const wait = vi.fn();
    const client = createV1Client(
      {
        location: { directory: "/repo" },
        session: {
          prompt,
          wait,
          switchAgent: vi.fn().mockResolvedValue(undefined),
          switchModel: vi.fn().mockResolvedValue(undefined),
        },
      } as unknown as V2Host,
      restricted,
    );
    const result = await client.session.promptAsync({
      body: {
        messageID: "msg_1",
        agent: "cross-reviewer",
        model: { providerID: "openai", modelID: "gpt" },
        parts: [{ type: "text", text: "look" }],
        tools: { bash: false, read: true },
      },
      path: { id: "child" },
      query: { directory: "/repo" },
    });
    expect(result.error).toBeUndefined();
    expect(prompt).toHaveBeenCalledWith(
      {
        sessionID: "child",
        id: "msg_1",
        text: "look",
        delivery: "queue",
      },
      undefined,
    );
    expect(wait).not.toHaveBeenCalled();
    expect(restricted.get("child")?.has("bash")).toBe(true);
    expect(restricted.get("child")?.has("read")).toBe(false);
  });

  it("builds the connected model catalog from V2 model.list", async () => {
    const client = createV1Client(
      {
        model: {
          list: vi.fn().mockResolvedValue({
            data: [
              {
                providerID: "openai",
                modelID: "gpt",
                enabled: true,
                limit: { context: 128_000 },
              },
              { providerID: "openai", modelID: "old", enabled: false },
            ],
          }),
        },
      } as unknown as V2Host,
      new Map(),
    );
    const catalog = await client.provider.list({
      query: { directory: "/repo" },
    });
    expect(catalog.data).toEqual({
      connected: ["openai"],
      all: [
        {
          id: "openai",
          models: { gpt: { limit: { context: 128_000 } } },
        },
      ],
    });
  });

  it("tracks busy and retry from session events and drops idle sessions", async () => {
    const activity = new Map();
    const client = createV1Client({} as V2Host, new Map(), activity);
    applySessionActivity(activity, {
      type: "session.execution.started",
      data: { sessionID: "child" },
    });
    applySessionActivity(activity, {
      type: "session.status",
      data: {
        sessionID: "other",
        status: { type: "retry", attempt: 2, message: "rate", next: 9 },
      },
    });
    applySessionActivity(activity, {
      type: "session.status",
      data: { sessionID: "gone", status: { type: "idle" } },
    });
    const status = await client.session.status({
      query: { directory: "/repo" },
    });
    expect(status.data).toEqual({
      child: { type: "busy" },
      other: { type: "retry", attempt: 2, message: "rate", next: 9 },
    });
    applySessionActivity(activity, {
      type: "session.idle",
      data: { sessionID: "child" },
    });
    const after = await client.session.status({
      query: { directory: "/repo" },
    });
    expect(after.data).toEqual({
      other: { type: "retry", attempt: 2, message: "rate", next: 9 },
    });
  });

  it("maps a tagged session-not-found error onto the V1 not-found result", async () => {
    const client = createV1Client(
      {
        session: {
          get: vi.fn().mockRejectedValue(
            Object.assign(new Error("missing session"), {
              _tag: "SessionNotFoundError",
            }),
          ),
        },
      } as unknown as V2Host,
      new Map(),
    );
    const result = await client.session.get({ path: { id: "missing" } });
    expect(result.response.status).toBe(404);
    expect(result.error).toMatchObject({
      name: "NotFoundError",
      data: { message: "missing session" },
    });
  });
});

describe("OpenCode V2 plugin", () => {
  const cleanups: Array<() => Promise<void>> = [];
  let cleanupRuns: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    cleanupRuns = vi
      .spyOn(FileCrossReviewRunStore.prototype, "cleanupExpiredRuns")
      .mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
    cleanupRuns.mockRestore();
  });

  function host() {
    const tools: V2ToolDefinition[] = [];
    const agents: Array<{
      id: string;
      permissions: Array<Record<string, string>>;
    }> = [
      {
        id: "build",
        permissions: [{ action: "edit", resource: "*", effect: "allow" }],
      },
    ];
    let contextHook:
      | ((event: {
          sessionID: string;
          tools: Record<string, { description: string; input: unknown }>;
        }) => void)
      | undefined;
    let promptHook:
      | ((event: {
          sessionID: string;
          messageID: string;
          prompt: { text?: string };
        }) => Promise<void>)
      | undefined;
    const queued: Array<{ type: string; data?: Record<string, unknown> }> = [];
    let wake: (() => void) | undefined;
    const created = vi.fn();
    const asserted = vi.fn();
    const v2 = {
      location: { directory: "/repo" },
      session: {
        get: vi.fn(async ({ sessionID }: { sessionID: string }) => ({
          id: sessionID,
          title: "x",
          time: { created: 1, updated: 2 },
          location: { directory: "/repo" },
        })),
        context: vi.fn(async () => [
          {
            type: "user",
            id: "user",
            time: { created: 1 },
            text: "/cross-review #42",
          },
          {
            type: "assistant",
            id: "assistant",
            time: { created: 2, completed: 3 },
            finish: "stop",
            content: [{ type: "text", text: "ok" }],
          },
        ]),
        create: created,
        list: vi.fn(),
        prompt: vi.fn(),
        interrupt: vi.fn(),
        switchAgent: vi.fn(),
        switchModel: vi.fn(),
        wait: vi.fn(),
        hook: vi.fn(
          async (name: string, callback: (event: never) => unknown) => {
            if (name === "context")
              contextHook = callback as typeof contextHook;
            if (name === "prompt") promptHook = callback as typeof promptHook;
            return { async dispose() {} };
          },
        ),
      },
      model: { list: vi.fn().mockResolvedValue({ data: [] }) },
      tool: {
        transform: vi.fn(
          async (
            callback: (editor: { add(tool: V2ToolDefinition): void }) => void,
          ) => {
            callback({
              add(tool) {
                tools.push(tool);
              },
            });
            return { async dispose() {} };
          },
        ),
        hook: vi.fn(async () => ({ async dispose() {} })),
      },
      agent: {
        transform: vi.fn(
          async (
            callback: (editor: {
              list(): typeof agents;
              update(
                id: string,
                update: (agent: (typeof agents)[number]) => void,
              ): void;
            }) => void,
          ) => {
            callback({
              list: () => agents,
              update(_id, update) {
                const agent = agents[0];
                if (agent !== undefined) update(agent);
              },
            });
            return { async dispose() {} };
          },
        ),
      },
      permission: { assert: asserted },
      event: {
        subscribe({ signal }: { signal?: AbortSignal } = {}) {
          return {
            async *[Symbol.asyncIterator]() {
              while (signal?.aborted !== true) {
                const next = queued.shift();
                if (next !== undefined) {
                  yield next;
                  continue;
                }
                await new Promise<void>((resolve) => {
                  wake = resolve;
                  signal?.addEventListener("abort", () => resolve(), {
                    once: true,
                  });
                });
              }
            },
          };
        },
      },
      push(event: { type: string; data?: Record<string, unknown> }) {
        queued.push(event);
        wake?.();
      },
      tools,
      agents,
      created,
      asserted,
      contextHook: () => contextHook,
      promptHook: () => promptHook,
    };
    return v2;
  }

  it("registers every current tool and the ask defaults", async () => {
    const v2 = host();
    cleanups.push(await plugin.setup(v2 as unknown as V2Host));
    expect(cleanupRuns).toHaveBeenCalled();
    expect(v2.tools.map((entry) => entry.name)).toEqual([
      "cross_review",
      "cross_review_config",
      "cross_review_start",
      "cross_review_status",
      "cross_review_cancel",
      "cross_review_finalize",
      "session_review",
      "cross_review_audit",
    ]);
    const sessionReview = v2.tools.find(
      (entry) => entry.name === "session_review",
    );
    expect(sessionReview?.input).toMatchObject({
      type: "object",
      required: ["sessionID", "mode"],
      additionalProperties: false,
    });
    expect(v2.agents[0]?.permissions.slice(0, 2)).toEqual([
      { action: "cross_review_start", resource: "*", effect: "ask" },
      { action: "cross_review", resource: "*", effect: "ask" },
    ]);
    expect(v2.agents[0]?.permissions.at(-1)).toEqual({
      action: "edit",
      resource: "*",
      effect: "allow",
    });
  });

  it("runs session_review through the V2 session APIs", async () => {
    const v2 = host();
    cleanups.push(await plugin.setup(v2 as unknown as V2Host));
    const sessionReview = v2.tools.find(
      (entry) => entry.name === "session_review",
    );
    if (sessionReview === undefined) throw new Error("missing session_review");
    const result = await sessionReview.execute(
      { sessionID: "ses_123", mode: "summary" },
      {
        sessionID: "current",
        agent: "build",
        messageID: "assistant",
        id: "call",
        signal: new AbortController().signal,
        progress: vi.fn(),
      },
    );
    expect(v2.session.get).toHaveBeenCalledWith(
      { sessionID: "current" },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(v2.session.context).toHaveBeenCalledWith(
      { sessionID: "ses_123" },
      expect.any(Object),
    );
    expect(result.content).toContain('"sessionID":"ses_123"');
    expect(result.metadata).toMatchObject({
      mode: "summary",
      title: "Session review input: ses_123",
    });
  });

  it("blocks cross_review_start until /cross-review is executed", async () => {
    const v2 = host();
    cleanups.push(await plugin.setup(v2 as unknown as V2Host));
    const start = v2.tools.find((entry) => entry.name === "cross_review_start");
    if (start === undefined) throw new Error("missing cross_review_start");
    const context = {
      sessionID: "parent",
      agent: "build",
      messageID: "assistant",
      id: "call",
      signal: new AbortController().signal,
      progress: vi.fn(),
    };
    await expect(start.execute({ target: "#42" }, context)).rejects.toThrow(
      "requires an explicit user /cross-review <target> command",
    );
    v2.push({
      type: "command.executed",
      data: {
        name: "cross-review",
        sessionID: "parent",
        messageID: "user",
        arguments: "#42",
      },
    });
    await vi.waitFor(async () => {
      await expect(
        start.execute({ target: "#42" }, context),
      ).rejects.not.toThrow(/requires an explicit user/);
    });
    const prompt = v2.promptHook();
    if (prompt === undefined) throw new Error("missing prompt hook");
    await prompt({
      sessionID: "parent",
      messageID: "user",
      prompt: {
        text: "The user invoked this OpenCode slash command:\n\n/cross-review #42\n\nLoad the skill.",
      },
    });
    await expect(start.execute({ target: "#42" }, context)).rejects.not.toThrow(
      /requires an explicit user/,
    );
    expect(v2.created).not.toHaveBeenCalled();
    expect(v2.asserted).not.toHaveBeenCalled();
    const hideTools = v2.contextHook();
    expect(hideTools).toBeTypeOf("function");
  });
});
