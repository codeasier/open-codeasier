import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { REVIEWER_AGENT } from "../cross-review/tool.js";
import type { V2CommandDefinition, V2Host } from "./host.js";

const ATTESTATION_TIMEOUT_MS = 8_000;
const STATE_KEY = Symbol.for("open-codeasier.review-destination.v1");

type Pending = { sessionID: string; directory: string; acknowledged: boolean };
type State = { name: string; pending: Map<string, Pending> };

function currentState(): State {
  // OpenCode loads a plugin at each location, and may reevaluate its module
  // graph. Keep the rendezvous in-process, even across those evaluations.
  const processScope = globalThis as typeof globalThis & {
    [STATE_KEY]?: State;
  };
  return (processScope[STATE_KEY] ??= {
    // An unrelated user-configured Markdown command must not accidentally
    // match the probe and submit its argument as a regular model prompt.
    name: `open-codeasier-check-review-${randomUUID().replaceAll("-", "")}`,
    pending: new Map(),
  });
}

function withoutWaitingOnAbort<T>(
  signal: AbortSignal,
  work: () => Promise<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    void Promise.resolve()
      .then(() => {
        signal.throwIfAborted();
        return work();
      })
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}

export type VerifyChildDestination = (
  sessionID: string,
  directory: string,
  signal?: AbortSignal,
) => Promise<void>;

export function createChildDestinationVerifier(ctx: V2Host): {
  command: V2CommandDefinition;
  verifyDestination: VerifyChildDestination;
} {
  const state = currentState();

  return {
    command: {
      name: state.name,
      description: "Internal Open-Codeasier read-only review check",
      async execute({ sessionID, prompt }) {
        const token = prompt.text;
        const check = state.pending.get(token);
        if (!check || check.sessionID !== sessionID) return;
        // Nothing is executed in any normal invocation of this command.
        // Consume the matching ticket before awaiting the host name lookup.
        state.pending.delete(token);
        if ((await realpath(ctx.location.directory)) !== check.directory)
          return;
        const { data } = await ctx.agent.get({ agentID: REVIEWER_AGENT });
        if (data?.id === REVIEWER_AGENT) check.acknowledged = true;
      },
    },
    async verifyDestination(sessionID, directory, signal) {
      signal?.throwIfAborted();
      const token = randomUUID();
      const timeout = AbortSignal.timeout(ATTESTATION_TIMEOUT_MS);
      const deadline = signal ? AbortSignal.any([signal, timeout]) : timeout;
      try {
        const check: Pending = {
          sessionID,
          directory: await withoutWaitingOnAbort(deadline, () =>
            realpath(directory),
          ),
          acknowledged: false,
        };
        state.pending.set(token, check);
        await withoutWaitingOnAbort(deadline, () =>
          ctx.session.command(
            { sessionID, name: state.name, text: token },
            { signal: deadline },
          ),
        );
        deadline.throwIfAborted();
        if (check.acknowledged) return;
      } catch {
        signal?.throwIfAborted();
        // Do not surface errors that may echo the internal command or token.
      } finally {
        state.pending.delete(token);
      }
      throw new Error(
        "OpenCode V2 could not verify the read-only plugin and cross-reviewer agent in the review directory. For snapshot reviews, install both globally or configure them at the destination. No reviewer prompt was sent.",
      );
    },
  };
}
