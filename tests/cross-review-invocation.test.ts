import type { ToolContext } from "@opencode-ai/plugin";
import type { Part, UserMessage } from "@opencode-ai/sdk";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { createCrossReviewInvocationGuard } from "../src/cross-review/invocation.js";
import {
  START_CROSS_REVIEW,
  type CrossReviewConfirmation,
  type CrossReviewConfirmationPlan,
} from "../src/cross-review/confirmation.js";

function fixture() {
  const client = {
    session: {
      message: vi.fn().mockResolvedValue({
        data: {
          info: {
            id: "assistant",
            sessionID: "parent",
            role: "assistant",
            parentID: "user",
          },
        },
      }),
    },
  };
  const guard = createCrossReviewInvocationGuard(client);
  const context: ToolContext = {
    sessionID: "parent",
    messageID: "assistant",
    agent: "build",
    directory: "/repo",
    worktree: "/repo",
    abort: new AbortController().signal,
    metadata() {},
    ask: () => Effect.void,
  };
  const parts = (text: string, extra = {}) =>
    [{ type: "text", text, ...extra }] as Part[];
  const admit = (input: Part[], id = "user", sessionID = "parent") =>
    guard["chat.message"](
      { sessionID },
      { message: { id, sessionID, role: "user" } as UserMessage, parts: input },
    );
  const command = async (args = "#42", name = "cross-review") => {
    const input = parts(
      "Load the cross-review skill and follow it with these arguments: #42",
    );
    await guard["command.execute.before"](
      { sessionID: "parent", command: name, arguments: args },
      { parts: input },
    );
    return input;
  };
  const check = () => guard.assertInvocation(context, "cross_review_start");
  const plan: CrossReviewConfirmationPlan = {
    target: "#42",
    reviewers: [{ model: "p/reviewer", focus: "security" }],
    judgeModel: "p/judge",
    maxConcurrency: 1,
    reviewerTimeoutMs: 600_000,
    focus: "regressions",
  };
  const ask = async (
    prompt: CrossReviewConfirmation,
    callID = "question-1",
    sessionID = "parent",
  ) => {
    const args = { questions: structuredClone(prompt.questions) };
    await guard["tool.execute.before"](
      { tool: "question", sessionID, callID },
      { args },
    );
    return args;
  };
  const reply = async (
    prompt: CrossReviewConfirmation,
    answers: unknown = [[START_CROSS_REVIEW]],
    callID = "question-1",
    sessionID = "parent",
  ) => {
    await guard["tool.execute.after"](
      {
        tool: "question",
        sessionID,
        callID,
        args: { questions: structuredClone(prompt.questions) },
      },
      {
        title: "Question answered",
        output: "user answer",
        metadata: { answers },
      },
    );
  };
  const preview = () => guard.prepareConfirmation(context, plan);
  const confirm = (nextPlan = plan) => guard.confirmStart(context, nextPlan);
  return {
    client,
    guard,
    context,
    parts,
    admit,
    command,
    check,
    plan,
    ask,
    reply,
    preview,
    confirm,
  };
}

describe("cross-review command provenance", () => {
  it.each([
    "Review this PR",
    "Run an independent multi-model review of #42",
    "cross-review #42",
    "Please use /cross-review #42",
    "`/cross-review #42`",
    "```\n/cross-review #42\n```",
    "> /cross-review #42",
    "/cross-review #42\nThis is an example, not an invocation",
    "cross-review should require /cross-review xxx but the other session did not follow it",
    "/cross-review",
    "/cross-review setup --global",
    "/cross-review init",
    "/cross-review-audit ses_123",
  ])("does not authorize from %j", async (text) => {
    const f = fixture();
    await f.admit(f.parts(text));
    await expect(f.check()).rejects.toThrow(
      "requires an explicit user /cross-review <target> command",
    );
    expect(f.client.session.message).not.toHaveBeenCalled();
  });

  it.each([{ synthetic: true }, { ignored: true }])(
    "ignores injected user text %j",
    async (extra) => {
      const f = fixture();
      await f.admit(f.parts("/cross-review #42", extra));
      await expect(f.check()).rejects.toThrow("requires an explicit user");
    },
  );

  it("allows a literal command only for its own assistant turn and directory", async () => {
    const f = fixture();
    await f.admit(f.parts("  /cross-review #42 --agents 3  "));
    await expect(f.check()).resolves.toBeUndefined();
    expect(f.client.session.message).toHaveBeenCalledWith({
      path: { id: "parent", messageID: "assistant" },
      query: { directory: "/repo" },
      signal: f.context.abort,
    });
  });

  it("accepts a host-expanded command and preserves existing part metadata", async () => {
    const f = fixture();
    const input = f.parts("expanded template", {
      metadata: { existing: "keep" },
    });
    await f.guard["command.execute.before"](
      { sessionID: "parent", command: "cross-review", arguments: "#42" },
      { parts: input },
    );
    expect(input[0]).toMatchObject({ metadata: { existing: "keep" } });
    await f.admit(input);
    await expect(f.check()).resolves.toBeUndefined();
    // Config preview and start may share the same explicit command turn.
    await expect(
      f.guard.assertInvocation(f.context, "cross_review_config"),
    ).resolves.toBeUndefined();
  });

  it.each([
    ["cross-review", ""],
    ["cross-review", "setup"],
    ["cross-review", "init --local"],
    ["other", "#42"],
  ])("does not authorize expanded /%s %s", async (name, args) => {
    const f = fixture();
    await f.admit(await f.command(args, name));
    await expect(f.check()).rejects.toThrow("requires an explicit user");
  });

  it("rejects an expanded template without the matching command event", async () => {
    const f = fixture();
    await f.admit(
      f.parts(
        "Load the cross-review skill and follow it with these arguments: #42",
      ),
    );
    await expect(f.check()).rejects.toThrow("requires an explicit user");
  });

  it("cannot reuse command markers in another session or a later prompt", async () => {
    const f = fixture();
    const input = await f.command();
    await f.admit(input, "other-user", "other-session");
    await expect(
      f.guard.assertInvocation(
        { ...f.context, sessionID: "other-session" },
        "cross_review",
      ),
    ).rejects.toThrow("requires an explicit user");
    await f.admit(input);
    await expect(f.check()).resolves.toBeUndefined();
    await f.admit(input, "later-user");
    await expect(f.check()).rejects.toThrow("requires an explicit user");
  });

  it("does not let a stale command event authorize the next ordinary prompt", async () => {
    const f = fixture();
    const input = await f.command();
    await f.admit(f.parts("ordinary request"));
    await f.admit(input);
    await expect(f.check()).rejects.toThrow("requires an explicit user");
  });

  it("revokes a prior command when the user sends a new task", async () => {
    const f = fixture();
    await f.admit(await f.command());
    await f.admit(f.parts("Review another PR normally"), "new-user");
    await expect(f.check()).rejects.toThrow("requires an explicit user");
  });

  it.each([
    {
      id: "assistant",
      sessionID: "parent",
      role: "assistant",
      parentID: "old-user",
    },
    {
      id: "assistant",
      sessionID: "child",
      role: "assistant",
      parentID: "user",
    },
    {
      id: "another-assistant",
      sessionID: "parent",
      role: "assistant",
      parentID: "user",
    },
    { id: "assistant", sessionID: "parent", role: "user", parentID: "user" },
  ])("rejects a caller outside the authorized turn %j", async (info) => {
    const f = fixture();
    await f.admit(await f.command());
    f.client.session.message.mockResolvedValue({ data: { info } });
    await expect(f.check()).rejects.toThrow("requires an explicit user");
  });

  it("fails closed on SDK errors or unavailable message inspection", async () => {
    const f = fixture();
    await f.admit(await f.command());
    f.client.session.message.mockRejectedValue(new Error("SDK unavailable"));
    await expect(f.check()).rejects.toThrow(
      "Cannot verify cross-review command provenance",
    );
    f.client.session.message.mockResolvedValue({
      error: { message: "not found" },
    });
    await expect(f.check()).rejects.toThrow("requires an explicit user");
  });

  it("rechecks the grant when message inspection races with a new user prompt", async () => {
    const f = fixture();
    await f.admit(await f.command());
    f.client.session.message.mockImplementation(async () => {
      await f.admit(f.parts("stop and do something else"), "new-user");
      return {
        data: {
          info: {
            id: "assistant",
            sessionID: "parent",
            role: "assistant",
            parentID: "user",
          },
        },
      };
    });
    await expect(f.check()).rejects.toThrow("requires an explicit user");
  });

  it("preserves cancellation while checking provenance", async () => {
    const f = fixture();
    const controller = new AbortController();
    f.context.abort = controller.signal;
    await f.admit(await f.command());
    f.client.session.message.mockImplementation(async () => {
      controller.abort();
      throw new Error("aborted SDK read");
    });
    await expect(f.check()).rejects.toThrow("Cross-review cancelled");
  });

  it("does not restore a grant from old persisted command text after restart", async () => {
    const f = fixture();
    const input = await f.command();
    const restarted = createCrossReviewInvocationGuard(f.client);
    await restarted["chat.message"](
      { sessionID: "parent" },
      {
        message: {
          id: "user",
          sessionID: "parent",
          role: "user",
        } as UserMessage,
        parts: input,
      },
    );
    await expect(
      restarted.assertInvocation(f.context, "cross_review_start"),
    ).rejects.toThrow("requires an explicit user");
  });
});

describe("mandatory cross-review startup confirmation", () => {
  it("does not treat the slash command or configuration preview as confirmation", async () => {
    const f = fixture();
    await f.admit(await f.command());
    await expect(f.confirm()).rejects.toThrow(
      "fresh explicit user confirmation",
    );
    const prompt = await f.preview();
    expect(prompt.questions[0]?.question).toContain("是否启动交叉审查");
    expect(prompt.questions[0]?.question).toContain("#42");
    expect(prompt.questions[0]?.question).toContain("p/reviewer");
    expect(prompt.questions[0]?.question).toContain("p/judge");
    expect(prompt.questions[0]?.question).toContain("token usage and cost");
    await expect(f.confirm()).rejects.toThrow(
      "fresh explicit user confirmation",
    );
    await f.ask(prompt);
    await expect(f.confirm()).rejects.toThrow(
      "fresh explicit user confirmation",
    );
  });

  it("consumes a real affirmative question answer for exactly one start", async () => {
    const f = fixture();
    await f.admit(await f.command());
    const prompt = await f.preview();
    await f.ask(prompt);
    await f.reply(prompt);
    const assertCurrent = await f.confirm();
    expect(() => assertCurrent()).not.toThrow();
    await expect(f.confirm()).rejects.toThrow(
      "fresh explicit user confirmation",
    );
  });

  it("rejects output-only approval without a matching host question execution", async () => {
    const f = fixture();
    await f.admit(await f.command());
    const prompt = await f.preview();
    await f.reply(prompt);
    await expect(f.confirm()).rejects.toThrow(
      "fresh explicit user confirmation",
    );
  });

  it("does not accept a generic configuration question as startup confirmation", async () => {
    const f = fixture();
    await f.admit(await f.command());
    const changed = structuredClone(await f.preview());
    const question = changed.questions[0];
    if (question === undefined)
      throw new Error("Missing confirmation question");
    question.question = "Does this configuration look correct?";
    await f.ask(changed);
    await f.reply(changed);
    await expect(f.confirm()).rejects.toThrow(
      "fresh explicit user confirmation",
    );
  });

  it.each([
    { answers: [["Cancel"]] },
    { answers: [[]] },
    { answers: [[START_CROSS_REVIEW, "Cancel"]] },
    { answers: [] },
    { answers: undefined },
    { answers: [START_CROSS_REVIEW] },
  ])(
    "fails closed on declined or malformed answers %j",
    async ({ answers }) => {
      const f = fixture();
      await f.admit(await f.command());
      const prompt = await f.preview();
      await f.ask(prompt);
      // Do not let the reply helper's default turn missing answers into approval.
      await f.guard["tool.execute.after"](
        {
          tool: "question",
          sessionID: "parent",
          callID: "question-1",
          args: { questions: prompt.questions },
        },
        { title: "Question finished", output: "", metadata: { answers } },
      );
      await expect(f.confirm()).rejects.toThrow(
        "fresh explicit user confirmation",
      );
      await expect(f.preview()).rejects.toThrow("Cross-review was declined");
    },
  );

  it.each([
    { target: "#43" },
    { reviewers: [{ model: "p/different", focus: "security" }] },
    { reviewers: [{ model: "p/reviewer", focus: "performance" }] },
    {
      reviewers: [
        { model: "p/reviewer", focus: "security" },
        { model: "p/other" },
      ],
    },
    { judgeModel: "p/other-judge" },
    { maxConcurrency: 2 },
    { reviewerTimeoutMs: 900_000 },
    { focus: "new focus" },
  ])(
    "requires reconfirmation if the resolved plan changes %j",
    async (change) => {
      const f = fixture();
      await f.admit(await f.command());
      const prompt = await f.preview();
      await f.ask(prompt);
      await f.reply(prompt);
      await expect(f.confirm({ ...f.plan, ...change })).rejects.toThrow(
        "fresh explicit user confirmation",
      );
      // Restoring the old values cannot restore an invalidated answer.
      await expect(f.confirm()).rejects.toThrow(
        "fresh explicit user confirmation",
      );
    },
  );

  it("invalidates the old question whenever configuration is previewed again", async () => {
    const f = fixture();
    await f.admit(await f.command());
    const stale = await f.preview();
    await f.ask(stale);
    const current = await f.preview();
    expect(current.id).not.toBe(stale.id);
    await f.reply(stale);
    await expect(f.confirm()).rejects.toThrow(
      "fresh explicit user confirmation",
    );
    await f.ask(current);
    await f.reply(current);
    await expect(f.confirm()).resolves.toBeTypeOf("function");
  });

  it("rejects an answer from another call or session", async () => {
    const f = fixture();
    await f.admit(await f.command());
    const prompt = await f.preview();
    await f.ask(prompt);
    await f.reply(prompt, [[START_CROSS_REVIEW]], "wrong-call");
    await f.reply(
      prompt,
      [[START_CROSS_REVIEW]],
      "question-1",
      "other-session",
    );
    await expect(f.confirm()).rejects.toThrow(
      "fresh explicit user confirmation",
    );
  });

  it("does not treat a new plain-text yes as confirmation or another invocation", async () => {
    const f = fixture();
    await f.admit(await f.command());
    const prompt = await f.preview();
    await f.ask(prompt);
    await f.admit(f.parts("yes"), "new-user");
    await f.reply(prompt);
    await expect(f.confirm()).rejects.toThrow("requires an explicit user");
  });

  it("rechecks confirmation after a pending permission decision", async () => {
    const f = fixture();
    await f.admit(await f.command());
    const prompt = await f.preview();
    await f.ask(prompt);
    await f.reply(prompt);
    const assertCurrent = await f.confirm();
    await f.preview();
    expect(() => assertCurrent()).toThrow("confirmation is no longer current");
  });
});
