import type { ToolContext } from "@opencode-ai/plugin";
import { Context, Effect } from "effect";
import { vi } from "vitest";

const HostDirectory = Context.Reference("test/host-directory", {
  defaultValue: () => "missing-host-context",
});

// Model the pinned host: the registry invokes async execute via Effect.promise,
// and forwards a lazy ask Effect that needs the calling fiber's instance refs.
export function pendingPermission() {
  const requested = Promise.withResolvers<Parameters<ToolContext["ask"]>[0]>();
  const decision = Promise.withResolvers<undefined>();
  const observedDirectories: string[] = [];
  const ask: ToolContext["ask"] = vi.fn((input) =>
    Effect.gen(function* () {
      observedDirectories.push(yield* HostDirectory);
      return yield* Effect.promise(() => {
        requested.resolve(input);
        return decision.promise;
      });
    }),
  );
  const execute = <T>(action: () => Promise<T>) =>
    Effect.runPromise(
      Effect.promise(action).pipe(
        Effect.provideService(HostDirectory, "/host-worktree"),
      ),
    );
  return { ask, requested, decision, observedDirectories, execute };
}
