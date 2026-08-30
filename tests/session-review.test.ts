/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it, vi } from "vitest";
import { SessionReviewError } from "../src/session-review/errors.js";
import { fetchSessionReviewInput } from "../src/session-review/fetch.js";
import { createSessionReviewTool } from "../src/session-review/tool.js";

const session = { id: "ses_1", title: "x", time: { created: 1, updated: 2 } };
const messages = [
  {
    info: { id: "m1", role: "user", time: { created: 1 } },
    parts: [{ type: "text", text: "hi" }],
  },
];
const result = (data?: unknown, status = 200, error?: unknown) => ({
  data,
  error,
  response: { status },
});

describe("session SDK boundary", () => {
  it("uses only the explicit ID and directory", async () => {
    const client = {
      session: {
        get: vi.fn().mockResolvedValue(result(session)),
        messages: vi.fn().mockResolvedValue(result(messages)),
      },
    };
    const review = await fetchSessionReviewInput({
      client: client as any,
      sessionID: "ses_1",
      directory: "/repo",
      mode: "summary",
    });
    expect(client.session.get).toHaveBeenCalledWith({
      path: { id: "ses_1" },
      query: { directory: "/repo" },
    });
    expect(client.session.messages).toHaveBeenCalledWith({
      path: { id: "ses_1" },
      query: { directory: "/repo" },
    });
    expect(review.sessionID).toBe("ses_1");
  });
  it.each([
    [
      result(undefined, 404, {
        name: "NotFoundError",
        data: { message: "path /secret" },
      }),
      "SESSION_NOT_FOUND",
    ],
    [
      result(undefined, 403, { name: "Denied", data: { message: "token x" } }),
      "SESSION_ACCESS_DENIED",
    ],
    [
      result(undefined, 500, { name: "Error", data: { message: "token x" } }),
      "SDK_FAILURE",
    ],
  ])("maps API errors safely", async (getResult, code) => {
    const client = {
      session: { get: vi.fn().mockResolvedValue(getResult), messages: vi.fn() },
    };
    await expect(
      fetchSessionReviewInput({
        client: client as any,
        sessionID: "ses_1",
        directory: "/repo",
        mode: "summary",
      }),
    ).rejects.toMatchObject({ code });
  });
  it("maps empty and rejected requests", async () => {
    const empty = {
      session: {
        get: vi.fn().mockResolvedValue(result(session)),
        messages: vi.fn().mockResolvedValue(result([])),
      },
    };
    await expect(
      fetchSessionReviewInput({
        client: empty as any,
        sessionID: "ses_1",
        directory: "/repo",
        mode: "summary",
      }),
    ).rejects.toMatchObject({ code: "SESSION_EMPTY" });
    const rejected = {
      session: {
        get: vi.fn().mockRejectedValue(new Error("token /secret")),
        messages: vi.fn(),
      },
    };
    const promise = fetchSessionReviewInput({
      client: rejected as any,
      sessionID: "ses_1",
      directory: "/repo",
      mode: "summary",
    });
    await expect(promise).rejects.toBeInstanceOf(SessionReviewError);
    await expect(promise).rejects.not.toThrow(/token|secret/);
  });
});

function toolContext(sessionID = "current") {
  return {
    sessionID,
    messageID: "m",
    agent: "a",
    directory: "/repo",
    worktree: "/repo",
    abort: new AbortController().signal,
    metadata() {},
    async ask() {},
  } as any;
}

describe("session_review tool", () => {
  it("rejects invocations from child sessions with a parentID", async () => {
    const client = {
      session: {
        get: vi
          .fn()
          .mockResolvedValue(
            result({ ...session, id: "child-session", parentID: "root" }),
          ),
        messages: vi.fn(),
      },
    };
    await expect(
      createSessionReviewTool(client as any).execute(
        { sessionID: "ses_1", mode: "summary" },
        toolContext("child-session"),
      ),
    ).rejects.toThrow(
      "session_review can only be invoked from primary sessions",
    );
    expect(client.session.messages).not.toHaveBeenCalled();
    expect(client.session.get).toHaveBeenCalledWith({
      path: { id: "child-session" },
      query: { directory: "/repo" },
      signal: expect.any(AbortSignal),
    });
  });

  it("reads the target session from a primary caller", async () => {
    const client = {
      session: {
        get: vi.fn().mockImplementation(async (input) => {
          if (input.path.id === "current")
            return result({ ...session, id: "current" });
          return result(session);
        }),
        messages: vi.fn().mockResolvedValue(result(messages)),
      },
    };
    const output = await createSessionReviewTool(client as any).execute(
      { sessionID: "ses_1", mode: "summary" },
      toolContext(),
    );
    expect(output).toMatchObject({
      title: "Session review input: ses_1",
      metadata: { mode: "summary", truncated: false, omittedMessages: 0 },
    });
    expect(client.session.get).toHaveBeenCalledWith({
      path: { id: "current" },
      query: { directory: "/repo" },
      signal: expect.any(AbortSignal),
    });
    expect(client.session.get).toHaveBeenCalledWith({
      path: { id: "ses_1" },
      query: { directory: "/repo" },
    });
  });
});
