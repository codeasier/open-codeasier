import type { Message, Part } from "@opencode-ai/sdk";
import { DEFAULT_LIMITS } from "../session-review/schema.js";
import {
  normalizeSession,
  toReviewMessage,
} from "../session-review/normalize.js";
import type { SessionBundle } from "../session-review/fetch.js";
import type { ReviewLimits, ReviewMessage } from "../session-review/schema.js";
import {
  PROTOCOL_TOOL_NAMES,
  SHARED_CONTEXT_MARKER,
  type AuditMessage,
  type AuditSessionEvidence,
  type ProtocolCall,
  type RoleBehavior,
} from "./audit-types.js";

const PROTOCOL_TOOLS = new Set<string>(PROTOCOL_TOOL_NAMES);
export const MAX_PROTOCOL_CALLS = 80;
const SELECTED_ARGS = [
  "timeoutAction",
  "detail",
  "includeOutputs",
  "waitMs",
] as const;

function userModel(
  info: Message,
): { providerID: string; modelID: string } | undefined {
  if (info.role !== "user") return undefined;
  const model = info.model;
  if (model === undefined) return undefined;
  return { providerID: model.providerID, modelID: model.modelID };
}

function overlayAuditFields(
  review: ReviewMessage,
  raw: { info: Message; parts: Part[] },
): AuditMessage {
  const projected: AuditMessage = {
    id: review.id,
    role: review.role,
    parts: review.parts,
    ...(review.createdAt === undefined ? {} : { createdAt: review.createdAt }),
  };
  if (raw.info.role === "user") {
    const model = userModel(raw.info);
    if (model !== undefined) projected.model = model;
    if (typeof raw.info.agent === "string") projected.agent = raw.info.agent;
    if (raw.info.tools !== undefined) projected.tools = { ...raw.info.tools };
  } else if (raw.info.finish !== undefined) {
    projected.finish = raw.info.finish;
  }
  return projected;
}

function compactArgs(input: unknown): {
  args: Record<string, unknown>;
  omitted: string[];
} {
  const omitted: string[] = [];
  if (input === undefined || input === null || typeof input !== "object")
    return { args: {}, omitted: ["input"] };
  if (Array.isArray(input)) return { args: {}, omitted: ["input"] };
  const record = input as Record<string, unknown>;
  if (record.truncated === true) return { args: {}, omitted: ["input"] };
  const args: Record<string, unknown> = {};
  if ("context" in record) {
    if (typeof record.context === "string")
      args.contextLength =
        record.context.length === 0 ? "omitted" : record.context.length;
    else omitted.push("context");
  }
  if (typeof record.runID === "string") args.runID = record.runID;
  for (const key of SELECTED_ARGS) {
    if (!(key in record)) continue;
    const value = record[key];
    if (value === undefined) omitted.push(key);
    else args[key] = value;
  }
  return { args, omitted };
}

function compactResult(output: unknown): Record<string, unknown> {
  let parsed = output;
  if (typeof output === "string") {
    try {
      parsed = JSON.parse(output) as unknown;
    } catch {
      return {};
    }
  }
  if (typeof parsed !== "object" || parsed === null) return {};
  const record = parsed as Record<string, unknown>;
  return {
    ...(typeof record.phase === "string" ? { phase: record.phase } : {}),
    ...(typeof record.status === "string" ? { status: record.status } : {}),
    ...(typeof record.runID === "string" ? { runID: record.runID } : {}),
  };
}

function toolOutput(part: Part): unknown {
  if (part.type !== "tool") return undefined;
  if (part.state.status === "completed") return part.state.output;
  return undefined;
}

function toolInput(part: Part): unknown {
  if (part.type !== "tool") return undefined;
  return part.state.input;
}

export function extractProtocolCalls(
  messages: Array<{ info: Message; parts: Part[] }>,
): ProtocolCall[] {
  const calls: ProtocolCall[] = [];
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type !== "tool" || !PROTOCOL_TOOLS.has(part.tool)) continue;
      const extracted = compactArgs(toolInput(part));
      const createdAt = message.info.time?.created;
      calls.push({
        name: part.tool,
        status: part.state.status,
        ...(createdAt === undefined ? {} : { createdAt }),
        args: extracted.args,
        omitted: extracted.omitted,
        result: compactResult(toolOutput(part)),
      });
    }
  }
  return calls;
}

export function protocolCallRunID(call: ProtocolCall): string | undefined {
  if (typeof call.args.runID === "string") return call.args.runID;
  if (typeof call.result.runID === "string") return call.result.runID;
  return undefined;
}

export function protocolCallsForRun(
  calls: ProtocolCall[],
  runID: string,
): ProtocolCall[] {
  return calls.filter((call) => {
    const attributed = protocolCallRunID(call);
    return attributed === undefined || attributed === runID;
  });
}

export function boundProtocolCalls(calls: ProtocolCall[]): {
  calls: ProtocolCall[];
  omitted: number;
} {
  if (calls.length <= MAX_PROTOCOL_CALLS) return { calls, omitted: 0 };
  const head = Math.floor(MAX_PROTOCOL_CALLS / 2);
  const tail = MAX_PROTOCOL_CALLS - head;
  return {
    calls: [...calls.slice(0, head), ...calls.slice(calls.length - tail)],
    omitted: calls.length - MAX_PROTOCOL_CALLS,
  };
}

export function roleBehavior(messages: AuditMessage[]): RoleBehavior {
  const toolHistogram: Record<string, number> = {};
  const deniedAttempts: RoleBehavior["deniedAttempts"] = [];
  let userText = "";
  let lastAssistant: AuditMessage | undefined;
  for (const message of messages) {
    if (message.role === "user") {
      userText += message.parts
        .flatMap((part) => (part.type === "text" ? [part.text] : []))
        .join("\n");
    }
    if (message.role === "assistant") lastAssistant = message;
    for (const part of message.parts) {
      if (part.type !== "tool") continue;
      toolHistogram[part.name] = (toolHistogram[part.name] ?? 0) + 1;
      if (part.status === "error" || part.status === "invalid") {
        deniedAttempts.push({
          name: part.name,
          status: part.status,
          ...(part.error === undefined ? {} : { error: part.error }),
        });
      }
    }
  }
  const assistantText =
    lastAssistant?.parts
      .flatMap((part) => (part.type === "text" ? [part.text] : []))
      .join("\n")
      .trim() ?? "";
  return {
    toolHistogram,
    deniedAttempts,
    hasSharedContextMarker: userText.includes(SHARED_CONTEXT_MARKER),
    hasFinalAssistantText: assistantText.length > 0,
    ...(lastAssistant?.finish === undefined
      ? {}
      : { finish: lastAssistant.finish }),
  };
}

export function sliceFromMessage(
  messages: AuditMessage[],
  startID: string,
  untilID?: string,
): AuditMessage[] {
  const start = messages.findIndex((message) => message.id === startID);
  if (start < 0) return [];
  const end =
    untilID === undefined
      ? messages.length
      : messages.findIndex(
          (message, index) => index > start && message.id === untilID,
        );
  return messages.slice(start, end < 0 ? messages.length : end);
}

export function projectAuditSession(input: {
  bundle: SessionBundle;
  focus?: string;
  limits?: Partial<ReviewLimits>;
  pinMessageIDs?: string[];
  includeProtocolCalls?: boolean;
  childrenListed?: boolean;
  childCount?: number;
}): AuditSessionEvidence {
  const limits = { ...DEFAULT_LIMITS, ...input.limits };
  const rawByID = new Map(
    input.bundle.messages.map((message) => [message.info.id, message]),
  );
  const empty = input.bundle.messages.length === 0;
  const normalized = empty
    ? {
        sessionID: input.bundle.session.id,
        messages: [] as ReviewMessage[],
        totalMessages: 0,
        includedMessages: 0,
        omittedMessages: 0,
        retainedMessageIDs: [] as string[],
        truncated: false,
      }
    : normalizeSession({
        session: input.bundle.session,
        messages: input.bundle.messages,
        mode: "summary",
        ...(input.focus === undefined ? {} : { focus: input.focus }),
        ...(input.limits === undefined ? {} : { limits: input.limits }),
      });
  const projected = new Map<string, AuditMessage>();
  for (const message of normalized.messages) {
    const raw = rawByID.get(message.id);
    projected.set(
      message.id,
      raw === undefined ? { ...message } : overlayAuditFields(message, raw),
    );
  }
  for (const pinID of input.pinMessageIDs ?? []) {
    if (projected.has(pinID)) continue;
    const raw = rawByID.get(pinID);
    if (raw === undefined) continue;
    const review = toReviewMessage(raw, limits.maxPartBytes);
    if (review === undefined) continue;
    projected.set(pinID, overlayAuditFields(review, raw));
  }
  const retainedMessageIDs = [
    ...new Set([...normalized.retainedMessageIDs, ...projected.keys()]),
  ];
  const seen = new Set<string>();
  const messages: AuditMessage[] = [];
  for (const raw of input.bundle.messages) {
    const message = projected.get(raw.info.id);
    if (message === undefined || seen.has(raw.info.id)) continue;
    seen.add(raw.info.id);
    messages.push(message);
  }
  for (const [id, message] of projected) {
    if (seen.has(id)) continue;
    seen.add(id);
    messages.push(message);
  }
  const includedMessages = messages.length;
  const omittedMessages = Math.max(
    normalized.totalMessages - includedMessages,
    0,
  );
  return {
    sessionID: input.bundle.session.id,
    ...(input.bundle.session.parentID === undefined
      ? {}
      : { parentID: input.bundle.session.parentID }),
    ...(input.bundle.session.title === undefined
      ? {}
      : { title: input.bundle.session.title }),
    messages,
    totalMessages: normalized.totalMessages,
    includedMessages,
    omittedMessages,
    retainedMessageIDs,
    truncated: omittedMessages > 0,
    protocolCalls:
      input.includeProtocolCalls === true
        ? extractProtocolCalls(input.bundle.messages)
        : [],
    childrenListed: input.childrenListed === true,
    ...(input.childCount === undefined ? {} : { childCount: input.childCount }),
  };
}
