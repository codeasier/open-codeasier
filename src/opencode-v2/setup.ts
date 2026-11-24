import { randomUUID } from "node:crypto";
import { tool } from "@opencode-ai/plugin";
import type { Event, Part, UserMessage } from "@opencode-ai/sdk";
import type { ZodRawShape } from "zod";
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
import { createChildDestinationVerifier } from "./destination.js";
import type { V2Host, V2ToolExecuteContext } from "./host.js";

import {
  withAskDefaults,
  filterReviewTools,
  assertReviewTool,
} from "./policy.js";

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
  signal.throwIfAborted();
  const session = await host.session.get({ sessionID }, { signal });
  signal.throwIfAborted();
  const directory = session.location?.directory;
  if (
    session.id !== sessionID ||
    typeof directory !== "string" ||
    !directory.trim()
  )
    throw new Error("Cannot verify the current OpenCode V2 session directory");
  return directory;
}

/**
 * OpenCode V2 entry. V1 keeps calling `server()`; V2 calls `setup(ctx)` and
 * ignores `server`. The tool implementations stay on the V1 client shape.
 */
export async function setup(ctx: V2Host): Promise<() => Promise<void>> {
  const restricted = new Map<string, ReadonlySet<string>>();
  const activity = new Map<string, V1Activity>();
  const destination = createChildDestinationVerifier(ctx);
  const client = createV1Client(
    ctx,
    restricted,
    activity,
    destination.verifyDestination,
  );
  const store = new FileCrossReviewRunStore();
  await store.cleanupExpiredRuns().catch(() => undefined);
  const commands = new Map<
    string,
    { sessionID: string; args: string; receipt: Promise<boolean> }
  >();
  const guard = createCrossReviewInvocationGuard(client, (sessionID, id) => {
    const command = commands.get(id);
    if (command?.sessionID !== sessionID) return undefined;
    commands.delete(id);
    return command;
  });
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
    filterReviewTools(
      event.agent,
      restricted.get(event.sessionID),
      event.tools,
    );
  });

  await ctx.agent.transform((editor) => {
    for (const agent of editor.list()) {
      editor.update(agent.id, (draft) => {
        draft.permissions = withAskDefaults(draft.permissions ?? []);
      });
    }
  });

  await ctx.tool.hook("execute.before", async (event) => {
    assertReviewTool(
      event.agent,
      restricted.get(event.sessionID),
      event.tool,
      event.info?.name,
    );
    await guard["tool.execute.before"](
      { tool: event.tool, callID: event.id, sessionID: event.sessionID },
      { args: asQuestionArgs(event.input) },
    );
  });
  await ctx.tool.hook("execute.after", async (event) => {
    if (event.status !== "completed" && event.status !== "error") return;
    await guard["tool.execute.after"](
      {
        tool: event.tool,
        callID: event.id,
        sessionID: event.sessionID,
        args: asQuestionArgs(event.input),
      },
      {
        title: "",
        output: "",
        // A dismissed/failed matching question has no affirmative answer.
        metadata:
          event.status === "completed" ? (event.result?.metadata ?? {}) : {},
      },
    );
  });

  await ctx.session.hook("prompt", async (event) => {
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

  // V2 Markdown commands submit expanded text, with no command-executed
  // event. Register the command itself and bind it to the exact admission.
  // Never treat prompt metadata or a copied expansion as command provenance.
  await ctx.command.transform((editor) => {
    editor.add({
      name: "cross-review",
      description: "Configure or run independent cross-reviews",
      async execute({ sessionID, prompt, delivery }) {
        const id = `msg_${randomUUID()}`;
        let settle!: (accepted: boolean) => void;
        const receipt = new Promise<boolean>((resolve) => {
          settle = resolve;
        });
        commands.set(id, { sessionID, args: prompt.text, receipt });
        let admitted = false;
        try {
          const admission = await ctx.session.prompt({
            ...prompt,
            id,
            sessionID,
            delivery,
            // Keep attachment/agent mention offsets within the original text.
            text: `${prompt.text}\n\nThe user invoked /cross-review with the arguments above. Load the cross-review skill and follow it.`,
          });
          if (admission.id !== id)
            throw new Error(
              "OpenCode V2 returned an unexpected command admission ID",
            );
          admitted = true;
        } finally {
          settle(admitted);
          commands.delete(id);
        }
      },
    });
    editor.add(destination.command);
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
          // One event must not stop later activity or deletion notices.
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
