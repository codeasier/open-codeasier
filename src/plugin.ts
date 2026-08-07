import type { Plugin, PluginModule } from "@opencode-ai/plugin";
import {
  createCrossReviewTool,
  type CrossReviewClient,
} from "./cross-review/tool.js";
import type { SessionClient } from "./session-review/fetch.js";
import { createSessionReviewTool } from "./session-review/tool.js";

export const server: Plugin = async ({ client }) => ({
  tool: {
    cross_review: createCrossReviewTool(client as CrossReviewClient),
    session_review: createSessionReviewTool(client as SessionClient),
  },
});

export default { id: "open-codeasier", server } satisfies PluginModule;
