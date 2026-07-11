/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it, vi } from "vitest";
import { SessionReviewError } from "../src/session-review/errors.js";
import { fetchSessionReviewInput } from "../src/session-review/fetch.js";

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
