import type { Message, Part, Session } from "@opencode-ai/sdk";

export type ReviewMode = "summary" | "troubleshoot";
export type ReviewLimits = {
  maxMessages: number;
  maxBytes: number;
  maxPartBytes: number;
};
export const DEFAULT_LIMITS: ReviewLimits = {
  maxMessages: 200,
  maxBytes: 200_000,
  maxPartBytes: 20_000,
};

export type ReviewPart =
  | { type: "text" | "reasoning"; text: string }
  | {
      type: "tool";
      name: string;
      status: string;
      input?: unknown;
      output?: string;
      error?: string;
    }
  | { type: "file"; mime: string; filename?: string }
  | { type: "unknown"; sourceType: string };

export type ReviewMessage = {
  id: string;
  role: "user" | "assistant";
  createdAt?: number;
  parts: ReviewPart[];
};
export type NormalizedSession = {
  sessionID: string;
  parentID?: string;
  title?: string;
  mode: ReviewMode;
  focus?: string;
  messages: ReviewMessage[];
  totalMessages: number;
  includedMessages: number;
  omittedMessages: number;
  retainedMessageIDs: string[];
  truncated: boolean;
  firstMessageID?: string;
  lastMessageID?: string;
};
export type SdkMessage = { info: Message; parts: Part[] };
export type NormalizeInput = {
  session: Session;
  messages: SdkMessage[];
  mode: ReviewMode;
  focus?: string;
  limits?: Partial<ReviewLimits>;
};
