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
  it("handles pinned SDK tool states and bounds arbitrary inputs deterministically", () => {
    const input = message("m1", "hello") as any;
    const circular: any = {
      z: "x".repeat(5_000),
      a: { b: { c: { d: { e: { f: 1 } } } } },
    };
    circular.self = circular;
    input.parts = [
      {
        type: "tool",
        tool: "a",
        state: { status: "pending", input: circular },
      },
      { type: "tool", tool: "b", state: { status: "running", input: [1, 2] } },
      {
        type: "tool",
        tool: "c",
        state: { status: "completed", input: {}, output: "ok" },
      },
      {
        type: "tool",
        tool: "d",
        state: { status: "error", input: {}, error: "bad" },
      },
    ];
    const first = normalizeSession({
      session: session as any,
      messages: [input],
      mode: "summary",
    });
    const second = normalizeSession({
      session: session as any,
      messages: [input],
      mode: "summary",
    });
    expect(first).toEqual(second);
    expect(JSON.stringify(first)).toContain("[circular]");
    expect(first.messages[0]?.parts.map((part: any) => part.status)).toEqual([
      "pending",
      "running",
      "completed",
      "error",
    ]);
  });
  it("bounds the complete response and reports retained IDs and omissions", () => {
    const messages = [1, 2, 3].map((id) => message(`m${id}`, "x".repeat(100)));
    const result = normalizeSession({
      session: session as any,
      messages: messages as any,
      mode: "troubleshoot",
      limits: { maxBytes: 500 },
    });
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(500);
    expect(result.omittedMessages).toBe(3 - result.includedMessages);
    expect(result.retainedMessageIDs).toEqual(
      result.messages.map((item) => item.id),
    );
    expect(() =>
      normalizeSession({
        session: session as any,
        messages: messages as any,
        mode: "summary",
        limits: { maxBytes: 1 },
      }),
    ).toThrow(expect.objectContaining({ code: "RESPONSE_TOO_LARGE" }));
  });
});
