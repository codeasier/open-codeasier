import type { Plugin, PluginModule } from "@opencode-ai/plugin";
import type { SessionClient } from "./session-review/fetch.js";
import { createSessionReviewTool } from "./session-review/tool.js";

export const server: Plugin = async ({ client }) => ({
  tool: {
    cce_session_review: createSessionReviewTool(client as SessionClient),
  },
});

export default { server } satisfies PluginModule;
