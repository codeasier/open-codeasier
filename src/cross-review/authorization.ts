import type { ToolContext } from "@opencode-ai/plugin";
import { Context, Effect, Fiber } from "effect";
// Root `effect` must stay the same release as `@opencode-ai/plugin` so
// Fiber.getCurrent() and runPromiseWith share one module instance.

export const CROSS_REVIEW_START_PERMISSIONS = [
  "cross_review_start",
  "cross_review",
] as const;

export const MISSING_HOST_FIBER_ERROR =
  "cross-review requires an Effect-based tool runtime";

type StartPermission = (typeof CROSS_REVIEW_START_PERMISSIONS)[number];
type HostAsk = Effect.Effect<void> | PromiseLike<void>;

function isMissingServiceError(error: unknown) {
  return (
    error instanceof Error && error.message.startsWith("Service not found:")
  );
}

function isThenable(value: unknown): value is PromiseLike<void> {
  return (
    typeof value === "object" &&
    value !== null &&
    "then" in value &&
    typeof value.then === "function"
  );
}

function cancelled() {
  return new Error("Cross-review cancelled");
}

/** OpenCode 1.18+ ask is a Promise; bare await ignores context.abort. */
function awaitHostAskPromise(asked: PromiseLike<void>, signal: AbortSignal) {
  const promise = Promise.resolve(asked);
  if (signal.aborted) {
    void promise.then(undefined, () => undefined);
    return Promise.reject(cancelled());
  }
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      void promise.then(undefined, () => undefined);
      reject(cancelled());
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      () => {
        cleanup();
        if (signal.aborted) reject(cancelled());
        else resolve();
      },
      (error: unknown) => {
        cleanup();
        if (signal.aborted) reject(cancelled());
        else reject(error);
      },
    );
  });
}

/** Capture the host fiber before the async tool's first await. */
export function crossReviewAuthorization(
  context: ToolContext,
  permission: StartPermission,
) {
  // OpenCode 1.14.49 invokes execute inside a fiber. The ask Effect reads
  // instance/workspace services from that context. Context.empty() only lets
  // service-free test doubles (Effect.void / Effect.die) run; a real host ask
  // without a fiber fails closed with MISSING_HOST_FIBER_ERROR.
  // OpenCode 1.18+ injects a Promise-returning ask; the pin only governs
  // compile/test types. Detect the runtime shape: Effect objects are not
  // thenable, and awaiting a non-thenable Effect would skip the consent gate.
  const fiber = Fiber.getCurrent();
  const run = Effect.runPromiseWith(fiber?.context ?? Context.empty());
  return async (plan: {
    target: string;
    reviewers: ReadonlyArray<{ model: string }>;
    judgeModel: string | undefined;
  }) => {
    if (context.abort.aborted) throw cancelled();
    const reviewModels = plan.reviewers.map((reviewer) => reviewer.model);
    const description = `Start cross-review for ${plan.target} with ${reviewModels.length} independent reviewers (${reviewModels.join(", ")}); judge: ${plan.judgeModel ?? "parent-session"}. Additional model calls increase token usage and cost; isolated snapshot worktrees may be created.`;
    const asked = context.ask({
      permission,
      // Unknown permissions display patterns in the host's approval dialog.
      patterns: [description],
      always: [],
      metadata: {
        description,
        target: plan.target,
        reviewModels,
        reviewerCount: reviewModels.length,
        judgeModel: plan.judgeModel ?? "parent-session",
      },
    }) as HostAsk;
    try {
      if (isThenable(asked)) await awaitHostAskPromise(asked, context.abort);
      else await run(asked, { signal: context.abort });
    } catch (error) {
      if (fiber === undefined && isMissingServiceError(error))
        throw new Error(MISSING_HOST_FIBER_ERROR, { cause: error });
      throw error;
    }
    if (context.abort.aborted) throw cancelled();
  };
}
