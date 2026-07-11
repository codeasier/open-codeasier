import type { Message, Part, Session } from "@opencode-ai/sdk";
import { SessionReviewError } from "./errors.js";
import { normalizeSession } from "./normalize.js";
import type { NormalizedSession, ReviewLimits, ReviewMode } from "./schema.js";

export type SdkResult<T> = {
  data?: T;
  error?: { name: string; data: { message: string } };
  response: { status: number };
};
export type SessionClient = {
  session: {
    get(input: {
      path: { id: string };
      query?: { directory?: string };
    }): Promise<SdkResult<Session>>;
    messages(input: {
      path: { id: string };
      query?: { directory?: string; limit?: number };
    }): Promise<SdkResult<Array<{ info: Message; parts: Part[] }>>>;
  };
};

function failure(sessionID: string, result: SdkResult<unknown>) {
  if (result.response.status === 404 || result.error?.name === "NotFoundError")
    return new SessionReviewError(
      "SESSION_NOT_FOUND",
      `Session not found: ${sessionID}`,
    );
  if (result.response.status === 401 || result.response.status === 403)
    return new SessionReviewError(
      "SESSION_ACCESS_DENIED",
      `Access denied for session: ${sessionID}`,
    );
  return new SessionReviewError(
    "SDK_FAILURE",
    `OpenCode SDK failed while reading session: ${sessionID}`,
  );
}

export async function fetchSessionReviewInput(input: {
  client: SessionClient;
  sessionID: string;
  directory: string;
  mode: ReviewMode;
  focus?: string;
  limits?: Partial<ReviewLimits>;
}): Promise<NormalizedSession> {
  try {
    const session = await input.client.session.get({
      path: { id: input.sessionID },
      query: { directory: input.directory },
    });
    if (session.error !== undefined || session.data === undefined)
      throw failure(input.sessionID, session);
    const messages = await input.client.session.messages({
      path: { id: input.sessionID },
      query: { directory: input.directory },
    });
    if (messages.error !== undefined || messages.data === undefined)
      throw failure(input.sessionID, messages);
    if (messages.data.length === 0)
      throw new SessionReviewError(
        "SESSION_EMPTY",
        `Session has no messages: ${input.sessionID}`,
      );
    return normalizeSession({
      session: session.data,
      messages: messages.data,
      mode: input.mode,
      ...(input.focus === undefined ? {} : { focus: input.focus }),
      ...(input.limits === undefined ? {} : { limits: input.limits }),
    });
  } catch (error) {
    if (error instanceof SessionReviewError) throw error;
    throw new SessionReviewError(
      "SDK_FAILURE",
      `OpenCode SDK failed while reading session: ${input.sessionID}`,
    );
  }
}
