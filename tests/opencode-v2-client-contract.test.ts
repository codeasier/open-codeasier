import { describe, expect, it, vi } from "vitest";
import { createV1Client } from "../src/opencode-v2/client.js";
import type { VerifyChildDestination } from "../src/opencode-v2/destination.js";
import type { V2Host, V2PermissionRule } from "../src/opencode-v2/host.js";
import { createSessionReviewTool } from "../src/session-review/tool.js";
import type { SessionClient } from "../src/session-review/fetch.js";
import type { ToolContext } from "@opencode-ai/plugin";

const directory = "/fixtures/reviewer-snapshot";
const request = {
  body: { parentID: "parent", title: "Reviewer" },
  query: { directory },
};
function moveFixture(
  outcome: "moved" | "wrong" | "denies-lost" | "workspace" = "moved",
  verifyDestination?: VerifyChildDestination,
) {
  let location = "/fixtures/parent";
  let permissions: readonly V2PermissionRule[] = [];
  const inherited = {
    action: "read",
    resource: "private/*",
    effect: "deny",
  } as const;
  const child = () => ({
    id: "child",
    parentID: "parent",
    location: { directory: location },
    permissions,
  });
  const get = vi.fn(async ({ sessionID }: { sessionID: string }) =>
    sessionID === "parent"
      ? {
          id: "parent",
          permissions: [inherited],
          location: { directory: location },
        }
      : child(),
  );
  const create = vi.fn(
    async (input: { permissions: readonly V2PermissionRule[] }) => {
      permissions = input.permissions;
      return child();
    },
  );
  const move = vi.fn(async () => undefined);
  const wait = vi.fn(async () => {
    if (outcome !== "wrong") location = directory;
    if (outcome === "denies-lost") permissions = [];
  });
  const remove = vi.fn(async () => undefined);
  const prompt = vi.fn(async () => ({ id: "unused" }));
  const host = {
    location: {
      directory: location,
      ...(outcome === "workspace" ? { workspaceID: "remote" } : {}),
    },
    session: { get, create, move, wait, remove, prompt },
  };
  return {
    client: createV1Client(
      host as unknown as V2Host,
      new Map(),
      new Map(),
      verifyDestination,
    ),
    get,
    create,
    move,
    wait,
    remove,
    prompt,
    inherited,
    child,
  };
}

describe("V2 session contracts", () => {
  it("creates at the inherited location, waits for the relocation, then returns the verified child", async () => {
    const f = moveFixture();
    const result = await f.client.session.create(request);
    expect(result.data).toEqual({ id: "child" });
    expect(f.create).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: "cross-reviewer",
        parentID: "parent",
        permissions: expect.arrayContaining([f.inherited]),
      }),
      undefined,
    );
    expect(f.child().permissions.length).toBeGreaterThan(1);
    expect(f.move).toHaveBeenCalledWith(
      { sessionID: "child", directory },
      undefined,
    );
    expect(f.wait).toHaveBeenCalledWith({ sessionID: "child" }, undefined);
    expect(f.get).toHaveBeenLastCalledWith({ sessionID: "child" }, undefined);
    expect(f.remove).not.toHaveBeenCalled();
  });
  it.each(["wrong", "denies-lost", "workspace"] as const)(
    "refuses to return or prompt an unverified child (%s)",
    async (outcome) => {
      const f = moveFixture(outcome);
      expect((await f.client.session.create(request)).error).toBeDefined();
      expect(f.remove).toHaveBeenCalledWith({ sessionID: "child" });
      expect(f.prompt).not.toHaveBeenCalled();
      if (outcome === "workspace") expect(f.move).not.toHaveBeenCalled();
    },
  );
  it("does not return a relocated child without destination attestation", async () => {
    const verify = vi.fn(async () => {
      throw new Error("Destination policy missing");
    });
    const f = moveFixture("moved", verify);
    const result = await f.client.session.create(request);
    expect(f.get).toHaveBeenLastCalledWith({ sessionID: "child" }, undefined);
    expect(verify).toHaveBeenCalledWith("child", directory, undefined);
    expect(f.remove).toHaveBeenCalledWith({ sessionID: "child" });
    expect(result.error?.data.message).toBe("Destination policy missing");
  });
  it("reattests a previously verified destination before dispatch", async () => {
    const verify = vi
      .fn<VerifyChildDestination>()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("Destination unloaded"));
    const f = moveFixture("moved", verify);
    expect((await f.client.session.create(request)).data).toEqual({
      id: "child",
    });
    const result = await f.client.session.promptAsync({
      path: { id: "child" },
      body: { tools: { bash: false } },
      query: { directory },
    });
    expect(verify).toHaveBeenCalledTimes(2);
    expect(result.error?.data.message).toBe("Destination unloaded");
    expect(f.prompt).not.toHaveBeenCalled();
  });
  it("does not move an inherited same-directory child", async () => {
    const f = moveFixture();
    expect(
      (
        await f.client.session.create({
          ...request,
          query: { directory: "/fixtures/parent" },
        })
      ).data,
    ).toEqual({ id: "child" });
    expect(f.move).not.toHaveBeenCalled();
  });
  it("refuses a subsequently unrestricted child before prompting", async () => {
    const f = moveFixture();
    const result = await f.client.session.promptAsync({
      path: { id: "child" },
      query: { directory },
      body: { agent: "cross-reviewer", tools: { bash: false } },
    });
    expect(result.error?.data.message).toMatch(/read-only/);
    expect(f.prompt).not.toHaveBeenCalled();
  });
  it("reports an incomplete audit through session_review while letting recent-turn readers see their tail", async () => {
    const host = {
      session: {
        get: vi.fn(async ({ sessionID }: { sessionID: string }) => ({
          id: sessionID,
          location: { directory },
        })),
        context: vi.fn(async () => [
          { type: "compaction", status: "completed", id: "summary" },
          { type: "user", id: "new", text: "visible tail" },
        ]),
      },
    };
    const client = createV1Client(host as unknown as V2Host, new Map());
    const review = createSessionReviewTool(client as unknown as SessionClient);
    const result = await review.execute({ sessionID: "ses", mode: "summary" }, {
      sessionID: "primary",
      directory,
      abort: new AbortController().signal,
    } as ToolContext);
    expect(result).toMatchObject({
      metadata: { error: "SESSION_HISTORY_INCOMPLETE" },
    });
    expect(
      (
        await client.session.messages({
          path: { id: "ses" },
          query: { limit: 1 },
        })
      ).data?.[0]?.info.id,
    ).toBe("new");
  });
  it("does not treat failed compaction as discarded history", async () => {
    const c = createV1Client(
      {
        session: {
          context: async () => [
            { type: "user", id: "before", text: "evidence" },
            { type: "compaction", status: "failed" },
          ],
        },
      } as unknown as V2Host,
      new Map(),
    );
    expect(
      (await c.session.completeMessages({ path: { id: "ses" } })).data?.map(
        (item) => item.info.id,
      ),
    ).toEqual(["before"]);
  });
  it("never returns the previous assistant reply for a newly queued prompt", async () => {
    const c = createV1Client(
      {
        session: {
          prompt: async () => ({ id: "new" }),
          wait: async () => {},
          context: async () => [
            { type: "user", id: "old" },
            {
              type: "assistant",
              id: "old-answer",
              content: [{ type: "text", text: "stale" }],
            },
            { type: "user", id: "new" },
          ],
        },
      } as unknown as V2Host,
      new Map(),
    );
    expect(
      (
        await c.session.prompt({
          path: { id: "child" },
          query: { directory },
          body: { parts: [{ type: "text", text: "new request" }] },
        })
      ).data?.parts,
    ).toEqual([]);
  });
});
