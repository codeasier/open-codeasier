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

function isMissingServiceError(error: unknown) {
  return (
    error instanceof Error && error.message.startsWith("Service not found:")
  );
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
  const fiber = Fiber.getCurrent();
  const run = Effect.runPromiseWith(fiber?.context ?? Context.empty());
  return async (plan: {
    target: string;
    reviewers: ReadonlyArray<{ model: string }>;
    judgeModel: string | undefined;
  }) => {
    if (context.abort.aborted) throw new Error("Cross-review cancelled");
    const reviewModels = plan.reviewers.map((reviewer) => reviewer.model);
    const description = `Start cross-review for ${plan.target} with ${reviewModels.length} independent reviewers (${reviewModels.join(", ")}); judge: ${plan.judgeModel ?? "parent-session"}. Additional model calls increase token usage and cost; isolated snapshot worktrees may be created.`;
    try {
      await run(
        context.ask({
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
        }),
        { signal: context.abort },
      );
    } catch (error) {
      if (fiber === undefined && isMissingServiceError(error))
        throw new Error(MISSING_HOST_FIBER_ERROR, { cause: error });
      throw error;
    }
    if (context.abort.aborted) throw new Error("Cross-review cancelled");
  };
}
