import { tool } from "@opencode-ai/plugin";
import type { Event, Part, UserMessage } from "@opencode-ai/sdk";
import type { ZodRawShape } from "zod";
import { CROSS_REVIEW_START_PERMISSIONS } from "../cross-review/authorization.js";
import { createCrossReviewInvocationGuard } from "../cross-review/invocation.js";
import { FileCrossReviewRunStore } from "../cross-review/run-store.js";
import {
  createOpenCodeasierTools,
  type RuntimeClient,
} from "../plugin-tools.js";
import {
  applySessionActivity,
  createV1Client,
  type V1Activity,
} from "./client.js";
import type {
  V2Host,
  V2PermissionRule,
  V2PromptEvent,
  V2ToolExecuteContext,
} from "./host.js";

const START_PERMISSIONS = new Set<string>(CROSS_REVIEW_START_PERMISSIONS);

type V1Tool = {
  description: string;
  args: ZodRawShape;
  execute(
    args: Record<string, unknown>,
    context: {
      sessionID: string;
      messageID: string;
      agent: string;
      directory: string;
      worktree: string;
      abort: AbortSignal;
      metadata(input: {
        title?: string;
        metadata?: Record<string, unknown>;
      }): void;
      ask(input: {
        permission: string;
        patterns: string[];
        always: string[];
        metadata: Record<string, unknown>;
      }): Promise<void>;
    },
  ): Promise<
    | string
    | {
        title?: string;
        output: string;
        metadata?: Record<string, unknown>;
      }
  >;
};

function jsonSchema(args: ZodRawShape): Record<string, unknown> {
  const schema = tool.schema.toJSONSchema(tool.schema.object(args)) as {
    properties?: unknown;
    required?: unknown;
  };
  return {
    type: "object",
    properties:
      schema.properties !== undefined && typeof schema.properties === "object"
        ? schema.properties
        : {},
    ...(Array.isArray(schema.required) ? { required: schema.required } : {}),
    additionalProperties: false,
  };
}

function toolResult(
  result:
    | string
    | { title?: string; output: string; metadata?: Record<string, unknown> },
): { content: string; metadata?: Record<string, unknown> } {
  if (typeof result === "string") return { content: result };
  const metadata = {
    ...(result.title === undefined ? {} : { title: result.title }),
    ...(result.metadata ?? {}),
  };
  return Object.keys(metadata).length === 0
    ? { content: result.output }
    : { content: result.output, metadata };
}

async function directoryFor(
  host: V2Host,
  sessionID: string,
  signal: AbortSignal,
): Promise<string> {
  try {
    const session = await host.session.get({ sessionID }, { signal });
    const directory = session.location?.directory;
    if (typeof directory === "string" && directory.length > 0) return directory;
  } catch {
    // Fall back to the plugin instance directory when the session has no location.
  }
  return host.location.directory;
}

function withAskDefaults(
  permissions: readonly V2PermissionRule[],
): V2PermissionRule[] {
  const rest = permissions.filter(
    (rule) =>
      !(
        START_PERMISSIONS.has(rule.action) &&
        rule.resource === "*" &&
        rule.effect === "ask"
      ),
  );
  return [
    ...CROSS_REVIEW_START_PERMISSIONS.map(
      (action) => ({ action, resource: "*", effect: "ask" }) as const,
    ),
    ...rest,
  ];
}

function commandArguments(event: V2PromptEvent): string | undefined {
  const metadata = event.metadata;
  const named = metadata?.command;
  if (named === "cross-review" && typeof metadata?.arguments === "string")
    return metadata.arguments;
  const text = event.prompt.text?.trim() ?? "";
  const match = /^\/cross-review[\t ]+(\S[^\r\n]*)$/.exec(text);
  return match?.[1];
}

/**
 * OpenCode V2 entry. V1 keeps calling `server()`; V2 calls `setup(ctx)` and
 * ignores `server`. The tool implementations stay on the V1 client shape.
 */
export async function setup(ctx: V2Host): Promise<() => Promise<void>> {
  const restricted = new Map<string, ReadonlySet<string>>();
  const activity = new Map<string, V1Activity>();
  const client = createV1Client(ctx, restricted, activity);
  const store = new FileCrossReviewRunStore();
  await store.cleanupExpiredRuns().catch(() => undefined);
  const guard = createCrossReviewInvocationGuard(client);
  // The adapter implements the methods the tools call. Their declared return
  // values still name the full V1 SDK Session, which this client does not build.
  const tools = createOpenCodeasierTools(client as unknown as RuntimeClient, {
    store,
    assertInvocation: guard.assertInvocation,
    prepareConfirmation: guard.prepareConfirmation,
    confirmStart: guard.confirmStart,
  });

  await ctx.tool.transform((editor) => {
    for (const [name, definition] of Object.entries(tools) as unknown as Array<
      [string, V1Tool]
    >) {
      const args = definition.args;
      editor.add({
        name,
        description: definition.description,
        input: jsonSchema(args),
        async execute(input, context) {
          const directory = await directoryFor(
            ctx,
            context.sessionID,
            context.signal,
          );
          const parsed = tool.schema.object(args).parse(input);
          const result = await definition.execute(
            parsed,
            v1Context(ctx, context, directory),
          );
          return toolResult(result);
        },
      });
    }
  });

  await ctx.session.hook("context", (event) => {
    const denied = restricted.get(event.sessionID);
    if (denied === undefined) return;
    for (const name of denied) Reflect.deleteProperty(event.tools, name);
  });

  await ctx.agent.transform((editor) => {
    for (const agent of editor.list()) {
      editor.update(agent.id, (draft) => {
        draft.permissions = withAskDefaults(draft.permissions ?? []);
      });
    }
  });

  await ctx.tool.hook("execute.before", async (event) => {
    await guard["tool.execute.before"](
      { tool: event.tool, callID: event.id, sessionID: event.sessionID },
      { args: asQuestionArgs(event.input) },
    );
  });
  await ctx.tool.hook("execute.after", async (event) => {
    if (event.status !== "completed") return;
    await guard["tool.execute.after"](
      {
        tool: event.tool,
        callID: event.id,
        sessionID: event.sessionID,
        args: asQuestionArgs(event.input),
      },
      { title: "", output: "", metadata: event.result?.metadata ?? {} },
    );
  });

  await ctx.session.hook("prompt", async (event) => {
    const args = commandArguments(event);
    if (args !== undefined) {
      await admitCommand(guard, event.sessionID, event.messageID, args);
      return;
    }
    await guard["chat.message"](
      { sessionID: event.sessionID },
      {
        message: userMessage(event.sessionID, event.messageID),
        parts: textParts(
          event.sessionID,
          event.messageID,
          event.prompt.text ?? "",
        ),
      },
    );
  });

  const controller = new AbortController();
  const events = listen(ctx, controller.signal, async (event) => {
    applySessionActivity(activity, event);
    if (event.type === "session.deleted") {
      const id = event.data?.sessionID;
      if (typeof id !== "string") return;
      restricted.delete(id);
      await guard.event({
        event: {
          type: "session.deleted",
          properties: { info: { id } },
        } as Event,
      });
      return;
    }
    if (event.type !== "command.executed") return;
    const name = event.data?.name;
    const sessionID = event.data?.sessionID;
    const messageID = event.data?.messageID;
    const args = event.data?.arguments;
    if (
      name !== "cross-review" ||
      typeof sessionID !== "string" ||
      typeof messageID !== "string" ||
      typeof args !== "string"
    )
      return;
    await admitCommand(guard, sessionID, messageID, args);
  });

  return async () => {
    controller.abort();
    await events;
  };
}

function v1Context(
  host: V2Host,
  context: V2ToolExecuteContext,
  directory: string,
) {
  return {
    sessionID: context.sessionID,
    messageID: context.messageID,
    agent: context.agent,
    directory,
    worktree: directory,
    abort: context.signal,
    metadata(input: { title?: string; metadata?: Record<string, unknown> }) {
      void context.progress({
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.metadata ?? {}),
      });
    },
    ask(input: {
      permission: string;
      patterns: string[];
      always: string[];
      metadata: Record<string, unknown>;
    }) {
      return host.permission.assert({
        sessionID: context.sessionID,
        agent: context.agent,
        action: input.permission,
        resources: input.patterns,
        ...(input.always.length === 0 ? {} : { save: input.always }),
        metadata: input.metadata,
        source: {
          type: "tool",
          messageID: context.messageID,
          id: context.id,
        },
      });
    },
  };
}

function textParts(sessionID: string, messageID: string, text: string): Part[] {
  return [
    {
      id: "part",
      sessionID,
      messageID,
      type: "text",
      text,
    },
  ];
}

function userMessage(sessionID: string, messageID: string): UserMessage {
  return {
    id: messageID,
    sessionID,
    role: "user",
    time: { created: 0 },
    agent: "build",
    model: { providerID: "opencode", modelID: "v2" },
  };
}

async function admitCommand(
  guard: ReturnType<typeof createCrossReviewInvocationGuard>,
  sessionID: string,
  messageID: string,
  args: string,
) {
  const parts = textParts(sessionID, messageID, `/cross-review ${args}`);
  await guard["command.execute.before"](
    { sessionID, command: "cross-review", arguments: args },
    { parts },
  );
  await guard["chat.message"](
    { sessionID },
    { message: userMessage(sessionID, messageID), parts },
  );
}

function asQuestionArgs(input: unknown): { questions?: unknown } {
  if (typeof input !== "object" || input === null) return {};
  return input as { questions?: unknown };
}

function listen(
  ctx: V2Host,
  signal: AbortSignal,
  onEvent: (event: {
    type: string;
    data?: Record<string, unknown>;
  }) => Promise<void>,
): Promise<void> {
  return (async () => {
    try {
      for await (const event of ctx.event.subscribe({ signal })) {
        try {
          await onEvent(event);
        } catch {
          // One event must not stop later command or deletion notices.
        }
      }
    } catch (error) {
      if (!signal.aborted)
        throw new Error("OpenCode V2 event subscription failed", {
          cause: error,
        });
    }
  })();
}
