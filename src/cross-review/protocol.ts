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
  type ApiResult,
  READ_ONLY_TOOLS,
  responseData,
  reviewBrief,
  REVIEWER_AGENT,
  resolveReviewers,
  splitModel,
  type CrossReviewConfigLoader,
} from "./tool.js";
import {
  loadCrossReviewConfig,
  validateCrossReviewOverrides,
} from "./config.js";
import {
  FileCrossReviewRunStore,
  RUN_SCHEMA_VERSION,
  type CrossReviewRun,
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
    }): Promise<ApiResult<{ id: string; parentID?: string }>>;
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
};

const ACTIVE_REVIEWER_STATUSES = new Set<ReviewerRunStatus>([
  "starting",
  "running",
  "retrying",
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

function successfulReviewers(run: CrossReviewRun) {
  return run.reviewers.filter((reviewer) => reviewer.status === "succeeded");
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
  };
  if (!detail && !includeOutputs) return compact;
  return {
    ...compact,
    target: run.target,
    reviewers: run.reviewers.map((reviewer) =>
      publicReviewer(reviewer, includeOutputs),
    ),
    ...(run.gatherer === undefined
      ? {}
      : { gatherer: publicGatherer(run.gatherer, includeOutputs) }),
    ...(run.judge === undefined
      ? {}
      : { judge: publicJudge(run.judge, includeOutputs) }),
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
    if (reviewer.error !== undefined) detail += ` — ${reviewer.error}`;
    lines.push(`  ${detail}`);
  }
  if (run.gatherer !== undefined) {
    const gatherer = run.gatherer;
    let detail = `gatherer (${gatherer.model}) — ${gatherer.status}`;
    if (gatherer.retry !== undefined)
      detail += ` (retry ${gatherer.retry.attempt}: ${gatherer.retry.message})`;
    if (gatherer.error !== undefined) detail += ` — ${gatherer.error}`;
    lines.push(`  ${detail}`);
  }
  if (run.judge !== undefined) {
    const judge = run.judge;
    let detail = `judge (${judge.model}) — ${judge.status}`;
    if (judge.retry !== undefined)
      detail += ` (retry ${judge.retry.attempt}: ${judge.retry.message})`;
    if (judge.error !== undefined) detail += ` — ${judge.error}`;
    lines.push(`  ${detail}`);
  }
  if (pollAfterMs !== undefined)
    lines.push(`poll again after ${Math.round(pollAfterMs / 1000)}s`);
  return lines.join("\n");
}

function result(title: string, output: Record<string, unknown>) {
  return {
    title,
    output: JSON.stringify(output),
    metadata: {
      runID: output.runID,
      phase: output.phase,
    },
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
        text: reviewBrief(
          run.target,
          reviewer.focus,
          run.context ?? run.gatherer?.output,
        ),
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
          "Act as the read-only cross-review judge.",
          `Target: ${run.target}`,
          ...(run.context === undefined || run.context.length === 0
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
        ].join("\n"),
      },
    ],
    tools: READ_ONLY_TOOLS,
  };
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
          query: { directory: run.directory },
          signal: requestSignal(context.abort),
        }),
        `Reviewer ${reviewer.reviewer} prompt`,
      );
    } catch (error) {
      const dispatchError = errorMessage(error);
      try {
        await abortSession(reviewer.sessionID, run.directory);
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
        query: { directory: run.directory, limit: 100 },
        signal: requestSignal(context.abort),
      }),
      "Session messages",
    );
  }

  async function timeoutReviewer(
    run: CrossReviewRun,
    reviewer: ReviewerRun,
    timestamp: number,
  ) {
    let abortWarning: string | undefined;
    try {
      await abortSession(reviewer.sessionID, run.directory);
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
  ) {
    if (!ACTIVE_REVIEWER_STATUSES.has(reviewer.status)) return;
    const timestamp = now();
    const status = statuses[reviewer.sessionID];
    const deadlineReached =
      reviewer.deadlineAt !== undefined && timestamp >= reviewer.deadlineAt;

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
      if (deadlineReached) {
        await timeoutReviewer(run, reviewer, timestamp);
        reviewer.error = `${reviewer.error}; status unavailable: ${errorMessage(error)}`;
      } else {
        reviewer.error = `Reviewer status unavailable: ${errorMessage(error)}`;
      }
      return;
    }
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
    if (deadlineReached) {
      await timeoutReviewer(run, reviewer, timestamp);
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
            query: { directory: run.directory },
            signal: requestSignal(context.abort),
          }),
          "Judge prompt",
        );
      } catch (error) {
        const dispatchError = errorMessage(error);
        try {
          await abortSession(judge.sessionID, run.directory);
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
    if (
      judge.status !== "starting" &&
      judge.status !== "running" &&
      judge.status !== "retrying"
    )
      return;
    const timestamp = now();
    const deadlineReached =
      judge.deadlineAt !== undefined && timestamp >= judge.deadlineAt;
    const timeoutJudge = async () => {
      let abortWarning: string | undefined;
      try {
        await abortSession(judge.sessionID, run.directory);
      } catch (error) {
        abortWarning = `; abort unconfirmed: ${errorMessage(error)}`;
      }
      judge.status = "timed_out";
      judge.completedAt = timestamp;
      judge.error = `Judge timed out after ${run.reviewerTimeoutMs}ms${abortWarning ?? ""}`;
      delete judge.retry;
    };
    const status = statuses[judge.sessionID];
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
      if (deadlineReached) {
        await timeoutJudge();
        judge.error = `${judge.error}; status unavailable: ${errorMessage(error)}`;
      } else {
        judge.error = `Judge status unavailable: ${errorMessage(error)}`;
      }
      return;
    }
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
    if (deadlineReached) {
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
            query: { directory: run.directory },
            signal: requestSignal(context.abort),
          }),
          "Gather prompt",
        );
      } catch (error) {
        const dispatchError = errorMessage(error);
        try {
          await abortSession(gatherer.sessionID, run.directory);
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
    if (
      gatherer.status !== "starting" &&
      gatherer.status !== "running" &&
      gatherer.status !== "retrying"
    )
      return;
    const timestamp = now();
    const deadlineReached =
      gatherer.deadlineAt !== undefined && timestamp >= gatherer.deadlineAt;
    const timeoutGatherer = async () => {
      let abortWarning: string | undefined;
      try {
        await abortSession(gatherer.sessionID, run.directory);
      } catch (error) {
        abortWarning = `; abort unconfirmed: ${errorMessage(error)}`;
      }
      gatherer.status = "timed_out";
      gatherer.completedAt = timestamp;
      gatherer.error = `Gatherer timed out after ${run.reviewerTimeoutMs}ms${abortWarning ?? ""}`;
      delete gatherer.retry;
    };
    const status = statuses[gatherer.sessionID];
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
      if (deadlineReached) {
        await timeoutGatherer();
        gatherer.error = `${gatherer.error}; status unavailable: ${errorMessage(error)}`;
        await transitionToReviewing();
      } else {
        gatherer.error = `Gatherer status unavailable: ${errorMessage(error)}`;
      }
      return;
    }
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
    if (deadlineReached) {
      await timeoutGatherer();
      await transitionToReviewing();
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
        query: { directory: run.directory },
        signal: requestSignal(context.abort),
      }),
      "Session status",
    );
  }

  async function reconcile(
    run: CrossReviewRun,
    save: SaveRun,
    context: ProtocolContext,
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
      await reconcileGatherer(run, currentStatuses ?? {}, save, context);
      return;
    }
    if (run.phase === "reviewing") {
      await Promise.all(
        run.reviewers.map((reviewer) =>
          reconcileReviewer(run, reviewer, currentStatuses ?? {}, context),
        ),
      );
      await dispatchAvailable(run, save, context);
    }
    if (run.phase === "judging")
      await reconcileJudge(run, currentStatuses ?? {}, save, context);
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
      // The host may not enforce the declared tool schema, so out-of-range
      // overrides are revalidated here with the loader's bounds.
      validateCrossReviewOverrides(args);
      const directory = await canonicalize(context.directory);
      const loaded = await loadConfig(context.directory);
      const reviewers = resolveReviewers(args, loaded.config);
      const judgeModel =
        args.judgeModel === undefined
          ? loaded.config.judgeModel
          : args.judgeModel.trim() || undefined;
      const maxConcurrency =
        args.maxConcurrency ??
        loaded.config.maxConcurrency ??
        DEFAULT_CONCURRENCY;
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
          signal: requestSignal(context.abort),
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

      const runID = createRunID();
      const childSessions: string[] = [];
      try {
        for (const [index] of reviewers.entries()) {
          const session = responseData(
            await client.session.create({
              body: {
                parentID: context.sessionID,
                title: `Cross-review ${runID.slice(0, 8)} reviewer ${index + 1}: ${args.target.slice(0, 120)}`,
              },
              query: { directory: context.directory },
              signal: requestSignal(context.abort),
            }),
            `Reviewer ${index + 1} session creation`,
          );
          childSessions.push(session.id);
        }
        let judgeSessionID: string | undefined;
        if (judgeModel !== undefined) {
          const session = responseData(
            await client.session.create({
              body: {
                parentID: context.sessionID,
                title: `Cross-review ${runID.slice(0, 8)} judge: ${args.target.slice(0, 120)}`,
              },
              query: { directory: context.directory },
              signal: requestSignal(context.abort),
            }),
            "Judge session creation",
          );
          judgeSessionID = session.id;
          childSessions.push(session.id);
        }
        const timestamp = now();
        const warning = configWarning(loaded);
        // An empty context is treated as "not provided": it must not disable
        // gathering while embedding nothing into reviewer briefs.
        const providedContext =
          args.context === undefined || args.context.length === 0
            ? undefined
            : args.context;
        const gathers =
          judgeModel !== undefined && providedContext === undefined;
        const run: CrossReviewRun = {
          schemaVersion: RUN_SCHEMA_VERSION,
          runID,
          directory,
          ownerSessionID: context.sessionID,
          createdAt: timestamp,
          updatedAt: timestamp,
          phase: gathers ? "gathering" : "reviewing",
          target: args.target,
          brief: reviewBrief(
            args.target,
            args.focus ?? loaded.config.focus,
            providedContext,
          ),
          ...(providedContext === undefined
            ? {}
            : { context: providedContext }),
          ...(warning === undefined ? {} : { warning }),
          quorum: Math.floor(reviewers.length / 2) + 1,
          maxConcurrency,
          reviewerTimeoutMs:
            args.reviewerTimeoutMs ??
            loaded.config.reviewerTimeoutMs ??
            DEFAULT_REVIEWER_TIMEOUT_MS,
          ...(judgeModel === undefined ? {} : { judgeModel }),
          configSources: loaded.sources,
          projectConfigPath: loaded.projectPath,
          globalConfigPath: loaded.globalPath,
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
                await abortSession(stored.gatherer.sessionID, stored.directory);
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
                  await abortSession(reviewer.sessionID, stored.directory);
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
            return result(
              `Cross-review cancelled: ${args.target}`,
              progress(stored, false, true, now()),
            );
          }
          return result(
            `Cross-review started: ${args.target}`,
            progress(stored, false, true, now()),
          );
        });
      } catch (error) {
        await Promise.all(
          childSessions.map((sessionID) =>
            abortSession(sessionID, context.directory).catch(() => undefined),
          ),
        );
        throw error;
      }
    },
  });

  const status = tool({
    description:
      "Poll and advance one asynchronous cross-review run without blocking; invoke only with explicit user review intent from primary sessions",
    args: {
      runID: tool.schema.string().uuid(),
      detail: tool.schema.boolean().optional(),
      includeOutputs: tool.schema.boolean().optional(),
    },
    async execute(args, context) {
      return withAuthorizedRun(args.runID, context, async (run, save) => {
        await reconcile(run, save, context);
        return result(
          `Cross-review status: ${truncate(run.target, STATUS_TARGET_LIMIT)}`,
          progress(
            run,
            args.includeOutputs ?? false,
            args.detail ?? false,
            now(),
          ),
        );
      });
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
              await abortSession(reviewer.sessionID, run.directory);
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
            run.gatherer.status === "starting" ||
            run.gatherer.status === "running" ||
            run.gatherer.status === "retrying")
        ) {
          try {
            await abortSession(run.gatherer.sessionID, run.directory);
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
          (run.judge.status === "starting" ||
            run.judge.status === "running" ||
            run.judge.status === "retrying")
        ) {
          try {
            await abortSession(run.judge.sessionID, run.directory);
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
        return result(
          `Cross-review cancelled: ${run.target}`,
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
            ...(run.gatherer === undefined
              ? {}
              : { gatherer: publicGatherer(run.gatherer, true) }),
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
            ...(run.gatherer === undefined
              ? {}
              : { gatherer: publicGatherer(run.gatherer, true) }),
            reviewers: run.reviewers.map((reviewer) =>
              publicReviewer(reviewer, true),
            ),
            judge: {
              model: "parent-session",
              status: "pending-parent-consolidation",
            },
          };
          return result(
            `Cross-review finalized: ${run.target}`,
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
              ...(run.gatherer === undefined
                ? {}
                : { gatherer: publicGatherer(run.gatherer, true) }),
              reviewers: run.reviewers.map((reviewer) =>
                publicReviewer(reviewer, true),
              ),
              judge: publicJudge(judge, true),
            };
            return result(
              `Cross-review finalized: ${run.target}`,
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
              runID: run.runID,
              phase: run.phase,
              status: "judge-failed",
              target: run.target,
              quorum: run.quorum,
              ...(run.gatherer === undefined
                ? {}
                : { gatherer: publicGatherer(run.gatherer, true) }),
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
    cross_review_start: start,
    cross_review_status: status,
    cross_review_cancel: cancel,
    cross_review_finalize: finalize,
  };
}
