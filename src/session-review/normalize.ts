import type { Part } from "@opencode-ai/sdk";
import { DEFAULT_LIMITS } from "./schema.js";
import type {
  NormalizeInput,
  NormalizedSession,
  ReviewMessage,
  ReviewPart,
} from "./schema.js";

const MARKER = "\n...[truncated]";
function truncate(value: string, maxBytes: number) {
  if (Buffer.byteLength(value) <= maxBytes) return value;
  let result = value;
  while (Buffer.byteLength(result + MARKER) > maxBytes && result.length)
    result = result.slice(0, -1);
  return result + MARKER;
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
      return { ...base, input: state.input };
    if (state.status === "completed")
      return {
        ...base,
        input: state.input,
        output: truncate(state.output, maxPartBytes),
      };
    return {
      ...base,
      input: state.input,
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
  let bytes = 2;
  for (const index of order) {
    if (selected.size >= limits.maxMessages) break;
    const size =
      Buffer.byteLength(JSON.stringify(all[index])) + (selected.size ? 1 : 0);
    if (bytes + size > limits.maxBytes) continue;
    selected.add(index);
    bytes += size;
  }
  const messages = all.filter((_, index) => selected.has(index));
  const base = {
    sessionID: input.session.id,
    mode: input.mode,
    messages,
    totalMessages: all.length,
    includedMessages: messages.length,
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
