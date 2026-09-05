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
} from "../src/cross-review/audit-checks.js";
import { READ_ONLY_TOOLS } from "../src/cross-review/tool.js";
import type { AuditSessionEvidence } from "../src/cross-review/audit-types.js";
import {
  RUN_SCHEMA_VERSION,
  type CrossReviewRun,
} from "../src/cross-review/run-store.js";
import { projectAuditSession } from "../src/cross-review/audit-project.js";

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
});
