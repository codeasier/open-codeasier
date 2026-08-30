export type SessionInspectionResult = {
  data?: { parentID?: string };
  error?: unknown;
};

export type SessionInspectionClient = {
  session: {
    get(input: {
      path: { id: string };
      query?: { directory?: string };
      signal?: AbortSignal;
    }): Promise<SessionInspectionResult>;
  };
};

function causeMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (typeof error === "object" && error !== null) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
    const nested = (error as { data?: { message?: unknown } }).data?.message;
    if (typeof nested === "string") return nested;
  }
  return String(error);
}

async function inspectCaller(
  client: SessionInspectionClient,
  context: { sessionID: string; directory: string },
  signal?: AbortSignal,
): Promise<{ parentID?: string }> {
  let result: SessionInspectionResult;
  try {
    result = await client.session.get({
      path: { id: context.sessionID },
      query: { directory: context.directory },
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (error) {
    throw new Error(`Session inspection failed: ${causeMessage(error)}`);
  }
  if (result.error !== undefined || result.data === undefined) {
    const cause =
      result.error === undefined ? undefined : causeMessage(result.error);
    throw new Error(
      cause === undefined
        ? "Session inspection failed"
        : `Session inspection failed: ${cause}`,
    );
  }
  return result.data;
}

export async function assertPrimarySession(
  client: SessionInspectionClient,
  context: { sessionID: string; directory: string },
  toolName: string,
  signal?: AbortSignal,
): Promise<void> {
  if (typeof client.session.get !== "function") {
    throw new Error(
      `${toolName} can only be invoked from primary sessions: session inspection is unavailable`,
    );
  }
  const caller = await inspectCaller(client, context, signal);
  if (caller.parentID !== undefined) {
    throw new Error(`${toolName} can only be invoked from primary sessions`);
  }
}
