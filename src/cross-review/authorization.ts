import type { ToolContext } from "@opencode-ai/plugin";
import { Context, Effect, Fiber } from "effect";

export const CROSS_REVIEW_START_PERMISSIONS = [
  "cross_review_start",
  "cross_review",
] as const;

type StartPermission = (typeof CROSS_REVIEW_START_PERMISSIONS)[number];

/** Capture the host fiber before the async tool's first await. */
export function crossReviewAuthorization(
  context: ToolContext,
  permission: StartPermission,
) {
  // OpenCode's ask Effect uses instance/workspace references from this context.
  const run = Effect.runPromiseWith(
    Fiber.getCurrent()?.context ?? Context.empty(),
  );
  return async (plan: {
    target: string;
    reviewers: ReadonlyArray<{ model: string }>;
    judgeModel: string | undefined;
  }) => {
    if (context.abort.aborted) throw new Error("Cross-review cancelled");
    const reviewModels = plan.reviewers.map((reviewer) => reviewer.model);
    const description = `Start cross-review for ${plan.target} with ${reviewModels.length} independent reviewers (${reviewModels.join(", ")}); judge: ${plan.judgeModel ?? "parent-session"}. Additional model calls increase token usage and cost; isolated snapshot worktrees may be created.`;
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
    if (context.abort.aborted) throw new Error("Cross-review cancelled");
  };
}
