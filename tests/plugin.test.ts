/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it, vi } from "vitest";
import plugin from "../src/plugin.js";

describe("plugin module", () => {
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
      "cross_review_start",
      "cross_review_status",
      "cross_review_cancel",
      "cross_review_finalize",
      "session_review",
    ]);
    expect(hooks.tool).toHaveProperty("session_review");
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
      path: { id: "ses_123" },
      query: { directory: "/repo" },
    });
    expect(output).toMatchObject({
      title: "Session review input: ses_123",
      metadata: { mode: "summary", truncated: false, omittedMessages: 0 },
    });
    expect((output as any).output).toContain('"sessionID":"ses_123"');
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
      "cross_review_start",
      "cross_review_status",
      "cross_review_cancel",
      "cross_review_finalize",
      "session_review",
    ]);

    const emptyConfig: any = {};
    await hooks.config?.(emptyConfig);
    expect(emptyConfig.experimental.primary_tools).toEqual([
      "cross_review",
      "cross_review_start",
      "cross_review_status",
      "cross_review_cancel",
      "cross_review_finalize",
      "session_review",
    ]);
  });
});
