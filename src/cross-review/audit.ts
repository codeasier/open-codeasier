import { tool } from "@opencode-ai/plugin";
import { assertPrimarySession } from "../primary-session.js";
import { SessionReviewError } from "../session-review/errors.js";
import {
  fetchSessionBundle,
  listSessionChildren,
  type SessionClient,
} from "../session-review/fetch.js";
import {
  checkLegacyToolAbsent,
  checkRunsFound,
  evaluateRunChecks,
  persistedContext,
} from "./audit-checks.js";
import {
  boundProtocolCalls,
  projectAuditSession,
  protocolCallsForRun,
  roleBehavior,
  sliceFromMessage,
} from "./audit-project.js";
import type {
  AuditRunResult,
  AuditSessionEvidence,
  CrossReviewAuditPayload,
  ProtocolCall,
  RoleReport,
} from "./audit-types.js";
import {
  FileCrossReviewRunStore,
  RUN_ID,
  type CrossReviewRun,
  type CrossReviewRunStore,
  type GathererRun,
  type JudgeRun,
  type ReviewerRun,
} from "./run-store.js";

export type AuditErrorCode =
  | "SESSION_NOT_FOUND"
  | "SESSION_ACCESS_DENIED"
  | "SESSION_EMPTY"
  | "RESPONSE_TOO_LARGE"
  | "SDK_FAILURE"
  | "RUN_NOT_FOUND"
  | "RUN_ID_AMBIGUOUS";

export class AuditError extends Error {
  constructor(
    public readonly code: AuditErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AuditError";
  }
}

function asAuditError(error: unknown): AuditError | undefined {
  if (error instanceof AuditError) return error;
  if (error instanceof SessionReviewError)
    return new AuditError(error.code, error.message);
  return undefined;
}

function compactHex(value: string): string {
  return value.replace(/-/g, "").toLowerCase();
}

function isRunIDPrefix(value: string): boolean {
  return /^[0-9a-f]{8,}$/i.test(compactHex(value));
}

function matchesRunPrefix(runID: string, prefix: string): boolean {
  const run = runID.toLowerCase();
  const token = prefix.toLowerCase();
  if (run.startsWith(token)) return true;
  return compactHex(run).startsWith(compactHex(token));
}

export function resolveOwnerRuns(
  runs: CrossReviewRun[],
  runID?: string,
): CrossReviewRun[] {
  if (runID === undefined) return runs;
  if (RUN_ID.test(runID)) {
    const exact = runs.filter(
      (run) => run.runID.toLowerCase() === runID.toLowerCase(),
    );
    if (exact.length === 1) return exact;
    throw new AuditError(
      "RUN_NOT_FOUND",
      `Cross-review run not found: ${runID}`,
    );
  }
  if (!isRunIDPrefix(runID))
    throw new AuditError(
      "RUN_NOT_FOUND",
      `Cross-review run not found: ${runID}`,
    );
  const matches = runs.filter((run) => matchesRunPrefix(run.runID, runID));
  if (matches.length === 0)
    throw new AuditError(
      "RUN_NOT_FOUND",
      `Cross-review run not found: ${runID}`,
    );
  if (matches.length > 1)
    throw new AuditError(
      "RUN_ID_AMBIGUOUS",
      `Ambiguous cross-review run ID prefix: ${runID}`,
    );
  return matches;
}

function publicRole(role: ReviewerRun | GathererRun | JudgeRun) {
  return {
    sessionID: role.sessionID,
    messageID: role.messageID,
    status: role.status,
    model: role.model,
  };
}

function rolePins(run: CrossReviewRun): Map<string, string[]> {
  const pins = new Map<string, string[]>();
  const add = (sessionID: string, messageID: string) => {
    const existing = pins.get(sessionID) ?? [];
    if (!existing.includes(messageID)) existing.push(messageID);
    pins.set(sessionID, existing);
  };
  for (const reviewer of run.reviewers)
    add(reviewer.sessionID, reviewer.messageID);
  if (run.gatherer !== undefined)
    add(run.gatherer.sessionID, run.gatherer.messageID);
  if (run.judge !== undefined) add(run.judge.sessionID, run.judge.messageID);
  return pins;
}

async function loadAuditSession(
  client: SessionClient,
  sessionID: string,
  directory: string,
  options: {
    pinMessageIDs?: string[];
    includeProtocolCalls?: boolean;
    focus?: string;
  },
): Promise<AuditSessionEvidence> {
  const bundle = await fetchSessionBundle({ client, sessionID, directory });
  const children = await listSessionChildren({ client, sessionID, directory });
  return projectAuditSession({
    bundle,
    ...(options.focus === undefined ? {} : { focus: options.focus }),
    ...(options.pinMessageIDs === undefined
      ? {}
      : { pinMessageIDs: options.pinMessageIDs }),
    ...(options.includeProtocolCalls === undefined
      ? {}
      : { includeProtocolCalls: options.includeProtocolCalls }),
    childrenListed: children.listed,
    ...(children.listed ? { childCount: children.children.length } : {}),
  });
}

function sessionCacheKey(directory: string, sessionID: string): string {
  return `${directory}\0${sessionID}`;
}

function uniqueDirectories(
  callerDirectory: string,
  runs: CrossReviewRun[],
): string[] {
  const directories: string[] = [];
  const seen = new Set<string>();
  for (const directory of [
    callerDirectory,
    ...runs.map((run) => run.directory),
  ]) {
    if (seen.has(directory)) continue;
    seen.add(directory);
    directories.push(directory);
  }
  return directories;
}

async function fetchParentBundle(
  client: SessionClient,
  parentSessionID: string,
  callerDirectory: string,
  runs: CrossReviewRun[],
) {
  let lastNotFound: unknown;
  for (const directory of uniqueDirectories(callerDirectory, runs)) {
    try {
      return await fetchSessionBundle({
        client,
        sessionID: parentSessionID,
        directory,
      });
    } catch (error) {
      if (
        !(error instanceof SessionReviewError) ||
        error.code !== "SESSION_NOT_FOUND"
      )
        throw error;
      lastNotFound = error;
    }
  }
  throw lastNotFound;
}

function timelineFields(
  calls: ProtocolCall[],
): Pick<
  AuditRunResult,
  "protocolTimeline" | "protocolCallCount" | "protocolTimelineOmitted"
> {
  const bounded = boundProtocolCalls(calls);
  return {
    protocolTimeline: bounded.calls,
    protocolCallCount: calls.length,
    ...(bounded.omitted === 0
      ? {}
      : { protocolTimelineOmitted: bounded.omitted }),
  };
}

function roleReport(input: {
  role: string;
  sessionID: string;
  messageID: string;
  model: string;
  evidence?: AuditSessionEvidence;
  fetchError?: { code: string; detail: string };
  untilMessageID?: string;
}): RoleReport {
  const messages =
    input.evidence === undefined
      ? []
      : sliceFromMessage(
          input.evidence.messages,
          input.messageID,
          input.untilMessageID,
        );
  return {
    role: input.role,
    sessionID: input.sessionID,
    messageID: input.messageID,
    model: input.model,
    truncated: input.evidence?.truncated ?? false,
    omittedMessages: input.evidence?.omittedMessages ?? 0,
    ...(input.fetchError === undefined ? {} : { fetchError: input.fetchError }),
    ...(input.evidence === undefined
      ? {}
      : { behavior: roleBehavior(messages) }),
  };
}

function buildRunResult(input: {
  run: CrossReviewRun;
  callerDirectory: string;
  parent: AuditSessionEvidence;
  sessions: Map<string, AuditSessionEvidence | undefined>;
  fetchErrors: Map<string, { code: string; detail: string }>;
}): AuditRunResult {
  const run = input.run;
  const checks = evaluateRunChecks({ run, sessions: input.sessions });
  const gathererUntil =
    run.gatherer !== undefined &&
    run.judge !== undefined &&
    run.gatherer.sessionID === run.judge.sessionID
      ? run.judge.messageID
      : undefined;
  const truncatedRoles: Record<string, boolean> = {};
  const gathererEvidence =
    run.gatherer === undefined
      ? undefined
      : input.sessions.get(run.gatherer.sessionID);
  const gathererError =
    run.gatherer === undefined
      ? undefined
      : input.fetchErrors.get(
          sessionCacheKey(run.directory, run.gatherer.sessionID),
        );
  const gatherer =
    run.gatherer === undefined
      ? undefined
      : roleReport({
          role: "gatherer",
          sessionID: run.gatherer.sessionID,
          messageID: run.gatherer.messageID,
          model: run.gatherer.model,
          ...(gathererEvidence === undefined
            ? {}
            : { evidence: gathererEvidence }),
          ...(gathererError === undefined ? {} : { fetchError: gathererError }),
          ...(gathererUntil === undefined
            ? {}
            : { untilMessageID: gathererUntil }),
        });
  if (gatherer !== undefined) truncatedRoles.gatherer = gatherer.truncated;
  const judgeEvidence =
    run.judge === undefined
      ? undefined
      : input.sessions.get(run.judge.sessionID);
  const judgeError =
    run.judge === undefined
      ? undefined
      : input.fetchErrors.get(
          sessionCacheKey(run.directory, run.judge.sessionID),
        );
  const judge =
    run.judge === undefined
      ? undefined
      : roleReport({
          role: "judge",
          sessionID: run.judge.sessionID,
          messageID: run.judge.messageID,
          model: run.judge.model,
          ...(judgeEvidence === undefined ? {} : { evidence: judgeEvidence }),
          ...(judgeError === undefined ? {} : { fetchError: judgeError }),
        });
  if (judge !== undefined) truncatedRoles.judge = judge.truncated;
  const reviewers = run.reviewers.map((reviewer) => {
    const reviewerEvidence = input.sessions.get(reviewer.sessionID);
    const reviewerError = input.fetchErrors.get(
      sessionCacheKey(run.directory, reviewer.sessionID),
    );
    const report = roleReport({
      role: `reviewer:${reviewer.reviewer}`,
      sessionID: reviewer.sessionID,
      messageID: reviewer.messageID,
      model: reviewer.model,
      ...(reviewerEvidence === undefined ? {} : { evidence: reviewerEvidence }),
      ...(reviewerError === undefined ? {} : { fetchError: reviewerError }),
    });
    truncatedRoles[report.role] = report.truncated;
    return report;
  });
  return {
    runID: run.runID,
    createdAt: run.createdAt,
    phase: run.phase,
    directory: run.directory,
    directoryMismatch: run.directory !== input.callerDirectory,
    target: run.target,
    hasContext: persistedContext(run) !== undefined,
    ...(run.judgeModel === undefined ? {} : { judgeModel: run.judgeModel }),
    ...(run.gatherer === undefined
      ? {}
      : { gatherer: publicRole(run.gatherer) }),
    ...(run.judge === undefined ? {} : { judge: publicRole(run.judge) }),
    reviewers: run.reviewers.map((reviewer) => ({
      reviewer: reviewer.reviewer,
      ...publicRole(reviewer),
    })),
    checks,
    ...timelineFields(
      protocolCallsForRun(input.parent.protocolCalls, run.runID),
    ),
    roles: {
      ...(gatherer === undefined ? {} : { gatherer }),
      ...(judge === undefined ? {} : { judge }),
      reviewers,
    },
    truncated: {
      parent: input.parent.truncated,
      roles: truncatedRoles,
    },
  };
}

export async function auditCrossReview(input: {
  client: SessionClient;
  store: CrossReviewRunStore;
  parentSessionID: string;
  directory: string;
  runID?: string;
  focus?: string;
}): Promise<CrossReviewAuditPayload> {
  const listed = await input.store.listByOwner(input.parentSessionID);
  const selected = resolveOwnerRuns(listed.runs, input.runID);
  const parentBundle = await fetchParentBundle(
    input.client,
    input.parentSessionID,
    input.directory,
    selected,
  );
  if (parentBundle.messages.length === 0)
    throw new AuditError(
      "SESSION_EMPTY",
      `Session has no messages: ${input.parentSessionID}`,
    );
  const parent = projectAuditSession({
    bundle: parentBundle,
    ...(input.focus === undefined ? {} : { focus: input.focus }),
    includeProtocolCalls: true,
    childrenListed: false,
  });

  const cache = new Map<string, Promise<AuditSessionEvidence>>();
  const fetchErrors = new Map<string, { code: string; detail: string }>();
  const load = (sessionID: string, directory: string, pins: string[]) => {
    const key = sessionCacheKey(directory, sessionID);
    const pending = cache.get(key);
    if (pending !== undefined) return pending;
    const request = loadAuditSession(input.client, sessionID, directory, {
      pinMessageIDs: pins,
      ...(input.focus === undefined ? {} : { focus: input.focus }),
    }).catch((error: unknown) => {
      const mapped = asAuditError(error);
      fetchErrors.set(key, {
        code: mapped?.code ?? "SDK_FAILURE",
        detail:
          mapped?.message ??
          `OpenCode SDK failed while reading session: ${sessionID}`,
      });
      throw error;
    });
    cache.set(key, request);
    return request;
  };

  const runs: AuditRunResult[] = [];
  for (const run of selected) {
    const pins = rolePins(run);
    const sessions = new Map<string, AuditSessionEvidence | undefined>();
    await Promise.all(
      [...pins.entries()].map(async ([sessionID, messageIDs]) => {
        try {
          sessions.set(
            sessionID,
            await load(sessionID, run.directory, messageIDs),
          );
        } catch {
          sessions.set(sessionID, undefined);
        }
      }),
    );
    runs.push(
      buildRunResult({
        run,
        callerDirectory: input.directory,
        parent,
        sessions,
        fetchErrors,
      }),
    );
  }

  return {
    parentSessionID: input.parentSessionID,
    ...(input.focus === undefined ? {} : { focus: input.focus }),
    parent: {
      sessionID: parent.sessionID,
      ...(parent.title === undefined ? {} : { title: parent.title }),
      truncated: parent.truncated,
      totalMessages: parent.totalMessages,
      includedMessages: parent.includedMessages,
      omittedMessages: parent.omittedMessages,
      ...timelineFields(parent.protocolCalls),
    },
    runs,
    checks: [
      checkRunsFound({
        runCount: selected.length,
        ...(input.runID === undefined ? {} : { runIDFilter: true }),
      }),
      checkLegacyToolAbsent(parent.protocolCalls),
    ],
    errors: listed.errors,
  };
}

export function createCrossReviewAuditTool(
  client: SessionClient,
  options: { store?: CrossReviewRunStore } = {},
) {
  const store = options.store ?? new FileCrossReviewRunStore();
  return tool({
    description:
      "Read-only audit of cross-review protocol and role behavior for one explicit parent session; invoke only from primary sessions",
    args: {
      parentSessionID: tool.schema.string().min(1),
      runID: tool.schema.string().optional(),
      focus: tool.schema.string().max(2_000).optional(),
    },
    async execute(args, context) {
      try {
        await assertPrimarySession(
          client,
          context,
          "cross_review_audit",
          context.abort,
        );
        const payload = await auditCrossReview({
          client,
          store,
          parentSessionID: args.parentSessionID,
          directory: context.directory,
          ...(args.runID === undefined ? {} : { runID: args.runID }),
          ...(args.focus === undefined ? {} : { focus: args.focus }),
        });
        return {
          title: `Cross-review audit: ${args.parentSessionID}`,
          output: JSON.stringify(payload),
          metadata: {
            runCount: payload.runs.length,
            truncated: payload.parent.truncated,
            errorCount: payload.errors.length,
          },
        };
      } catch (error) {
        const mapped = asAuditError(error);
        if (mapped !== undefined)
          return {
            title: `Cross-review audit failed: ${args.parentSessionID}`,
            output: `${mapped.code}: ${mapped.message}`,
            metadata: { error: mapped.code },
          };
        throw error;
      }
    },
  });
}
