import { tool } from "@opencode-ai/plugin";

const REVIEWER_AGENT = "cross-reviewer";
const MODEL_ID = /^[^/\s]+\/[^/\s]+$/;
const READ_ONLY_TOOLS = {
  bash: false,
  edit: false,
  patch: false,
  task: false,
  write: false,
} as const;

type ApiResult<T> = { data?: T; error?: unknown };

export type CrossReviewClient = {
  provider: {
    list(input: {
      query: { directory: string };
      signal?: AbortSignal;
    }): Promise<
      ApiResult<{
        all: Array<{ id: string; models: Record<string, unknown> }>;
        connected: string[];
      }>
    >;
  };
  session: {
    create(input: {
      body: { parentID: string; title: string };
      query: { directory: string };
      signal?: AbortSignal;
    }): Promise<ApiResult<{ id: string }>>;
    prompt(input: {
      body: {
        agent: string;
        model: { providerID: string; modelID: string };
        parts: Array<{ type: "text"; text: string }>;
        tools: Record<string, boolean>;
      };
      path: { id: string };
      query: { directory: string };
      signal?: AbortSignal;
    }): Promise<ApiResult<{ parts: Array<{ type: string; text?: string }> }>>;
    abort(input: {
      path: { id: string };
      query: { directory: string };
    }): Promise<unknown>;
  };
};

type ReviewerResult = {
  reviewer: number;
  model: string;
  sessionID?: string;
  status: "succeeded" | "failed" | "cancelled";
  output?: string;
  error?: string;
};

function splitModel(value: string) {
  if (!MODEL_ID.test(value))
    throw new Error(`Invalid model identifier: ${value}`);
  const slash = value.indexOf("/");
  return { providerID: value.slice(0, slash), modelID: value.slice(slash + 1) };
}

function responseData<T>(result: ApiResult<T>, operation: string): T {
  if (result.error !== undefined || result.data === undefined)
    throw new Error(`${operation} failed`);
  return result.data;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function reviewBrief(target: string, focus?: string) {
  return [
    "Independently review the specified target. Remain read-only.",
    `Target: ${target}`,
    ...(focus === undefined ? [] : [`Focus: ${focus}`]),
    "Prioritize correctness defects, security risks, behavioral regressions, and missing tests.",
    "Verify each finding against repository evidence. Report only actionable findings with severity and file/line references; state explicitly when there are no findings.",
    "Return only your review. Do not inspect or infer any other reviewer's output.",
  ].join("\n");
}

async function runLimited<T>(
  count: number,
  concurrency: number,
  run: (index: number) => Promise<T>,
) {
  const results = new Array<T>(count);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(count, concurrency) }, async () => {
      while (next < count) {
        const index = next;
        next += 1;
        results[index] = await run(index);
      }
    }),
  );
  return results;
}

export function createCrossReviewTool(client: CrossReviewClient) {
  return tool({
    description:
      "Run isolated read-only code reviewers with explicit models and bounded concurrency",
    args: {
      target: tool.schema.string().min(1).max(4_000),
      reviewModels: tool.schema.array(tool.schema.string()).min(1).max(8),
      agents: tool.schema.number().int().min(1).max(8).default(3),
      maxConcurrency: tool.schema.number().int().min(1).max(8).default(3),
      judgeModel: tool.schema.string().optional(),
      focus: tool.schema.string().max(2_000).optional(),
    },
    async execute(args, context) {
      const requestedModels = [
        ...args.reviewModels,
        ...(args.judgeModel === undefined ? [] : [args.judgeModel]),
      ];
      const parsedModels = new Map(
        requestedModels.map((model) => [model, splitModel(model)]),
      );
      const catalog = responseData(
        await client.provider.list({
          query: { directory: context.directory },
          signal: context.abort,
        }),
        "Provider discovery",
      );
      for (const [model, parsed] of parsedModels) {
        const provider = catalog.all.find(
          (candidate) => candidate.id === parsed.providerID,
        );
        if (
          !catalog.connected.includes(parsed.providerID) ||
          provider === undefined ||
          !(parsed.modelID in provider.models)
        )
          throw new Error(`Unavailable model: ${model}`);
      }

      const sessions = new Set<string>();
      const abortSessions = () => {
        for (const id of sessions)
          void client.session
            .abort({
              path: { id },
              query: { directory: context.directory },
            })
            .catch(() => undefined);
      };
      context.abort.addEventListener("abort", abortSessions, { once: true });

      try {
        const brief = reviewBrief(args.target, args.focus);
        const reviewers = await runLimited(
          args.agents,
          args.maxConcurrency,
          async (index): Promise<ReviewerResult> => {
            const model = args.reviewModels[index % args.reviewModels.length];
            if (model === undefined) throw new Error("Missing reviewer model");
            const parsedModel = parsedModels.get(model);
            if (parsedModel === undefined)
              throw new Error(`Unvalidated reviewer model: ${model}`);
            let sessionID: string | undefined;
            try {
              const session = responseData(
                await client.session.create({
                  body: {
                    parentID: context.sessionID,
                    title: `Cross-review ${index + 1}: ${args.target}`,
                  },
                  query: { directory: context.directory },
                  signal: context.abort,
                }),
                "Reviewer session creation",
              );
              sessionID = session.id;
              sessions.add(session.id);
              const response = responseData(
                await client.session.prompt({
                  body: {
                    agent: REVIEWER_AGENT,
                    model: parsedModel,
                    parts: [{ type: "text", text: brief }],
                    tools: READ_ONLY_TOOLS,
                  },
                  path: { id: session.id },
                  query: { directory: context.directory },
                  signal: context.abort,
                }),
                "Reviewer prompt",
              );
              return {
                reviewer: index + 1,
                model,
                sessionID: session.id,
                status: "succeeded",
                output: response.parts
                  .filter((part) => part.type === "text")
                  .map((part) => part.text ?? "")
                  .join("\n"),
              };
            } catch (error) {
              return {
                reviewer: index + 1,
                model,
                ...(sessionID === undefined ? {} : { sessionID }),
                status: context.abort.aborted ? "cancelled" : "failed",
                error: errorMessage(error),
              };
            }
          },
        );

        if (context.abort.aborted) throw new Error("Cross-review cancelled");
        const successful = reviewers.filter(
          (reviewer) => reviewer.status === "succeeded",
        );
        const quorum = Math.floor(args.agents / 2) + 1;
        if (successful.length < quorum) {
          return {
            title: `Cross-review failed: ${args.target}`,
            output: JSON.stringify({
              target: args.target,
              brief,
              quorum,
              status: "quorum-not-met",
              reviewers,
            }),
            metadata: {
              requestedReviewers: args.agents,
              successfulReviewers: successful.length,
              failedReviewers: args.agents - successful.length,
              quorum,
              error: "quorum-not-met",
            },
          };
        }

        let judge:
          | {
              model: string;
              sessionID: string;
              status: "succeeded";
              output: string;
            }
          | undefined;
        if (args.judgeModel !== undefined) {
          const parsedJudgeModel = parsedModels.get(args.judgeModel);
          if (parsedJudgeModel === undefined)
            throw new Error(`Unvalidated judge model: ${args.judgeModel}`);
          const session = responseData(
            await client.session.create({
              body: {
                parentID: context.sessionID,
                title: `Cross-review judge: ${args.target}`,
              },
              query: { directory: context.directory },
              signal: context.abort,
            }),
            "Judge session creation",
          );
          sessions.add(session.id);
          const response = responseData(
            await client.session.prompt({
              body: {
                agent: REVIEWER_AGENT,
                model: parsedJudgeModel,
                parts: [
                  {
                    type: "text",
                    text: [
                      "Act as the read-only cross-review judge.",
                      `Target: ${args.target}`,
                      "Independently verify every candidate against repository evidence, deduplicate overlapping findings, and recalibrate severity.",
                      "Reject unsupported findings. Report findings first with file/line references, followed by reviewer provenance and testing gaps.",
                      JSON.stringify(successful),
                    ].join("\n"),
                  },
                ],
                tools: READ_ONLY_TOOLS,
              },
              path: { id: session.id },
              query: { directory: context.directory },
              signal: context.abort,
            }),
            "Judge prompt",
          );
          judge = {
            model: args.judgeModel,
            sessionID: session.id,
            status: "succeeded",
            output: response.parts
              .filter((part) => part.type === "text")
              .map((part) => part.text ?? "")
              .join("\n"),
          };
        }

        const result = {
          target: args.target,
          brief,
          quorum,
          reviewers,
          judge: judge ?? {
            model: "parent-session",
            status: "pending-parent-consolidation",
          },
        };
        return {
          title: `Cross-review: ${args.target}`,
          output: JSON.stringify(result),
          metadata: {
            requestedReviewers: args.agents,
            successfulReviewers: successful.length,
            failedReviewers: args.agents - successful.length,
            quorum,
            judgeModel: args.judgeModel ?? "parent-session",
          },
        };
      } finally {
        context.abort.removeEventListener("abort", abortSessions);
      }
    },
  });
}
