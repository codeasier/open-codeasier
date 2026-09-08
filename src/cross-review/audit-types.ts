import type {
  AdapterGathererRun,
  CrossReviewRun,
  CrossReviewRunPhase,
  RunStoreError,
} from "./run-store.js";

export type CheckResult = "pass" | "fail" | "insufficient-evidence";

export type AuditCheck = {
  id: string;
  result: CheckResult;
  detail: string;
  runID?: string;
  role?: string;
};

export type ProtocolCall = {
  name: string;
  status: string;
  createdAt?: number;
  args: Record<string, unknown>;
  omitted: string[];
  result: Record<string, unknown>;
  /** Bounded host error text for rejected calls (for example a premature finalize). */
  error?: string;
};

export type AuditMessage = {
  id: string;
  role: "user" | "assistant";
  createdAt?: number;
  model?: { providerID: string; modelID: string };
  agent?: string;
  tools?: Record<string, boolean>;
  finish?: string;
  parts: Array<
    | { type: "text" | "reasoning"; text: string }
    | {
        type: "tool";
        name: string;
        status: string;
        input?: unknown;
        output?: string;
        error?: string;
      }
    | { type: "file"; mime: string; filename?: string }
    | { type: "unknown"; sourceType: string }
  >;
};

export type AuditSessionEvidence = {
  sessionID: string;
  parentID?: string;
  title?: string;
  /** Directory the host bound the session to, as reported by the SDK. */
  directory?: string;
  messages: AuditMessage[];
  totalMessages: number;
  includedMessages: number;
  omittedMessages: number;
  retainedMessageIDs: string[];
  truncated: boolean;
  protocolCalls: ProtocolCall[];
  childrenListed: boolean;
  childCount?: number;
};

export type RoleBehavior = {
  toolHistogram: Record<string, number>;
  deniedAttempts: Array<{ name: string; status: string; error?: string }>;
  hasSharedContextMarker: boolean;
  hasFinalAssistantText: boolean;
  finish?: string;
};

export type RoleReport = {
  role: string;
  sessionID: string;
  messageID: string;
  model: string;
  truncated: boolean;
  omittedMessages: number;
  fetchError?: { code: string; detail: string };
  behavior?: RoleBehavior;
};

/**
 * Manifest-side summary of one dispatched role. Timing and timeout fields are
 * copied verbatim so the skill can grade preserve/abort handling; `error` is
 * bounded.
 */
export type AuditRoleSummary = {
  sessionID: string;
  messageID: string;
  status: string;
  model: string;
  startedAt?: number;
  completedAt?: number;
  deadlineAt?: number;
  timeoutDetectedAt?: number;
  timeoutExtensions?: number;
  retry?: { attempt: number; message: string; next: number };
  error?: string;
};

export type AuditAdapterGatherer = Pick<
  AdapterGathererRun,
  "forge" | "status" | "startedAt" | "completedAt" | "error"
>;

export type AuditSnapshot = NonNullable<CrossReviewRun["snapshot"]>;

export type AuditRunResult = {
  runID: string;
  createdAt: number;
  phase: CrossReviewRunPhase;
  /** `finalResult.status` when the run recorded one (for example `gather-failed`). */
  finalStatus?: string;
  directory: string;
  directoryMismatch: boolean;
  target: string;
  /** Legacy embed marker: true only when the manifest persisted nonblank `context`. */
  hasContext: boolean;
  judgeModel?: string;
  adapterGatherer?: AuditAdapterGatherer;
  snapshot?: AuditSnapshot;
  gatherer?: AuditRoleSummary;
  judge?: AuditRoleSummary;
  reviewers: Array<{ reviewer: number } & AuditRoleSummary>;
  checks: AuditCheck[];
  protocolTimeline: ProtocolCall[];
  protocolCallCount?: number;
  protocolTimelineOmitted?: number;
  roles: {
    gatherer?: RoleReport;
    judge?: RoleReport;
    reviewers: RoleReport[];
  };
  truncated: {
    parent: boolean;
    roles: Record<string, boolean>;
  };
};

export type CrossReviewAuditPayload = {
  parentSessionID: string;
  focus?: string;
  parent: {
    sessionID: string;
    title?: string;
    truncated: boolean;
    totalMessages: number;
    includedMessages: number;
    omittedMessages: number;
    protocolTimeline: ProtocolCall[];
    protocolCallCount?: number;
    protocolTimelineOmitted?: number;
  };
  runs: AuditRunResult[];
  checks: AuditCheck[];
  errors: RunStoreError[];
};

export const SHARED_CONTEXT_MARKER =
  "Shared target context (already gathered; verify findings against it):";

/** Prefix shared by snapshot reviewer and judge briefs; does not imply embed. */
export const SNAPSHOT_EVIDENCE_MARKER =
  "The current directory is an isolated git worktree";

export const PROTOCOL_TOOL_NAMES = [
  "cross_review",
  "cross_review_config",
  "cross_review_start",
  "cross_review_status",
  "cross_review_cancel",
  "cross_review_finalize",
] as const;

/** Upper bound for role `error` and protocol `warning` / `error` text in the payload. */
export const MAX_AUDIT_TEXT_LENGTH = 400;

export function boundText(
  text: string,
  limit: number = MAX_AUDIT_TEXT_LENGTH,
): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 3)}...`;
}

export const TERMINAL_AUDIT_PHASES = new Set<CrossReviewRunPhase>([
  "completed",
  "quorum-not-met",
  "failed",
  "cancelled",
]);
