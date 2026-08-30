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
import type { SessionClient } from "./session-review/fetch.js";
import { createSessionReviewTool } from "./session-review/tool.js";

export const server: Plugin = async ({ client }) => {
  const protocol = createCrossReviewProtocolTools(
    client as AsyncCrossReviewClient,
  );
  return {
    config: async (config) => {
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
    },
  };
};

export default { id: "open-codeasier", server } satisfies PluginModule;
