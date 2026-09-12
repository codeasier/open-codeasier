/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it, vi } from "vitest";
import { Context, Effect } from "effect";
import {
  crossReviewAuthorization,
  MISSING_HOST_FIBER_ERROR,
} from "../src/cross-review/authorization.js";
import { pendingPermission } from "./helpers/permission.js";

const plan = {
  target: "https://github.com/org/repo/pull/69",
  reviewers: [{ model: "a/one" }],
  judgeModel: "b/judge",
};

function toolContext(
  ask: (input: unknown) => unknown,
  abort = new AbortController(),
) {
  return {
    sessionID: "parent",
    messageID: "message",
    agent: "build",
    directory: "/repo",
    worktree: "/repo",
    abort: abort.signal,
    metadata() {},
    ask,
  } as any;
}

describe("crossReviewAuthorization", () => {
  it("executes a host ask Effect with the captured fiber context", async () => {
    const approval = pendingPermission();
    const started = approval.execute(() => {
      const authorize = crossReviewAuthorization(
        toolContext(approval.ask),
        "cross_review_start",
      );
      return authorize(plan);
    });
    const request = await approval.requested.promise;
    expect(request.permission).toBe("cross_review_start");
    expect(approval.observedDirectories).toEqual(["/host-worktree"]);
    approval.decision.resolve(undefined);
    await started;
  });

  it("keeps service-free test doubles runnable without a host fiber", async () => {
    const ask = vi.fn(() => Effect.void);
    await crossReviewAuthorization(toolContext(ask), "cross_review")(plan);
    expect(ask).toHaveBeenCalledOnce();
  });

  it("surfaces permission denial from a fiber-less Effect.die", async () => {
    const ask = vi.fn(() => Effect.die(new Error("Permission denied")));
    await expect(
      crossReviewAuthorization(toolContext(ask), "cross_review_start")(plan),
    ).rejects.toThrow("Permission denied");
  });

  it("fails closed with an explicit error when a fiber-less ask needs host services", async () => {
    const Host = Context.Reference("test/required-host");
    const ask = vi.fn(() =>
      Effect.gen(function* () {
        return yield* Host;
      }),
    );
    await expect(
      crossReviewAuthorization(toolContext(ask), "cross_review_start")(plan),
    ).rejects.toThrow(MISSING_HOST_FIBER_ERROR);
  });
});
