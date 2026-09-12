/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import plugin from "../src/plugin.js";
import { FileCrossReviewRunStore } from "../src/cross-review/run-store.js";

describe("plugin module", () => {
  let cleanup: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    cleanup = vi
      .spyOn(FileCrossReviewRunStore.prototype, "cleanupExpiredRuns")
      .mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup.mockRestore();
  });

  it("exports the OpenCode server entry", () => {
    expect(plugin).toEqual(
      expect.objectContaining({
        id: "open-codeasier",
        server: expect.any(Function),
      }),
    );
  });

  it("registers and executes the explicit read-only session tool", async () => {
    const client = {
      session: {
        get: vi.fn().mockResolvedValue({
          data: {
            id: "ses_123",
            title: "x",
            time: { created: 1, updated: 2 },
          },
          response: { status: 200 },
        }),
        messages: vi.fn().mockResolvedValue({
          data: [
            {
              info: { id: "m1", role: "user", time: { created: 1 } },
              parts: [{ type: "text", text: "hi" }],
            },
          ],
          response: { status: 200 },
        }),
      },
    };
    const hooks = await plugin.server({
      client,
      project: {},
      directory: "/repo",
      worktree: "/repo",
      serverUrl: new URL("http://localhost"),
    } as any);
    expect(Object.keys(hooks.tool ?? {})).toEqual([
      "cross_review",
      "cross_review_config",
      "cross_review_start",
      "cross_review_status",
      "cross_review_cancel",
      "cross_review_finalize",
      "session_review",
      "cross_review_audit",
    ]);
    expect(hooks.tool).toHaveProperty("session_review");
    expect(hooks.tool).toHaveProperty("cross_review_audit");
    const output = await hooks.tool?.session_review?.execute(
      { sessionID: "ses_123", mode: "summary" },
      {
        sessionID: "current",
        messageID: "m",
        agent: "a",
        directory: "/repo",
        worktree: "/repo",
        abort: new AbortController().signal,
        metadata() {},
        async ask() {},
      },
    );
    expect(client.session.get).toHaveBeenCalledWith({
      path: { id: "current" },
      query: { directory: "/repo" },
      signal: expect.any(AbortSignal),
    });
    expect(client.session.get).toHaveBeenCalledWith({
      path: { id: "ses_123" },
      query: { directory: "/repo" },
    });
    expect(output).toMatchObject({
      title: "Session review input: ses_123",
      metadata: { mode: "summary", truncated: false, omittedMessages: 0 },
    });
    expect((output as any).output).toContain('"sessionID":"ses_123"');
  });

  it("reclaims expired cross-review runs when the plugin loads", async () => {
    await plugin.server({
      client: {},
      project: {},
      directory: "/repo",
      worktree: "/repo",
      serverUrl: new URL("http://localhost"),
    } as any);
    expect(cleanup).toHaveBeenCalled();
  });

  it("configures review tools as primary_tools in experimental config hook", async () => {
    const hooks = await plugin.server({
      client: {},
      project: {},
      directory: "/repo",
      worktree: "/repo",
      serverUrl: new URL("http://localhost"),
    } as any);

    expect(hooks.config).toBeDefined();
    const config: any = {
      experimental: {
        primary_tools: ["custom_primary"],
      },
    };
    await hooks.config?.(config);
    expect(config.experimental.primary_tools).toEqual([
      "custom_primary",
      "cross_review",
      "cross_review_config",
      "cross_review_start",
      "cross_review_status",
      "cross_review_cancel",
      "cross_review_finalize",
      "session_review",
      "cross_review_audit",
    ]);

    const emptyConfig: any = {};
    await hooks.config?.(emptyConfig);
    expect(emptyConfig.experimental.primary_tools).toEqual([
      "cross_review",
      "cross_review_config",
      "cross_review_start",
      "cross_review_status",
      "cross_review_cancel",
      "cross_review_finalize",
      "session_review",
      "cross_review_audit",
    ]);
  });

  it.each([
    [
      undefined,
      [
        ["cross_review_start", "ask"],
        ["cross_review", "ask"],
      ],
    ],
    [
      "allow",
      [
        ["cross_review_start", "ask"],
        ["cross_review", "ask"],
        ["*", "allow"],
      ],
    ],
    [
      "deny",
      [
        ["cross_review_start", "ask"],
        ["cross_review", "ask"],
        ["*", "deny"],
      ],
    ],
    [
      { "*": "allow" },
      [
        ["cross_review_start", "ask"],
        ["cross_review", "ask"],
        ["*", "allow"],
      ],
    ],
    [
      { "cross_review*": "deny" },
      [
        ["cross_review_start", "ask"],
        ["cross_review", "ask"],
        ["cross_review*", "deny"],
      ],
    ],
    [
      { "*": "allow", cross_review_start: "ask", cross_review: "deny" },
      [
        ["*", "allow"],
        ["cross_review_start", "ask"],
        ["cross_review", "deny"],
      ],
    ],
    [
      {
        cross_review_start: "deny",
        "*": "allow",
        cross_review: { "*": "ask" },
      },
      [
        ["cross_review_start", "deny"],
        ["*", "allow"],
        ["cross_review", { "*": "ask" }],
      ],
    ],
  ])(
    "adds ask defaults without reordering explicit permission policy %j",
    async (permission, expected) => {
      const hooks = await plugin.server({ client: {} } as any);
      const config: any = {
        permission,
        agent: { build: { permission: { cross_review: "deny" } } },
      };
      await hooks.config?.(config);
      expect(Object.entries(config.permission)).toEqual(expected);
      expect(config.agent.build.permission).toEqual({ cross_review: "deny" });
      // Repeated config hooks must not change last-match-wins semantics.
      await hooks.config?.(config);
      expect(Object.entries(config.permission)).toEqual(expected);
    },
  );
});
