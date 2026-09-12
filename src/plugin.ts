import type { Plugin, PluginModule } from "@opencode-ai/plugin";
import {
  createCrossReviewTool,
  PRIMARY_TOOL_IDS,
  type CrossReviewClient,
} from "./cross-review/tool.js";
import {
  createCrossReviewProtocolTools,
  type AsyncCrossReviewClient,
} from "./cross-review/protocol.js";
import { FileCrossReviewRunStore } from "./cross-review/run-store.js";
import { createCrossReviewAuditTool } from "./cross-review/audit.js";
import type { SessionClient } from "./session-review/fetch.js";
import { createSessionReviewTool } from "./session-review/tool.js";
import { CROSS_REVIEW_START_PERMISSIONS } from "./cross-review/authorization.js";

export const server: Plugin = async ({ client }) => {
  const store = new FileCrossReviewRunStore();
  await store.cleanupExpiredRuns().catch(() => undefined);
  const protocol = createCrossReviewProtocolTools(
    client as AsyncCrossReviewClient,
    { store },
  );
  return {
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
    tool: {
      cross_review: createCrossReviewTool(client as CrossReviewClient),
      ...protocol,
      session_review: createSessionReviewTool(client as SessionClient),
      cross_review_audit: createCrossReviewAuditTool(client as SessionClient),
    },
  };
};

export default { id: "open-codeasier", server } satisfies PluginModule;
