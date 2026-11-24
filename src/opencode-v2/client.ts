import { childReviewPermissions, hasChildReviewPermissions } from "./policy.js";
import { REVIEWER_AGENT } from "../cross-review/tool.js";
import { realpath } from "node:fs/promises";
import type { VerifyChildDestination } from "./destination.js";
import type {
  V2Event,
  V2Host,
  V2PermissionRule,
  V2Request,
  V2SessionInfo,
} from "./host.js";
import {
  hasCompactedHistory,
  toV1Messages,
  type V1SessionMessage,
} from "./messages.js";

export type V1Activity =
  | { type: "busy" }
  | { type: "retry"; attempt: number; message: string; next: number };

const IDLE_EVENTS = new Set([
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.idle",
  "session.deleted",
]);

function sessionIDOf(event: V2Event): string | undefined {
  const sessionID = event.data?.sessionID;
  return typeof sessionID === "string" ? sessionID : undefined;
}

function retryActivity(status: Record<string, unknown>): V1Activity {
  return {
    type: "retry",
    attempt: typeof status.attempt === "number" ? status.attempt : 1,
    message: typeof status.message === "string" ? status.message : "retrying",
    next: typeof status.next === "number" ? status.next : Date.now(),
  };
}

/**
 * The plugin context has no session status query. Child prompts stay busy or
 * retrying until a later execution, idle, or status event clears them.
 * Sessions already running when the plugin loaded are not backfilled.
 */
export function applySessionActivity(
  activity: Map<string, V1Activity>,
  event: V2Event,
): void {
  const sessionID = sessionIDOf(event);
  if (sessionID === undefined) return;
  if (event.type === "session.execution.started") {
    activity.set(sessionID, { type: "busy" });
    return;
  }
  if (event.type === "session.retry.scheduled") {
    const error = event.data?.error;
    const record =
      typeof error === "object" && error !== null
        ? (error as Record<string, unknown>)
        : {};
    activity.set(sessionID, {
      type: "retry",
      attempt: typeof event.data?.attempt === "number" ? event.data.attempt : 1,
      message: typeof record.message === "string" ? record.message : "retrying",
      next: typeof event.data?.at === "number" ? event.data.at : Date.now(),
    });
    return;
  }
  if (event.type === "session.status") {
    const status = event.data?.status;
    if (typeof status !== "object" || status === null) return;
    const record = status as Record<string, unknown>;
    if (record.type === "busy") {
      activity.set(sessionID, { type: "busy" });
      return;
    }
    if (record.type === "retry") {
      activity.set(sessionID, retryActivity(record));
      return;
    }
    if (record.type === "idle") activity.delete(sessionID);
    return;
  }
  if (IDLE_EVENTS.has(event.type)) activity.delete(sessionID);
}

type SdkSuccess<T> = {
  data: T;
  error?: undefined;
  response: { status: number };
};
type SdkFailure = {
  data?: undefined;
  error: { name: string; data: { message: string } };
  response: { status: number };
};
type SdkResult<T> = SdkSuccess<T> | SdkFailure;

export type V1PromptBody = {
  messageID?: string;
  agent?: string;
  model?: { providerID: string; modelID: string };
  parts?: Array<{ type: string; text?: string }>;
  tools?: Record<string, boolean>;
};

export type OpenCodeV2Client = {
  provider: {
    list(input: {
      query: { directory: string };
      signal?: AbortSignal;
    }): Promise<
      SdkResult<{
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
      SdkResult<{
        id: string;
        parentID?: string;
        title?: string;
        directory?: string;
        time?: { created: number; updated?: number };
      }>
    >;
    create(input: {
      body: { parentID: string; title: string };
      query: { directory: string };
      signal?: AbortSignal;
    }): Promise<SdkResult<{ id: string }>>;
    prompt(input: {
      body: V1PromptBody;
      path: { id: string };
      query: { directory: string };
      signal?: AbortSignal;
    }): Promise<
      SdkResult<{
        info?: V1SessionMessage["info"];
        parts: V1SessionMessage["parts"];
      }>
    >;
    promptAsync(input: {
      body: V1PromptBody;
      path: { id: string };
      query: { directory: string };
      signal?: AbortSignal;
    }): Promise<SdkResult<void>>;
    status(input: {
      query: { directory: string };
      signal?: AbortSignal;
    }): Promise<
      SdkResult<
        Record<
          string,
          | { type: "idle" }
          | { type: "busy" }
          | { type: "retry"; attempt: number; message: string; next: number }
        >
      >
    >;
    messages(input: {
      path: { id: string };
      query?: { directory?: string; limit?: number };
      signal?: AbortSignal;
    }): Promise<SdkResult<V1SessionMessage[]>>;
    completeMessages: OpenCodeV2Client["session"]["messages"];
    children(input: {
      path: { id: string };
      query?: { directory?: string };
      signal?: AbortSignal;
    }): Promise<SdkResult<V2SessionInfo[]>>;
    abort(input: {
      path: { id: string };
      query: { directory: string };
      signal?: AbortSignal;
    }): Promise<SdkResult<boolean>>;
    message(input: {
      path: { id: string; messageID: string };
      query: { directory: string };
      signal: AbortSignal;
    }): Promise<SdkResult<{ info: V1SessionMessage["info"] }>>;
  };
};

function request(signal: AbortSignal | undefined): V2Request | undefined {
  return signal === undefined ? undefined : { signal };
}

function errorText(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message;
  if (typeof error === "object" && error !== null) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.length > 0) return message;
  }
  if (typeof error === "string" && error.length > 0) return error;
  return "OpenCode V2 request failed";
}

function errorRecord(error: unknown): Record<string, unknown> | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  return error as Record<string, unknown>;
}

function errorStatus(error: unknown): number | undefined {
  const record = errorRecord(error);
  if (record === undefined) return undefined;
  if (typeof record.status === "number") return record.status;
  if (typeof record.statusCode === "number") return record.statusCode;
  return undefined;
}

function errorTag(error: unknown): string | undefined {
  const tag = errorRecord(error)?._tag;
  return typeof tag === "string" ? tag : undefined;
}

function sdkFailure(error: unknown): SdkFailure {
  const message = errorText(error);
  const tag = errorTag(error);
  const name = tag ?? (error instanceof Error ? error.name : "Error");
  const status = errorStatus(error);
  const notFound =
    status === 404 ||
    name === "NotFoundError" ||
    (tag?.endsWith("NotFoundError") ?? false) ||
    /not found/i.test(message);
  const denied =
    status === 403 ||
    tag === "ForbiddenError" ||
    /forbidden|access denied/i.test(message);
  const unauthorized =
    status === 401 ||
    tag === "UnauthorizedError" ||
    /unauthorized/i.test(message);
  const http = notFound
    ? 404
    : denied
      ? 403
      : unauthorized
        ? 401
        : (status ?? 500);
  return {
    error: {
      name: notFound ? "NotFoundError" : name,
      data: { message },
    },
    response: { status: http },
  };
}

function sdkOk<T>(data: T): SdkSuccess<T> {
  return { data, response: { status: 200 } };
}

async function attempt<T>(run: () => Promise<T>): Promise<SdkResult<T>> {
  try {
    return sdkOk(await run());
  } catch (error) {
    return sdkFailure(error);
  }
}

function promptText(body: V1PromptBody): string {
  return (body.parts ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n");
}

function applyLimit<T>(items: T[], limit: number | undefined): T[] {
  if (limit === undefined || items.length <= limit) return items;
  return items.slice(items.length - limit);
}

async function sameDirectory(
  actual: string | undefined,
  expected: string,
): Promise<boolean> {
  if (!actual) return false;
  if (actual === expected) return true;
  const [left, right] = await Promise.all(
    [actual, expected].map((path) => realpath(path).catch(() => undefined)),
  );
  return left !== undefined && left === right;
}

/** A host that silently trims inherited denies must not be accepted. */
function sameRules(
  actual: readonly V2PermissionRule[] | undefined,
  expected: readonly V2PermissionRule[],
) {
  return (
    actual?.length === expected.length &&
    expected.every((rule, index) => {
      const stored = actual[index];
      return (
        stored?.action === rule.action &&
        stored.resource === rule.resource &&
        stored.effect === rule.effect
      );
    })
  );
}

/**
 * V1-shaped client backed by the V2 session and model APIs.
 * `restricted` records tool names a child prompt turned off, so the context
 * hook can hide them from that session.
 */
export function createV1Client(
  host: V2Host,
  restricted: Map<string, ReadonlySet<string>>,
  activity: Map<string, V1Activity> = new Map(),
  verifyDestination?: VerifyChildDestination,
): OpenCodeV2Client {
  async function readMessages(
    sessionID: string,
    signal: AbortSignal | undefined,
    limit?: number,
    requireComplete = false,
  ): Promise<V1SessionMessage[]> {
    const messages = await host.session.context({ sessionID }, request(signal));
    if (requireComplete && hasCompactedHistory(messages)) {
      const error = new Error(
        `OpenCode V2 exposes only the context after compaction for session ${sessionID}; a complete session review is unavailable.`,
      );
      error.name = "SessionHistoryIncompleteError";
      throw error;
    }
    return applyLimit(toV1Messages(sessionID, messages), limit);
  }

  async function preparePrompt(
    sessionID: string,
    body: V1PromptBody,
    directory: string,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const options = request(signal);
    const denied = Object.entries(body.tools ?? {})
      .filter(([, allowed]) => allowed === false)
      .map(([name]) => name);
    if (denied.length > 0) {
      const persisted = await host.session.get({ sessionID }, options);
      if (
        persisted.id !== sessionID ||
        !hasChildReviewPermissions(persisted.permissions)
      )
        throw new Error(
          "OpenCode V2 child lacks persistent read-only permissions; refusing to dispatch",
        );
      // Do not resume or dispatch a child after it has moved out of the
      // verified location or after its destination plugin was removed.
      if (verifyDestination) {
        if (!(await sameDirectory(persisted.location?.directory, directory)))
          throw new Error(
            "OpenCode V2 child left its verified review directory; refusing to dispatch",
          );
      }
      restricted.set(sessionID, new Set(denied));
    }
    if (body.agent !== undefined && body.agent.length > 0)
      await host.session.switchAgent({ sessionID, agent: body.agent }, options);
    if (body.model !== undefined)
      await host.session.switchModel(
        {
          sessionID,
          model: { providerID: body.model.providerID, id: body.model.modelID },
        },
        options,
      );
    if (denied.length > 0)
      await verifyDestination?.(sessionID, directory, signal);
    signal?.throwIfAborted();
  }

  function sessionRecord(session: V2SessionInfo) {
    const directory = session.location?.directory;
    return {
      id: session.id,
      ...(session.parentID === undefined ? {} : { parentID: session.parentID }),
      ...(session.title === undefined ? {} : { title: session.title }),
      ...(directory === undefined || directory.length === 0
        ? {}
        : { directory }),
      ...(session.time === undefined ? {} : { time: session.time }),
    };
  }

  return {
    provider: {
      list(input) {
        return attempt(async () => {
          const listed = await host.model.list(request(input.signal));
          const models = new Map<string, Record<string, unknown>>();
          for (const model of listed.data) {
            if (model.enabled === false) continue;
            const bucket = models.get(model.providerID) ?? {};
            bucket[model.modelID] = { limit: model.limit };
            models.set(model.providerID, bucket);
          }
          return {
            all: [...models].map(([id, providerModels]) => ({
              id,
              models: providerModels,
            })),
            connected: [...models.keys()],
          };
        });
      },
    },
    session: {
      get(input) {
        return attempt(async () =>
          sessionRecord(
            await host.session.get(
              { sessionID: input.path.id },
              request(input.signal),
            ),
          ),
        );
      },
      create(input) {
        return attempt(async () => {
          const options = request(input.signal);
          const parent = await host.session.get(
            { sessionID: input.body.parentID },
            options,
          );
          if (parent.id !== input.body.parentID)
            throw new Error("OpenCode V2 returned a different parent session");
          const permissions = childReviewPermissions(parent.permissions ?? []);
          input.signal?.throwIfAborted();
          const created = await host.session.create(
            {
              parentID: input.body.parentID,
              permissions,
              agent: REVIEWER_AGENT,
              title: input.body.title,
            },
            request(input.signal),
          );
          // V2 always inherits the parent's location, even if create is given a
          // location. Move an idle, unprompted child, wait for the inbox handoff
          // and verify the binding before giving the child to the orchestrator.
          const sessionID = created.id;
          if (
            !sessionID ||
            sessionID === parent.id ||
            created.parentID !== parent.id
          )
            throw new Error(
              "OpenCode V2 did not return a new child of the requested parent",
            );
          try {
            input.signal?.throwIfAborted();
            if (!sameRules(created.permissions, permissions))
              throw new Error(
                "OpenCode V2 failed to persist read-only permissions on the new child",
              );
            if (
              !(await sameDirectory(
                created.location?.directory,
                input.query.directory,
              ))
            ) {
              if (host.location.workspaceID || created.location?.workspaceID)
                throw new Error(
                  "OpenCode V2 cannot preserve workspace identity when moving a child to a review snapshot",
                );
              input.signal?.throwIfAborted();
              await host.session.move(
                { sessionID, directory: input.query.directory },
                options,
              );
              await host.session.wait({ sessionID }, options);
              input.signal?.throwIfAborted();
              const bound = await host.session.get({ sessionID }, options);
              if (
                bound.id !== sessionID ||
                bound.parentID !== input.body.parentID ||
                !sameRules(bound.permissions, permissions) ||
                !(await sameDirectory(
                  bound.location?.directory,
                  input.query.directory,
                ))
              )
                throw new Error(
                  `OpenCode V2 could not bind child ${sessionID} to the requested review directory`,
                );
            }
            await verifyDestination?.(
              sessionID,
              input.query.directory,
              input.signal,
            );
          } catch (error) {
            // Nobody else has received this new child ID. Do not leave a failed
            // bind as an orphan, and never dispatch it in the parent's checkout.
            await host.session.remove({ sessionID }).catch(() => undefined);
            throw error;
          }
          return { id: created.id };
        });
      },
      async prompt(input) {
        return attempt(async () => {
          await preparePrompt(
            input.path.id,
            input.body,
            input.query.directory,
            input.signal,
          );
          const accepted = await host.session.prompt(
            {
              sessionID: input.path.id,
              ...(input.body.messageID === undefined
                ? {}
                : { id: input.body.messageID }),
              text: promptText(input.body),
              delivery: "queue",
            },
            request(input.signal),
          );
          await host.session.wait(
            { sessionID: input.path.id },
            request(input.signal),
          );
          const messages = await readMessages(input.path.id, input.signal);
          const assistant = [...messages]
            .reverse()
            .find(
              (message) =>
                message.info.role === "assistant" &&
                message.info.parentID === accepted.id,
            );
          return {
            ...(assistant === undefined ? {} : { info: assistant.info }),
            parts: assistant?.parts ?? [],
          };
        });
      },
      promptAsync(input) {
        return attempt(async () => {
          await preparePrompt(
            input.path.id,
            input.body,
            input.query.directory,
            input.signal,
          );
          await host.session.prompt(
            {
              sessionID: input.path.id,
              ...(input.body.messageID === undefined
                ? {}
                : { id: input.body.messageID }),
              text: promptText(input.body),
              delivery: "queue",
            },
            request(input.signal),
          );
        });
      },
      status() {
        return attempt(async () => ({ ...Object.fromEntries(activity) }));
      },
      messages(input) {
        return attempt(() =>
          readMessages(input.path.id, input.signal, input.query?.limit),
        );
      },
      completeMessages(input) {
        return attempt(() =>
          readMessages(input.path.id, input.signal, input.query?.limit, true),
        );
      },
      children(input) {
        return attempt(async () => {
          const sessions: V2SessionInfo[] = [];
          let cursor: string | undefined;
          for (let page = 0; page < 20; page += 1) {
            const listed = await host.session.list(
              {
                parentID: input.path.id,
                limit: 100,
                ...(input.query?.directory === undefined
                  ? {}
                  : { directory: input.query.directory }),
                ...(cursor === undefined ? {} : { cursor }),
              },
              request(input.signal),
            );
            sessions.push(...listed.data);
            const next = listed.cursor?.next;
            if (next == null || next.length === 0 || next === cursor) break;
            cursor = next;
          }
          return sessions;
        });
      },
      abort(input) {
        return attempt(async () => {
          const interrupted = await host.session.interrupt(
            { sessionID: input.path.id, resume: false },
            request(input.signal),
          );
          return interrupted.interrupted;
        });
      },
      message(input) {
        return attempt(async () => {
          const messages = await host.session.context(
            { sessionID: input.path.id },
            request(input.signal),
          );
          const found = toV1Messages(input.path.id, messages).find(
            (message) => message.info.id === input.path.messageID,
          );
          if (found === undefined) {
            const error = new Error(
              `Session message not found: ${input.path.messageID}`,
            );
            error.name = "NotFoundError";
            throw error;
          }
          return { info: found.info };
        });
      },
    },
  };
}
