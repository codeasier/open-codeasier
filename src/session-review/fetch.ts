import type { Message, Part, Session } from "@opencode-ai/sdk";
import { SessionReviewError } from "./errors.js";
import { normalizeSession } from "./normalize.js";
import type { NormalizedSession, ReviewLimits, ReviewMode } from "./schema.js";

// The pinned SDK supports a count limit, but no cursor or total count. Fetch a
// sentinel and reject oversized sessions rather than present a tail as complete.
// This cannot bound response bytes: even one SDK message may be arbitrarily large.
export const MAX_FETCH_MESSAGES = 10_000;

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
      signal?: AbortSignal;
    }): Promise<SdkResult<Session>>;
    messages(input: {
      path: { id: string };
      query?: { directory?: string; limit?: number };
      signal?: AbortSignal;
    }): Promise<SdkResult<Array<{ info: Message; parts: Part[] }>>>;
    children?(input: {
      path: { id: string };
      query?: { directory?: string };
      signal?: AbortSignal;
    }): Promise<SdkResult<Session[]>>;
  };
};

export type SessionBundle = {
  session: Session;
  messages: Array<{ info: Message; parts: Part[] }>;
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

export async function fetchSessionBundle(input: {
  client: SessionClient;
  sessionID: string;
  directory: string;
  signal?: AbortSignal;
}): Promise<SessionBundle> {
  input.signal?.throwIfAborted();
  try {
    const session = await input.client.session.get({
      path: { id: input.sessionID },
      query: { directory: input.directory },
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    input.signal?.throwIfAborted();
    if (session.error !== undefined || session.data === undefined)
      throw failure(input.sessionID, session);
    const messages = await input.client.session.messages({
      path: { id: input.sessionID },
      query: { directory: input.directory, limit: MAX_FETCH_MESSAGES + 1 },
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    input.signal?.throwIfAborted();
    if (messages.error !== undefined || messages.data === undefined)
      throw failure(input.sessionID, messages);
    if (messages.data.length > MAX_FETCH_MESSAGES)
      throw new SessionReviewError(
        "RESPONSE_TOO_LARGE",
        `Session exceeds the ${MAX_FETCH_MESSAGES}-message input limit`,
      );
    return { session: session.data, messages: messages.data };
  } catch (error) {
    input.signal?.throwIfAborted();
    if (error instanceof SessionReviewError) throw error;
    throw new SessionReviewError(
      "SDK_FAILURE",
      `OpenCode SDK failed while reading session: ${input.sessionID}`,
    );
  }
}

export async function listSessionChildren(input: {
  client: SessionClient;
  sessionID: string;
  directory: string;
  signal?: AbortSignal;
}): Promise<{ listed: true; children: Session[] } | { listed: false }> {
  if (typeof input.client.session.children !== "function")
    return { listed: false };
  input.signal?.throwIfAborted();
  try {
    const result = await input.client.session.children({
      path: { id: input.sessionID },
      query: { directory: input.directory },
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    input.signal?.throwIfAborted();
    if (result.error !== undefined || result.data === undefined)
      return { listed: false };
    return { listed: true, children: result.data };
  } catch {
    input.signal?.throwIfAborted();
    return { listed: false };
  }
}

export async function fetchSessionReviewInput(input: {
  client: SessionClient;
  sessionID: string;
  directory: string;
  signal?: AbortSignal;
  mode: ReviewMode;
  focus?: string;
  limits?: Partial<ReviewLimits>;
}): Promise<NormalizedSession> {
  const bundle = await fetchSessionBundle({
    client: input.client,
    sessionID: input.sessionID,
    directory: input.directory,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  if (bundle.messages.length === 0)
    throw new SessionReviewError(
      "SESSION_EMPTY",
      `Session has no messages: ${input.sessionID}`,
    );
  return normalizeSession({
    session: bundle.session,
    messages: bundle.messages,
    mode: input.mode,
    ...(input.focus === undefined ? {} : { focus: input.focus }),
    ...(input.limits === undefined ? {} : { limits: input.limits }),
  });
}
