import type { ToolContext } from "@opencode-ai/plugin";

export type CrossReviewConfirmationPlan = {
  target: string;
  reviewers: ReadonlyArray<{ model: string; focus?: string }>;
  judgeModel: string | undefined;
  maxConcurrency: number;
  reviewerTimeoutMs: number;
  focus: string | undefined;
};

export const START_CROSS_REVIEW = "Start cross-review";

export function confirmationPlanKey(plan: CrossReviewConfirmationPlan): string {
  return JSON.stringify({
    target: plan.target,
    reviewers: plan.reviewers.map(({ model, focus }) => ({ model, focus })),
    judgeModel: plan.judgeModel,
    maxConcurrency: plan.maxConcurrency,
    reviewerTimeoutMs: plan.reviewerTimeoutMs,
    focus: plan.focus,
  });
}

export function startConfirmation(
  plan: CrossReviewConfirmationPlan,
  id: string,
) {
  return {
    id,
    questions: [
      {
        header: "Start cross-review",
        question: `是否启动交叉审查 / Start cross-review?\nTarget: ${plan.target}\nReviewers (${plan.reviewers.length}): ${plan.reviewers.map(({ model, focus }) => `${model}${focus === undefined ? "" : ` [${focus}]`}`).join(", ")}\nJudge: ${plan.judgeModel ?? "parent-session"}\nConcurrency: ${plan.maxConcurrency}; reviewer timeout: ${plan.reviewerTimeoutMs}ms\nFocus: ${plan.focus ?? "default"}\nAdditional model calls increase token usage and cost.\nConfirmation: ${id}`,
        options: [
          {
            label: START_CROSS_REVIEW,
            description:
              "Start this cross-review with the displayed target and configuration",
          },
          { label: "Cancel", description: "Do not start cross-review" },
        ],
        multiple: false,
      },
    ],
  };
}

export type CrossReviewConfirmation = ReturnType<typeof startConfirmation>;
export type CrossReviewPrepareConfirmation = (
  context: ToolContext,
  plan: CrossReviewConfirmationPlan,
) => Promise<CrossReviewConfirmation>;
export type CrossReviewConfirmStart = (
  context: ToolContext,
  plan: CrossReviewConfirmationPlan,
) => Promise<() => void>;

/** Match content, not object-key order; a question's answer comes from the host. */
export function matchesStartQuestion(
  actual: unknown,
  expected: CrossReviewConfirmation,
): boolean {
  if (!Array.isArray(actual) || actual.length !== 1) return false;
  const question = actual[0];
  const wanted = expected.questions[0];
  return (
    wanted !== undefined &&
    question !== null &&
    typeof question === "object" &&
    question.header === wanted.header &&
    question.question === wanted.question &&
    question.multiple !== true &&
    Array.isArray(question.options) &&
    question.options.length === wanted.options.length &&
    wanted.options.every(
      (option, index) =>
        question.options[index]?.label === option.label &&
        question.options[index]?.description === option.description,
    )
  );
}
