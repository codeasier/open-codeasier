import type { Part } from "@opencode-ai/sdk";
import { DEFAULT_LIMITS } from "./schema.js";
import type {
  NormalizeInput,
  NormalizedSession,
  ReviewMessage,
  ReviewPart,
} from "./schema.js";
import { SessionReviewError } from "./errors.js";

const MARKER = "\n...[truncated]";
function truncate(value: string, maxBytes: number) {
  if (Buffer.byteLength(value) <= maxBytes) return value;
  let result = value;
  while (Buffer.byteLength(result + MARKER) > maxBytes && result.length)
    result = result.slice(0, -1);
  return result + MARKER;
}

const INPUT_LIMITS = { depth: 6, keys: 100, stringBytes: 4_000, bytes: 20_000 };
function sanitizeInput(value: unknown): unknown {
  let keys = 0;
  const seen = new Set<object>();
  const visit = (item: unknown, depth: number): unknown => {
    if (typeof item === "string")
      return truncate(item, INPUT_LIMITS.stringBytes);
    if (item === null || typeof item === "boolean" || typeof item === "number")
      return item;
    if (depth >= INPUT_LIMITS.depth) return "[depth-limit]";
    if (typeof item !== "object") return `[${typeof item}]`;
    if (seen.has(item)) return "[circular]";
    seen.add(item);
    if (Array.isArray(item))
      return item.slice(0, INPUT_LIMITS.keys).map((x) => visit(x, depth + 1));
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(item).sort()) {
      if (++keys > INPUT_LIMITS.keys) {
        result["[omitted]"] = "key-limit";
        break;
      }
      result[truncate(key, 200)] = visit(
        (item as Record<string, unknown>)[key],
        depth + 1,
      );
    }
    return result;
  };
  const result = visit(value, 0);
  const json = JSON.stringify(result) ?? `[${typeof value}]`;
  return Buffer.byteLength(json) <= INPUT_LIMITS.bytes
    ? result
    : { truncated: true, preview: truncate(json, INPUT_LIMITS.bytes - 40) };
}

function normalizePart(part: Part, maxPartBytes: number): ReviewPart {
  if (part.type === "text" || part.type === "reasoning")
    return { type: part.type, text: truncate(part.text, maxPartBytes) };
  if (part.type === "file") {
    const filename =
      "filename" in part && typeof part.filename === "string"
        ? part.filename
        : undefined;
    return filename === undefined
      ? { type: "file", mime: part.mime }
      : { type: "file", mime: part.mime, filename };
  }
  if (part.type === "tool") {
    const state = part.state;
    const base = {
      type: "tool" as const,
      name: part.tool,
      status: state.status,
    };
    if (state.status === "pending" || state.status === "running")
      return { ...base, input: sanitizeInput(state.input) };
    if (state.status === "completed")
      return {
        ...base,
        input: sanitizeInput(state.input),
        output: truncate(state.output, maxPartBytes),
      };
    return {
      ...base,
      input: sanitizeInput(state.input),
      error: truncate(state.error, maxPartBytes),
    };
  }
  return {
    type: "unknown",
    sourceType: String((part as { type?: unknown }).type ?? "unknown"),
  };
}

function normalizeMessage(
  message: NormalizeInput["messages"][number],
  maxPartBytes: number,
): ReviewMessage | undefined {
  if (message.info.role !== "user" && message.info.role !== "assistant")
    return undefined;
  const createdAt = message.info.time?.created;
  const result: ReviewMessage = {
    id: message.info.id,
    role: message.info.role,
    parts: message.parts.map((part) => normalizePart(part, maxPartBytes)),
  };
  return createdAt === undefined ? result : { ...result, createdAt };
}

export function normalizeSession(input: NormalizeInput): NormalizedSession {
  const limits = { ...DEFAULT_LIMITS, ...input.limits };
  const all = input.messages
    .map((message) => normalizeMessage(message, limits.maxPartBytes))
    .filter((message): message is ReviewMessage => message !== undefined);
  const order =
    input.mode === "troubleshoot"
      ? all.map((_, index) => index).reverse()
      : Array.from({ length: all.length }, (_, step) =>
          step % 2 === 0 ? step / 2 : all.length - 1 - (step - 1) / 2,
        );
  const selected = new Set<number>();
  for (const index of order) {
    if (selected.size >= limits.maxMessages) break;
    selected.add(index);
    const candidate = build(selected);
    if (Buffer.byteLength(JSON.stringify(candidate)) > limits.maxBytes)
      selected.delete(index);
  }
  const result = build(selected);
  if (Buffer.byteLength(JSON.stringify(result)) > limits.maxBytes)
    throw new SessionReviewError(
      "RESPONSE_TOO_LARGE",
      "Session review metadata exceeds maxBytes",
    );
  return result;

  function build(indices: Set<number>): NormalizedSession {
    const messages = all.filter((_, index) => indices.has(index));
    const base = {
      sessionID: input.session.id,
      mode: input.mode,
      messages,
      totalMessages: all.length,
      includedMessages: messages.length,
      omittedMessages: all.length - messages.length,
      retainedMessageIDs: messages.map((message) => message.id),
      truncated: messages.length < all.length,
    };
    return {
      ...base,
      ...(input.session.parentID === undefined
        ? {}
        : { parentID: input.session.parentID }),
      ...(input.session.title === undefined
        ? {}
        : { title: input.session.title }),
      ...(input.focus === undefined ? {} : { focus: input.focus }),
      ...(messages[0] === undefined
        ? {}
        : {
            firstMessageID: messages[0].id,
            lastMessageID: messages[messages.length - 1]?.id ?? messages[0].id,
          }),
    };
  }
}
