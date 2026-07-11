import { tool } from "@opencode-ai/plugin";
import { SessionReviewError } from "./errors.js";
import { fetchSessionReviewInput, type SessionClient } from "./fetch.js";

export function createSessionReviewTool(client: SessionClient) {
  return tool({
    description:
      "Read and normalize one explicit OpenCode session for evidence-based review",
    args: {
      sessionID: tool.schema.string().min(1),
      mode: tool.schema.enum(["summary", "troubleshoot"]),
      focus: tool.schema.string().max(2_000).optional(),
    },
    async execute(args, context) {
      try {
        const review = await fetchSessionReviewInput({
          client,
          directory: context.directory,
          sessionID: args.sessionID,
          mode: args.mode,
          ...(args.focus === undefined ? {} : { focus: args.focus }),
        });
        return {
          title: `Session review input: ${args.sessionID}`,
          output: JSON.stringify(review),
          metadata: {
            mode: args.mode,
            truncated: review.truncated,
            includedMessages: review.includedMessages,
          },
        };
      } catch (error) {
        if (error instanceof SessionReviewError)
          return {
            title: `Session review failed: ${args.sessionID}`,
            output: `${error.code}: ${error.message}`,
            metadata: { mode: args.mode, error: error.code },
          };
        throw error;
      }
    },
  });
}
