import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { tool } from "@opencode-ai/plugin";
import { assertPrimarySession } from "../primary-session.js";
import {
  configWarning,
  embeddedContext,
  errorMessage,
  gatherBrief,
  prSnapshotJudgeBrief,
  prSnapshotReviewBrief,
  type ApiResult,
  READ_ONLY_TOOLS,
  responseData,
  reviewBrief,
  REVIEWER_AGENT,
  resolveReviewers,
  splitModel,
  type CrossReviewConfigLoader,
  type ReviewerTarget,
} from "./tool.js";
import {
  findGitRoot,
  loadCrossReviewConfig,
  normalizeHostDefaultOverrides,
  prepareCrossReviewOverrides,
  type LoadedCrossReviewConfig,
} from "./config.js";
import {
  classifyPrTargetInRepository,
  type PrTargetClassification,
} from "./pr-target.js";
import {
  createDefaultPrAdapterRunner,
  defaultRemoveSnapshot,
  snapshotPaths,
  type PrAdapterRunner,
} from "./pr-gather.js";
import {
  defaultCrossReviewStateDirectory,
  FileCrossReviewRunStore,
  RUN_SCHEMA_VERSION,
  type AdapterGathererRun,
  type CrossReviewRun,
  type CrossReviewRunPhase,
  type CrossReviewRunStore,
  type GathererRun,
  type JudgeRun,
  type ReviewerRun,
  type ReviewerRunStatus,
  type SaveRun,
} from "./run-store.js";

const DEFAULT_CONCURRENCY = 3;
const DEFAULT_REVIEWER_TIMEOUT_MS = 10 * 60 * 1_000;
const DEFAULT_POLL_AFTER_MS = 3_000;
const SETTLED_POLL_AFTER_MS = 10_000;
const DEADLINE_WARNING_MS = 30_000;
const STATUS_TARGET_LIMIT = 80;
const SDK_REQUEST_TIMEOUT_MS = 15_000;
const STARTING_GRACE_MS = 15_000;
const DEFAULT_WAIT_MS = 30_000;
const MAX_WAIT_MS = 60_000;
const WAIT_TICK_MS = 3_000;

type SessionStatus =
  | { type: "idle" }
  | { type: "busy" }
  | { type: "retry"; attempt: number; message: string; next: number };

type SessionMessage = {
  info: {
    id?: string;
    parentID?: string;
    role: "user" | "assistant";
    time: { created: number; completed?: number };
    error?: unknown;
    finish?: string;
  };
  parts: Array<{
    type: string;
    text?: string;
    time?: { start: number; end?: number };
  }>;
};

type AsyncPrompt = {
  body: {
    messageID: string;
    agent: string;
    model: { providerID: string; modelID: string };
    parts: Array<{ type: "text"; text: string }>;
    tools: Record<string, boolean>;
  };
  path: { id: string };
  query: { directory: string };
  signal?: AbortSignal;
};

export type AsyncCrossReviewClient = {
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
    promptAsync(input: AsyncPrompt): Promise<ApiResult<void>>;
    status(input: {
      query: { directory: string };
      signal?: AbortSignal;
    }): Promise<ApiResult<Record<string, SessionStatus>>>;
    messages(input: {
      path: { id: string };
      query: { directory: string; limit?: number };
      signal?: AbortSignal;
    }): Promise<ApiResult<SessionMessage[]>>;
    abort(input: {
      path: { id: string };
      query: { directory: string };
      signal?: AbortSignal;
    }): Promise<ApiResult<boolean>>;
  };
};

type ProtocolContext = {
  sessionID: string;
  directory: string;
  abort: AbortSignal;
};

type ProtocolOptions = {
  loadConfig?: CrossReviewConfigLoader;
  store?: CrossReviewRunStore;
  now?: () => number;
  createRunID?: () => string;
  canonicalize?: (directory: string) => Promise<string>;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  defaultWaitMs?: number;
  /** Override PR classification (tests) or provide a custom classifier. */
  classifyTarget?: (
    target: string,
    directory: string,
  ) => Promise<PrTargetClassification>;
  /** Override the PR snapshot adapter runner (tests inject fakes here). */
  runPrAdapter?: PrAdapterRunner;
  /** Root that hosts `<runID>/` snapshot directories. */
  stateRoot?: string;
  /** Remove a snapshot worktree + its run directory (tests). */
  removeSnapshot?: (worktree: string) => Promise<void>;
};

type TimeoutAction = "abort" | "preserve";
type TimedRun = ReviewerRun | GathererRun | JudgeRun;

const ACTIVE_REVIEWER_STATUSES = new Set<ReviewerRunStatus>([
  "starting",
  "running",
  "retrying",
  "timeout_pending",
]);
const TERMINAL_REVIEWER_STATUSES = new Set<ReviewerRunStatus>([
  "succeeded",
  "failed",
  "timed_out",
  "cancelled",
]);

function requestSignal(parent: AbortSignal) {
  return AbortSignal.any([parent, AbortSignal.timeout(SDK_REQUEST_TIMEOUT_MS)]);
}

async function canonicalizeDirectory(directory: string) {
  try {
    return await realpath(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return resolve(directory);
    throw error;
  }
}

function asyncResponse(result: ApiResult<void>, operation: string) {
  if (result.error !== undefined)
    throw new Error(messageError(result.error, operation));
}

function createMessageID() {
  return `msg_${randomUUID()}`;
}

function migrateMessageIDs(run: CrossReviewRun) {
  let migrated = false;
  const migrate = (entry: ReviewerRun | GathererRun | JudgeRun) => {
    if (entry.messageID.startsWith("msg_")) return;
    entry.messageID = `msg_${entry.messageID}`;
    migrated = true;
  };
  for (const reviewer of run.reviewers) migrate(reviewer);
  if (run.gatherer !== undefined) migrate(run.gatherer);
  if (run.judge !== undefined) migrate(run.judge);
  return migrated;
}

function errorProperty(error: unknown, property: "name" | "message") {
  if (typeof error !== "object" || error === null) return undefined;
  const value = (error as Record<string, unknown>)[property];
  return typeof value === "string" ? value : undefined;
}

function messageError(error: unknown, operation: string) {
  const name = errorProperty(error, "name") ?? "MessageError";
  let message = errorProperty(error, "message");
  if (message === undefined && typeof error === "object" && error !== null)
    message = errorProperty((error as Record<string, unknown>).data, "message");
  return `${operation} failed: ${name}${message === undefined ? "" : `: ${message}`}`;
}

function activityAt(message: SessionMessage) {
  let latest = message.info.time.completed ?? message.info.time.created;
  for (const part of message.parts)
    latest = Math.max(latest, part.time?.end ?? part.time?.start ?? 0);
  return latest;
}

function terminalOutcome(
  messages: SessionMessage[],
  operation: string,
  expectedParentID?: string,
):
  | {
      status: "succeeded" | "failed" | "cancelled";
      latestActivityAt: number;
      output?: string;
      error?: string;
    }
  | undefined {
  // Prefer assistant messages linked to the expected user message, so a
  // session shared with another prompt (the judge reuses the gatherer
  // session) is never resolved from a sibling response. Fall back to the
  // last assistant message only when the SDK exposes no parent linkage at
  // all, which is unambiguous for single-prompt sessions.
  const assistantMessages = messages.filter(
    (message) => message.info.role === "assistant",
  );
  const hasParentData = assistantMessages.some(
    (message) => message.info.parentID !== undefined,
  );
  const candidates =
    expectedParentID !== undefined && hasParentData
      ? assistantMessages.filter(
          (message) => message.info.parentID === expectedParentID,
        )
      : assistantMessages;
  let assistant: SessionMessage | undefined;
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const candidate = candidates[index];
    if (candidate !== undefined) {
      assistant = candidate;
      break;
    }
  }
  if (assistant === undefined) return undefined;
  const latestActivityAt = activityAt(assistant);
  if (assistant.info.error !== undefined) {
    const name = errorProperty(assistant.info.error, "name");
    return {
      status: name === "MessageAbortedError" ? "cancelled" : "failed",
      latestActivityAt,
      error: messageError(assistant.info.error, operation),
    };
  }
  if (
    assistant.info.time.completed === undefined &&
    assistant.info.finish === undefined
  )
    return undefined;
  const output = assistant.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n")
    .trim();
  if (output.length === 0)
    return {
      status: "failed",
      latestActivityAt,
      error: `${operation} returned no text output`,
    };
  return { status: "succeeded", latestActivityAt, output };
}

function assertAuthorized(
  run: CrossReviewRun,
  context: ProtocolContext,
  directory: string,
) {
  if (run.ownerSessionID !== context.sessionID || run.directory !== directory)
    throw new Error(
      `Cross-review run is not owned by this session: ${run.runID}`,
    );
}

function activeReviewerCount(run: CrossReviewRun) {
  return run.reviewers.filter((reviewer) =>
    ACTIVE_REVIEWER_STATUSES.has(reviewer.status),
  ).length;
}

function reviewersTerminal(run: CrossReviewRun) {
  return run.reviewers.every((reviewer) =>
    TERMINAL_REVIEWER_STATUSES.has(reviewer.status),
  );
}

function isTerminalPhase(phase: CrossReviewRunPhase) {
  return (
    phase === "completed" ||
    phase === "quorum-not-met" ||
    phase === "failed" ||
    phase === "cancelled"
  );
}

function successfulReviewers(run: CrossReviewRun) {
  return run.reviewers.filter((reviewer) => reviewer.status === "succeeded");
}

function pendingTimeouts(run: CrossReviewRun) {
  return [
    ...run.reviewers
      .filter((reviewer) => reviewer.status === "timeout_pending")
      .map((reviewer) => ({
        role: "reviewer" as const,
        reviewer: reviewer.reviewer,
        model: reviewer.model,
        sessionID: reviewer.sessionID,
      })),
    ...(run.gatherer?.status === "timeout_pending"
      ? [
          {
            role: "gatherer" as const,
            model: run.gatherer.model,
            sessionID: run.gatherer.sessionID,
          },
        ]
      : []),
    ...(run.judge?.status === "timeout_pending"
      ? [
          {
            role: "judge" as const,
            model: run.judge.model,
            sessionID: run.judge.sessionID,
          },
        ]
      : []),
  ];
}

function timeoutActionRequired(run: CrossReviewRun) {
  return {
    type: "timeout",
    sessions: pendingTimeouts(run),
    options: ["preserve", "abort"],
    message:
      "Choose preserve to keep these sessions running and extend their deadlines, or abort to stop them. Then call cross_review_status with timeoutAction.",
  };
}

function markTimeoutPending(
  entry: TimedRun,
  label: string,
  timeoutMs: number,
  timestamp: number,
) {
  entry.status = "timeout_pending";
  entry.timeoutDetectedAt ??= timestamp;
  entry.error = `${label} reached its ${timeoutMs}ms timeout; awaiting preserve or abort decision`;
  delete entry.retry;
}

function preserveTimedRun(
  entry: TimedRun,
  status: SessionStatus | undefined,
  timeoutMs: number,
  timestamp: number,
) {
  entry.timeoutExtensions = (entry.timeoutExtensions ?? 0) + 1;
  entry.deadlineAt = timestamp + timeoutMs;
  delete entry.error;
  if (status?.type === "retry") {
    entry.status = "retrying";
    entry.retry = {
      attempt: status.attempt,
      message: status.message,
      next: status.next,
    };
    return;
  }
  delete entry.retry;
  entry.status = status?.type === "busy" ? "running" : "starting";
}

function runFinishedWaiting(run: CrossReviewRun) {
  if (pendingTimeouts(run).length > 0) return true;
  if (isTerminalPhase(run.phase)) return true;
  if (run.phase === "reviewing" && reviewersTerminal(run)) return true;
  if (
    run.phase === "judging" &&
    run.judge !== undefined &&
    TERMINAL_REVIEWER_STATUSES.has(run.judge.status as ReviewerRunStatus)
  )
    return true;
  return false;
}

function runSnapshot(run: CrossReviewRun) {
  return [
    run.phase,
    run.gatherer?.status ?? "",
    run.judge?.status ?? "",
    ...run.reviewers.map((reviewer) => reviewer.status),
  ].join(":");
}

function publicReviewer(reviewer: ReviewerRun, includeOutputs: boolean) {
  return {
    reviewer: reviewer.reviewer,
    model: reviewer.model,
    ...(reviewer.focus === undefined ? {} : { focus: reviewer.focus }),
    sessionID: reviewer.sessionID,
    status: reviewer.status,
    ...(reviewer.startedAt === undefined
      ? {}
      : { startedAt: reviewer.startedAt }),
    ...(reviewer.deadlineAt === undefined
      ? {}
      : { deadlineAt: reviewer.deadlineAt }),
    ...(reviewer.latestActivityAt === undefined
      ? {}
      : { latestActivityAt: reviewer.latestActivityAt }),
    ...(reviewer.timeoutDetectedAt === undefined
      ? {}
      : { timeoutDetectedAt: reviewer.timeoutDetectedAt }),
    ...(reviewer.timeoutExtensions === undefined
      ? {}
      : { timeoutExtensions: reviewer.timeoutExtensions }),
    ...(reviewer.completedAt === undefined
      ? {}
      : { completedAt: reviewer.completedAt }),
    ...(reviewer.retry === undefined ? {} : { retry: reviewer.retry }),
    ...(reviewer.error === undefined ? {} : { error: reviewer.error }),
    ...(!includeOutputs || reviewer.output === undefined
      ? {}
      : { output: reviewer.output }),
  };
}

function publicGatherer(
  gatherer: GathererRun | undefined,
  includeOutput: boolean,
) {
  if (gatherer === undefined) return undefined;
  return {
    model: gatherer.model,
    sessionID: gatherer.sessionID,
    status: gatherer.status,
    ...(gatherer.startedAt === undefined
      ? {}
      : { startedAt: gatherer.startedAt }),
    ...(gatherer.deadlineAt === undefined
      ? {}
      : { deadlineAt: gatherer.deadlineAt }),
    ...(gatherer.latestActivityAt === undefined
      ? {}
      : { latestActivityAt: gatherer.latestActivityAt }),
    ...(gatherer.timeoutDetectedAt === undefined
      ? {}
      : { timeoutDetectedAt: gatherer.timeoutDetectedAt }),
    ...(gatherer.timeoutExtensions === undefined
      ? {}
      : { timeoutExtensions: gatherer.timeoutExtensions }),
    ...(gatherer.completedAt === undefined
      ? {}
      : { completedAt: gatherer.completedAt }),
    ...(gatherer.retry === undefined ? {} : { retry: gatherer.retry }),
    ...(gatherer.error === undefined ? {} : { error: gatherer.error }),
    ...(!includeOutput || gatherer.output === undefined
      ? {}
      : { output: gatherer.output }),
  };
}

/** Adapter gatherer has no model and no session; `kind: "adapter"` (R4). */
function publicAdapterGatherer(adapter: AdapterGathererRun | undefined) {
  if (adapter === undefined) return undefined;
  return {
    kind: "adapter" as const,
    forge: adapter.forge,
    status: adapter.status,
    ...(adapter.startedAt === undefined
      ? {}
      : { startedAt: adapter.startedAt }),
    ...(adapter.completedAt === undefined
      ? {}
      : { completedAt: adapter.completedAt }),
    ...(adapter.error === undefined ? {} : { error: adapter.error }),
  };
}

function publicJudge(judge: JudgeRun | undefined, includeOutput: boolean) {
  if (judge === undefined) return undefined;
  return {
    model: judge.model,
    sessionID: judge.sessionID,
    status: judge.status,
    ...(judge.startedAt === undefined ? {} : { startedAt: judge.startedAt }),
    ...(judge.deadlineAt === undefined ? {} : { deadlineAt: judge.deadlineAt }),
    ...(judge.latestActivityAt === undefined
      ? {}
      : { latestActivityAt: judge.latestActivityAt }),
    ...(judge.timeoutDetectedAt === undefined
      ? {}
      : { timeoutDetectedAt: judge.timeoutDetectedAt }),
    ...(judge.timeoutExtensions === undefined
      ? {}
      : { timeoutExtensions: judge.timeoutExtensions }),
    ...(judge.completedAt === undefined
      ? {}
      : { completedAt: judge.completedAt }),
    ...(judge.retry === undefined ? {} : { retry: judge.retry }),
    ...(judge.error === undefined ? {} : { error: judge.error }),
    ...(!includeOutput || judge.output === undefined
      ? {}
      : { output: judge.output }),
  };
}

function truncate(text: string, limit: number) {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 3)}...`;
}

// Polling is what advances a run (dispatch, deadline enforcement), so the
// interval is the token-cost lever: poll eagerly only while sessions are
// starting or a deadline approaches, and settle into longer intervals once
// every active session is confirmed running.
function pollAfterMs(run: CrossReviewRun, timestamp: number) {
  if (pendingTimeouts(run).length > 0) return undefined;
  if (
    run.phase === "completed" ||
    run.phase === "quorum-not-met" ||
    run.phase === "failed" ||
    run.phase === "cancelled"
  )
    return undefined;
  // The gathering phase gates every reviewer, so poll eagerly.
  if (run.phase === "gathering") return DEFAULT_POLL_AFTER_MS;
  const active = [
    ...run.reviewers,
    ...(run.gatherer === undefined ? [] : [run.gatherer]),
    ...(run.judge === undefined ? [] : [run.judge]),
  ].filter((entry) => ACTIVE_REVIEWER_STATUSES.has(entry.status));
  if (active.some((entry) => entry.status === "starting"))
    return DEFAULT_POLL_AFTER_MS;
  const earliestDeadline = active.reduce(
    (earliest, entry) =>
      Math.min(earliest, entry.deadlineAt ?? Number.POSITIVE_INFINITY),
    Number.POSITIVE_INFINITY,
  );
  if (earliestDeadline - timestamp < DEADLINE_WARNING_MS)
    return Math.max(1_000, earliestDeadline - timestamp);
  return SETTLED_POLL_AFTER_MS;
}

function configObservability(run: CrossReviewRun) {
  return {
    config: {
      sources: run.configSources,
      projectConfigPath: run.projectConfigPath,
      globalConfigPath: run.globalConfigPath,
    },
    ...(run.warning === undefined ? {} : { warning: run.warning }),
  };
}

function progress(
  run: CrossReviewRun,
  includeOutputs: boolean,
  detail: boolean,
  timestamp: number,
) {
  const counts: Record<string, number> = {};
  for (const reviewer of run.reviewers)
    counts[reviewer.status] = (counts[reviewer.status] ?? 0) + 1;
  const pollAfter = pollAfterMs(run, timestamp);
  const compact = {
    runID: run.runID,
    phase: run.phase,
    quorum: run.quorum,
    counts,
    readyToFinalize: run.phase === "reviewing" && reviewersTerminal(run),
    pollAfterMs: pollAfter,
    summary: progressSummary(run, counts, pollAfter),
    ...(pendingTimeouts(run).length === 0
      ? {}
      : { actionRequired: timeoutActionRequired(run) }),
  };
  if (!detail && !includeOutputs) return compact;
  return {
    ...compact,
    ...configObservability(run),
    target: run.target,
    reviewers: run.reviewers.map((reviewer) =>
      publicReviewer(reviewer, includeOutputs),
    ),
    ...(run.gatherer === undefined && run.adapterGatherer === undefined
      ? {}
      : run.gatherer !== undefined
        ? { gatherer: publicGatherer(run.gatherer, includeOutputs) }
        : { gatherer: publicAdapterGatherer(run.adapterGatherer) }),
    ...(run.judge === undefined
      ? {}
      : { judge: publicJudge(run.judge, includeOutputs) }),
    ...(run.snapshot === undefined
      ? {}
      : {
          snapshot: {
            worktree: run.snapshot.worktree,
            forge: run.snapshot.forge,
            ...(run.snapshot.url === undefined
              ? {}
              : { url: run.snapshot.url }),
            ...(run.snapshot.headSha === undefined
              ? {}
              : { headSha: run.snapshot.headSha }),
          },
        }),
  };
}

function progressSummary(
  run: CrossReviewRun,
  counts: Record<string, number>,
  pollAfterMs: number | undefined,
): string {
  const lines: string[] = [];
  lines.push(
    `Cross-review ${run.phase} for ${truncate(run.target, STATUS_TARGET_LIMIT)}`,
  );
  const total = run.reviewers.length;
  const ordered = [
    "succeeded",
    "running",
    "starting",
    "retrying",
    "queued",
    "timeout_pending",
    "timed_out",
    "failed",
    "cancelled",
  ] as const;
  const present = ordered.filter((status) => (counts[status] ?? 0) > 0);
  if (present.length === 0) {
    lines.push(`- ${total} reviewer(s) pending`);
  } else {
    for (const status of present)
      lines.push(`- ${counts[status]} ${status} of ${total}`);
  }
  for (const reviewer of run.reviewers) {
    const label = [reviewer.reviewer, reviewer.model]
      .filter(Boolean)
      .join(": ");
    let detail = `${label} — ${reviewer.status}`;
    if (reviewer.retry !== undefined)
      detail += ` (retry ${reviewer.retry.attempt}: ${reviewer.retry.message})`;
    if (reviewer.timeoutExtensions !== undefined)
      detail += ` (preserved ${reviewer.timeoutExtensions}x)`;
    if (reviewer.error !== undefined) detail += ` — ${reviewer.error}`;
    lines.push(`  ${detail}`);
  }
  if (run.gatherer !== undefined) {
    const gatherer = run.gatherer;
    let detail = `gatherer (${gatherer.model}) — ${gatherer.status}`;
    if (gatherer.retry !== undefined)
      detail += ` (retry ${gatherer.retry.attempt}: ${gatherer.retry.message})`;
    if (gatherer.timeoutExtensions !== undefined)
      detail += ` (preserved ${gatherer.timeoutExtensions}x)`;
    if (gatherer.error !== undefined) detail += ` — ${gatherer.error}`;
    lines.push(`  ${detail}`);
  }
  if (run.judge !== undefined) {
    const judge = run.judge;
    let detail = `judge (${judge.model}) — ${judge.status}`;
    if (judge.retry !== undefined)
      detail += ` (retry ${judge.retry.attempt}: ${judge.retry.message})`;
    if (judge.timeoutExtensions !== undefined)
      detail += ` (preserved ${judge.timeoutExtensions}x)`;
    if (judge.error !== undefined) detail += ` — ${judge.error}`;
    lines.push(`  ${detail}`);
  }
  if (pollAfterMs !== undefined)
    lines.push(`poll again after ${Math.round(pollAfterMs / 1000)}s`);
  if (pendingTimeouts(run).length > 0)
    lines.push(
      "timeout decision required: call cross_review_status with timeoutAction preserve or abort",
    );
  return lines.join("\n");
}

function result(title: string, output: Record<string, unknown>) {
  const config =
    output.config !== undefined &&
    typeof output.config === "object" &&
    output.config !== null
      ? (output.config as {
          sources?: unknown;
          projectConfigPath?: unknown;
          globalConfigPath?: unknown;
        })
      : undefined;
  return {
    title,
    output: JSON.stringify(output),
    metadata: {
      runID: output.runID,
      phase: output.phase,
      ...(config === undefined
        ? {}
        : {
            configSources: config.sources,
            projectConfigPath: config.projectConfigPath,
            globalConfigPath: config.globalConfigPath,
          }),
    },
  };
}

type ReviewPlanArgs = {
  reviewModels?: string[] | undefined;
  agents?: number | undefined;
  maxConcurrency?: number | undefined;
  judgeModel?: string | undefined;
  focus?: string | undefined;
  reviewerTimeoutMs?: number | undefined;
};

/**
 * Resolve reviewers, judge, and limits from overrides plus the loaded config,
 * then verify every requested model is connected. Shared by `start` and the
 * read-only config preview so both report the exact same plan. Creates no
 * sessions.
 */
async function resolveReviewPlan(
  args: ReviewPlanArgs,
  loaded: LoadedCrossReviewConfig,
  client: AsyncCrossReviewClient,
  directory: string,
  signal: AbortSignal,
) {
  const overrides = normalizeHostDefaultOverrides(args);
  const reviewers: ReviewerTarget[] = resolveReviewers(
    overrides,
    loaded.config,
  );
  const judgeModel =
    overrides.judgeModel === undefined
      ? loaded.config.judgeModel
      : overrides.judgeModel.trim() || undefined;
  const maxConcurrency =
    overrides.maxConcurrency ??
    loaded.config.maxConcurrency ??
    DEFAULT_CONCURRENCY;
  const reviewerTimeoutMs =
    overrides.reviewerTimeoutMs ??
    loaded.config.reviewerTimeoutMs ??
    DEFAULT_REVIEWER_TIMEOUT_MS;
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
    await client.provider.list({ query: { directory }, signal }),
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
  return {
    reviewers,
    judgeModel,
    maxConcurrency,
    reviewerTimeoutMs,
  };
}

function reviewerPrompt(
  run: CrossReviewRun,
  reviewer: ReviewerRun,
): AsyncPrompt["body"] {
  return {
    messageID: reviewer.messageID,
    agent: REVIEWER_AGENT,
    model: splitModel(reviewer.model),
    parts: [
      {
        type: "text",
        text:
          run.snapshot === undefined
            ? reviewBrief(
                run.target,
                reviewer.focus,
                run.context ?? run.gatherer?.output,
              )
            : // PR snapshot runs never embed the diff or caller context.
              prSnapshotReviewBrief(run.target, reviewer.focus),
      },
    ],
    tools: READ_ONLY_TOOLS,
  };
}

function gatherPrompt(
  run: CrossReviewRun,
  gatherer: GathererRun,
): AsyncPrompt["body"] {
  return {
    messageID: gatherer.messageID,
    agent: REVIEWER_AGENT,
    model: splitModel(gatherer.model),
    parts: [{ type: "text", text: gatherBrief(run.target) }],
    tools: READ_ONLY_TOOLS,
  };
}

function judgePrompt(run: CrossReviewRun): AsyncPrompt["body"] {
  if (run.judgeModel === undefined || run.judge === undefined)
    throw new Error(`Cross-review run has no judge model: ${run.runID}`);
  return {
    messageID: run.judge.messageID,
    agent: REVIEWER_AGENT,
    model: splitModel(run.judgeModel),
    parts: [
      {
        type: "text",
        text: [
          run.snapshot === undefined
            ? "Act as the read-only cross-review judge."
            : prSnapshotJudgeBrief(run.target),
          run.snapshot === undefined ? `Target: ${run.target}` : "",
          ...(run.snapshot !== undefined
            ? []
            : run.context === undefined || run.context.length === 0
              ? []
              : [
                  "Shared target context (already gathered; verify findings against it):",
                  embeddedContext(run.context) ?? "",
                ]),
          "Independently verify every candidate against repository evidence, deduplicate overlapping findings, and recalibrate severity.",
          "Reject unsupported findings. Report findings first with file/line references, followed by reviewer provenance and testing gaps.",
          JSON.stringify(
            successfulReviewers(run).map((reviewer) =>
              publicReviewer(reviewer, true),
            ),
          ),
        ]
          .filter((line) => line.length > 0)
          .join("\n"),
      },
    ],
    tools: READ_ONLY_TOOLS,
  };
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((res, rej) => {
    if (signal?.aborted) {
      rej(new Error("Cross-review cancelled"));
      return;
    }
    const abortHandler = () => {
      clearTimeout(timer);
      rej(new Error("Cross-review cancelled"));
    };
    if (signal !== undefined) {
      signal.addEventListener("abort", abortHandler, { once: true });
    }
    const timer = setTimeout(() => {
      if (signal !== undefined) {
        signal.removeEventListener("abort", abortHandler);
      }
      res();
    }, ms);
  });
}

export function createCrossReviewProtocolTools(
  client: AsyncCrossReviewClient,
  options: ProtocolOptions = {},
) {
  const loadConfig = options.loadConfig ?? loadCrossReviewConfig;
  const store = options.store ?? new FileCrossReviewRunStore();
  const now = options.now ?? Date.now;
  const createRunID = options.createRunID ?? randomUUID;
  const canonicalize = options.canonicalize ?? canonicalizeDirectory;
  const sleep = options.sleep ?? defaultSleep;
  const configuredDefaultWaitMs = options.defaultWaitMs ?? DEFAULT_WAIT_MS;
  const classifyTarget = options.classifyTarget ?? classifyPrTargetInRepository;
  const runPrAdapter = options.runPrAdapter ?? createDefaultPrAdapterRunner();
  const stateRoot = options.stateRoot ?? defaultCrossReviewStateDirectory();
  const removeSnapshot = options.removeSnapshot ?? defaultRemoveSnapshot;

  /**
   * Sessions for reviewer/judge of a snapshot run use the snapshot
   * worktree as `query.directory`; every other run uses the parent project.
   * Authorization, config loading, and `assertAuthorized` keep using
   * `run.directory` (the parent project).
   */
  function sessionDirectory(run: CrossReviewRun) {
    return run.snapshot === undefined ? run.directory : run.snapshot.worktree;
  }

  /**
   * Fail closed (S10) when the runtime does not bind the child session to
   * the requested snapshot directory.
   */
  async function assertSessionDirectory(
    snapshot: NonNullable<CrossReviewRun["snapshot"]>,
    sessionID: string,
  ) {
    const session = responseData(
      await client.session.get({
        path: { id: sessionID },
        query: { directory: snapshot.worktree },
        signal: AbortSignal.timeout(SDK_REQUEST_TIMEOUT_MS),
      }),
      "Session inspection",
    );
    const requested = await canonicalize(snapshot.worktree);
    // A missing `directory` on the session record is not evidence of the
    // correct binding; fail closed instead of defaulting to the expectation.
    if (session.directory === undefined)
      throw new Error(
        `Session ${sessionID} reports no bound directory; refusing to review the wrong checkout (expected the PR snapshot ${requested})`,
      );
    const boundReal = await canonicalize(session.directory);
    if (boundReal !== requested)
      throw new Error(
        `Session ${sessionID} is bound to ${boundReal} instead of the PR snapshot ${requested}; refusing to review the wrong checkout`,
      );
  }

  async function abortSession(sessionID: string, directory: string) {
    const aborted = responseData(
      await client.session.abort({
        path: { id: sessionID },
        query: { directory },
        signal: AbortSignal.timeout(SDK_REQUEST_TIMEOUT_MS),
      }),
      "Session abort",
    );
    if (!aborted)
      throw new Error(`Session abort was not confirmed: ${sessionID}`);
  }

  /**
   * Snapshot cleanup after a terminal transition (R6): remove the worktree
   * and the `<state>/<runID>/` directory. Returns a warning suffix when the
   * best-effort removal fails so callers can surface it.
   */
  async function cleanupSnapshot(
    run: CrossReviewRun,
  ): Promise<string | undefined> {
    if (run.snapshot === undefined) return undefined;
    try {
      await removeSnapshot(run.snapshot.worktree);
      return undefined;
    } catch (error) {
      return `; snapshot cleanup failed: ${errorMessage(error)}`;
    }
  }

  async function dispatchReviewer(
    run: CrossReviewRun,
    reviewer: ReviewerRun,
    context: ProtocolContext,
  ) {
    try {
      asyncResponse(
        await client.session.promptAsync({
          body: reviewerPrompt(run, reviewer),
          path: { id: reviewer.sessionID },
          query: { directory: sessionDirectory(run) },
          signal: requestSignal(context.abort),
        }),
        `Reviewer ${reviewer.reviewer} prompt`,
      );
    } catch (error) {
      const dispatchError = errorMessage(error);
      try {
        await abortSession(reviewer.sessionID, sessionDirectory(run));
        reviewer.status = context.abort.aborted ? "cancelled" : "failed";
        reviewer.completedAt = now();
        reviewer.error = dispatchError;
      } catch (abortError) {
        reviewer.status = "starting";
        reviewer.error = `${dispatchError}; ${errorMessage(abortError)}`;
      }
    }
  }

  async function dispatchAvailable(
    run: CrossReviewRun,
    save: SaveRun,
    context: ProtocolContext,
  ) {
    if (migrateMessageIDs(run)) await save();
    while (activeReviewerCount(run) < run.maxConcurrency) {
      const available = run.maxConcurrency - activeReviewerCount(run);
      const reviewers = run.reviewers
        .filter((candidate) => candidate.status === "queued")
        .slice(0, available);
      if (reviewers.length === 0) return;
      const startedAt = now();
      for (const reviewer of reviewers) {
        reviewer.status = "starting";
        // Preserve the original deadline for a reviewer redispatch so an
        // ambiguous async prompt cannot retry forever. Only assign a fresh
        // start/deadline when dispatching for the first time.
        if (reviewer.startedAt === undefined) {
          reviewer.startedAt = startedAt;
          reviewer.deadlineAt = startedAt + run.reviewerTimeoutMs;
        }
        delete reviewer.error;
      }
      await save();
      await Promise.all(
        reviewers.map((reviewer) => dispatchReviewer(run, reviewer, context)),
      );
      await save();
    }
  }

  async function sessionMessages(
    sessionID: string,
    run: CrossReviewRun,
    context: ProtocolContext,
  ) {
    return responseData(
      await client.session.messages({
        path: { id: sessionID },
        query: { directory: sessionDirectory(run), limit: 100 },
        signal: requestSignal(context.abort),
      }),
      "Session messages",
    );
  }

  async function timeoutReviewer(
    run: CrossReviewRun,
    reviewer: ReviewerRun,
    timestamp: number,
    status: SessionStatus | undefined,
    timeoutAction: TimeoutAction | undefined,
  ) {
    if (timeoutAction === undefined) {
      markTimeoutPending(
        reviewer,
        `Reviewer ${reviewer.reviewer}`,
        run.reviewerTimeoutMs,
        timestamp,
      );
      return;
    }
    if (timeoutAction === "preserve") {
      preserveTimedRun(reviewer, status, run.reviewerTimeoutMs, timestamp);
      return;
    }
    let abortWarning: string | undefined;
    try {
      await abortSession(reviewer.sessionID, sessionDirectory(run));
    } catch (error) {
      abortWarning = `; abort unconfirmed: ${errorMessage(error)}`;
      for (const queued of run.reviewers) {
        if (queued.status !== "queued") continue;
        queued.status = "cancelled";
        queued.completedAt = timestamp;
        queued.error =
          "Reviewer was not started because a timed-out session could not be confirmed stopped";
      }
    }
    reviewer.status = "timed_out";
    reviewer.completedAt = timestamp;
    reviewer.error = `Reviewer timed out after ${run.reviewerTimeoutMs}ms${abortWarning ?? ""}`;
    delete reviewer.retry;
  }

  async function reconcileReviewer(
    run: CrossReviewRun,
    reviewer: ReviewerRun,
    statuses: Record<string, SessionStatus>,
    context: ProtocolContext,
    timeoutAction?: TimeoutAction,
  ) {
    if (!ACTIVE_REVIEWER_STATUSES.has(reviewer.status)) return;
    const timestamp = now();
    const status = statuses[reviewer.sessionID];
    const deadlineReached =
      reviewer.deadlineAt !== undefined && timestamp >= reviewer.deadlineAt;
    // A previously preserved session can still be aborted before its
    // extended deadline runs out: the user already saw the timeout decision
    // and explicitly chose to stop it.
    const abortExtended =
      timeoutAction === "abort" && reviewer.timeoutExtensions !== undefined;
    if (
      abortExtended &&
      !deadlineReached &&
      (status?.type === "busy" || status?.type === "retry")
    ) {
      await timeoutReviewer(run, reviewer, timestamp, status, "abort");
      return;
    }

    if (status?.type === "busy" && !deadlineReached) {
      reviewer.status = "running";
      delete reviewer.retry;
      delete reviewer.error;
      return;
    }
    if (status?.type === "retry" && !deadlineReached) {
      reviewer.status = "retrying";
      reviewer.retry = {
        attempt: status.attempt,
        message: status.message,
        next: status.next,
      };
      return;
    }

    // OpenCode persists the completed assistant message before publishing
    // idle, so a deadline-boundary poll can still find valid output. Read it
    // before timing out so quorum is not discarded.
    let messages: SessionMessage[];
    try {
      messages = await sessionMessages(reviewer.sessionID, run, context);
    } catch (error) {
      if (deadlineReached || abortExtended) {
        await timeoutReviewer(
          run,
          reviewer,
          timestamp,
          status,
          deadlineReached ? timeoutAction : "abort",
        );
        // A preserved session keeps running, so a transient fetch failure
        // must not stick to it; later polls report fresh state instead.
        if (
          reviewer.status === "timeout_pending" ||
          reviewer.status === "timed_out"
        ) {
          reviewer.error = `${reviewer.error}; status unavailable: ${errorMessage(error)}`;
        }
      } else {
        reviewer.error = `Reviewer status unavailable: ${errorMessage(error)}`;
      }
      return;
    }
    // A transient fetch failure must not linger once reads succeed again.
    if (reviewer.error?.startsWith("Reviewer status unavailable") ?? false)
      delete reviewer.error;
    const outcome = terminalOutcome(
      messages,
      `Reviewer ${reviewer.reviewer} prompt`,
      reviewer.messageID,
    );
    if (outcome !== undefined) {
      reviewer.status = outcome.status;
      reviewer.completedAt = timestamp;
      reviewer.latestActivityAt = outcome.latestActivityAt;
      if (outcome.output !== undefined) reviewer.output = outcome.output;
      if (outcome.error !== undefined) reviewer.error = outcome.error;
      else delete reviewer.error;
      delete reviewer.retry;
      return;
    }
    if (deadlineReached || abortExtended) {
      await timeoutReviewer(
        run,
        reviewer,
        timestamp,
        status,
        deadlineReached ? timeoutAction : "abort",
      );
      return;
    }
    const latest = messages.at(-1);
    if (latest !== undefined) reviewer.latestActivityAt = activityAt(latest);
    if (
      messages.length === 0 &&
      reviewer.startedAt !== undefined &&
      timestamp - reviewer.startedAt >= STARTING_GRACE_MS
    ) {
      // Re-queue an ambiguous dispatch (no visible message yet) so the same
      // message ID is re-submitted, but keep the original deadline so a truly
      // missing agent eventually times out instead of retrying forever.
      reviewer.status = "queued";
      return;
    }
    reviewer.status = "starting";
  }

  async function reconcileJudge(
    run: CrossReviewRun,
    statuses: Record<string, SessionStatus>,
    save: SaveRun,
    context: ProtocolContext,
    timeoutAction?: TimeoutAction,
  ) {
    const judge = run.judge;
    if (judge === undefined) return;
    if (judge.status === "queued") {
      if (migrateMessageIDs(run)) await save();
      const startedAt = now();
      judge.status = "starting";
      // Preserve the original deadline on redispatch so an ambiguous judge
      // prompt cannot retry forever.
      if (judge.startedAt === undefined) {
        judge.startedAt = startedAt;
        judge.deadlineAt = startedAt + run.reviewerTimeoutMs;
      }
      delete judge.error;
      await save();
      try {
        asyncResponse(
          await client.session.promptAsync({
            body: judgePrompt(run),
            path: { id: judge.sessionID },
            query: { directory: sessionDirectory(run) },
            signal: requestSignal(context.abort),
          }),
          "Judge prompt",
        );
      } catch (error) {
        const dispatchError = errorMessage(error);
        try {
          await abortSession(judge.sessionID, sessionDirectory(run));
          judge.status = context.abort.aborted ? "cancelled" : "failed";
          judge.completedAt = now();
          judge.error = dispatchError;
        } catch (abortError) {
          judge.status = "starting";
          judge.error = `${dispatchError}; ${errorMessage(abortError)}`;
        }
        await save();
      }
      return;
    }
    if (!ACTIVE_REVIEWER_STATUSES.has(judge.status as ReviewerRunStatus))
      return;
    const timestamp = now();
    const deadlineReached =
      judge.deadlineAt !== undefined && timestamp >= judge.deadlineAt;
    // See reconcileReviewer: a previously preserved session honors an
    // explicit abort even before its extended deadline runs out.
    const abortExtended =
      timeoutAction === "abort" && judge.timeoutExtensions !== undefined;
    const timeoutJudge = async () => {
      if (timeoutAction === undefined) {
        markTimeoutPending(judge, "Judge", run.reviewerTimeoutMs, timestamp);
        return;
      }
      if (timeoutAction === "preserve") {
        preserveTimedRun(judge, status, run.reviewerTimeoutMs, timestamp);
        return;
      }
      let abortWarning: string | undefined;
      try {
        await abortSession(judge.sessionID, sessionDirectory(run));
      } catch (error) {
        abortWarning = `; abort unconfirmed: ${errorMessage(error)}`;
      }
      judge.status = "timed_out";
      judge.completedAt = timestamp;
      judge.error = `Judge timed out after ${run.reviewerTimeoutMs}ms${abortWarning ?? ""}`;
      delete judge.retry;
    };
    const status = statuses[judge.sessionID];
    if (
      abortExtended &&
      !deadlineReached &&
      (status?.type === "busy" || status?.type === "retry")
    ) {
      await timeoutJudge();
      return;
    }
    if (status?.type === "busy" && !deadlineReached) {
      judge.status = "running";
      delete judge.retry;
      delete judge.error;
      return;
    }
    if (status?.type === "retry" && !deadlineReached) {
      judge.status = "retrying";
      judge.retry = {
        attempt: status.attempt,
        message: status.message,
        next: status.next,
      };
      return;
    }

    let messages: SessionMessage[];
    try {
      messages = await sessionMessages(judge.sessionID, run, context);
    } catch (error) {
      if (deadlineReached || abortExtended) {
        await timeoutJudge();
        // A preserved session keeps running, so a transient fetch failure
        // must not stick to it; later polls report fresh state instead.
        if (
          judge.status === "timeout_pending" ||
          judge.status === "timed_out"
        ) {
          judge.error = `${judge.error}; status unavailable: ${errorMessage(error)}`;
        }
      } else {
        judge.error = `Judge status unavailable: ${errorMessage(error)}`;
      }
      return;
    }
    // A transient fetch failure must not linger once reads succeed again.
    if (judge.error?.startsWith("Judge status unavailable") ?? false)
      delete judge.error;
    const outcome = terminalOutcome(messages, "Judge prompt", judge.messageID);
    if (outcome !== undefined) {
      judge.status = outcome.status;
      judge.completedAt = timestamp;
      judge.latestActivityAt = outcome.latestActivityAt;
      if (outcome.output !== undefined) judge.output = outcome.output;
      if (outcome.error !== undefined) judge.error = outcome.error;
      else delete judge.error;
      delete judge.retry;
      return;
    }
    if (deadlineReached || abortExtended) {
      await timeoutJudge();
      return;
    }
    const latest = messages.at(-1);
    if (latest !== undefined) judge.latestActivityAt = activityAt(latest);
    // The judge session is shared with the gatherer, so a visible message
    // does not prove the judge dispatch took. Only the judge's own user
    // message does: re-queue an ambiguous dispatch when it is still absent,
    // but keep the original deadline so it eventually times out.
    const judgePromptVisible = messages.some(
      (message) =>
        message.info.role === "user" && message.info.id === judge.messageID,
    );
    if (
      !judgePromptVisible &&
      judge.startedAt !== undefined &&
      timestamp - judge.startedAt >= STARTING_GRACE_MS
    ) {
      judge.status = "queued";
      return;
    }
    judge.status = "starting";
  }

  async function reconcileGatherer(
    run: CrossReviewRun,
    statuses: Record<string, SessionStatus>,
    save: SaveRun,
    context: ProtocolContext,
    timeoutAction?: TimeoutAction,
  ) {
    const gatherer = run.gatherer;
    if (gatherer === undefined) return;
    // Gathering is an optimization: when it fails or times out, degrade to
    // independent fetching rather than failing the whole review. On success
    // the gathered output becomes the shared context reviewers must verify
    // against; it stays in the judge session's own history, so the later
    // judge prompt does not need to repeat it.
    const transitionToReviewing = async () => {
      run.phase = "reviewing";
      await save();
      await dispatchAvailable(run, save, context);
    };
    if (gatherer.status === "queued") {
      if (migrateMessageIDs(run)) await save();
      const startedAt = now();
      gatherer.status = "starting";
      // Preserve the original deadline on redispatch so an ambiguous gatherer
      // prompt cannot retry forever.
      if (gatherer.startedAt === undefined) {
        gatherer.startedAt = startedAt;
        gatherer.deadlineAt = startedAt + run.reviewerTimeoutMs;
      }
      delete gatherer.error;
      await save();
      try {
        asyncResponse(
          await client.session.promptAsync({
            body: gatherPrompt(run, gatherer),
            path: { id: gatherer.sessionID },
            query: { directory: sessionDirectory(run) },
            signal: requestSignal(context.abort),
          }),
          "Gather prompt",
        );
      } catch (error) {
        const dispatchError = errorMessage(error);
        try {
          await abortSession(gatherer.sessionID, sessionDirectory(run));
          gatherer.status = context.abort.aborted ? "cancelled" : "failed";
          gatherer.completedAt = now();
          gatherer.error = dispatchError;
        } catch (abortError) {
          // The session could not be confirmed stopped; keep the same
          // message ID queued for redispatch under the original deadline.
          gatherer.status = "starting";
          gatherer.error = `${dispatchError}; ${errorMessage(abortError)}`;
          await save();
          return;
        }
        await save();
        // A confirmed dispatch failure is terminal for the gatherer: degrade
        // to independent fetching instead of leaving the run stuck in the
        // gathering phase. A parent abort is finalized by the caller.
        if (!context.abort.aborted) await transitionToReviewing();
      }
      return;
    }
    if (!ACTIVE_REVIEWER_STATUSES.has(gatherer.status as ReviewerRunStatus))
      return;
    const timestamp = now();
    const deadlineReached =
      gatherer.deadlineAt !== undefined && timestamp >= gatherer.deadlineAt;
    // See reconcileReviewer: a previously preserved session honors an
    // explicit abort even before its extended deadline runs out.
    const abortExtended =
      timeoutAction === "abort" && gatherer.timeoutExtensions !== undefined;
    const timeoutGatherer = async () => {
      if (timeoutAction === undefined) {
        markTimeoutPending(
          gatherer,
          "Gatherer",
          run.reviewerTimeoutMs,
          timestamp,
        );
        return false;
      }
      if (timeoutAction === "preserve") {
        preserveTimedRun(gatherer, status, run.reviewerTimeoutMs, timestamp);
        return false;
      }
      let abortWarning: string | undefined;
      try {
        await abortSession(gatherer.sessionID, sessionDirectory(run));
      } catch (error) {
        abortWarning = `; abort unconfirmed: ${errorMessage(error)}`;
      }
      gatherer.status = "timed_out";
      gatherer.completedAt = timestamp;
      gatherer.error = `Gatherer timed out after ${run.reviewerTimeoutMs}ms${abortWarning ?? ""}`;
      delete gatherer.retry;
      return true;
    };
    const status = statuses[gatherer.sessionID];
    if (
      abortExtended &&
      !deadlineReached &&
      (status?.type === "busy" || status?.type === "retry")
    ) {
      if (await timeoutGatherer()) await transitionToReviewing();
      return;
    }
    if (status?.type === "busy" && !deadlineReached) {
      gatherer.status = "running";
      delete gatherer.retry;
      delete gatherer.error;
      return;
    }
    if (status?.type === "retry" && !deadlineReached) {
      gatherer.status = "retrying";
      gatherer.retry = {
        attempt: status.attempt,
        message: status.message,
        next: status.next,
      };
      return;
    }

    let messages: SessionMessage[];
    try {
      messages = await sessionMessages(gatherer.sessionID, run, context);
    } catch (error) {
      if (deadlineReached || abortExtended) {
        const timedOut = await timeoutGatherer();
        // A preserved session keeps running, so a transient fetch failure
        // must not stick to it; later polls report fresh state instead.
        if (
          gatherer.status === "timeout_pending" ||
          gatherer.status === "timed_out"
        ) {
          gatherer.error = `${gatherer.error}; status unavailable: ${errorMessage(error)}`;
        }
        if (timedOut) await transitionToReviewing();
      } else {
        gatherer.error = `Gatherer status unavailable: ${errorMessage(error)}`;
      }
      return;
    }
    // A transient fetch failure must not linger once reads succeed again.
    if (gatherer.error?.startsWith("Gatherer status unavailable") ?? false)
      delete gatherer.error;
    const outcome = terminalOutcome(
      messages,
      "Gather prompt",
      gatherer.messageID,
    );
    if (outcome !== undefined) {
      gatherer.status = outcome.status;
      gatherer.completedAt = timestamp;
      gatherer.latestActivityAt = outcome.latestActivityAt;
      if (outcome.output !== undefined) gatherer.output = outcome.output;
      if (outcome.error !== undefined) gatherer.error = outcome.error;
      else delete gatherer.error;
      delete gatherer.retry;
      await transitionToReviewing();
      return;
    }
    if (deadlineReached || abortExtended) {
      const timedOut = await timeoutGatherer();
      if (timedOut) await transitionToReviewing();
      return;
    }
    const latest = messages.at(-1);
    if (latest !== undefined) gatherer.latestActivityAt = activityAt(latest);
    if (
      messages.length === 0 &&
      gatherer.startedAt !== undefined &&
      timestamp - gatherer.startedAt >= STARTING_GRACE_MS
    ) {
      // Re-queue an ambiguous gather dispatch so the same message ID is
      // re-submitted, but keep the original deadline so it eventually times out.
      gatherer.status = "queued";
      return;
    }
    gatherer.status = "starting";
  }

  async function statuses(run: CrossReviewRun, context: ProtocolContext) {
    return responseData(
      await client.session.status({
        query: { directory: sessionDirectory(run) },
        signal: requestSignal(context.abort),
      }),
      "Session status",
    );
  }

  async function reconcile(
    run: CrossReviewRun,
    save: SaveRun,
    context: ProtocolContext,
    timeoutAction?: TimeoutAction,
  ) {
    if (
      run.phase === "completed" ||
      run.phase === "quorum-not-met" ||
      run.phase === "failed" ||
      run.phase === "cancelled"
    )
      return;

    // Only query global session status when something can still be running.
    // A fully-terminal run only needs local finalization; requiring the status
    // API here would let one unavailable project directory block otherwise
    // recoverable local finalization.
    const hasActive =
      (run.phase === "gathering" &&
        run.gatherer !== undefined &&
        ACTIVE_REVIEWER_STATUSES.has(
          run.gatherer.status as ReviewerRunStatus,
        )) ||
      (run.phase === "reviewing" &&
        run.reviewers.some((reviewer) =>
          ACTIVE_REVIEWER_STATUSES.has(reviewer.status),
        )) ||
      (run.phase === "judging" &&
        run.judge !== undefined &&
        ACTIVE_REVIEWER_STATUSES.has(run.judge.status as ReviewerRunStatus));
    let currentStatuses: Record<string, SessionStatus> | undefined;
    if (hasActive) {
      try {
        currentStatuses = await statuses(run, context);
      } catch {
        // A transient status failure must not block local finalization of
        // reviewers that are already terminal. Reconcilers treat a missing
        // status map as "no busy signal" and fall back to reading messages.
        currentStatuses = {};
      }
    }

    if (run.phase === "gathering") {
      await reconcileGatherer(
        run,
        currentStatuses ?? {},
        save,
        context,
        timeoutAction,
      );
      return;
    }
    if (run.phase === "reviewing") {
      await Promise.all(
        run.reviewers.map((reviewer) =>
          reconcileReviewer(
            run,
            reviewer,
            currentStatuses ?? {},
            context,
            timeoutAction,
          ),
        ),
      );
      await dispatchAvailable(run, save, context);
    }
    if (run.phase === "judging")
      await reconcileJudge(
        run,
        currentStatuses ?? {},
        save,
        context,
        timeoutAction,
      );
  }

  async function withAuthorizedRun<T>(
    runID: string,
    context: ProtocolContext,
    action: (run: CrossReviewRun, save: SaveRun) => Promise<T>,
  ) {
    const directory = await canonicalize(context.directory);
    return store.withRun(runID, async (run, save) => {
      assertAuthorized(run, context, directory);
      return action(run, save);
    });
  }

  const configPreview = tool({
    description:
      "Preview the resolved cross-review configuration without creating sessions; invoke from primary sessions to confirm the effective config before starting",
    args: {
      reviewModels: tool.schema
        .array(tool.schema.string())
        .min(1)
        .max(8)
        .optional(),
      agents: tool.schema.number().int().min(1).max(8).optional(),
      maxConcurrency: tool.schema.number().int().min(1).max(8).optional(),
      judgeModel: tool.schema.string().optional(),
      focus: tool.schema.string().max(2_000).optional(),
      reviewerTimeoutMs: tool.schema
        .number()
        .int()
        .min(5_000)
        .max(60 * 60 * 1_000)
        .optional(),
    },
    async execute(args, context) {
      if (context.abort.aborted) throw new Error("Cross-review cancelled");
      await assertPrimarySession(
        client,
        context,
        "cross_review_config",
        requestSignal(context.abort),
      );
      // Same fast-fail bounds as `start`, even when the host skips
      // tool-schema validation. Host type-defaults are stripped first.
      const overrides = prepareCrossReviewOverrides(args);
      const loaded = await loadConfig(context.directory);
      const plan = await resolveReviewPlan(
        overrides,
        loaded,
        client,
        context.directory,
        requestSignal(context.abort),
      );
      const warning = configWarning(loaded);
      const sharedFocus = overrides.focus ?? loaded.config.focus;
      return result("Cross-review config preview", {
        config: {
          sources: loaded.sources,
          projectConfigPath: loaded.projectPath,
          globalConfigPath: loaded.globalPath,
        },
        ...(warning === undefined ? {} : { warning }),
        reviewers: plan.reviewers.map((reviewer, index) => ({
          reviewer: index + 1,
          model: reviewer.model,
          ...(reviewer.focus === undefined ? {} : { focus: reviewer.focus }),
        })),
        quorum: Math.floor(plan.reviewers.length / 2) + 1,
        judge:
          plan.judgeModel === undefined
            ? { model: "parent-session" }
            : { model: plan.judgeModel },
        maxConcurrency: plan.maxConcurrency,
        reviewerTimeoutMs: plan.reviewerTimeoutMs,
        ...(sharedFocus === undefined ? {} : { focus: sharedFocus }),
      });
    },
  });

  const start = tool({
    description:
      "Start isolated cross-review sessions asynchronously and return a run ID; invoke only with explicit user review intent from primary sessions",
    args: {
      target: tool.schema.string().min(1).max(4_000),
      context: tool.schema.string().min(1).max(1_000_000).optional(),
      reviewModels: tool.schema
        .array(tool.schema.string())
        .min(1)
        .max(8)
        .optional(),
      agents: tool.schema.number().int().min(1).max(8).optional(),
      maxConcurrency: tool.schema.number().int().min(1).max(8).optional(),
      judgeModel: tool.schema.string().optional(),
      focus: tool.schema.string().max(2_000).optional(),
      reviewerTimeoutMs: tool.schema
        .number()
        .int()
        .min(5_000)
        .max(60 * 60 * 1_000)
        .optional(),
    },
    async execute(args, context) {
      if (context.abort.aborted) throw new Error("Cross-review cancelled");
      await assertPrimarySession(
        client,
        context,
        "cross_review_start",
        requestSignal(context.abort),
      );
      // The host may not enforce the declared tool schema, so type-default
      // empty overrides are stripped and remaining values are revalidated
      // against the loader's bounds.
      const overrides = prepareCrossReviewOverrides(args);
      const directory = await canonicalize(context.directory);
      const loaded = await loadConfig(context.directory);
      const plan = await resolveReviewPlan(
        overrides,
        loaded,
        client,
        context.directory,
        requestSignal(context.abort),
      );
      const reviewers = plan.reviewers;
      const judgeModel = plan.judgeModel;
      const maxConcurrency = plan.maxConcurrency;

      const runID = createRunID();
      const childSessions: string[] = [];
      let prSnapshot: NonNullable<CrossReviewRun["snapshot"]> | undefined;
      let runPersisted = false;
      try {
        // Classify the target first: a GitHub/GitCode pull request must be
        // materialized as a pinned snapshot before any reviewer session
        // exists (fail closed, no LLM gatherer, no reviewer concurrency).
        const classification = await classifyTarget(
          args.target,
          context.directory,
        );
        if (classification.kind === "error")
          throw new Error(classification.message);

        let adapterGatherer: AdapterGathererRun | undefined;
        if (classification.kind === "pr") {
          const repo =
            (await findGitRoot(context.directory)) ?? context.directory;
          const paths = snapshotPaths(stateRoot, runID);
          const gatherStartedAt = now();
          const gather = await runPrAdapter({
            forge: classification.forge,
            repo,
            target: args.target,
            runID,
            stateRoot,
            ...(args.context === undefined || args.context.length === 0
              ? {}
              : { notes: args.context }),
            ...(loaded.config.gitcodeCli === undefined
              ? {}
              : { gitcodeCli: loaded.config.gitcodeCli }),
          });
          if (!gather.ok) {
            const error = `${gather.error}${gather.snapshotPath === undefined ? "" : ` (snapshot retained at ${gather.snapshotPath})`}`;
            adapterGatherer = {
              kind: "adapter",
              forge: classification.forge,
              status: "failed",
              startedAt: gatherStartedAt,
              completedAt: now(),
              error,
            };
            // Persist a failed run so the snapshot is discoverable for
            // diagnosis, then surface the error without any reviewers.
            await store.create({
              schemaVersion: RUN_SCHEMA_VERSION,
              runID,
              directory,
              ownerSessionID: context.sessionID,
              createdAt: now(),
              updatedAt: now(),
              phase: "failed",
              target: args.target,
              brief: prSnapshotReviewBrief(
                args.target,
                overrides.focus ?? loaded.config.focus,
              ),
              quorum: Math.floor(reviewers.length / 2) + 1,
              maxConcurrency,
              reviewerTimeoutMs: plan.reviewerTimeoutMs,
              configSources: loaded.sources,
              projectConfigPath: loaded.projectPath,
              globalConfigPath: loaded.globalPath,
              reviewers: [],
              ...(gather.snapshotPath === undefined
                ? {}
                : {
                    snapshot: {
                      // The runner-reported path (where the snapshot really
                      // lives), not the derived expectation: a custom
                      // runner must keep the manifest pointing at reality
                      // so cleanup removes the right directory.
                      worktree: gather.snapshotPath,
                      snapshotDir: paths.snapshotDir,
                      forge: classification.forge,
                    },
                  }),
              adapterGatherer,
            } as CrossReviewRun);
            runPersisted = true;
            throw new Error(error);
          }
          prSnapshot = {
            worktree: gather.worktree,
            snapshotDir: gather.snapshotDir,
            forge: classification.forge,
            url: gather.meta.url,
            headSha: gather.meta.headSha,
            mergeBaseSha: gather.meta.mergeBaseSha,
          };
          adapterGatherer = {
            kind: "adapter",
            forge: classification.forge,
            status: "succeeded",
            startedAt: gatherStartedAt,
            completedAt: now(),
          };
        }

        const sessionRoot =
          prSnapshot === undefined ? context.directory : prSnapshot.worktree;
        for (const [index] of reviewers.entries()) {
          const session = responseData(
            await client.session.create({
              body: {
                parentID: context.sessionID,
                title: `Cross-review ${runID.slice(0, 8)} reviewer ${index + 1}: ${args.target.slice(0, 120)}`,
              },
              query: { directory: sessionRoot },
              signal: requestSignal(context.abort),
            }),
            `Reviewer ${index + 1} session creation`,
          );
          childSessions.push(session.id);
          // Fail closed (S10) when the runtime binds the child to another
          // directory than the PR snapshot.
          if (prSnapshot !== undefined)
            await assertSessionDirectory(prSnapshot, session.id);
        }
        let judgeSessionID: string | undefined;
        if (judgeModel !== undefined) {
          const session = responseData(
            await client.session.create({
              body: {
                parentID: context.sessionID,
                title: `Cross-review ${runID.slice(0, 8)} judge: ${args.target.slice(0, 120)}`,
              },
              query: { directory: sessionRoot },
              signal: requestSignal(context.abort),
            }),
            "Judge session creation",
          );
          judgeSessionID = session.id;
          childSessions.push(session.id);
          // The judge reads the same snapshot; fail closed (S10) exactly as
          // for reviewers.
          if (prSnapshot !== undefined)
            await assertSessionDirectory(prSnapshot, session.id);
        }
        const timestamp = now();
        const warning = configWarning(loaded);
        // An empty context is treated as "not provided": it must not disable
        // gathering while embedding nothing into reviewer briefs.
        const providedContext =
          args.context === undefined || args.context.length === 0
            ? undefined
            : args.context;
        // A classified PR always used the adapter; `context` became notes.md
        // and never suppresses gathering.
        const gathers =
          judgeModel !== undefined &&
          providedContext === undefined &&
          prSnapshot === undefined;
        const run: CrossReviewRun = {
          schemaVersion: RUN_SCHEMA_VERSION,
          runID,
          directory,
          ownerSessionID: context.sessionID,
          createdAt: timestamp,
          updatedAt: timestamp,
          phase: gathers ? "gathering" : "reviewing",
          target: args.target,
          brief:
            prSnapshot === undefined
              ? reviewBrief(
                  args.target,
                  overrides.focus ?? loaded.config.focus,
                  providedContext,
                )
              : prSnapshotReviewBrief(
                  args.target,
                  overrides.focus ?? loaded.config.focus,
                ),
          ...(providedContext === undefined || prSnapshot !== undefined
            ? {}
            : { context: providedContext }),
          ...(warning === undefined ? {} : { warning }),
          quorum: Math.floor(reviewers.length / 2) + 1,
          maxConcurrency,
          reviewerTimeoutMs: plan.reviewerTimeoutMs,
          ...(judgeModel === undefined ? {} : { judgeModel }),
          configSources: loaded.sources,
          projectConfigPath: loaded.projectPath,
          globalConfigPath: loaded.globalPath,
          ...(prSnapshot === undefined ? {} : { snapshot: prSnapshot }),
          ...(adapterGatherer === undefined ? {} : { adapterGatherer }),
          reviewers: reviewers.map((reviewer, index) => ({
            reviewer: index + 1,
            model: reviewer.model,
            ...(reviewer.focus === undefined ? {} : { focus: reviewer.focus }),
            sessionID: childSessions[index] as string,
            messageID: createMessageID(),
            status: "queued",
          })),
          ...(judgeModel === undefined || judgeSessionID === undefined
            ? {}
            : {
                ...(gathers
                  ? {
                      gatherer: {
                        model: judgeModel,
                        sessionID: judgeSessionID,
                        messageID: createMessageID(),
                        status: "queued" as const,
                      },
                    }
                  : {}),
                judge: {
                  model: judgeModel,
                  sessionID: judgeSessionID,
                  messageID: createMessageID(),
                  status: "queued" as const,
                },
              }),
        };
        await store.create(run);
        runPersisted = true;
        return store.withRun(runID, async (stored, save) => {
          assertAuthorized(stored, context, directory);
          if (stored.phase === "gathering" && stored.gatherer !== undefined) {
            await reconcileGatherer(stored, {}, save, context);
          } else {
            await dispatchAvailable(stored, save, context);
          }
          if (context.abort.aborted) {
            if (
              stored.gatherer !== undefined &&
              ACTIVE_REVIEWER_STATUSES.has(
                stored.gatherer.status as ReviewerRunStatus,
              )
            ) {
              let abortWarning: string | undefined;
              try {
                await abortSession(
                  stored.gatherer.sessionID,
                  sessionDirectory(stored),
                );
              } catch (error) {
                abortWarning = `; abort unconfirmed: ${errorMessage(error)}`;
              }
              stored.gatherer.status = "cancelled";
              stored.gatherer.completedAt = now();
              stored.gatherer.error = `Cross-review cancelled${abortWarning ?? ""}`;
            }
            for (const reviewer of stored.reviewers) {
              let abortWarning: string | undefined;
              if (ACTIVE_REVIEWER_STATUSES.has(reviewer.status)) {
                try {
                  await abortSession(
                    reviewer.sessionID,
                    sessionDirectory(stored),
                  );
                } catch (error) {
                  abortWarning = `; abort unconfirmed: ${errorMessage(error)}`;
                }
              }
              if (
                reviewer.status === "queued" ||
                ACTIVE_REVIEWER_STATUSES.has(reviewer.status)
              ) {
                reviewer.status = "cancelled";
                reviewer.completedAt = now();
                reviewer.error = `Cross-review cancelled${abortWarning ?? ""}`;
              }
            }
            if (stored.judge !== undefined) {
              stored.judge.status = "cancelled";
              stored.judge.completedAt = now();
              stored.judge.error = "Cross-review cancelled";
            }
            stored.phase = "cancelled";
            await save();
            const cleanupWarning = await cleanupSnapshot(stored);
            return result(
              `Cross-review cancelled: ${args.target}${cleanupWarning ?? ""}`,
              progress(stored, false, true, now()),
            );
          }
          return result(
            `Cross-review started: ${args.target}`,
            progress(stored, false, true, now()),
          );
        });
      } catch (error) {
        const abortDirectory = prSnapshot?.worktree ?? context.directory;
        await Promise.all(
          childSessions.map((sessionID) =>
            abortSession(sessionID, abortDirectory).catch(() => undefined),
          ),
        );
        // A materialized snapshot that no manifest references must not be
        // orphaned; failed gathers persist their run first and keep the
        // snapshot for diagnosis (S5).
        if (prSnapshot !== undefined && !runPersisted)
          await removeSnapshot(prSnapshot.worktree).catch(() => undefined);
        throw error;
      }
    },
  });

  const status = tool({
    description:
      "Poll and advance one asynchronous cross-review run, or resolve its pending timeout with an explicit preserve/abort action; invoke only with explicit user review intent from primary sessions",
    args: {
      runID: tool.schema.string().uuid(),
      detail: tool.schema.boolean().optional(),
      includeOutputs: tool.schema.boolean().optional(),
      waitMs: tool.schema.number().int().min(0).max(MAX_WAIT_MS).optional(),
      timeoutAction: tool.schema.enum(["preserve", "abort"]).optional(),
    },
    async execute(args, context) {
      const waitBudgetMs = args.waitMs ?? configuredDefaultWaitMs;
      let initialSnapshot: string | undefined;
      let finishedWaiting = false;

      let latestRun: CrossReviewRun | undefined;

      await withAuthorizedRun(args.runID, context, async (run, save) => {
        await reconcile(run, save, context, args.timeoutAction);
        latestRun = run;
        initialSnapshot = runSnapshot(run);
        finishedWaiting = runFinishedWaiting(run);
      });

      if (waitBudgetMs > 0 && !finishedWaiting) {
        const deadline = now() + waitBudgetMs;
        while (now() < deadline) {
          if (context.abort.aborted) throw new Error("Cross-review cancelled");
          const remaining = deadline - now();
          const sleepDuration = Math.min(remaining, WAIT_TICK_MS);
          if (sleepDuration <= 0) break;
          await sleep(sleepDuration, context.abort);
          if (context.abort.aborted) throw new Error("Cross-review cancelled");

          let stateChanged = false;
          await withAuthorizedRun(args.runID, context, async (run, save) => {
            // Apply the caller's timeout decision to timeouts that arise
            // while waiting, so no extra round trip is needed.
            await reconcile(run, save, context, args.timeoutAction);
            latestRun = run;
            const currentSnap = runSnapshot(run);
            if (currentSnap !== initialSnapshot || runFinishedWaiting(run)) {
              stateChanged = true;
            }
          });
          if (stateChanged) break;
        }
      }

      if (latestRun === undefined) {
        throw new Error(`Cross-review run unavailable: ${args.runID}`);
      }

      return result(
        `Cross-review status: ${truncate(latestRun.target, STATUS_TARGET_LIMIT)}`,
        progress(
          latestRun,
          args.includeOutputs ?? false,
          args.detail ?? false,
          now(),
        ),
      );
    },
  });

  const cancel = tool({
    description:
      "Cancel one asynchronous cross-review run; invoke only with explicit user review intent from primary sessions",
    args: { runID: tool.schema.string().uuid() },
    async execute(args, context) {
      return withAuthorizedRun(args.runID, context, async (run, save) => {
        if (run.phase === "cancelled")
          return result(
            `Cross-review cancelled: ${run.target}`,
            progress(run, false, true, now()),
          );
        if (
          run.phase === "completed" ||
          run.phase === "quorum-not-met" ||
          run.phase === "failed"
        )
          return result(
            `Cross-review already finished: ${run.target}`,
            progress(run, false, true, now()),
          );
        const timestamp = now();
        for (const reviewer of run.reviewers) {
          if (reviewer.status === "queued") {
            reviewer.status = "cancelled";
            reviewer.completedAt = timestamp;
            reviewer.error = "Cross-review cancelled";
            await save();
            continue;
          }
          if (ACTIVE_REVIEWER_STATUSES.has(reviewer.status)) {
            let abortWarning: string | undefined;
            try {
              await abortSession(reviewer.sessionID, sessionDirectory(run));
            } catch (error) {
              abortWarning = `; abort unconfirmed: ${errorMessage(error)}`;
            }
            reviewer.status = "cancelled";
            reviewer.completedAt = timestamp;
            reviewer.error = `Cross-review cancelled${abortWarning ?? ""}`;
            await save();
          }
        }
        let gathererAbortWarning: string | undefined;
        if (
          run.gatherer?.sessionID !== undefined &&
          (run.gatherer.status === "queued" ||
            ACTIVE_REVIEWER_STATUSES.has(
              run.gatherer.status as ReviewerRunStatus,
            ))
        ) {
          try {
            await abortSession(run.gatherer.sessionID, sessionDirectory(run));
          } catch (error) {
            gathererAbortWarning = `; abort unconfirmed: ${errorMessage(error)}`;
          }
          run.gatherer.status = "cancelled";
          run.gatherer.completedAt = timestamp;
          run.gatherer.error = `Cross-review cancelled${gathererAbortWarning ?? ""}`;
          await save();
        }
        let judgeAbortWarning: string | undefined;
        if (
          run.judge?.sessionID !== undefined &&
          ACTIVE_REVIEWER_STATUSES.has(run.judge.status as ReviewerRunStatus)
        ) {
          try {
            await abortSession(run.judge.sessionID, sessionDirectory(run));
          } catch (error) {
            judgeAbortWarning = `; abort unconfirmed: ${errorMessage(error)}`;
          }
        }
        if (run.judge !== undefined) {
          run.judge.status = "cancelled";
          run.judge.completedAt = timestamp;
          run.judge.error = `Cross-review cancelled${judgeAbortWarning ?? ""}`;
          await save();
        }
        run.phase = "cancelled";
        await save();
        const cleanupWarning = await cleanupSnapshot(run);
        return result(
          `Cross-review cancelled: ${run.target}${cleanupWarning ?? ""}`,
          progress(run, false, true, now()),
        );
      });
    },
  });

  const finalize = tool({
    description:
      "Finalize an asynchronous cross-review run or start its explicit judge; invoke only with explicit user review intent from primary sessions",
    args: { runID: tool.schema.string().uuid() },
    async execute(args, context) {
      return withAuthorizedRun(args.runID, context, async (run, save) => {
        if (run.finalResult !== undefined)
          return result(
            `Cross-review finalized: ${run.target}`,
            run.finalResult,
          );
        await reconcile(run, save, context);
        if (run.phase === "cancelled")
          return result(
            `Cross-review cancelled: ${run.target}`,
            progress(run, false, true, now()),
          );
        if (run.phase === "gathering")
          return result(
            `Cross-review still running: ${run.target}`,
            progress(run, false, true, now()),
          );
        if (run.phase === "reviewing" && !reviewersTerminal(run))
          return result(
            `Cross-review still running: ${run.target}`,
            progress(run, false, true, now()),
          );

        const successful = successfulReviewers(run);
        if (run.phase === "reviewing" && successful.length < run.quorum) {
          run.phase = "quorum-not-met";
          run.finalResult = {
            ...(run.warning === undefined ? {} : { warning: run.warning }),
            runID: run.runID,
            phase: run.phase,
            status: "quorum-not-met",
            target: run.target,
            brief: run.brief,
            quorum: run.quorum,
            ...(run.gatherer === undefined && run.adapterGatherer === undefined
              ? {}
              : run.gatherer !== undefined
                ? { gatherer: publicGatherer(run.gatherer, true) }
                : {
                    gatherer: publicAdapterGatherer(run.adapterGatherer),
                  }),
            reviewers: run.reviewers.map((reviewer) =>
              publicReviewer(reviewer, true),
            ),
          };
          return result(`Cross-review failed: ${run.target}`, run.finalResult);
        }

        if (run.phase === "reviewing" && run.judgeModel === undefined) {
          run.phase = "completed";
          run.finalResult = {
            ...(run.warning === undefined ? {} : { warning: run.warning }),
            runID: run.runID,
            phase: run.phase,
            target: run.target,
            brief: run.brief,
            quorum: run.quorum,
            ...(run.gatherer === undefined && run.adapterGatherer === undefined
              ? {}
              : run.gatherer !== undefined
                ? { gatherer: publicGatherer(run.gatherer, true) }
                : {
                    gatherer: publicAdapterGatherer(run.adapterGatherer),
                  }),
            reviewers: run.reviewers.map((reviewer) =>
              publicReviewer(reviewer, true),
            ),
            judge: {
              model: "parent-session",
              status: "pending-parent-consolidation",
            },
          };
          await save();
          const cleanupWarning = await cleanupSnapshot(run);
          return result(
            `Cross-review finalized: ${run.target}${cleanupWarning ?? ""}`,
            run.finalResult,
          );
        }

        if (run.phase === "reviewing" && run.judgeModel !== undefined) {
          run.phase = "judging";
          if (run.judge === undefined)
            throw new Error(
              `Cross-review judge session is missing: ${run.runID}`,
            );
          await save();
          await reconcileJudge(run, {}, save, context);
          return result(
            `Cross-review judge started: ${run.target}`,
            progress(run, false, true, now()),
          );
        }

        if (run.phase === "judging") {
          const judge = run.judge;
          if (judge?.status === "succeeded") {
            run.phase = "completed";
            run.finalResult = {
              ...(run.warning === undefined ? {} : { warning: run.warning }),
              runID: run.runID,
              phase: run.phase,
              target: run.target,
              brief: run.brief,
              quorum: run.quorum,
              ...(run.gatherer === undefined &&
              run.adapterGatherer === undefined
                ? {}
                : run.gatherer !== undefined
                  ? { gatherer: publicGatherer(run.gatherer, true) }
                  : {
                      gatherer: publicAdapterGatherer(run.adapterGatherer),
                    }),
              reviewers: run.reviewers.map((reviewer) =>
                publicReviewer(reviewer, true),
              ),
              judge: publicJudge(judge, true),
            };
            await save();
            const cleanupWarning = await cleanupSnapshot(run);
            return result(
              `Cross-review finalized: ${run.target}${cleanupWarning ?? ""}`,
              run.finalResult,
            );
          }
          if (
            judge?.status === "failed" ||
            judge?.status === "timed_out" ||
            judge?.status === "cancelled"
          ) {
            run.phase = "failed";
            run.finalResult = {
              ...(run.warning === undefined ? {} : { warning: run.warning }),
              runID: run.runID,
              phase: run.phase,
              status: "judge-failed",
              target: run.target,
              quorum: run.quorum,
              ...(run.gatherer === undefined &&
              run.adapterGatherer === undefined
                ? {}
                : run.gatherer !== undefined
                  ? { gatherer: publicGatherer(run.gatherer, true) }
                  : {
                      gatherer: publicAdapterGatherer(run.adapterGatherer),
                    }),
              reviewers: run.reviewers.map((reviewer) =>
                publicReviewer(reviewer, true),
              ),
              judge: publicJudge(judge, true),
            };
            return result(
              `Cross-review judge failed: ${run.target}`,
              run.finalResult,
            );
          }
        }
        return result(
          `Cross-review still running: ${run.target}`,
          progress(run, false, true, now()),
        );
      });
    },
  });

  return {
    cross_review_config: configPreview,
    cross_review_start: start,
    cross_review_status: status,
    cross_review_cancel: cancel,
    cross_review_finalize: finalize,
  };
}
