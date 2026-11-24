import { createCrossReviewAuditTool } from "./cross-review/audit.js";
import type {
  CrossReviewConfirmStart,
  CrossReviewPrepareConfirmation,
} from "./cross-review/confirmation.js";
import type { CrossReviewInvocationCheck } from "./cross-review/invocation.js";
import {
  createCrossReviewProtocolTools,
  type AsyncCrossReviewClient,
} from "./cross-review/protocol.js";
import type { CrossReviewRunStore } from "./cross-review/run-store.js";
import {
  createCrossReviewTool,
  type CrossReviewClient,
} from "./cross-review/tool.js";
import type { SessionClient } from "./session-review/fetch.js";
import { createSessionReviewTool } from "./session-review/tool.js";

export type RuntimeClient = CrossReviewClient &
  AsyncCrossReviewClient &
  SessionClient;

export function createOpenCodeasierTools(
  client: RuntimeClient,
  options: {
    store: CrossReviewRunStore;
    assertInvocation: CrossReviewInvocationCheck;
    prepareConfirmation: CrossReviewPrepareConfirmation;
    confirmStart: CrossReviewConfirmStart;
  },
) {
  return {
    cross_review: createCrossReviewTool(client, undefined, {
      assertInvocation: options.assertInvocation,
      confirmStart: options.confirmStart,
    }),
    ...createCrossReviewProtocolTools(client, options),
    session_review: createSessionReviewTool(client),
    cross_review_audit: createCrossReviewAuditTool(client, {
      store: options.store,
    }),
  };
}
