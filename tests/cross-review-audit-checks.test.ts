import { describe, expect, it } from "vitest";
import {
  checkContextContract,
  checkGathererJudgeSession,
  checkGathererSkippedWhenContext,
  checkLegacyToolAbsent,
  checkPromptMessageID,
  checkPromptModel,
  checkSilentModelReplace,
  checkToolsDeny,
  persistedContext,
  roleNeverDispatched,
} from "../src/cross-review/audit-checks.js";
import { READ_ONLY_TOOLS } from "../src/cross-review/tool.js";
import type { AuditSessionEvidence } from "../src/cross-review/audit-types.js";
import {
  RUN_SCHEMA_VERSION,
  type CrossReviewRun,
} from "../src/cross-review/run-store.js";
import {
  MAX_PROTOCOL_CALLS,
  boundProtocolCalls,
  extractProtocolCalls,
  projectAuditSession,
  protocolCallsForRun,
  roleBehavior,
  sliceFromMessage,
} from "../src/cross-review/audit-project.js";

const RUN_ID = "00000000-0000-4000-8000-000000000001";

function run(overrides: Partial<CrossReviewRun> = {}): CrossReviewRun {
  return {
    schemaVersion: RUN_SCHEMA_VERSION,
    runID: RUN_ID,
    directory: "/repo",
    ownerSessionID: "parent",
    createdAt: 1,
    updatedAt: 1,
    phase: "completed",
    target: "HEAD",
    brief: "brief",
    quorum: 1,
    maxConcurrency: 1,
    reviewerTimeoutMs: 5_000,
    configSources: { project: "loaded", global: "absent" },
    projectConfigPath: "/repo/.opencode/cross-review.json",
    globalConfigPath: "/home/.config/opencode/cross-review.json",
    reviewers: [
      {
        reviewer: 1,
        model: "a/one",
        sessionID: "child-1",
        messageID: "msg-1",
        status: "succeeded",
      },
    ],
    ...overrides,
  };
}

function evidence(
  overrides: Partial<AuditSessionEvidence> = {},
): AuditSessionEvidence {
  return {
    sessionID: "child-1",
    parentID: "parent",
    title: `Cross-review ${RUN_ID.slice(0, 8)} reviewer 1: HEAD`,
    messages: [
      {
        id: "msg-1",
        role: "user",
        model: { providerID: "a", modelID: "one" },
        agent: "cross-reviewer",
        tools: { ...READ_ONLY_TOOLS },
        parts: [{ type: "text", text: "review" }],
      },
    ],
    totalMessages: 1,
    includedMessages: 1,
    omittedMessages: 0,
    retainedMessageIDs: ["msg-1"],
    truncated: false,
    protocolCalls: [],
    childrenListed: true,
    childCount: 0,
    ...overrides,
  };
}

describe("persisted context", () => {
  it("treats empty context as omitted", () => {
    expect(persistedContext({ context: "" })).toBeUndefined();
    expect(persistedContext({ context: "diff" })).toBe("diff");
  });
});

describe("deterministic audit checks", () => {
  it("fails the context contract when a parent-judged run omits context", () => {
    expect(checkContextContract(run()).result).toBe("fail");
    expect(checkContextContract(run({ context: "diff" })).result).toBe("pass");
    expect(checkContextContract(run({ context: "" })).result).toBe("fail");
    expect(
      checkContextContract(
        run({
          judgeModel: "b/judge",
          gatherer: {
            model: "b/judge",
            sessionID: "judge",
            messageID: "g",
            status: "succeeded",
          },
        }),
      ).result,
    ).toBe("pass");
    expect(checkContextContract(run({ judgeModel: "b/judge" })).result).toBe(
      "fail",
    );
    expect(
      checkGathererSkippedWhenContext(run({ context: "diff" })).result,
    ).toBe("pass");
    expect(
      checkGathererSkippedWhenContext(
        run({
          context: "diff",
          gatherer: {
            model: "b/judge",
            sessionID: "judge",
            messageID: "g",
            status: "queued",
          },
        }),
      ).result,
    ).toBe("fail");
    expect(checkGathererSkippedWhenContext(run({ context: "" })).result).toBe(
      "pass",
    );
  });

  it("checks gatherer and judge pairing on session and message IDs", () => {
    expect(checkGathererJudgeSession(run()).result).toBe("pass");
    expect(
      checkGathererJudgeSession(
        run({
          gatherer: {
            model: "b/judge",
            sessionID: "shared",
            messageID: "g",
            status: "succeeded",
          },
          judge: {
            model: "b/judge",
            sessionID: "shared",
            messageID: "j",
            status: "succeeded",
          },
        }),
      ).result,
    ).toBe("pass");
    expect(
      checkGathererJudgeSession(
        run({
          gatherer: {
            model: "b/judge",
            sessionID: "shared",
            messageID: "same",
            status: "succeeded",
          },
          judge: {
            model: "b/judge",
            sessionID: "shared",
            messageID: "same",
            status: "succeeded",
          },
        }),
      ).result,
    ).toBe("fail");
  });

  it("evaluates prompt model, tools-deny, and messageID on the linked user message", () => {
    const present = evidence();
    expect(
      checkPromptMessageID({
        runID: RUN_ID,
        role: "reviewer:1",
        messageID: "msg-1",
        evidence: present,
        inProgress: false,
      }).result,
    ).toBe("pass");
    expect(
      checkPromptModel({
        runID: RUN_ID,
        role: "reviewer:1",
        messageID: "msg-1",
        expectedModel: "a/one",
        evidence: present,
        inProgress: false,
      }).result,
    ).toBe("pass");
    expect(
      checkPromptModel({
        runID: RUN_ID,
        role: "reviewer:1",
        messageID: "msg-1",
        expectedModel: "a/one",
        evidence: evidence({
          messages: [
            {
              id: "msg-1",
              role: "user",
              model: { providerID: "a", modelID: "two" },
              parts: [{ type: "text", text: "x" }],
            },
          ],
        }),
        inProgress: false,
      }).result,
    ).toBe("fail");
    expect(
      checkToolsDeny({
        runID: RUN_ID,
        role: "reviewer:1",
        messageID: "msg-1",
        evidence: present,
        inProgress: false,
      }).result,
    ).toBe("pass");
    expect(
      checkToolsDeny({
        runID: RUN_ID,
        role: "reviewer:1",
        messageID: "msg-1",
        evidence: evidence({
          messages: [
            {
              id: "msg-1",
              role: "user",
              tools: { ...READ_ONLY_TOOLS, bash: true },
              parts: [{ type: "text", text: "x" }],
            },
          ],
        }),
        inProgress: false,
      }).result,
    ).toBe("fail");
    expect(
      checkPromptModel({
        runID: RUN_ID,
        role: "reviewer:1",
        messageID: "msg-1",
        expectedModel: "a/one",
        evidence: evidence({
          messages: [],
          retainedMessageIDs: [],
          includedMessages: 0,
          omittedMessages: 1,
          truncated: true,
        }),
        inProgress: false,
      }).result,
    ).toBe("insufficient-evidence");
  });

  it("does not hard-fail prompt checks for roles that were never dispatched", () => {
    expect(roleNeverDispatched({ status: "queued" })).toBe(true);
    expect(roleNeverDispatched({ status: "cancelled" })).toBe(true);
    expect(roleNeverDispatched({ status: "cancelled", startedAt: 10 })).toBe(
      false,
    );
    const empty = evidence({
      messages: [],
      retainedMessageIDs: [],
      includedMessages: 0,
      omittedMessages: 0,
      truncated: false,
    });
    expect(
      checkPromptMessageID({
        runID: RUN_ID,
        role: "reviewer:2",
        messageID: "msg-queued",
        evidence: empty,
        inProgress: false,
        neverDispatched: true,
      }).result,
    ).toBe("insufficient-evidence");
    expect(
      checkPromptModel({
        runID: RUN_ID,
        role: "judge",
        messageID: "msg-judge",
        expectedModel: "b/judge",
        evidence: empty,
        inProgress: false,
        neverDispatched: true,
      }).result,
    ).toBe("insufficient-evidence");
    expect(
      checkSilentModelReplace({
        run: run({
          phase: "cancelled",
          reviewers: [
            {
              reviewer: 1,
              model: "a/one",
              sessionID: "child-1",
              messageID: "msg-1",
              status: "cancelled",
            },
          ],
        }),
        sessions: new Map([["child-1", empty]]),
      }).result,
    ).toBe("pass");
  });

  it("fails silent model replace even when an earlier session is truncated", () => {
    expect(
      checkSilentModelReplace({
        run: run({
          reviewers: [
            {
              reviewer: 1,
              model: "a/one",
              sessionID: "child-1",
              messageID: "msg-1",
              status: "succeeded",
            },
            {
              reviewer: 2,
              model: "a/two",
              sessionID: "child-2",
              messageID: "msg-2",
              status: "succeeded",
            },
          ],
        }),
        sessions: new Map([
          [
            "child-1",
            evidence({
              sessionID: "child-1",
              messages: [],
              retainedMessageIDs: [],
              includedMessages: 0,
              omittedMessages: 1,
              truncated: true,
            }),
          ],
          [
            "child-2",
            evidence({
              sessionID: "child-2",
              messages: [
                {
                  id: "msg-2",
                  role: "user",
                  model: { providerID: "z", modelID: "wrong" },
                  parts: [{ type: "text", text: "x" }],
                },
              ],
            }),
          ],
        ]),
      }),
    ).toMatchObject({
      result: "fail",
      detail: expect.stringContaining("z/wrong"),
    });
  });

  it("marks wrap-up model comparison insufficient while a run is in progress", () => {
    const inProgress = run({ phase: "reviewing" });
    expect(
      checkSilentModelReplace({
        run: inProgress,
        sessions: new Map([["child-1", evidence({ messages: [] })]]),
      }).result,
    ).toBe("insufficient-evidence");
    expect(
      checkPromptModel({
        runID: RUN_ID,
        role: "reviewer:1",
        messageID: "msg-1",
        expectedModel: "a/one",
        evidence: evidence({
          messages: [
            {
              id: "msg-1",
              role: "user",
              model: { providerID: "z", modelID: "wrong" },
              parts: [{ type: "text", text: "x" }],
            },
          ],
        }),
        inProgress: true,
      }).result,
    ).toBe("fail");
  });

  it("fails when the parent used the blocking legacy tool", () => {
    expect(checkLegacyToolAbsent([]).result).toBe("pass");
    expect(
      checkLegacyToolAbsent([
        {
          name: "cross_review",
          status: "completed",
          args: {},
          omitted: [],
          result: {},
        },
      ]).result,
    ).toBe("fail");
  });
});

describe("audit session projection", () => {
  it("keeps user-message id, model, agent, and tools after normalize bounds", () => {
    const projected = projectAuditSession({
      bundle: {
        session: {
          id: "child-1",
          projectID: "p",
          directory: "/repo",
          parentID: "parent",
          title: "Cross-review 00000000 reviewer 1: HEAD",
          version: "1",
          time: { created: 1, updated: 2 },
        },
        messages: [
          {
            info: {
              id: "msg-1",
              sessionID: "child-1",
              role: "user",
              time: { created: 1 },
              agent: "cross-reviewer",
              model: { providerID: "a", modelID: "one" },
              tools: { ...READ_ONLY_TOOLS },
            },
            parts: [{ type: "text", text: "hello" }],
          },
        ],
      },
    });
    expect(projected.messages[0]).toMatchObject({
      id: "msg-1",
      model: { providerID: "a", modelID: "one" },
      agent: "cross-reviewer",
      tools: expect.objectContaining({
        bash: false,
        cross_review_audit: false,
      }),
    });
  });

  it("keeps shared gatherer/judge windows in original session order", () => {
    const projected = projectAuditSession({
      bundle: {
        session: {
          id: "judge",
          projectID: "p",
          directory: "/repo",
          parentID: "parent",
          title: "Cross-review 00000000 judge: HEAD",
          version: "1",
          time: { created: 1, updated: 2 },
        },
        messages: [
          {
            info: {
              id: "msg-g",
              sessionID: "judge",
              role: "user",
              time: { created: 1 },
            },
            parts: [{ type: "text", text: "gather" }],
          },
          {
            info: {
              id: "msg-g-a",
              sessionID: "judge",
              role: "assistant",
              time: { created: 2, completed: 3 },
              finish: "stop",
              parentID: "msg-g",
              modelID: "judge",
              providerID: "b",
              mode: "build",
              path: { cwd: "/repo", root: "/repo" },
              cost: 0,
              tokens: {
                input: 0,
                output: 0,
                reasoning: 0,
                cache: { read: 0, write: 0 },
              },
            },
            parts: [
              { type: "text", text: "gathered" },
              {
                type: "tool",
                tool: "read",
                state: { status: "completed", input: {}, output: "ok" },
              },
            ],
          },
          {
            info: {
              id: "msg-j",
              sessionID: "judge",
              role: "user",
              time: { created: 3 },
            },
            parts: [{ type: "text", text: "judge" }],
          },
          {
            info: {
              id: "msg-j-a",
              sessionID: "judge",
              role: "assistant",
              time: { created: 4, completed: 5 },
              finish: "stop",
              parentID: "msg-j",
              modelID: "judge",
              providerID: "b",
              mode: "build",
              path: { cwd: "/repo", root: "/repo" },
              cost: 0,
              tokens: {
                input: 0,
                output: 0,
                reasoning: 0,
                cache: { read: 0, write: 0 },
              },
            },
            parts: [{ type: "text", text: "verified" }],
          },
        ],
      },
      pinMessageIDs: ["msg-g", "msg-j"],
    });
    expect(projected.messages.map((message) => message.id)).toEqual([
      "msg-g",
      "msg-g-a",
      "msg-j",
      "msg-j-a",
    ]);
    const gatherer = roleBehavior(
      sliceFromMessage(projected.messages, "msg-g", "msg-j"),
    );
    const judge = roleBehavior(sliceFromMessage(projected.messages, "msg-j"));
    expect(gatherer.hasFinalAssistantText).toBe(true);
    expect(gatherer.toolHistogram.read).toBe(1);
    expect(judge.hasFinalAssistantText).toBe(true);
    expect(judge.toolHistogram).toEqual({});
  });

  it("attributes protocol calls by runID and caps the emitted timeline", () => {
    const calls = extractProtocolCalls([
      {
        info: {
          id: "a",
          sessionID: "p",
          role: "assistant",
          time: { created: 1, completed: 2 },
          finish: "tool-calls",
          parentID: "u",
          modelID: "p",
          providerID: "a",
          mode: "build",
          path: { cwd: "/repo", root: "/repo" },
          cost: 0,
          tokens: {
            input: 0,
            output: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
        },
        parts: [
          {
            type: "tool",
            tool: "cross_review_start",
            state: {
              status: "completed",
              input: { target: "HEAD" },
              output: JSON.stringify({ runID: RUN_ID, phase: "reviewing" }),
            },
          },
          {
            type: "tool",
            tool: "cross_review_status",
            state: {
              status: "completed",
              input: { runID: RUN_ID },
              output: JSON.stringify({ runID: RUN_ID, phase: "reviewing" }),
            },
          },
          {
            type: "tool",
            tool: "cross_review_start",
            state: {
              status: "completed",
              input: { target: "other" },
              output: JSON.stringify({
                runID: "00000000-0000-4000-8000-000000000002",
                phase: "reviewing",
              }),
            },
          },
        ],
      },
    ]);
    expect(protocolCallsForRun(calls, RUN_ID).map((call) => call.name)).toEqual(
      ["cross_review_start", "cross_review_status"],
    );
    const many = Array.from(
      { length: MAX_PROTOCOL_CALLS + 20 },
      (_, index) => ({
        name: "cross_review_status",
        status: "completed",
        createdAt: index,
        args: { waitMs: index },
        omitted: [],
        result: {},
      }),
    );
    const bounded = boundProtocolCalls(many);
    expect(bounded.calls).toHaveLength(MAX_PROTOCOL_CALLS);
    expect(bounded.omitted).toBe(20);
    expect(bounded.calls[0]?.args.waitMs).toBe(0);
    expect(bounded.calls.at(-1)?.args.waitMs).toBe(MAX_PROTOCOL_CALLS + 19);
  });
});
