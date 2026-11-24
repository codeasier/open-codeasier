import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "../src/plugin.js";
import { FileCrossReviewRunStore } from "../src/cross-review/run-store.js";
import { CROSS_REVIEW_START_PERMISSIONS } from "../src/cross-review/authorization.js";
import type {
  V2ContextEvent,
  V2Host,
  V2PermissionRule,
  V2ToolHookEvent,
} from "../src/opencode-v2/host.js";
import {
  childReviewPermissions,
  filterReviewTools,
  hasChildReviewPermissions,
  withAskDefaults,
} from "../src/opencode-v2/policy.js";

const rule = (
  action: string,
  effect: V2PermissionRule["effect"],
  resource = "*",
): V2PermissionRule => ({ action, effect, resource });
const native = [
  rule("*", "allow"),
  rule("read", "ask", "*.env"),
  rule("read", "ask", "*.env.*"),
  rule("read", "allow", "*.env.example"),
];
// Every rule exercised by this helper targets all resources.
const effectFor = (rules: readonly V2PermissionRule[], action: string) =>
  [...rules]
    .reverse()
    .find(
      (r) => (r.action === "*" || r.action === action) && r.resource === "*",
    )?.effect;

describe("V2 native permission rules", () => {
  it("asks on the stock V2 agent without moving any existing ask/allow/deny overrides", () => {
    for (const action of CROSS_REVIEW_START_PERMISSIONS) {
      expect(effectFor(withAskDefaults(native), action)).toBe("ask");
    }
    const configured = [
      ...native,
      rule("*", "allow"),
      rule("cross_review", "ask"),
      rule("cross_review", "deny", "a project"),
      rule("cross_review_start", "deny"),
      rule("cross_review_start", "ask"),
    ];
    expect(withAskDefaults(configured)).toEqual(configured);
    expect(withAskDefaults(withAskDefaults(native))).toEqual(
      withAskDefaults(native),
    );
    for (const userEffect of ["allow", "deny"] as const) {
      const rules = withAskDefaults([...native, rule("*", userEffect)]);
      for (const action of CROSS_REVIEW_START_PERMISSIONS)
        expect(effectFor(rules, action)).toBe(userEffect);
    }
  });

  it("appends native deny rules, preserves inherited path restrictions and fails closed if the host did not keep the policy", () => {
    const parent = [
      rule("read", "deny", "private/*"),
      rule("edit", "allow"),
      rule("shell", "allow"),
    ];
    const child = childReviewPermissions(parent);
    expect(child.slice(0, parent.length)).toEqual(parent);
    expect(child.slice(parent.length).every((r) => r.effect === "deny")).toBe(
      true,
    );
    for (const action of [
      "shell",
      "edit",
      "subagent",
      "execute",
      "external_directory",
      "cross_review",
      "session_review",
    ]) {
      expect(effectFor(child, action)).toBe("deny");
    }
    expect(hasChildReviewPermissions(child)).toBe(true);
    expect(hasChildReviewPermissions(parent)).toBe(false);
    expect(hasChildReviewPermissions(undefined)).toBe(false);
    expect(hasChildReviewPermissions([...child, rule("*", "allow")])).toBe(
      false,
    );
    expect(
      hasChildReviewPermissions(child.filter((r) => r.action !== "shell")),
    ).toBe(false);
  });

  it("honors a narrower V1 tool map without exposing new tools", () => {
    const tools = { read: 1, grep: 2, shell: 3 };
    filterReviewTools("cross-reviewer", new Set(["read"]), tools);
    expect(tools).toEqual({ grep: 2 });
  });

  afterEach(() => vi.restoreAllMocks());
  it("enforces the reviewer allowlist in both hooks in a fresh instance with no previous prompt", async () => {
    vi.spyOn(
      FileCrossReviewRunStore.prototype,
      "cleanupExpiredRuns",
    ).mockResolvedValue(undefined);
    const registration = { async dispose() {} };
    let context: ((event: V2ContextEvent) => void) | undefined;
    let before: ((event: V2ToolHookEvent) => Promise<void>) | undefined;
    const host = {
      location: { directory: "/review" },
      agent: { transform: vi.fn().mockResolvedValue(registration) },
      command: { transform: vi.fn().mockResolvedValue(registration) },
      tool: {
        transform: vi.fn().mockResolvedValue(registration),
        async hook(
          name: string,
          callback: (event: V2ToolHookEvent) => Promise<void>,
        ) {
          if (name === "execute.before") before = callback;
          return registration;
        },
      },
      session: {
        async hook(name: string, callback: (event: V2ContextEvent) => void) {
          if (name === "context") context = callback;
          return registration;
        },
      },
      event: { subscribe: () => [] },
    };
    const close = await plugin.setup(host as unknown as V2Host);
    try {
      if (!context || !before) throw new Error("missing V2 policy hook");
      const names = [
        "read",
        "grep",
        "shell",
        "subagent",
        "execute",
        "patch",
        "cross_review_start",
        "third_party",
      ];
      const catalog = () =>
        Object.fromEntries(
          names.map((n) => [n, { description: "", input: {} }]),
        );
      const tools = catalog();
      const sessionID = "resumed-review";
      const agent = "cross-reviewer";
      context({ sessionID, agent, tools });
      expect(Object.keys(tools)).toEqual(["read", "grep"]);
      for (const tool of names.slice(2)) {
        await expect(
          before({ sessionID, agent, tool, id: "call", input: {} }),
        ).rejects.toThrow("read-only review");
      }
      await expect(
        before({ sessionID, agent, tool: "read", id: "call", input: {} }),
      ).resolves.toBeUndefined();
      await expect(
        before({
          sessionID,
          agent,
          tool: "read",
          info: { name: "third_party" },
          id: "call",
          input: {},
        }),
      ).rejects.toThrow("read-only review");
      const parent = catalog();
      context({ sessionID: "parent", agent: "build", tools: parent });
      expect(Object.keys(parent)).toEqual(names);
      await expect(
        before({
          sessionID: "parent",
          agent: "build",
          tool: "shell",
          id: "call",
          input: {},
        }),
      ).resolves.toBeUndefined();
    } finally {
      await close();
    }
  });
});
