/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from "vitest";
import { normalizeSession } from "../src/session-review/normalize.js";

const session = {
  id: "ses_1",
  slug: "one",
  projectID: "p",
  directory: "/repo",
  title: "Review",
  version: "1",
  time: { created: 1, updated: 2 },
};
const message = (id: string, text: string) => ({
  info: {
    id,
    sessionID: "ses_1",
    role: "user" as const,
    time: { created: Number(id.slice(1)) },
    agent: "a",
    model: { providerID: "p", modelID: "m" },
  },
  parts: [
    {
      id: `p${id}`,
      sessionID: "ses_1",
      messageID: id,
      type: "text" as const,
      text,
    },
  ],
});

describe("session normalization", () => {
  it("normalizes supported parts without file URLs and preserves unknown types", () => {
    const input = message("m1", "hello") as any;
    input.parts.push(
      { type: "reasoning", text: "why" },
      {
        type: "tool",
        tool: "bash",
        state: { status: "completed", input: { x: 1 }, output: "ok" },
      },
      { type: "file", mime: "image/png", filename: "x.png", url: "secret" },
      { type: "future", secret: "no" },
    );
    const result = normalizeSession({
      session: session as any,
      messages: [input],
      mode: "summary",
    });
    expect(result.messages[0]?.parts).toEqual([
      { type: "text", text: "hello" },
      { type: "reasoning", text: "why" },
      {
        type: "tool",
        name: "bash",
        status: "completed",
        input: { x: 1 },
        output: "ok",
      },
      { type: "file", mime: "image/png", filename: "x.png" },
      { type: "unknown", sourceType: "future" },
    ]);
  });
  it("keeps newest troubleshooting messages and balanced summary messages", () => {
    const messages = [1, 2, 3, 4, 5].map((id) => message(`m${id}`, "x"));
    expect(
      normalizeSession({
        session: session as any,
        messages: messages as any,
        mode: "troubleshoot",
        limits: { maxMessages: 2 },
      }).messages.map((item) => item.id),
    ).toEqual(["m4", "m5"]);
    const summary = normalizeSession({
      session: session as any,
      messages: messages as any,
      mode: "summary",
      limits: { maxMessages: 3 },
    });
    expect(summary.messages.map((item) => item.id)).toEqual(["m1", "m2", "m5"]);
    expect(summary).toMatchObject({
      totalMessages: 5,
      includedMessages: 3,
      truncated: true,
      firstMessageID: "m1",
      lastMessageID: "m5",
    });
  });
  it("truncates oversized fields visibly", () => {
    const result = normalizeSession({
      session: session as any,
      messages: [message("m1", "abcdefghijklmnopqrstuvwxyz")] as any,
      mode: "summary",
      limits: { maxPartBytes: 20 },
    });
    expect((result.messages[0]?.parts[0] as any).text).toContain(
      "...[truncated]",
    );
  });
});
