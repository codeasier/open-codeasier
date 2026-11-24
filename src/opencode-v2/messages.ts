import type {
  V2SessionMessage,
  V2StructuredError,
  V2ToolContent,
} from "./host.js";

export type V1Part = {
  type: string;
  text?: string;
  tool?: string;
  mime?: string;
  filename?: string;
  state?: {
    status: string;
    input?: unknown;
    output?: string;
    error?: string;
  };
  time?: { start?: number; end?: number };
};

export type V1SessionMessage = {
  info: {
    id: string;
    sessionID: string;
    role: "user" | "assistant";
    parentID?: string;
    time: { created: number; completed?: number };
    finish?: string;
    error?: { name: string; message?: string };
  };
  parts: V1Part[];
};

function errorName(error: V2StructuredError): string {
  const type = error.type ?? "";
  const message = error.message ?? "";
  if (/abort/i.test(type) || /abort/i.test(message))
    return "MessageAbortedError";
  return type.length > 0 ? type : "MessageError";
}

function toolOutput(content: V2ToolContent[] | undefined): string {
  return (content ?? [])
    .filter((item) => item.type === "text")
    .map((item) => item.text ?? "")
    .join("\n");
}

function assistantParts(message: V2SessionMessage): V1Part[] {
  return (message.content ?? []).flatMap((part): V1Part[] => {
    if (part.type === "text" || part.type === "reasoning")
      return [{ type: part.type, text: part.text ?? "" }];
    if (part.type !== "tool") return [];
    const state = part.state;
    const status = state?.status ?? "unknown";
    const time =
      part.time?.created === undefined
        ? undefined
        : {
            start: part.time.created,
            ...(part.time.completed === undefined
              ? {}
              : { end: part.time.completed }),
          };
    const base = {
      type: "tool",
      tool: part.name ?? "unknown",
      ...(time === undefined ? {} : { time }),
    };
    const input = state?.input === undefined ? {} : { input: state.input };
    if (status === "completed")
      return [
        {
          ...base,
          state: {
            status,
            ...input,
            output: toolOutput(
              state !== undefined && "content" in state
                ? state.content
                : undefined,
            ),
          },
        },
      ];
    if (status === "error") {
      const error =
        state !== undefined && "error" in state ? state.error : undefined;
      return [
        {
          ...base,
          state: {
            status,
            ...input,
            error: error?.message ?? error?.type ?? "tool failed",
          },
        },
      ];
    }
    return [{ ...base, state: { status, ...input } }];
  });
}

function userParts(message: V2SessionMessage): V1Part[] {
  const parts: V1Part[] = [{ type: "text", text: message.text ?? "" }];
  for (const file of message.files ?? []) {
    parts.push({
      type: "file",
      mime: file.mime ?? "application/octet-stream",
      ...(typeof file.name === "string" && file.name.length > 0
        ? { filename: file.name }
        : {}),
    });
  }
  return parts;
}

/** Map a V2 session transcript onto the V1 `{ info, parts }` messages the tools already read. */
export function toV1Messages(
  sessionID: string,
  messages: readonly V2SessionMessage[],
): V1SessionMessage[] {
  const mapped: V1SessionMessage[] = [];
  let parentID: string | undefined;
  for (const message of messages) {
    if (message.type !== "user" && message.type !== "assistant") continue;
    const id = message.id ?? "";
    if (message.type === "user") {
      mapped.push({
        info: {
          id,
          sessionID,
          role: "user",
          time: { created: message.time?.created ?? 0 },
        },
        parts: userParts(message),
      });
      if (id.length > 0) parentID = id;
      continue;
    }
    const error = message.error;
    mapped.push({
      info: {
        id,
        sessionID,
        role: "assistant",
        ...(parentID === undefined ? {} : { parentID }),
        time: {
          created: message.time?.created ?? 0,
          ...(message.time?.completed === undefined
            ? {}
            : { completed: message.time.completed }),
        },
        ...(message.finish === undefined ? {} : { finish: message.finish }),
        ...(error === undefined
          ? {}
          : {
              error: {
                name: errorName(error),
                ...(typeof error.message === "string"
                  ? { message: error.message }
                  : {}),
              },
            }),
      },
      parts: assistantParts(message),
    });
  }
  return mapped;
}
