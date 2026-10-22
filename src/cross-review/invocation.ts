import { randomUUID } from "node:crypto";
import type { Hooks, ToolContext } from "@opencode-ai/plugin";
import {
  confirmationPlanKey,
  matchesStartQuestion,
  startConfirmation,
  START_CROSS_REVIEW,
  type CrossReviewConfirmation,
  type CrossReviewConfirmStart,
  type CrossReviewPrepareConfirmation,
} from "./confirmation.js";

export type CrossReviewInvocationCheck = (
  context: ToolContext,
  toolName: string,
) => Promise<void>;

type InvocationClient = {
  session: {
    message(input: {
      path: { id: string; messageID: string };
      query: { directory: string };
      signal: AbortSignal;
    }): Promise<{
      data?:
        | {
            info: {
              id: string;
              sessionID: string;
              role: string;
              parentID?: string;
            };
          }
        | undefined;
      error?: unknown;
    }>;
  };
};

const MARKER = "open-codeasier.cross-review-command";

type Confirmation = {
  prompt: CrossReviewConfirmation;
  planKey: string;
  status: "pending" | "approved" | "consumed";
  callID?: string;
};

type InvocationGrant = {
  userMessageID: string;
  confirmation?: Confirmation;
  declined?: boolean;
};

function isReviewArguments(args: string): boolean {
  const first = args.trim().split(/\s+/, 1)[0];
  return (
    first !== undefined && first !== "" && !["init", "setup"].includes(first)
  );
}

/** Only a whole, nonsynthetic user prompt is a literal command invocation. */
function isLiteralCommand(
  parts: Parameters<NonNullable<Hooks["chat.message"]>>[1]["parts"],
) {
  const text = parts
    .filter((part) => part.type === "text" && !part.synthetic && !part.ignored)
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("\n")
    .trim();
  const match = /^\/cross-review[\t ]+(\S[^\r\n]*)$/.exec(text);
  const args = match?.[1];
  return args !== undefined && isReviewArguments(args);
}

/**
 * Bind a real slash-command event to its admitted user message. A bare skill
 * load, quoted command, remembered permission, or old turn cannot mint a grant.
 * Grants are deliberately process-local: after a restart, reissue the command.
 */
export function createCrossReviewInvocationGuard(client: InvocationClient) {
  const pending = new Map<string, { token: string; review: boolean }>();
  const grants = new Map<string, InvocationGrant>();

  const command: NonNullable<Hooks["command.execute.before"]> = async (
    input,
    output,
  ) => {
    const token = randomUUID();
    pending.set(input.sessionID, {
      token,
      review:
        input.command === "cross-review" && isReviewArguments(input.arguments),
    });
    // OpenCode expands slash commands before chat.message; do not try to infer
    // invocation from the expanded template's prose. Preserve existing metadata.
    const part = output.parts.find((part) => part.type === "text");
    if (part?.type === "text") {
      part.metadata = { ...part.metadata, [MARKER]: token };
    }
  };

  const message: NonNullable<Hooks["chat.message"]> = async (input, output) => {
    const invocation = pending.get(input.sessionID);
    pending.delete(input.sessionID);
    grants.delete(input.sessionID);
    if (
      output.message.role !== "user" ||
      output.message.sessionID !== input.sessionID
    )
      return;
    const authorized =
      invocation === undefined
        ? isLiteralCommand(output.parts)
        : invocation.review &&
          output.parts.some(
            (part) =>
              part.type === "text" &&
              part.metadata?.[MARKER] === invocation.token,
          );
    if (authorized) {
      grants.set(input.sessionID, { userMessageID: output.message.id });
    }
  };

  const assertInvocation: CrossReviewInvocationCheck = async (
    context,
    toolName,
  ) => {
    const denied = () =>
      new Error(
        `${toolName} requires an explicit user /cross-review <target> command in the current turn; ordinary review requests, command mentions, setup, and permission approval do not authorize cross-review`,
      );
    const grant = grants.get(context.sessionID);
    if (grant === undefined) throw denied();
    if (context.abort.aborted) throw new Error("Cross-review cancelled");
    let result;
    try {
      result = await client.session.message({
        path: { id: context.sessionID, messageID: context.messageID },
        query: { directory: context.directory },
        signal: context.abort,
      });
    } catch (error) {
      if (context.abort.aborted) throw new Error("Cross-review cancelled");
      throw new Error("Cannot verify cross-review command provenance", {
        cause: error,
      });
    }
    if (context.abort.aborted) throw new Error("Cross-review cancelled");
    const info = result.data?.info;
    if (
      result.error !== undefined ||
      info?.role !== "assistant" ||
      info.id !== context.messageID ||
      info.sessionID !== context.sessionID ||
      info.parentID !== grant.userMessageID ||
      grants.get(context.sessionID) !== grant
    )
      throw denied();
  };

  const prepareConfirmation: CrossReviewPrepareConfirmation = async (
    context,
    plan,
  ) => {
    const grant = grants.get(context.sessionID);
    await assertInvocation(context, "cross_review_config");
    if (grant === undefined || grants.get(context.sessionID) !== grant) {
      throw new Error("Cross-review command invocation is no longer current");
    }
    if (grant.declined) {
      throw new Error(
        "Cross-review was declined; a new /cross-review command is required",
      );
    }
    const prompt = startConfirmation(plan, randomUUID());
    grant.confirmation = {
      prompt,
      planKey: confirmationPlanKey(plan),
      status: "pending",
    };
    return structuredClone(prompt);
  };

  const beforeTool: NonNullable<Hooks["tool.execute.before"]> = async (
    input,
    output,
  ) => {
    if (
      input.tool !== "question" ||
      typeof input.callID !== "string" ||
      input.callID.length === 0
    )
      return;
    const grant = grants.get(input.sessionID);
    const confirmation = grant?.confirmation;
    if (
      confirmation === undefined ||
      grant?.declined ||
      !matchesStartQuestion(output.args?.questions, confirmation.prompt)
    )
      return;
    confirmation.status = "pending";
    confirmation.callID = input.callID;
  };

  const afterTool: NonNullable<Hooks["tool.execute.after"]> = async (
    input,
    output,
  ) => {
    if (
      input.tool !== "question" ||
      typeof input.callID !== "string" ||
      input.callID.length === 0
    )
      return;
    const grant = grants.get(input.sessionID);
    const confirmation = grant?.confirmation;
    if (
      grant === undefined ||
      confirmation === undefined ||
      confirmation.callID === undefined ||
      confirmation.callID !== input.callID ||
      !matchesStartQuestion(input.args?.questions, confirmation.prompt)
    )
      return;
    delete confirmation.callID;
    const answers: unknown = output.metadata?.answers;
    if (
      Array.isArray(answers) &&
      answers.length === 1 &&
      Array.isArray(answers[0]) &&
      answers[0].length === 1 &&
      answers[0][0] === START_CROSS_REVIEW
    ) {
      confirmation.status = "approved";
    } else {
      confirmation.status = "pending";
      grant.declined = true;
    }
  };

  const confirmStart: CrossReviewConfirmStart = async (context, plan) => {
    const grant = grants.get(context.sessionID);
    await assertInvocation(context, "cross-review start confirmation");
    const confirmation = grant?.confirmation;
    if (
      confirmation !== undefined &&
      confirmation.planKey !== confirmationPlanKey(plan)
    ) {
      confirmation.status = "pending";
      delete confirmation.callID;
    }
    if (
      grant === undefined ||
      grants.get(context.sessionID) !== grant ||
      grant.declined ||
      confirmation?.status !== "approved" ||
      confirmation.planKey !== confirmationPlanKey(plan)
    ) {
      throw new Error(
        "Cross-review requires fresh explicit user confirmation before every start: preview this target with cross_review_config, ask its exact confirmation.questions using the question tool, and wait for Start cross-review. Permission approval alone is insufficient",
      );
    }
    // One actual user answer authorizes one start, including across entry points.
    confirmation.status = "consumed";
    return () => {
      if (context.abort.aborted) throw new Error("Cross-review cancelled");
      if (
        grants.get(context.sessionID) !== grant ||
        grant.confirmation !== confirmation ||
        grant.declined ||
        confirmation.status !== "consumed"
      ) {
        throw new Error("Cross-review start confirmation is no longer current");
      }
    };
  };

  const event: NonNullable<Hooks["event"]> = async ({ event }) => {
    if (event.type !== "session.deleted") return;
    pending.delete(event.properties.info.id);
    grants.delete(event.properties.info.id);
  };

  return {
    assertInvocation,
    prepareConfirmation,
    confirmStart,
    "command.execute.before": command,
    "chat.message": message,
    "tool.execute.before": beforeTool,
    "tool.execute.after": afterTool,
    event,
  };
}
