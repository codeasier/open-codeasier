import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import plugin from "../src/plugin.js";
import {
  applySessionActivity,
  createV1Client,
} from "../src/opencode-v2/client.js";
import { toV1Messages } from "../src/opencode-v2/messages.js";
import { childReviewPermissions } from "../src/opencode-v2/policy.js";
import type {
  V2CommandDefinition,
  V2Host,
  V2PromptEvent,
  V2ToolDefinition,
  V2ToolHookEvent,
} from "../src/opencode-v2/host.js";
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
          get: vi.fn().mockResolvedValue({
            id: "child",
            permissions: childReviewPermissions([]),
          }),
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
    const commands = new Map<string, V2CommandDefinition>();
    const toolHooks = new Map<
      string,
      (event: V2ToolHookEvent) => Promise<void>
    >();
    let currentUserID = "user";
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
    let promptHook: ((event: V2PromptEvent) => Promise<void>) | undefined;
    const queued: Array<{ type: string; data?: Record<string, unknown> }> = [];
    let wake: (() => void) | undefined;
    const created = vi.fn();
    const asserted = vi.fn();
    const v2 = {
      location: { directory: "/repo" },
      command: {
        async transform(
          edit: (editor: {
            add: (command: V2CommandDefinition) => void;
          }) => void,
        ) {
          edit({ add: (command) => commands.set(command.name, command) });
          return { async dispose() {} };
        },
      },
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
            id: currentUserID,
            time: { created: 1 },
            text: "review target",
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
        prompt: vi.fn(
          async (input: { sessionID: string; id: string; text: string }) => {
            currentUserID = input.id;
            await promptHook?.({
              sessionID: input.sessionID,
              messageID: input.id,
              prompt: { text: input.text },
            });
            return { id: input.id };
          },
        ),
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
        hook: vi.fn(
          async (
            name: string,
            callback: (event: V2ToolHookEvent) => Promise<void>,
          ) => {
            toolHooks.set(name, callback);
            return { async dispose() {} };
          },
        ),
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
      commands,
      toolHooks,
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

  it("does not run a tool under the plugin checkout when its session directory is unavailable", async () => {
    const v2 = host();
    cleanups.push(await plugin.setup(v2 as unknown as V2Host));
    const definition = v2.tools.find(
      (entry) => entry.name === "session_review",
    );
    if (!definition) throw new Error("missing session_review");
    const execute = () =>
      definition.execute(
        { sessionID: "target", mode: "summary" },
        {
          sessionID: "current",
          agent: "build",
          messageID: "assistant",
          id: "call",
          signal: new AbortController().signal,
          progress: vi.fn(),
        },
      );
    v2.session.get.mockRejectedValueOnce(new Error("session access denied"));
    await expect(execute()).rejects.toThrow("session access denied");
    v2.session.get.mockResolvedValueOnce({
      id: "current",
      title: "x",
      time: { created: 1, updated: 2 },
      location: { directory: "" },
    });
    await expect(execute()).rejects.toThrow("Cannot verify");
    expect(v2.session.context).not.toHaveBeenCalled();
  });

  it.each(["failed", "different ID"])(
    "keeps a %s command admission from authorizing a concurrent preview",
    async (outcome) => {
      const v2 = host();
      cleanups.push(await plugin.setup(v2 as unknown as V2Host));
      const command = v2.commands.get("cross-review");
      const prompt = v2.promptHook();
      const config = v2.tools.find(
        (entry) => entry.name === "cross_review_config",
      );
      if (!command || !prompt || !config)
        throw new Error("missing V2 registration");
      let entered!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let finish!: () => void;
      const proceed = new Promise<void>((resolve) => {
        finish = resolve;
      });
      v2.session.prompt.mockImplementationOnce(
        async ({ id, sessionID, text }) => {
          await prompt({ messageID: id, sessionID, prompt: { text } });
          entered();
          await proceed;
          if (outcome === "failed") throw new Error("attachment unavailable");
          return { id: "msg_other" };
        },
      );
      const executing = command.execute({
        sessionID: "parent",
        prompt: { text: "review target" },
        delivery: "queue",
      });
      await started;
      const controller = new AbortController();
      const context = {
        sessionID: "parent",
        agent: "build",
        messageID: "assistant",
        id: "call",
        signal: controller.signal,
        progress: vi.fn(),
      };
      const preview = config.execute({ target: "review target" }, context);
      // Both current directory and primary-session checks run before the guard.
      await vi.waitFor(() =>
        expect(v2.session.get.mock.calls.length).toBeGreaterThanOrEqual(2),
      );
      expect(v2.session.context).not.toHaveBeenCalled();
      const commandResult = expect(executing).rejects.toThrow(
        outcome === "failed"
          ? "attachment unavailable"
          : "unexpected command admission ID",
      );
      const previewResult = expect(preview).rejects.toThrow(
        "requires an explicit user",
      );
      finish();
      await Promise.all([commandResult, previewResult]);
      expect(v2.session.context).not.toHaveBeenCalled();
      expect(v2.asserted).not.toHaveBeenCalled();
    },
  );

  it.each(["Start cross-review", "Cancel", "dismissed"])(
    "binds a native command to its prompt and keeps a duplicate admission from resetting %s",
    async (answer) => {
      const v2 = host();
      v2.model.list.mockResolvedValue({
        data: [{ providerID: "p", modelID: "model" }],
      });
      // Stop at the actual permission boundary; this test must not dispatch reviewers.
      v2.asserted.mockRejectedValue(new Error("host permission declined"));
      cleanups.push(await plugin.setup(v2 as unknown as V2Host));
      function tool(name: string) {
        const definition = v2.tools.find((entry) => entry.name === name);
        if (!definition) throw new Error(`missing tool: ${name}`);
        return definition;
      }
      const config = tool("cross_review_config");
      const start = tool("cross_review_start");
      const args = {
        target: "review target",
        reviewModels: ["p/model"],
        judgeModel: "p/model",
      };
      const context = {
        sessionID: "parent",
        agent: "build",
        messageID: "assistant",
        id: "call",
        signal: new AbortController().signal,
        progress: vi.fn(),
      };
      const prompt = v2.promptHook();
      const command = v2.commands.get("cross-review");
      const before = v2.toolHooks.get("execute.before");
      const after = v2.toolHooks.get("execute.after");
      if (!prompt || !command || !before || !after)
        throw new Error("missing V2 registration");

      await prompt({
        sessionID: "parent",
        messageID: "user",
        prompt: { text: "/cross-review review target" },
        metadata: { command: "cross-review", arguments: "review target" },
      });
      await expect(config.execute(args, context)).rejects.toThrow(
        "requires an explicit user",
      );
      await command.execute({
        sessionID: "parent",
        prompt: { text: "init" },
        delivery: "queue",
      });
      await expect(config.execute(args, context)).rejects.toThrow(
        "requires an explicit user",
      );
      const attachments = [{ uri: "file:///docs/notes" }];
      await command.execute({
        sessionID: "parent",
        prompt: { text: "review target", files: attachments },
        delivery: "steer",
      });
      const submitted = v2.session.prompt.mock.lastCall?.[0];
      if (!submitted) throw new Error("no submitted V2 prompt");
      expect(submitted).toMatchObject({
        id: expect.stringMatching(/^msg_/),
        files: attachments,
        delivery: "steer",
      });
      const repeat = () =>
        prompt({
          sessionID: "parent",
          messageID: submitted.id,
          prompt: { text: submitted.text },
        });
      const preview = await config.execute(args, context);
      const plan = JSON.parse(preview.content ?? "") as {
        confirmation: { questions: unknown[] };
      };
      const question = {
        tool: "question",
        agent: "build",
        sessionID: "parent",
        id: "question-1",
        input: { questions: plan.confirmation.questions },
      };
      await expect(start.execute(args, context)).rejects.toThrow(
        "fresh explicit user confirmation",
      );
      await before(question);
      await repeat();
      await after(
        answer === "dismissed"
          ? { ...question, status: "error" }
          : {
              ...question,
              status: "completed",
              result: { metadata: { answers: [[answer]] } },
            },
      );
      await repeat();
      if (answer !== "Start cross-review") {
        await expect(config.execute(args, context)).rejects.toThrow(
          "Cross-review was declined",
        );
        await expect(start.execute(args, context)).rejects.toThrow(
          "fresh explicit user confirmation",
        );
        expect(v2.asserted).not.toHaveBeenCalled();
      } else {
        await expect(start.execute(args, context)).rejects.toThrow(
          "host permission declined",
        );
        await repeat();
        await expect(start.execute(args, context)).rejects.toThrow(
          "fresh explicit user confirmation",
        );
        expect(v2.asserted).toHaveBeenCalledTimes(1);
      }
      await prompt({
        sessionID: "parent",
        messageID: "new-user",
        prompt: { text: "different task" },
      });
      await repeat();
      await expect(config.execute(args, context)).rejects.toThrow(
        "requires an explicit user",
      );
      expect(v2.created).not.toHaveBeenCalled();
    },
  );
});
