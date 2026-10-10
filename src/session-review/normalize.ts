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
type OnTruncate = () => void;
const ignoreTruncation = () => {};

// Inspect at most maxBytes UTF-8 bytes, without splitting a surrogate pair or
// repeatedly encoding the entire (potentially very large) remaining string.
function prefixEnd(value: string, maxBytes: number): number {
  let bytes = 0;
  let end = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character);
    if (bytes + size > maxBytes) break;
    bytes += size;
    end += character.length;
  }
  return end;
}

function truncate(
  value: string,
  maxBytes: number,
  onTruncate: OnTruncate = ignoreTruncation,
) {
  const end = prefixEnd(value, maxBytes);
  if (end === value.length) return value;
  onTruncate();
  // Tiny budgets must still be respected, even if the full marker cannot fit.
  const marker = MARKER.slice(0, maxBytes);
  return value.slice(0, prefixEnd(value, maxBytes - marker.length)) + marker;
}

const INPUT_LIMITS = { depth: 6, keys: 100, stringBytes: 4_000, bytes: 20_000 };
function sanitizeInput(value: unknown, onTruncate: OnTruncate): unknown {
  let nodes = 0;
  const omitted = (reason: string) => {
    onTruncate();
    return reason;
  };
  const seen = new Set<object>();
  const visit = (item: unknown, depth: number): unknown => {
    if (++nodes > INPUT_LIMITS.keys) return omitted("[node-limit]");
    if (typeof item === "string")
      return truncate(item, INPUT_LIMITS.stringBytes, onTruncate);
    if (item === null || typeof item === "boolean" || typeof item === "number")
      return item;
    if (item === undefined) return "[undefined]";
    if (depth >= INPUT_LIMITS.depth) return omitted("[depth-limit]");
    if (typeof item !== "object") return omitted(`[${typeof item}]`);
    if (seen.has(item)) return omitted("[circular]");
    seen.add(item);
    if (Array.isArray(item)) {
      const result: unknown[] = [];
      for (const child of item) {
        if (nodes >= INPUT_LIMITS.keys) {
          result.push(omitted("[node-limit]"));
          break;
        }
        result.push(visit(child, depth + 1));
      }
      return result;
    }
    const result: Record<string, unknown> = Object.create(null);
    // Retain only a bounded set of keys for sorting and traversal. The SDK
    // has already materialized the raw object before normalization.
    const keys: string[] = [];
    for (const key in item) {
      if (!Object.prototype.hasOwnProperty.call(item, key)) continue;
      keys.push(key);
      if (keys.length > INPUT_LIMITS.keys) break;
    }
    for (const key of keys.sort()) {
      if (nodes >= INPUT_LIMITS.keys) {
        result["[omitted]"] = omitted("node-limit");
        break;
      }
      result[truncate(key, 200, onTruncate)] = visit(
        (item as Record<string, unknown>)[key],
        depth + 1,
      );
    }
    return result;
  };
  const result = visit(value, 0);
  const json = JSON.stringify(result) ?? `[${typeof value}]`;
  if (Buffer.byteLength(json) <= INPUT_LIMITS.bytes) return result;
  onTruncate();
  return { truncated: true, preview: truncate(json, INPUT_LIMITS.bytes - 40) };
}

function normalizePart(
  part: Part,
  maxPartBytes: number,
  onTruncate: OnTruncate,
): ReviewPart {
  if (part.type === "text" || part.type === "reasoning")
    return {
      type: part.type,
      text: truncate(part.text, maxPartBytes, onTruncate),
    };
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
      return { ...base, input: sanitizeInput(state.input, onTruncate) };
    if (state.status === "completed")
      return {
        ...base,
        input: sanitizeInput(state.input, onTruncate),
        output: truncate(state.output, maxPartBytes, onTruncate),
      };
    return {
      ...base,
      input: sanitizeInput(state.input, onTruncate),
      error: truncate(state.error, maxPartBytes, onTruncate),
    };
  }
  return {
    type: "unknown",
    sourceType: String((part as { type?: unknown }).type ?? "unknown"),
  };
}

export function toReviewMessage(
  message: NormalizeInput["messages"][number],
  maxPartBytes: number,
  onTruncate: OnTruncate = ignoreTruncation,
): ReviewMessage | undefined {
  if (message.info.role !== "user" && message.info.role !== "assistant")
    return undefined;
  const createdAt = message.info.time?.created;
  const result: ReviewMessage = {
    id: message.info.id,
    role: message.info.role,
    parts: message.parts.map((part) =>
      normalizePart(part, maxPartBytes, onTruncate),
    ),
  };
  return createdAt === undefined ? result : { ...result, createdAt };
}

export function normalizeSession(input: NormalizeInput): NormalizedSession {
  const limits = { ...DEFAULT_LIMITS, ...input.limits };
  for (const value of Object.values(limits)) {
    if (!Number.isSafeInteger(value) || value < 0)
      throw new RangeError("Review limits must be non-negative safe integers");
  }
  const all = input.messages.filter(
    (message) =>
      message.info.role === "user" || message.info.role === "assistant",
  );
  const retained = new Map<number, ReviewMessage>();
  const clipped = new Set<number>();
  const order =
    input.mode === "troubleshoot"
      ? all.map((_, index) => index).reverse()
      : Array.from({ length: all.length }, (_, step) =>
          step % 2 === 0 ? step / 2 : all.length - 1 - (step - 1) / 2,
        );
  const selected = new Set<number>();
  for (const index of order) {
    if (selected.size >= limits.maxMessages) break;
    const raw = all[index];
    if (raw === undefined) continue;
    const message = toReviewMessage(raw, limits.maxPartBytes, () =>
      clipped.add(index),
    );
    if (message === undefined) continue;
    retained.set(index, message);
    selected.add(index);
    const candidate = build(selected);
    if (Buffer.byteLength(JSON.stringify(candidate)) > limits.maxBytes) {
      selected.delete(index);
      retained.delete(index);
      clipped.delete(index);
    }
  }
  const result = build(selected);
  if (Buffer.byteLength(JSON.stringify(result)) > limits.maxBytes)
    throw new SessionReviewError(
      "RESPONSE_TOO_LARGE",
      "Session review metadata exceeds maxBytes",
    );
  return result;

  function build(indices: Set<number>): NormalizedSession {
    const ordered = [...indices].sort((a, b) => a - b);
    const messages = ordered
      .map((index) => retained.get(index))
      .filter((message): message is ReviewMessage => message !== undefined);
    const base = {
      sessionID: input.session.id,
      mode: input.mode,
      messages,
      totalMessages: all.length,
      includedMessages: messages.length,
      omittedMessages: all.length - messages.length,
      retainedMessageIDs: messages.map((message) => message.id),
      truncated:
        messages.length < all.length ||
        ordered.some((index) => clipped.has(index)),
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
