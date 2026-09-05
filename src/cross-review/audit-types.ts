import type { CrossReviewRunPhase, RunStoreError } from "./run-store.js";

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

export type AuditRunResult = {
  runID: string;
  createdAt: number;
  phase: CrossReviewRunPhase;
  directory: string;
  directoryMismatch: boolean;
  target: string;
  hasContext: boolean;
  judgeModel?: string;
  gatherer?: {
    sessionID: string;
    messageID: string;
    status: string;
    model: string;
  };
  judge?: {
    sessionID: string;
    messageID: string;
    status: string;
    model: string;
  };
  reviewers: Array<{
    reviewer: number;
    sessionID: string;
    messageID: string;
    status: string;
    model: string;
  }>;
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

export const PROTOCOL_TOOL_NAMES = [
  "cross_review",
  "cross_review_start",
  "cross_review_status",
  "cross_review_cancel",
  "cross_review_finalize",
] as const;

export const TERMINAL_AUDIT_PHASES = new Set<CrossReviewRunPhase>([
  "completed",
  "quorum-not-met",
  "failed",
  "cancelled",
]);
