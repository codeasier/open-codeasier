import { tool } from "@opencode-ai/plugin";
import {
  loadCrossReviewConfig,
  MODEL_ID,
  type CrossReviewConfig,
  type LoadedCrossReviewConfig,
} from "./config.js";

const REVIEWER_AGENT = "cross-reviewer";
const DEFAULT_AGENTS = 3;
const DEFAULT_CONCURRENCY = 3;
const READ_ONLY_TOOLS = {
  bash: false,
  edit: false,
  patch: false,
  task: false,
  write: false,
} as const;

type ApiResult<T> = { data?: T; error?: unknown };

type PromptResponse = {
  info?: { error?: unknown };
  parts: Array<{ type: string; text?: string }>;
};

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
    }): Promise<ApiResult<PromptResponse>>;
    abort(input: {
      path: { id: string };
      query: { directory: string };
    }): Promise<unknown>;
  };
};

export type CrossReviewConfigLoader = (
  directory: string,
) => Promise<LoadedCrossReviewConfig>;

type ReviewerTarget = { model: string; focus?: string };

type ReviewerResult = {
  reviewer: number;
  model: string;
  focus?: string;
  sessionID?: string;
  status: "succeeded" | "failed" | "cancelled";
  output?: string;
  error?: string;
};

type ReviewerProgress = Omit<ReviewerResult, "output" | "error" | "status"> & {
  status: "queued" | "running" | ReviewerResult["status"];
};

type JudgeProgress = {
  model: string;
  sessionID?: string;
  status: "starting" | "running" | "succeeded" | "failed" | "cancelled";
};

function configWarning(loaded: LoadedCrossReviewConfig): string | undefined {
  if (loaded.sources.project === "loaded") return undefined;
  if (loaded.sources.global === "loaded")
    return `warning: project config not found at ${loaded.projectPath}; using global config at ${loaded.globalPath}`;
  return `warning: no cross-review config found at ${loaded.projectPath} or ${loaded.globalPath}`;
}

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

function errorProperty(error: unknown, property: "name" | "message") {
  if (typeof error !== "object" || error === null) return undefined;
  const value = (error as Record<string, unknown>)[property];
  return typeof value === "string" ? value : undefined;
}

function promptError(error: unknown, operation: string) {
  const name = errorProperty(error, "name") ?? "MessageError";
  let message = errorProperty(error, "message");
  if (message === undefined && typeof error === "object" && error !== null)
    message = errorProperty((error as Record<string, unknown>).data, "message");
  const result = new Error(
    `${operation} failed: ${name}${message === undefined ? "" : `: ${message}`}`,
  );
  result.name = name;
  return result;
}

function promptOutput(result: ApiResult<PromptResponse>, operation: string) {
  const response = responseData(result, operation);
  if (response.info?.error !== undefined)
    throw promptError(response.info.error, operation);
  const output = response.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n")
    .trim();
  if (output.length === 0)
    throw new Error(`${operation} returned no text output`);
  return output;
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

function resolveReviewers(
  args: {
    reviewModels?: string[] | undefined;
    agents?: number | undefined;
    focus?: string | undefined;
  },
  config: CrossReviewConfig,
): ReviewerTarget[] {
  const sharedFocus = args.focus ?? config.focus;
  const count = args.agents ?? config.agents ?? DEFAULT_AGENTS;
  const explicitModels = args.reviewModels;
  if (explicitModels !== undefined)
    return Array.from({ length: count }, (_, index) => {
      const model = explicitModels[index % explicitModels.length];
      if (model === undefined) throw new Error("Missing reviewer model");
      return {
        model,
        ...(sharedFocus === undefined ? {} : { focus: sharedFocus }),
      };
    });
  if (config.reviewers !== undefined) {
    const configuredReviewers = config.reviewers;
    return Array.from(
      { length: args.agents ?? configuredReviewers.length },
      (_, index) => {
        const reviewer =
          configuredReviewers[index % configuredReviewers.length];
        if (reviewer === undefined)
          throw new Error("Missing configured reviewer");
        return {
          model: reviewer.model,
          ...(reviewer.focus === undefined
            ? sharedFocus === undefined
              ? {}
              : { focus: sharedFocus }
            : { focus: reviewer.focus }),
        };
      },
    );
  }
  const configuredModels = config.reviewModels;
  if (configuredModels !== undefined)
    return Array.from({ length: count }, (_, index) => {
      const model = configuredModels[index % configuredModels.length];
      if (model === undefined) throw new Error("Missing reviewer model");
      return {
        model,
        ...(sharedFocus === undefined ? {} : { focus: sharedFocus }),
      };
    });
  throw new Error(
    "No review models configured: pass --review-models or create .opencode/cross-review.json",
  );
}

async function runLimited<T>(
  count: number,
  concurrency: number,
  run: (index: number) => Promise<T>,
  shouldStop: () => boolean,
) {
  const results = new Array<T>(count);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(count, concurrency) }, async () => {
      while (next < count) {
        if (shouldStop()) return;
        const index = next;
        next += 1;
        results[index] = await run(index);
      }
    }),
  );
  return results;
}

export function createCrossReviewTool(
  client: CrossReviewClient,
  loadConfig: CrossReviewConfigLoader = loadCrossReviewConfig,
) {
  return tool({
    description:
      "Run isolated read-only code reviewers with configured models and bounded concurrency",
    args: {
      target: tool.schema.string().min(1).max(4_000),
      reviewModels: tool.schema
        .array(tool.schema.string())
        .min(1)
        .max(8)
        .optional(),
      agents: tool.schema.number().int().min(1).max(8).optional(),
      maxConcurrency: tool.schema.number().int().min(1).max(8).optional(),
      judgeModel: tool.schema.string().optional(),
      focus: tool.schema.string().max(2_000).optional(),
    },
    async execute(args, context) {
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

      const throwIfCancelled = () => {
        if (!context.abort.aborted) return;
        abortSessions();
        throw new Error("Cross-review cancelled");
      };

      try {
        throwIfCancelled();
        context.metadata({
          title: "Cross-review: preparing",
          metadata: { target: args.target, stage: "preparing" },
        });
        const loaded = await loadConfig(context.directory);
        throwIfCancelled();
        const config = loaded.config;
        const warning = configWarning(loaded);
        const reviewers = resolveReviewers(args, config);
        const judgeModel =
          args.judgeModel === undefined
            ? config.judgeModel
            : args.judgeModel.trim() || undefined;
        const maxConcurrency =
          args.maxConcurrency ?? config.maxConcurrency ?? DEFAULT_CONCURRENCY;
        const sharedFocus = args.focus ?? config.focus;
        const progress: ReviewerProgress[] = reviewers.map(
          (reviewer, index) => ({
            reviewer: index + 1,
            model: reviewer.model,
            ...(reviewer.focus === undefined ? {} : { focus: reviewer.focus }),
            status: "queued",
          }),
        );
        let judgeProgress: JudgeProgress | undefined;
        const publishProgress = (
          stage: "preparing" | "reviewing" | "judging" | "completed" | "failed",
        ) => {
          const completed = progress.filter(
            (reviewer) =>
              reviewer.status !== "queued" && reviewer.status !== "running",
          ).length;
          context.metadata({
            title:
              stage === "reviewing"
                ? `Cross-review: ${completed}/${reviewers.length} reviewers complete`
                : stage === "judging"
                  ? "Cross-review: judge running"
                  : stage === "completed"
                    ? "Cross-review: complete"
                    : stage === "failed"
                      ? "Cross-review: failed"
                      : "Cross-review: preparing",
            metadata: {
              target: args.target,
              stage,
              requestedReviewers: reviewers.length,
              completedReviewers: completed,
              reviewers: progress.map((reviewer) => ({ ...reviewer })),
              ...(judgeProgress === undefined
                ? {}
                : { judge: { ...judgeProgress } }),
            },
          });
        };
        publishProgress("preparing");

        const requestedModels = [
          ...new Set([
            ...reviewers.map((reviewer) => reviewer.model),
            ...(judgeModel === undefined ? [] : [judgeModel]),
          ]),
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
        throwIfCancelled();
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

        const brief = reviewBrief(args.target, sharedFocus);
        const reviewerResults = await runLimited(
          reviewers.length,
          maxConcurrency,
          async (index): Promise<ReviewerResult> => {
            const reviewer = reviewers[index];
            if (reviewer === undefined)
              throw new Error(`Missing reviewer ${index + 1}`);
            const parsedModel = parsedModels.get(reviewer.model);
            if (parsedModel === undefined)
              throw new Error(`Unvalidated reviewer model: ${reviewer.model}`);
            let sessionID: string | undefined;
            try {
              throwIfCancelled();
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
              progress[index] = {
                reviewer: index + 1,
                model: reviewer.model,
                ...(reviewer.focus === undefined
                  ? {}
                  : { focus: reviewer.focus }),
                sessionID: session.id,
                status: "running",
              };
              publishProgress("reviewing");
              try {
                throwIfCancelled();
                const output = promptOutput(
                  await client.session.prompt({
                    body: {
                      agent: REVIEWER_AGENT,
                      model: parsedModel,
                      parts: [
                        {
                          type: "text",
                          text: reviewBrief(args.target, reviewer.focus),
                        },
                      ],
                      tools: READ_ONLY_TOOLS,
                    },
                    path: { id: session.id },
                    query: { directory: context.directory },
                    signal: context.abort,
                  }),
                  "Reviewer prompt",
                );
                throwIfCancelled();
                const result: ReviewerResult = {
                  reviewer: index + 1,
                  model: reviewer.model,
                  ...(reviewer.focus === undefined
                    ? {}
                    : { focus: reviewer.focus }),
                  sessionID: session.id,
                  status: "succeeded",
                  output,
                };
                progress[index] = {
                  reviewer: result.reviewer,
                  model: result.model,
                  ...(result.focus === undefined
                    ? {}
                    : { focus: result.focus }),
                  sessionID: session.id,
                  status: result.status,
                };
                publishProgress("reviewing");
                return result;
              } finally {
                sessions.delete(session.id);
              }
            } catch (error) {
              const result: ReviewerResult = {
                reviewer: index + 1,
                model: reviewer.model,
                ...(reviewer.focus === undefined
                  ? {}
                  : { focus: reviewer.focus }),
                ...(sessionID === undefined ? {} : { sessionID }),
                status:
                  context.abort.aborted ||
                  (error instanceof Error &&
                    error.name === "MessageAbortedError")
                    ? "cancelled"
                    : "failed",
                error: errorMessage(error),
              };
              progress[index] = {
                reviewer: result.reviewer,
                model: result.model,
                ...(result.focus === undefined ? {} : { focus: result.focus }),
                ...(result.sessionID === undefined
                  ? {}
                  : { sessionID: result.sessionID }),
                status: result.status,
              };
              publishProgress("reviewing");
              return result;
            }
          },
          () => context.abort.aborted,
        );

        if (context.abort.aborted) throw new Error("Cross-review cancelled");
        const successful = reviewerResults.filter(
          (reviewer) => reviewer.status === "succeeded",
        );
        const quorum = Math.floor(reviewers.length / 2) + 1;
        if (successful.length < quorum) {
          publishProgress("failed");
          return {
            title: `Cross-review failed: ${args.target}`,
            output: JSON.stringify({
              ...(warning === undefined ? {} : { warning }),
              target: args.target,
              brief,
              quorum,
              status: "quorum-not-met",
              reviewers: reviewerResults,
            }),
            metadata: {
              requestedReviewers: reviewers.length,
              successfulReviewers: successful.length,
              failedReviewers: reviewers.length - successful.length,
              quorum,
              error: "quorum-not-met",
              configSources: loaded.sources,
              projectConfigPath: loaded.projectPath,
              globalConfigPath: loaded.globalPath,
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
        if (judgeModel !== undefined) {
          throwIfCancelled();
          const parsedJudgeModel = parsedModels.get(judgeModel);
          if (parsedJudgeModel === undefined)
            throw new Error(`Unvalidated judge model: ${judgeModel}`);
          judgeProgress = { model: judgeModel, status: "starting" };
          publishProgress("judging");
          try {
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
            judgeProgress = {
              model: judgeModel,
              sessionID: session.id,
              status: "running",
            };
            publishProgress("judging");
            throwIfCancelled();
            try {
              const output = promptOutput(
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
              throwIfCancelled();
              judge = {
                model: judgeModel,
                sessionID: session.id,
                status: "succeeded",
                output,
              };
              judgeProgress = {
                model: judge.model,
                sessionID: judge.sessionID,
                status: judge.status,
              };
              publishProgress("judging");
            } finally {
              sessions.delete(session.id);
            }
          } catch (error) {
            judgeProgress = {
              ...judgeProgress,
              model: judgeModel,
              status:
                context.abort.aborted ||
                (error instanceof Error && error.name === "MessageAbortedError")
                  ? "cancelled"
                  : "failed",
            };
            publishProgress("failed");
            throw error;
          }
        }

        const result = {
          ...(warning === undefined ? {} : { warning }),
          target: args.target,
          brief,
          quorum,
          reviewers: reviewerResults,
          judge: judge ?? {
            model: "parent-session",
            status: "pending-parent-consolidation",
          },
        };
        publishProgress("completed");
        return {
          title: `Cross-review: ${args.target}`,
          output: JSON.stringify(result),
          metadata: {
            requestedReviewers: reviewers.length,
            successfulReviewers: successful.length,
            failedReviewers: reviewers.length - successful.length,
            quorum,
            judgeModel: judgeModel ?? "parent-session",
            configSources: loaded.sources,
            projectConfigPath: loaded.projectPath,
            globalConfigPath: loaded.globalPath,
          },
        };
      } finally {
        context.abort.removeEventListener("abort", abortSessions);
      }
    },
  });
}
