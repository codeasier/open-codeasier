import type { Plugin, PluginModule } from "@opencode-ai/plugin";
import { PRIMARY_TOOL_IDS } from "./cross-review/tool.js";
import type { AsyncCrossReviewClient } from "./cross-review/protocol.js";
import { FileCrossReviewRunStore } from "./cross-review/run-store.js";
import type { SessionClient } from "./session-review/fetch.js";
import { CROSS_REVIEW_START_PERMISSIONS } from "./cross-review/authorization.js";
import { createCrossReviewInvocationGuard } from "./cross-review/invocation.js";
import { setup as setupV2 } from "./opencode-v2/setup.js";
import type { V2Host } from "./opencode-v2/host.js";
import { createOpenCodeasierTools } from "./plugin-tools.js";
import type { CrossReviewClient } from "./cross-review/tool.js";

export const server: Plugin = async ({ client }) => {
  const store = new FileCrossReviewRunStore();
  await store.cleanupExpiredRuns().catch(() => undefined);
  const {
    assertInvocation,
    prepareConfirmation,
    confirmStart,
    ...invocationHooks
  } = createCrossReviewInvocationGuard(client);
  return {
    ...invocationHooks,
    config: async (config) => {
      const permission =
        typeof config.permission === "string"
          ? { "*": config.permission }
          : (config.permission ?? {});
      // Override the host's built-in wildcard allow, but preserve user rules
      // and their last-match-wins order (including explicit wildcard overrides).
      config.permission = Object.fromEntries([
        ...CROSS_REVIEW_START_PERMISSIONS.filter(
          (name) => !Object.hasOwn(permission, name),
        ).map((name) => [name, "ask"] as const),
        ...Object.entries(permission),
      ]);
      const existing = config.experimental?.primary_tools ?? [];
      const merged = Array.from(new Set([...existing, ...PRIMARY_TOOL_IDS]));
      config.experimental = {
        ...config.experimental,
        primary_tools: merged,
      };
    },
    tool: createOpenCodeasierTools(
      client as CrossReviewClient & AsyncCrossReviewClient & SessionClient,
      { store, assertInvocation, prepareConfirmation, confirmStart },
    ),
  };
};

/** V2 calls `setup` and ignores `server`. V1 calls `server` and ignores `setup`. */
export async function setup(ctx: V2Host): Promise<() => Promise<void>> {
  return setupV2(ctx);
}

const v1Module = { id: "open-codeasier", server } satisfies PluginModule;

export default { ...v1Module, setup };
