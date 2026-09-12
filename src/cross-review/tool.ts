import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tool } from "@opencode-ai/plugin";
import { assertPrimarySession } from "../primary-session.js";
import { crossReviewAuthorization } from "./authorization.js";
import {
  findGitRoot,
  loadCrossReviewConfig,
  MODEL_ID,
  normalizeHostDefaultOverrides,
  prepareCrossReviewOverrides,
  type CrossReviewConfig,
  type LoadedCrossReviewConfig,
} from "./config.js";
import {
  classifyPrTargetInRepository,
  type PrTargetClassification,
} from "./pr-target.js";
import {
  createDefaultPrAdapterRunner,
  defaultRemoveSnapshot,
  existingPath,
  snapshotPaths,
  type PrAdapterRunner,
  type SnapshotRemover,
} from "./pr-gather.js";
import { assertSessionDirectoryBinding } from "./protocol.js";
import {
  defaultCrossReviewStateDirectory,
  FileCrossReviewRunStore,
  RUN_SCHEMA_VERSION,
  type CrossReviewRun,
} from "./run-store.js";

/** Injection points for the legacy tool's PR snapshot path (tests). */
export type LegacyPrSnapshotOptions = {
  classifyTarget?: (
    target: string,
    directory: string,
  ) => Promise<PrTargetClassification>;
  runPrAdapter?: PrAdapterRunner;
  stateRoot?: string;
  removeSnapshot?: SnapshotRemover;
};

export const REVIEWER_AGENT = "cross-reviewer";
const DEFAULT_AGENTS = 3;
const DEFAULT_CONCURRENCY = 3;
export const PRIMARY_TOOL_IDS = [
  "cross_review",
  "cross_review_config",
  "cross_review_start",
  "cross_review_status",
  "cross_review_cancel",
  "cross_review_finalize",
  "session_review",
  "cross_review_audit",
] as const;

export const READ_ONLY_TOOLS = {
  bash: false,
  edit: false,
  patch: false,
  task: false,
  write: false,
  cross_review: false,
  cross_review_config: false,
  cross_review_start: false,
  cross_review_status: false,
  cross_review_cancel: false,
  cross_review_finalize: false,
  session_review: false,
  cross_review_audit: false,
} as const;

export type ApiResult<T> = { data?: T; error?: unknown };

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
    get(input: {
      path: { id: string };
      query?: { directory?: string };
      signal?: AbortSignal;
    }): Promise<
      ApiResult<{ id: string; parentID?: string; directory?: string }>
    >;
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

export type ReviewerTarget = { model: string; focus?: string };

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

export function configWarning(
  loaded: LoadedCrossReviewConfig,
): string | undefined {
  if (loaded.sources.project === "loaded") return undefined;
  if (loaded.sources.global === "loaded")
    return `warning: project config not found at ${loaded.projectPath}; using global config at ${loaded.globalPath}`;
  return `warning: no cross-review config found at ${loaded.projectPath} or ${loaded.globalPath}`;
}

export const MISSING_PARENT_CONTEXT_ERROR =
  "Missing shared evidence for non-PR target without judgeModel: pass parent-gathered `context` or `evidenceDir`, or set `judgeModel`";

export const ACCEPTED_PR_TARGET_FORMS =
  "a `/pull/<n>` URL, `#<n>`, `<n>`, `PR#<n>`, or `PR <n>`";

export function missingSharedEvidenceMessage(target?: string): string {
  const received =
    target === undefined || target.trim() === ""
      ? "The target was not recognized as a pull request"
      : `Target "${target.trim()}" was not recognized as a pull request`;
  return `${MISSING_PARENT_CONTEXT_ERROR}. ${received}; accepted PR forms are ${ACCEPTED_PR_TARGET_FORMS}`;
}

export const OMIT_ARRAY_OVERRIDE_DESCRIPTION =
  "Omit when using defaults; do not pass an empty array";
export const OMIT_ZERO_OVERRIDE_DESCRIPTION =
  "Omit when using defaults; do not pass 0";

export function joinWarnings(
  ...parts: Array<string | undefined>
): string | undefined {
  const present = parts.filter(
    (part): part is string => typeof part === "string" && part.length > 0,
  );
  return present.length === 0 ? undefined : present.join("; ");
}

/**
 * Empty or whitespace-only `context` is treated as omitted: it must not
 * disable gathering or satisfy the parent-context requirement.
 */
export function normalizeProvidedContext(
  context: string | undefined,
): string | undefined {
  if (context === undefined) return undefined;
  const trimmed = context.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/**
 * Parent-session judging cannot run the gatherer. A classified PR snapshot,
 * validated evidence pack, or nonblank context supplies shared evidence.
 * Starts without shared evidence or a judge model fail closed before any
 * reviewer session exists.
 */
export function requireSharedEvidence(input: {
  judgeModel?: string | undefined;
  context?: string | undefined;
  isPrSnapshot: boolean;
  hasEvidencePack?: boolean;
  target?: string;
}): void {
  if (input.isPrSnapshot) return;
  if (input.hasEvidencePack === true) return;
  if (input.judgeModel !== undefined) return;
  if (normalizeProvidedContext(input.context) !== undefined) return;
  throw new Error(missingSharedEvidenceMessage(input.target));
}

/** Evidence retrieval limits for read-only reviewer, gatherer, and judge briefs. */
export function readOnlyEvidenceRules(): string[] {
  return [
    "Do not read `.git/**` or other VCS internals.",
    "Use only current working-directory-relative paths; do not guess historical or host-absolute paths.",
    "Consume provided shared evidence first (the already-gathered context block, or `.cross-review/` contract files in an isolated snapshot). Do not glob the whole tree or re-read the same file in overlapping chunks; stop exploring and return findings from the evidence you already have.",
    "If webfetch returns 403, 404, or 429, stop after that one attempt and fall back to local worktree files and already-gathered context. Do not retry.",
  ];
}

export function splitModel(value: string) {
  if (!MODEL_ID.test(value))
    throw new Error(`Invalid model identifier: ${value}`);
  const slash = value.indexOf("/");
  return { providerID: value.slice(0, slash), modelID: value.slice(slash + 1) };
}

export function responseData<T>(result: ApiResult<T>, operation: string): T {
  if (result.error !== undefined || result.data === undefined)
    throw new Error(`${operation} failed`);
  return result.data;
}

function errorProperty(error: unknown, property: "name" | "message") {
  if (typeof error !== "object" || error === null) return undefined;
  const value = (error as Record<string, unknown>)[property];
  return typeof value === "string" ? value : undefined;
}

export function promptError(error: unknown, operation: string) {
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

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/** Aligns with the `context` schema max on `cross_review` / `cross_review_start`. */
export const MAX_EMBEDDED_CONTEXT_LENGTH = 1_000_000;
/**
 * ASCII-equivalent units per estimated token. One ASCII char costs 1 unit;
 * one non-ASCII char costs this many (≈ 1 token for CJK).
 */
export const CHARS_PER_TOKEN_ESTIMATE = 4;
/** Leave room in the model window for the brief, tools, and output. */
export const CONTEXT_WINDOW_RESERVE_RATIO = 0.25;

export function embedUnitCost(charCode: number): number {
  return charCode <= 0x7f ? 1 : CHARS_PER_TOKEN_ESTIMATE;
}

/** Prefix length that fits in `limit` ASCII-equivalent units. */
export function embedKeepLength(
  context: string,
  limit = MAX_EMBEDDED_CONTEXT_LENGTH,
): number {
  const maxChars = Math.min(context.length, Math.max(0, limit));
  let units = 0;
  let kept = 0;
  for (; kept < maxChars; kept++) {
    const cost = embedUnitCost(context.charCodeAt(kept));
    if (units + cost > limit) break;
    units += cost;
  }
  return kept;
}

export function modelContextTokens(entry: unknown): number | undefined {
  if (typeof entry !== "object" || entry === null) return undefined;
  const limit = (entry as { limit?: unknown }).limit;
  if (typeof limit !== "object" || limit === null) return undefined;
  const context = (limit as { context?: unknown }).context;
  if (typeof context !== "number" || !Number.isFinite(context) || context <= 0)
    return undefined;
  return context;
}

export function tightestContextTokens(
  catalog: { all: Array<{ id: string; models: Record<string, unknown> }> },
  models: string[],
): number | undefined {
  let tightest: number | undefined;
  for (const model of models) {
    let parsed: { providerID: string; modelID: string };
    try {
      parsed = splitModel(model);
    } catch {
      continue;
    }
    const provider = catalog.all.find(
      (candidate) => candidate.id === parsed.providerID,
    );
    const tokens = modelContextTokens(provider?.models[parsed.modelID]);
    if (tokens === undefined) continue;
    tightest = tightest === undefined ? tokens : Math.min(tightest, tokens);
  }
  return tightest;
}

/** ASCII-equivalent unit budget from a token window; 1M when the window is unknown. */
export function embedLimitForContextWindow(
  windowTokens: number | undefined,
): number {
  if (windowTokens === undefined) return MAX_EMBEDDED_CONTEXT_LENGTH;
  const usableTokens = Math.max(
    1,
    Math.floor(windowTokens * (1 - CONTEXT_WINDOW_RESERVE_RATIO)),
  );
  return Math.min(
    MAX_EMBEDDED_CONTEXT_LENGTH,
    usableTokens * CHARS_PER_TOKEN_ESTIMATE,
  );
}

export function resolveEmbedLimit(
  catalog: { all: Array<{ id: string; models: Record<string, unknown> }> },
  models: string[],
): number {
  return embedLimitForContextWindow(tightestContextTokens(catalog, models));
}

export function embeddedContextOmitted(
  context: string,
  limit = MAX_EMBEDDED_CONTEXT_LENGTH,
): number {
  return context.length - embedKeepLength(context, limit);
}

export function embeddedContextWarning(
  context: string | undefined,
  limit = MAX_EMBEDDED_CONTEXT_LENGTH,
): string | undefined {
  if (context === undefined) return undefined;
  const omitted = embeddedContextOmitted(context, limit);
  if (omitted === 0) return undefined;
  return `warning: shared context exceeded the ${limit}-character embed limit and was truncated (${omitted} characters omitted)`;
}

export function embeddedContext(
  context: string,
  limit = MAX_EMBEDDED_CONTEXT_LENGTH,
): string | undefined {
  if (context.length === 0) return undefined;
  const kept = embedKeepLength(context, limit);
  if (kept === context.length) return context;
  return `${context.slice(0, kept)}\n[...context truncated: ${context.length - kept} chars omitted...]`;
}

export function reviewBrief(
  target: string,
  focus?: string,
  context?: string,
  embedLimit = MAX_EMBEDDED_CONTEXT_LENGTH,
) {
  return [
    "Independently review the specified target. Remain read-only.",
    `Target: ${target}`,
    ...(focus === undefined ? [] : [`Focus: ${focus}`]),
    ...(context === undefined || context.length === 0
      ? []
      : [
          "Shared target context (already gathered; verify findings against it):",
          embeddedContext(context, embedLimit) ?? "",
        ]),
    ...readOnlyEvidenceRules(),
    "Prioritize correctness defects, security risks, behavioral regressions, and missing tests.",
    "Verify each finding against repository evidence. Report only actionable findings with severity and file/line references; state explicitly when there are no findings.",
    "Return only your review. Do not inspect or infer any other reviewer's output.",
  ].join("\n");
}

export function gatherBrief(target: string) {
  return [
    "Act as the read-only cross-review context gatherer.",
    `Target: ${target}`,
    "Inspect the target (a repository state, pull request, or issue) and produce one self-contained review context: what changed or is reported, the exact diff or issue description, affected files and line references, and any referenced code or tests reviewers will need to verify findings.",
    ...readOnlyEvidenceRules(),
    "Do not review, judge, or propose findings. Do not consult other sessions. Return only the gathered context.",
  ].join("\n");
}

export type SnapshotBriefEvidence = {
  parentPack?: boolean;
  notes?: boolean;
  materials?: boolean;
};

/** Map persisted snapshot provenance to the files this run actually wrote. */
export function snapshotBriefEvidence(
  snapshot:
    | {
        source?: "parent-pack" | "adapter";
        evidenceDir?: string;
        notes?: boolean;
      }
    | undefined,
): SnapshotBriefEvidence {
  return {
    parentPack: snapshot?.source === "parent-pack",
    notes: snapshot?.notes === true,
    materials:
      snapshot !== undefined &&
      snapshot.source !== "parent-pack" &&
      typeof snapshot.evidenceDir === "string" &&
      snapshot.evidenceDir.length > 0,
  };
}

function adapterContractFiles(evidence: SnapshotBriefEvidence): string[] {
  return [
    "meta.json",
    "diff.patch",
    "pr.md",
    ...(evidence.notes === true ? ["notes.md"] : []),
    ...(evidence.materials === true ? ["materials/ attachments"] : []),
  ];
}

/**
 * Brief for classified pull-request snapshot runs: the current directory is
 * the pinned PR head worktree, and evidence is the worktree plus the
 * `.cross-review/` contract files that exist for this run. Never embeds the
 * diff or caller context.
 */
export function prSnapshotReviewBrief(
  target: string,
  focus?: string,
  evidence: SnapshotBriefEvidence = {},
) {
  return [
    "Independently review the specified target. Remain read-only.",
    `Target: ${target}`,
    ...(focus === undefined ? [] : [`Focus: ${focus}`]),
    "The current directory is an isolated git worktree snapshot at the pinned commit. Treat only this worktree as evidence.",
    "Evidence sources (read them from the current directory):",
    "- Worktree files at the pinned commit (the exact code under review).",
    ...(evidence.parentPack === true
      ? [
          "- .cross-review/meta.json (parent evidence metadata).",
          "- .cross-review/summary.md (shared target context).",
          "- Other files under .cross-review/ (parent-provided evidence).",
        ]
      : [
          "- .cross-review/meta.json (forge, canonical URL, base/head/merge-base SHAs).",
          "- .cross-review/diff.patch (the complete authoritative diff).",
          "- .cross-review/pr.md (title and description).",
          ...(evidence.notes === true
            ? ["- .cross-review/notes.md (caller notes)."]
            : []),
          ...(evidence.materials === true
            ? [
                "- .cross-review/materials/ (additional parent evidence, including meta.json and summary.md); these do not replace the authoritative adapter diff or metadata.",
              ]
            : []),
        ]),
    "Do not treat any other checkout or directory as evidence.",
    ...readOnlyEvidenceRules(),
    "Prioritize correctness defects, security risks, behavioral regressions, and missing tests.",
    "Verify each finding against repository evidence. Report only actionable findings with severity and file/line references; state explicitly when there are no findings.",
    "Return only your review. Do not inspect or infer any other reviewer's output.",
  ].join("\n");
}

/** Judge prompt prefix for classified pull-request snapshot runs. */
export function prSnapshotJudgeBrief(
  target: string,
  evidence: SnapshotBriefEvidence = {},
) {
  return [
    "Act as the read-only cross-review judge.",
    `Target: ${target}`,
    evidence.parentPack === true
      ? "The current directory is an isolated git worktree at the pinned commit. Read .cross-review/meta.json, .cross-review/summary.md and other .cross-review/ evidence files. Do not treat any other checkout as evidence."
      : `The current directory is an isolated git worktree snapshot at the pull request head commit. Evidence is this worktree plus .cross-review/ (${adapterContractFiles(evidence).join(", ")}). Do not treat any other checkout as evidence.`,
    ...readOnlyEvidenceRules(),
  ].join("\n");
}

export function resolveReviewers(
  args: {
    reviewModels?: string[] | undefined;
    agents?: number | undefined;
    focus?: string | undefined;
  },
  config: CrossReviewConfig,
): ReviewerTarget[] {
  const reviewers = resolveReviewerTargets(
    normalizeHostDefaultOverrides(args),
    config,
  );
  // A zero-reviewer resolution must be an error, never a valid run: it would
  // otherwise persist a ghost run that is immediately "finalizable" with an
  // unreachable quorum.
  if (reviewers.length === 0)
    throw new Error("Cross-review requires at least one reviewer");
  return reviewers;
}

function resolveReviewerTargets(
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
    "No review models configured: configure reviewers in .opencode/cross-review.json or pass --review-models",
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
  prSnapshotOptions: LegacyPrSnapshotOptions = {},
) {
  const classifyTarget =
    prSnapshotOptions.classifyTarget ?? classifyPrTargetInRepository;
  const runPrAdapter =
    prSnapshotOptions.runPrAdapter ?? createDefaultPrAdapterRunner();
  const stateRoot =
    prSnapshotOptions.stateRoot ?? defaultCrossReviewStateDirectory();
  const removeSnapshot =
    prSnapshotOptions.removeSnapshot ?? defaultRemoveSnapshot;
  return tool({
    description:
      "Legacy blocking cross-review entry point; invoke only with explicit user cross-review intent (independent multi-model review), not ordinary review, from primary sessions and prefer cross_review_start/status/finalize",
    args: {
      target: tool.schema.string().min(1).max(4_000),
      context: tool.schema.string().min(1).max(1_000_000).optional(),
      reviewModels: tool.schema
        .array(tool.schema.string())
        .min(1)
        .max(8)
        .optional()
        .describe(OMIT_ARRAY_OVERRIDE_DESCRIPTION),
      agents: tool.schema
        .number()
        .int()
        .min(1)
        .max(8)
        .optional()
        .describe(OMIT_ZERO_OVERRIDE_DESCRIPTION),
      maxConcurrency: tool.schema
        .number()
        .int()
        .min(1)
        .max(8)
        .optional()
        .describe(OMIT_ZERO_OVERRIDE_DESCRIPTION),
      judgeModel: tool.schema.string().optional(),
      focus: tool.schema.string().max(2_000).optional(),
    },
    async execute(args, context) {
      const authorize = crossReviewAuthorization(context, "cross_review");
      if (context.abort.aborted) throw new Error("Cross-review cancelled");
      await assertPrimarySession(
        client,
        context,
        "cross_review",
        context.abort,
      );
      const sessions = new Set<string>();
      // Child sessions live in the PR snapshot worktree once one exists; the
      // abort path must target the same directory the sessions were created
      // in.
      let childSessionDirectory = context.directory;
      const abortSessions = () => {
        for (const id of sessions)
          void client.session
            .abort({
              path: { id },
              query: { directory: childSessionDirectory },
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
        // The host may not enforce the declared tool schema, so type-default
        // empty overrides are stripped and remaining values are revalidated
        // against the loader's bounds.
        const overrides = prepareCrossReviewOverrides(args);
        const loaded = await loadConfig(context.directory);
        throwIfCancelled();
        const config = loaded.config;
        const configNotice = configWarning(loaded);
        const reviewers = resolveReviewers(overrides, config);
        const judgeModel =
          overrides.judgeModel === undefined
            ? config.judgeModel
            : overrides.judgeModel.trim() || undefined;
        const maxConcurrency =
          overrides.maxConcurrency ??
          config.maxConcurrency ??
          DEFAULT_CONCURRENCY;
        const sharedFocus = overrides.focus ?? config.focus;
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
        const embedLimit = resolveEmbedLimit(catalog, requestedModels);

        // An empty or whitespace-only context is treated as "not provided":
        // it must not disable gathering while embedding nothing into briefs.
        const providedContext = normalizeProvidedContext(args.context);
        // Classify and require shared evidence before the permission prompt
        // so a request that cannot succeed does not consume an approval.
        const classification = await classifyTarget(
          args.target,
          context.directory,
        );
        if (classification.kind === "error")
          throw new Error(classification.message);
        requireSharedEvidence({
          judgeModel,
          context: providedContext,
          isPrSnapshot: classification.kind === "pr",
          target: args.target,
        });
        await authorize({ target: args.target, reviewers, judgeModel });
        throwIfCancelled();
        publishProgress("preparing");

        let judgeSessionID: string | undefined;
        let gatheredContext: string | undefined;
        let gatherer:
          | {
              model: string;
              status: "succeeded" | "failed";
              output?: string;
              error?: string;
            }
          | undefined;
        // Classified pull requests are materialized as a snapshot worktree
        // before any reviewer session exists (fail closed, no LLM gatherer).
        let prSnapshot:
          | {
              worktree: string;
              snapshotDir: string;
              forge: "github" | "gitcode";
            }
          | undefined;
        let gatherRunID: string | undefined;
        const persistFailedSnapshotRun = async (
          worktree: string,
          reason: string,
        ): Promise<void> => {
          if (gatherRunID === undefined) return;
          const timestamp = Date.now();
          const failedRun: CrossReviewRun = {
            schemaVersion: RUN_SCHEMA_VERSION,
            runID: gatherRunID,
            directory: context.directory,
            ownerSessionID: context.sessionID,
            createdAt: timestamp,
            updatedAt: timestamp,
            phase: "failed",
            target: args.target,
            brief: `PR snapshot run failed: ${reason}`,
            quorum: 1,
            maxConcurrency: 1,
            reviewerTimeoutMs: 0,
            configSources: loaded.sources,
            projectConfigPath: loaded.projectPath,
            globalConfigPath: loaded.globalPath,
            reviewers: [],
            // Derive the snapshotDir from the retained worktree itself (not
            // the derived stateRoot layout) so the manifest keeps pointing
            // at reality for custom runners, mirroring protocol.ts.
            snapshot: {
              worktree,
              snapshotDir: join(worktree, ".cross-review"),
              forge:
                classification.kind === "pr" ? classification.forge : "github",
            },
          };
          await new FileCrossReviewRunStore(stateRoot)
            .create(failedRun)
            .catch(() => undefined);
        };
        if (classification.kind === "pr") {
          const repo =
            (await findGitRoot(context.directory)) ?? context.directory;
          gatherRunID = randomUUID();
          const gather = await runPrAdapter({
            forge: classification.forge,
            repo,
            target: args.target,
            runID: gatherRunID,
            stateRoot,
            ...(providedContext === undefined
              ? {}
              : { notes: providedContext }),
            ...(config.gitcodeCli === undefined
              ? {}
              : { gitcodeCli: config.gitcodeCli }),
          }).catch(async (error: unknown) => ({
            ok: false as const,
            error: errorMessage(error),
            // Only report a snapshot path that actually exists; a thrown
            // error may predate any materialization.
            snapshotPath: await existingPath(
              snapshotPaths(stateRoot, gatherRunID as string).worktree,
            ),
          }));
          if (!gather.ok) {
            // Persist a terminal failed manifest so the 7-day expired-run
            // cleanup can reclaim the worktree; the blocking tool has no
            // protocol lifecycle to do it.
            if (gather.snapshotPath !== undefined)
              await persistFailedSnapshotRun(gather.snapshotPath, gather.error);
            // The retained snapshot stays for diagnosis (S5).
            throw new Error(
              `${gather.error}${gather.snapshotPath === undefined ? "" : ` (snapshot retained at ${gather.snapshotPath})`}`,
            );
          }
          prSnapshot = {
            worktree: gather.worktree,
            snapshotDir: gather.snapshotDir,
            forge: classification.forge,
          };
        }
        // PR snapshot runs use the worktree as the child session directory
        // and the snapshot briefs; caller context is already notes.md.
        const sessionRoot = prSnapshot?.worktree ?? context.directory;
        childSessionDirectory = sessionRoot;
        const snapshotEvidence = {
          notes: providedContext !== undefined,
        };
        let completed = false;
        try {
          if (
            judgeModel !== undefined &&
            providedContext === undefined &&
            prSnapshot === undefined
          ) {
            const parsedJudgeModel = parsedModels.get(judgeModel);
            if (parsedJudgeModel === undefined)
              throw new Error(`Unvalidated judge model: ${judgeModel}`);
            throwIfCancelled();
            const session = responseData(
              await client.session.create({
                body: {
                  parentID: context.sessionID,
                  title: `Cross-review gather: ${args.target}`,
                },
                query: { directory: context.directory },
                signal: context.abort,
              }),
              "Gather session creation",
            );
            judgeSessionID = session.id;
            sessions.add(session.id);
            try {
              throwIfCancelled();
              const output = promptOutput(
                await client.session.prompt({
                  body: {
                    agent: REVIEWER_AGENT,
                    model: parsedJudgeModel,
                    parts: [{ type: "text", text: gatherBrief(args.target) }],
                    tools: READ_ONLY_TOOLS,
                  },
                  path: { id: session.id },
                  query: { directory: context.directory },
                  signal: context.abort,
                }),
                "Gather prompt",
              );
              throwIfCancelled();
              gatheredContext = output;
              gatherer = {
                model: judgeModel,
                status: "succeeded",
                output,
              };
            } catch (error) {
              gatherer = {
                model: judgeModel,
                status: "failed",
                error: errorMessage(error),
              };
            }
          }

          const gathered = providedContext ?? gatheredContext;
          const warning = joinWarnings(
            configNotice,
            prSnapshot === undefined
              ? embeddedContextWarning(gathered, embedLimit)
              : undefined,
          );
          const brief =
            prSnapshot === undefined
              ? reviewBrief(args.target, sharedFocus, gathered, embedLimit)
              : prSnapshotReviewBrief(
                  args.target,
                  sharedFocus,
                  snapshotEvidence,
                );
          const reviewerResults = await runLimited(
            reviewers.length,
            maxConcurrency,
            async (index): Promise<ReviewerResult> => {
              const reviewer = reviewers[index];
              if (reviewer === undefined)
                throw new Error(`Missing reviewer ${index + 1}`);
              const parsedModel = parsedModels.get(reviewer.model);
              if (parsedModel === undefined)
                throw new Error(
                  `Unvalidated reviewer model: ${reviewer.model}`,
                );
              let sessionID: string | undefined;
              try {
                throwIfCancelled();
                const session = responseData(
                  await client.session.create({
                    body: {
                      parentID: context.sessionID,
                      title: `Cross-review ${index + 1}: ${args.target}`,
                    },
                    query: { directory: sessionRoot },
                    signal: context.abort,
                  }),
                  "Reviewer session creation",
                );
                sessionID = session.id;
                sessions.add(session.id);
                // Fail closed (S10): the child must actually be bound to the
                // snapshot worktree, not the parent checkout.
                if (prSnapshot !== undefined)
                  await assertSessionDirectoryBinding(
                    client,
                    prSnapshot,
                    session.id,
                  );
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
                            text:
                              prSnapshot === undefined
                                ? reviewBrief(
                                    args.target,
                                    reviewer.focus,
                                    gathered,
                                    embedLimit,
                                  )
                                : prSnapshotReviewBrief(
                                    args.target,
                                    reviewer.focus,
                                    snapshotEvidence,
                                  ),
                          },
                        ],
                        tools: READ_ONLY_TOOLS,
                      },
                      path: { id: session.id },
                      query: { directory: sessionRoot },
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
                  ...(result.focus === undefined
                    ? {}
                    : { focus: result.focus }),
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
              let session: { id: string };
              if (judgeSessionID === undefined) {
                session = responseData(
                  await client.session.create({
                    body: {
                      parentID: context.sessionID,
                      title: `Cross-review judge: ${args.target}`,
                    },
                    query: { directory: sessionRoot },
                    signal: context.abort,
                  }),
                  "Judge session creation",
                );
                sessions.add(session.id);
                // Fail closed (S10): the judge must be bound to the same
                // snapshot worktree as the reviewers.
                if (prSnapshot !== undefined)
                  await assertSessionDirectoryBinding(
                    client,
                    prSnapshot,
                    session.id,
                  );
              } else {
                session = { id: judgeSessionID };
              }
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
                            prSnapshot === undefined
                              ? "Act as the read-only cross-review judge."
                              : prSnapshotJudgeBrief(
                                  args.target,
                                  snapshotEvidence,
                                ),
                            prSnapshot === undefined
                              ? `Target: ${args.target}`
                              : "",
                            ...(prSnapshot !== undefined
                              ? []
                              : providedContext === undefined
                                ? []
                                : [
                                    "Shared target context (already gathered; verify findings against it):",
                                    embeddedContext(
                                      providedContext,
                                      embedLimit,
                                    ) ?? "",
                                  ]),
                            ...(prSnapshot === undefined
                              ? readOnlyEvidenceRules()
                              : []),
                            "Independently verify every candidate against repository evidence, deduplicate overlapping findings, and recalibrate severity.",
                            "Reject unsupported findings. Report findings first with file/line references, followed by reviewer provenance and testing gaps.",
                            JSON.stringify(successful),
                          ]
                            .filter((line) => line.length > 0)
                            .join("\n"),
                        },
                      ],
                      tools: READ_ONLY_TOOLS,
                    },
                    path: { id: session.id },
                    query: { directory: sessionRoot },
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
                  (error instanceof Error &&
                    error.name === "MessageAbortedError")
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
            ...(gatherer === undefined ? {} : { gatherer }),
            reviewers: reviewerResults,
            judge: judge ?? {
              model: "parent-session",
              status: "pending-parent-consolidation",
            },
          };
          publishProgress("completed");
          completed = true;
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
          // Successful completion and cancellation remove the snapshot
          // worktree (R6); failures and quorum misses retain it for
          // diagnosis and persist a terminal failed manifest so the 7-day
          // expired-run cleanup can reclaim it later.
          if (prSnapshot !== undefined) {
            if (completed || context.abort.aborted) {
              await removeSnapshot(prSnapshot.worktree).catch(() => undefined);
            } else {
              await persistFailedSnapshotRun(
                prSnapshot.worktree,
                "run failed before expired-run cleanup",
              );
            }
          }
        }
      } finally {
        context.abort.removeEventListener("abort", abortSessions);
      }
    },
  });
}
