/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it, vi } from "vitest";
import {
  createCrossReviewAuditTool,
  resolveOwnerRuns,
} from "../src/cross-review/audit.js";
import { READ_ONLY_TOOLS } from "../src/cross-review/tool.js";
import {
  RUN_SCHEMA_VERSION,
  type CrossReviewRun,
  type CrossReviewRunStore,
  type SaveRun,
} from "../src/cross-review/run-store.js";

const PARENT = "ses_parent";
const RUN_A = "aaaaaaaa-0000-4000-8000-000000000001";
const RUN_B = "bbbbbbbb-0000-4000-8000-000000000002";
const RUN_C = "aaaaaaaa-0000-4000-8000-000000000003";

class MemoryRunStore implements CrossReviewRunStore {
  readonly runs = new Map<string, CrossReviewRun>();
  extraErrors: Array<{
    code: "MANIFEST_CORRUPT" | "MANIFEST_NOT_FOUND";
    detail: string;
    runID?: string;
  }> = [];
  listCalls = 0;

  async create(run: CrossReviewRun) {
    this.runs.set(run.runID, structuredClone(run));
  }

  async withRun<T>(
    runID: string,
    action: (run: CrossReviewRun, save: SaveRun) => Promise<T>,
  ) {
    const run = this.runs.get(runID);
    if (run === undefined)
      throw new Error(`Cross-review run not found: ${runID}`);
    const save = async () => {
      this.runs.set(runID, structuredClone(run));
    };
    const result = await action(run, save);
    await save();
    return result;
  }

  async listByOwner(ownerSessionID: string) {
    this.listCalls += 1;
    const runs = [...this.runs.values()]
      .filter((run) => run.ownerSessionID === ownerSessionID)
      .map((run) => structuredClone(run))
      .sort(
        (left, right) =>
          left.createdAt - right.createdAt ||
          left.runID.localeCompare(right.runID),
      );
    return { runs, errors: this.extraErrors };
  }

  async read(runID: string) {
    const run = this.runs.get(runID);
    if (run === undefined)
      return {
        error: {
          code: "MANIFEST_NOT_FOUND" as const,
          runID,
          detail: `Cross-review run not found: ${runID}`,
        },
      };
    return { run: structuredClone(run) };
  }
}

function run(overrides: Partial<CrossReviewRun> = {}): CrossReviewRun {
  return {
    schemaVersion: RUN_SCHEMA_VERSION,
    runID: RUN_A,
    directory: "/repo",
    ownerSessionID: PARENT,
    createdAt: 10,
    updatedAt: 10,
    phase: "completed",
    target: "HEAD",
    brief: "brief",
    context: "the diff",
    quorum: 2,
    maxConcurrency: 3,
    reviewerTimeoutMs: 5_000,
    configSources: { project: "loaded", global: "absent" },
    projectConfigPath: "/repo/.opencode/cross-review.json",
    globalConfigPath: "/home/.config/opencode/cross-review.json",
    reviewers: [1, 2, 3].map((index) => ({
      reviewer: index,
      model: "a/one",
      sessionID: `rev-${index}`,
      messageID: `msg-rev-${index}`,
      status: "succeeded" as const,
    })),
    ...overrides,
  };
}

function userMessage(
  id: string,
  text: string,
  extras: Record<string, unknown> = {},
) {
  return {
    info: {
      id,
      sessionID: "s",
      role: "user" as const,
      time: { created: 1 },
      agent: "cross-reviewer",
      model: { providerID: "a", modelID: "one" },
      tools: { ...READ_ONLY_TOOLS },
      ...extras,
    },
    parts: [{ type: "text", text }],
  };
}

function assistantMessage(
  id: string,
  text: string,
  parts: unknown[] = [],
  finish = "stop",
) {
  return {
    info: {
      id,
      sessionID: "s",
      role: "assistant" as const,
      time: { created: 2, completed: 3 },
      finish,
      parentID: "u",
      modelID: "one",
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
    parts: [{ type: "text", text }, ...parts],
  };
}

function toolPart(
  name: string,
  input: unknown,
  output = "{}",
  status = "completed",
) {
  return {
    type: "tool",
    tool: name,
    state: {
      status,
      input,
      ...(status === "completed" ? { output } : { error: output }),
    },
  };
}

function parentMessages(parts: unknown[]) {
  return [
    {
      info: {
        id: "p-user",
        sessionID: PARENT,
        role: "user" as const,
        time: { created: 1 },
        agent: "build",
        model: { providerID: "a", modelID: "parent" },
      },
      parts: [{ type: "text", text: "review this" }],
    },
    {
      info: {
        id: "p-asst",
        sessionID: PARENT,
        role: "assistant" as const,
        time: { created: 2, completed: 3 },
        finish: "tool-calls",
        parentID: "p-user",
        modelID: "parent",
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
      parts,
    },
  ];
}

function reviewerSession(
  id: string,
  messageID: string,
  text = "Shared target context (already gathered; verify findings against it):\nthe diff",
  extraParts: unknown[] = [],
) {
  return {
    session: {
      id,
      projectID: "p",
      directory: "/repo",
      parentID: PARENT,
      title: `Cross-review ${RUN_A.slice(0, 8)} reviewer 1: HEAD`,
      version: "1",
      time: { created: 1, updated: 2 },
    },
    messages: [
      userMessage(messageID, text),
      assistantMessage(`${messageID}-a`, "Looks good", extraParts),
    ],
    children: [],
  };
}

function mockClient(sessions: Record<string, any>, callerID = "auditor") {
  return {
    session: {
      get: vi.fn(async (input: { path: { id: string } }) => {
        if (input.path.id === callerID)
          return { data: { id: callerID }, response: { status: 200 } };
        const found = sessions[input.path.id];
        if (found === undefined)
          return {
            error: { name: "NotFoundError", data: { message: "missing" } },
            response: { status: 404 },
          };
        return { data: found.session, response: { status: 200 } };
      }),
      messages: vi.fn(async (input: { path: { id: string } }) => {
        const found = sessions[input.path.id];
        if (found === undefined)
          return {
            error: { name: "NotFoundError", data: { message: "missing" } },
            response: { status: 404 },
          };
        return { data: found.messages, response: { status: 200 } };
      }),
      children: vi.fn(async (input: { path: { id: string } }) => {
        const found = sessions[input.path.id];
        if (found === undefined || found.children === undefined)
          return {
            error: { name: "NotFoundError", data: { message: "missing" } },
            response: { status: 404 },
          };
        return { data: found.children, response: { status: 200 } };
      }),
    },
  };
}

function context(sessionID = "auditor") {
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

async function execute(
  store: MemoryRunStore,
  sessions: Record<string, any>,
  args: { parentSessionID: string; runID?: string; focus?: string },
  callerID = "auditor",
) {
  const client = mockClient(sessions, callerID);
  const result = await createCrossReviewAuditTool(client as any, {
    store,
  }).execute(args, context(callerID));
  let payload: any;
  try {
    payload = JSON.parse((result as any).output);
  } catch {
    payload = undefined;
  }
  return { client, result, payload };
}

describe("run ID resolution", () => {
  it("accepts a stored UUID or an unambiguous hex prefix of at least 8 characters", () => {
    const runs = [
      run({ runID: RUN_A }),
      run({ runID: RUN_B }),
      run({ runID: RUN_C, createdAt: 20 }),
    ];
    expect(resolveOwnerRuns(runs, RUN_A).map((item) => item.runID)).toEqual([
      RUN_A,
    ]);
    expect(
      resolveOwnerRuns(runs, "bbbbbbbb").map((item) => item.runID),
    ).toEqual([RUN_B]);
    expect(() => resolveOwnerRuns(runs, "aaaaaaaa")).toThrow(
      expect.objectContaining({ code: "RUN_ID_AMBIGUOUS" }),
    );
    expect(() => resolveOwnerRuns(runs, "deadbeef")).toThrow(
      expect.objectContaining({ code: "RUN_NOT_FOUND" }),
    );
    expect(() => resolveOwnerRuns(runs, "abc")).toThrow(
      expect.objectContaining({ code: "RUN_NOT_FOUND" }),
    );
  });
});

describe("cross_review_audit tool", () => {
  it("audits a completed parent-judged run with shared context", async () => {
    const store = new MemoryRunStore();
    await store.create(run());
    const sessions = {
      [PARENT]: {
        session: {
          id: PARENT,
          projectID: "p",
          directory: "/repo",
          title: "parent",
          version: "1",
          time: { created: 1, updated: 2 },
        },
        messages: parentMessages([
          toolPart("cross_review_start", {
            target: "HEAD",
            context: "the diff",
          }),
        ]),
      },
      "rev-1": reviewerSession("rev-1", "msg-rev-1"),
      "rev-2": reviewerSession("rev-2", "msg-rev-2"),
      "rev-3": reviewerSession("rev-3", "msg-rev-3"),
    };
    const { payload } = await execute(store, sessions, {
      parentSessionID: PARENT,
    });
    expect(
      payload.checks.find((item: any) => item.id === "runs.found"),
    ).toMatchObject({ result: "pass" });
    expect(
      payload.checks.find((item: any) => item.id === "run.legacy_tool.absent"),
    ).toMatchObject({ result: "pass" });
    expect(payload.runs).toHaveLength(1);
    expect(
      payload.runs[0].checks.find(
        (item: any) => item.id === "run.context_contract",
      ),
    ).toMatchObject({ result: "pass" });
    expect(
      payload.runs[0].roles.reviewers.every(
        (role: any) => role.behavior.hasSharedContextMarker === true,
      ),
    ).toBe(true);
  });

  it("fails the context contract when reviewers wander without shared context", async () => {
    const store = new MemoryRunStore();
    await store.create(run({ context: undefined }));
    const wander = [
      toolPart("glob", { pattern: "**/*" }),
      toolPart("bash", { command: "git diff" }, "invalid", "invalid"),
    ];
    const sessions = {
      [PARENT]: {
        session: {
          id: PARENT,
          directory: "/repo",
          title: "parent",
          version: "1",
          time: { created: 1, updated: 2 },
          projectID: "p",
        },
        messages: parentMessages([
          toolPart("cross_review_start", { target: "HEAD" }),
        ]),
      },
      "rev-1": reviewerSession("rev-1", "msg-rev-1", "review HEAD", wander),
      "rev-2": reviewerSession("rev-2", "msg-rev-2", "review HEAD", wander),
      "rev-3": reviewerSession("rev-3", "msg-rev-3", "review HEAD", wander),
    };
    const { payload } = await execute(store, sessions, {
      parentSessionID: PARENT,
    });
    expect(
      payload.runs[0].checks.find(
        (item: any) => item.id === "run.context_contract",
      ),
    ).toMatchObject({ result: "fail" });
    expect(payload.runs[0].roles.reviewers[0].behavior.toolHistogram.bash).toBe(
      1,
    );
    expect(payload.runs[0].roles.reviewers[0].behavior.deniedAttempts).toEqual([
      expect.objectContaining({ name: "bash", status: "invalid" }),
    ]);
    expect(
      payload.runs[0].roles.reviewers[0].behavior.hasSharedContextMarker,
    ).toBe(false);
  });

  it("fetches a shared gatherer/judge session once and pairs message IDs", async () => {
    const store = new MemoryRunStore();
    await store.create(
      run({
        context: undefined,
        judgeModel: "b/judge",
        gatherer: {
          model: "b/judge",
          sessionID: "judge",
          messageID: "msg-g",
          status: "succeeded",
        },
        judge: {
          model: "b/judge",
          sessionID: "judge",
          messageID: "msg-j",
          status: "succeeded",
        },
      }),
    );
    const sessions = {
      [PARENT]: {
        session: {
          id: PARENT,
          directory: "/repo",
          title: "parent",
          version: "1",
          time: { created: 1, updated: 2 },
          projectID: "p",
        },
        messages: parentMessages([
          toolPart("cross_review_start", {
            target: "HEAD",
            judgeModel: "b/judge",
          }),
        ]),
      },
      "rev-1": reviewerSession("rev-1", "msg-rev-1"),
      "rev-2": reviewerSession("rev-2", "msg-rev-2"),
      "rev-3": reviewerSession("rev-3", "msg-rev-3"),
      judge: {
        session: {
          id: "judge",
          directory: "/repo",
          parentID: PARENT,
          title: `Cross-review ${RUN_A.slice(0, 8)} judge: HEAD`,
          version: "1",
          time: { created: 1, updated: 2 },
          projectID: "p",
        },
        messages: [
          userMessage("msg-g", "gather", {
            model: { providerID: "b", modelID: "judge" },
          }),
          assistantMessage("msg-g-a", "gathered diff"),
          userMessage("msg-j", "judge", {
            model: { providerID: "b", modelID: "judge" },
          }),
          assistantMessage("msg-j-a", "verified"),
        ],
        children: [],
      },
    };
    const { client, payload } = await execute(store, sessions, {
      parentSessionID: PARENT,
    });
    expect(
      payload.runs[0].checks.find(
        (item: any) => item.id === "gatherer.judge_session",
      ),
    ).toMatchObject({ result: "pass" });
    expect(
      client.session.get.mock.calls.filter(
        (call: any) => call[0].path.id === "judge",
      ),
    ).toHaveLength(1);
    expect(
      client.session.messages.mock.calls.filter(
        (call: any) => call[0].path.id === "judge",
      ),
    ).toHaveLength(1);
  });

  it("lists every owner run by createdAt and filters unique or ambiguous prefixes", async () => {
    const store = new MemoryRunStore();
    await store.create(run({ runID: RUN_A, createdAt: 30 }));
    await store.create(run({ runID: RUN_B, createdAt: 10, reviewers: [] }));
    await store.create(run({ runID: RUN_C, createdAt: 20, reviewers: [] }));
    const sessions = {
      [PARENT]: {
        session: {
          id: PARENT,
          directory: "/repo",
          title: "parent",
          version: "1",
          time: { created: 1, updated: 2 },
          projectID: "p",
        },
        messages: parentMessages([]),
      },
    };
    const all = await execute(store, sessions, { parentSessionID: PARENT });
    expect(all.payload.runs.map((item: any) => item.runID)).toEqual([
      RUN_B,
      RUN_C,
      RUN_A,
    ]);
    const one = await execute(store, sessions, {
      parentSessionID: PARENT,
      runID: "bbbbbbbb",
    });
    expect(one.payload.runs.map((item: any) => item.runID)).toEqual([RUN_B]);
    const unknown = await execute(store, sessions, {
      parentSessionID: PARENT,
      runID: "deadbeef",
    });
    expect(unknown.result).toMatchObject({
      metadata: { error: "RUN_NOT_FOUND" },
    });
    const ambiguous = await execute(store, sessions, {
      parentSessionID: PARENT,
      runID: "aaaaaaaa",
    });
    expect(ambiguous.result).toMatchObject({
      metadata: { error: "RUN_ID_AMBIGUOUS" },
    });
  });

  it("includes in-progress runs and keeps prompt checks that have evidence", async () => {
    const store = new MemoryRunStore();
    await store.create(
      run({
        phase: "reviewing",
        reviewers: [
          {
            reviewer: 1,
            model: "a/one",
            sessionID: "rev-1",
            messageID: "msg-rev-1",
            status: "running",
          },
        ],
      }),
    );
    const sessions = {
      [PARENT]: {
        session: {
          id: PARENT,
          directory: "/repo",
          title: "parent",
          version: "1",
          time: { created: 1, updated: 2 },
          projectID: "p",
        },
        messages: parentMessages([]),
      },
      "rev-1": {
        session: {
          id: "rev-1",
          directory: "/repo",
          parentID: PARENT,
          title: `Cross-review ${RUN_A.slice(0, 8)} reviewer 1: HEAD`,
          version: "1",
          time: { created: 1, updated: 2 },
          projectID: "p",
        },
        messages: [
          userMessage("msg-rev-1", "review", {
            model: { providerID: "z", modelID: "wrong" },
          }),
        ],
        children: [],
      },
    };
    const { payload } = await execute(store, sessions, {
      parentSessionID: PARENT,
    });
    expect(payload.runs[0].phase).toBe("reviewing");
    expect(
      payload.runs[0].checks.find(
        (item: any) => item.id === "role.prompt.model",
      ),
    ).toMatchObject({ result: "fail" });
    expect(
      payload.runs[0].checks.find(
        (item: any) => item.id === "role.orchestration.absent",
      ),
    ).toMatchObject({ result: "insufficient-evidence" });
  });

  it("reports legacy-only and never-used parents without throwing", async () => {
    const store = new MemoryRunStore();
    const sessions = {
      [PARENT]: {
        session: {
          id: PARENT,
          directory: "/repo",
          title: "parent",
          version: "1",
          time: { created: 1, updated: 2 },
          projectID: "p",
        },
        messages: parentMessages([
          toolPart("cross_review", { target: "HEAD" }, '{"phase":"completed"}'),
        ]),
      },
    };
    const legacy = await execute(store, sessions, { parentSessionID: PARENT });
    expect(legacy.payload.runs).toEqual([]);
    expect(
      legacy.payload.checks.find((item: any) => item.id === "runs.found"),
    ).toMatchObject({ result: "fail" });
    expect(
      legacy.payload.checks.find(
        (item: any) => item.id === "run.legacy_tool.absent",
      ),
    ).toMatchObject({ result: "fail" });

    const unused = await execute(
      store,
      {
        [PARENT]: {
          session: sessions[PARENT].session,
          messages: parentMessages([]),
        },
      },
      { parentSessionID: PARENT },
    );
    expect(
      unused.payload.checks.find((item: any) => item.id === "runs.found"),
    ).toMatchObject({ result: "fail" });
    expect(
      unused.payload.checks.find(
        (item: any) => item.id === "run.legacy_tool.absent",
      ),
    ).toMatchObject({ result: "pass" });
  });

  it("rejects child callers before reading the run store", async () => {
    const store = new MemoryRunStore();
    const client = mockClient(
      {
        child: {
          session: { id: "child", parentID: "root" },
          messages: [],
        },
      },
      "child",
    );
    client.session.get = vi.fn().mockResolvedValue({
      data: { id: "child", parentID: "root" },
      response: { status: 200 },
    });
    await expect(
      createCrossReviewAuditTool(client as any, { store }).execute(
        { parentSessionID: PARENT },
        context("child"),
      ),
    ).rejects.toThrow(
      "cross_review_audit can only be invoked from primary sessions",
    );
    expect(store.listCalls).toBe(0);
  });

  it("lets a non-owner primary session audit another owner on this machine", async () => {
    const store = new MemoryRunStore();
    await store.create(run({ reviewers: [] }));
    const { payload } = await execute(
      store,
      {
        [PARENT]: {
          session: {
            id: PARENT,
            directory: "/repo",
            title: "parent",
            version: "1",
            time: { created: 1, updated: 2 },
            projectID: "p",
          },
          messages: parentMessages([]),
        },
      },
      { parentSessionID: PARENT },
      "auditor",
    );
    expect(payload.runs).toHaveLength(1);
    expect(payload.parent.sessionID).toBe(PARENT);
  });

  it("includes directory-mismatched runs and corrupt sibling errors", async () => {
    const store = new MemoryRunStore();
    await store.create(run({ directory: "/other", reviewers: [] }));
    store.extraErrors = [
      {
        code: "MANIFEST_CORRUPT",
        runID: "00000000-0000-4000-8000-0000000000aa",
        detail: "Corrupt or unsupported cross-review run manifest",
      },
    ];
    const { payload } = await execute(
      store,
      {
        [PARENT]: {
          session: {
            id: PARENT,
            directory: "/repo",
            title: "parent",
            version: "1",
            time: { created: 1, updated: 2 },
            projectID: "p",
          },
          messages: parentMessages([]),
        },
      },
      { parentSessionID: PARENT },
    );
    expect(payload.runs[0].directoryMismatch).toBe(true);
    expect(payload.errors).toEqual(store.extraErrors);
  });

  it("does not invent omitted protocol args when parent polls are truncated", async () => {
    const store = new MemoryRunStore();
    const { payload } = await execute(
      store,
      {
        [PARENT]: {
          session: {
            id: PARENT,
            directory: "/repo",
            title: "parent",
            version: "1",
            time: { created: 1, updated: 2 },
            projectID: "p",
          },
          messages: parentMessages([
            toolPart("cross_review_status", { truncated: true, preview: "{}" }),
          ]),
        },
      },
      { parentSessionID: PARENT },
    );
    expect(payload.parent.protocolTimeline[0]).toMatchObject({
      name: "cross_review_status",
      omitted: ["input"],
    });
    expect(payload.parent.protocolTimeline[0].args).not.toHaveProperty(
      "timeoutAction",
    );
  });

  it("maps parent SDK failures without leaking tokens or paths", async () => {
    const store = new MemoryRunStore();
    const client = mockClient({}, "auditor");
    client.session.get = vi.fn().mockImplementation(async (input) => {
      if (input.path.id === "auditor")
        return { data: { id: "auditor" }, response: { status: 200 } };
      return {
        error: { name: "Denied", data: { message: "token /secret" } },
        response: { status: 403 },
      };
    });
    const result = await createCrossReviewAuditTool(client as any, {
      store,
    }).execute({ parentSessionID: PARENT }, context());
    expect(result).toMatchObject({
      metadata: { error: "SESSION_ACCESS_DENIED" },
    });
    expect((result as any).output).not.toMatch(/token|secret/);
  });
});
