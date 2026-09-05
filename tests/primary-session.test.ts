import { describe, expect, it, vi } from "vitest";
import { assertPrimarySession } from "../src/primary-session.js";

describe("assertPrimarySession", () => {
  it("rejects when session.get is missing", async () => {
    await expect(
      assertPrimarySession(
        { session: {} } as never,
        { sessionID: "child", directory: "/repo" },
        "cross_review",
      ),
    ).rejects.toThrow(
      "cross_review can only be invoked from primary sessions: session inspection is unavailable",
    );
  });

  it("rejects child sessions with a parentID", async () => {
    const get = vi.fn().mockResolvedValue({
      data: { id: "child", parentID: "root" },
    });
    await expect(
      assertPrimarySession(
        { session: { get } },
        { sessionID: "child", directory: "/repo" },
        "session_review",
      ),
    ).rejects.toThrow(
      "session_review can only be invoked from primary sessions",
    );
    await expect(
      assertPrimarySession(
        { session: { get } },
        { sessionID: "child", directory: "/repo" },
        "cross_review_audit",
      ),
    ).rejects.toThrow(
      "cross_review_audit can only be invoked from primary sessions",
    );
  });

  it("allows primary sessions without a parentID", async () => {
    const get = vi.fn().mockResolvedValue({
      data: { id: "primary" },
    });
    await assertPrimarySession(
      { session: { get } },
      { sessionID: "primary", directory: "/repo" },
      "cross_review_start",
    );
    expect(get).toHaveBeenCalledWith({
      path: { id: "primary" },
      query: { directory: "/repo" },
    });
  });

  it("attaches the underlying inspection error", async () => {
    const get = vi.fn().mockResolvedValue({
      error: { name: "APIError", data: { message: "boom" } },
    });
    await expect(
      assertPrimarySession(
        { session: { get } },
        { sessionID: "primary", directory: "/repo" },
        "cross_review",
      ),
    ).rejects.toThrow("Session inspection failed: boom");
  });

  it("attaches thrown inspection errors", async () => {
    const get = vi.fn().mockRejectedValue(new Error("network down"));
    await expect(
      assertPrimarySession(
        { session: { get } },
        { sessionID: "primary", directory: "/repo" },
        "cross_review",
      ),
    ).rejects.toThrow("Session inspection failed: network down");
  });
});
