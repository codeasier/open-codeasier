import type { ToolContext } from "@opencode-ai/plugin";
import { Context, Effect } from "effect";
import { vi } from "vitest";

const HostDirectory = Context.Reference("test/host-directory", {
  defaultValue: () => "missing-host-context",
});

type PendingPermissionOptions = {
  ask?: "effect" | "promise";
};

// Model both published host shapes: 1.14.49 ask is a lazy Effect that needs
// the calling fiber's instance refs; 1.18.30 ask is a native Promise.
export function pendingPermission(options: PendingPermissionOptions = {}) {
  const requested = Promise.withResolvers<Parameters<ToolContext["ask"]>[0]>();
  const decision = Promise.withResolvers<undefined>();
  const observedDirectories: string[] = [];
  const ask = vi.fn((input: Parameters<ToolContext["ask"]>[0]) => {
    if (options.ask === "promise") {
      requested.resolve(input);
      return decision.promise;
    }
    return Effect.gen(function* () {
      observedDirectories.push(yield* HostDirectory);
      return yield* Effect.promise(() => {
        requested.resolve(input);
        return decision.promise;
      });
    });
  });
  const execute = <T>(action: () => Promise<T>) =>
    Effect.runPromise(
      Effect.promise(action).pipe(
        Effect.provideService(HostDirectory, "/host-worktree"),
      ),
    );
  return { ask, requested, decision, observedDirectories, execute };
}
