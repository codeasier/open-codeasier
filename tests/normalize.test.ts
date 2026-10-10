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
      a: { b: { c: { d: { e: { f: { g: 1 } } } } } },
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

describe("UTF-8 truncation and truthful metadata", () => {
  const normalize = (text: string, maxPartBytes: number) =>
    normalizeSession({
      session: session as any,
      messages: [message("m1", text)] as any,
      mode: "summary",
      limits: { maxPartBytes },
    });
  it.each([0, 1, 5, 13, 14, 15, 17, 18, 19, 20, 25, 64])(
    "respects a %i-byte budget without splitting multibyte characters",
    (budget) => {
      const result = normalize("😀中文é".repeat(100), budget);
      const text = (result.messages[0]?.parts[0] as any).text;
      expect(Buffer.byteLength(text)).toBeLessThanOrEqual(budget);
      expect(Buffer.from(text).toString("utf8")).toBe(text);
      expect(result).toMatchObject({
        truncated: true,
        includedMessages: 1,
        omittedMessages: 0,
      });
    },
  );
  it("leaves an exact UTF-8 fit intact and does not interpret literal markers as truncation", () => {
    for (const text of ["😀中文é", "\n...[truncated]"]) {
      const result = normalize(text, Buffer.byteLength(text));
      expect((result.messages[0]?.parts[0] as any).text).toBe(text);
      expect(result.truncated).toBe(false);
    }
  });
  it("clips a very long message within the test timeout", () => {
    const result = normalize("😀".repeat(1_000_000), 100);
    expect(
      Buffer.byteLength((result.messages[0]?.parts[0] as any).text),
    ).toBeLessThanOrEqual(100);
    expect(result.truncated).toBe(true);
  });
  it.each(["reasoning", "output", "error"])(
    "reports clipping of %s without message omission",
    (field) => {
      const input = message("m1", "hi") as any;
      input.parts =
        field === "reasoning"
          ? [{ type: "reasoning", text: "x".repeat(100) }]
          : [
              {
                type: "tool",
                tool: "test",
                state: {
                  status: field === "output" ? "completed" : "error",
                  input: {},
                  [field]: "x".repeat(100),
                },
              },
            ];
      const result = normalizeSession({
        session: session as any,
        messages: [input],
        mode: "summary",
        limits: { maxPartBytes: 20 },
      });
      expect(result).toMatchObject({ truncated: true, omittedMessages: 0 });
    },
  );
  it.each([
    "x".repeat(5_000),
    Array.from({ length: 101 }, (_, i) => i),
    { a: { b: { c: { d: { e: { f: { g: 1 } } } } } } },
    Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`k${i}`, i])),
    { ["x".repeat(201)]: "short" },
    Array.from({ length: 10 }, () => '\\"'.repeat(3_000)),
  ])("reports sanitized input loss without message omission", (toolInput) => {
    const input = message("m1", "hi") as any;
    input.parts = [
      {
        type: "tool",
        tool: "test",
        state: { status: "running", input: toolInput },
      },
    ];
    const result = normalizeSession({
      session: session as any,
      messages: [input],
      mode: "summary",
    });
    expect(result).toMatchObject({ truncated: true, omittedMessages: 0 });
  });
  it("bounds traversal across nested arrays with a shared node budget", () => {
    let reads = 0;
    const leaf = () =>
      Object.defineProperty({}, "text", {
        enumerable: true,
        get() {
          reads++;
          return "x";
        },
      });
    const toolInput = Array.from({ length: 100 }, () =>
      Array.from({ length: 100 }, leaf),
    );
    const input = message("m1", "hi") as any;
    input.parts = [
      {
        type: "tool",
        tool: "test",
        state: { status: "running", input: toolInput },
      },
    ];
    const result = normalizeSession({
      session: session as any,
      messages: [input],
      mode: "summary",
    });
    expect(reads).toBeLessThanOrEqual(100);
    expect(result.truncated).toBe(true);
    expect(JSON.stringify(result)).toContain("[node-limit]");
  });
  it("does not normalize messages beyond the retained count", () => {
    const ignored = message("m2", "ignored");
    Object.defineProperty(ignored, "parts", {
      get() {
        throw new Error("unused message normalized");
      },
    });
    const result = normalizeSession({
      session: session as any,
      messages: [message("m1", "hi"), ignored],
      mode: "summary",
      limits: { maxMessages: 1 },
    });
    expect(result.retainedMessageIDs).toEqual(["m1"]);
  });
  it.each([NaN, Infinity, -1, 1.5])(
    "rejects invalid limits (%s)",
    (maxPartBytes) => {
      expect(() => normalize("x", maxPartBytes)).toThrow(RangeError);
    },
  );
});
