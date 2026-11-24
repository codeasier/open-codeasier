/**
 * Structural slice of the OpenCode V2 plugin context (@opencode/plugin 2.4).
 * The host passes this object to `setup`. Keeping the slice local avoids
 * pulling @opencode/plugin's Effect 4.1 runtime next to the V1 Effect pin.
 */

export type V2Request = { signal?: AbortSignal };

export type V2Registration = { dispose(): Promise<void> };

export type V2SessionInfo = {
  id: string;
  parentID?: string;
  title?: string;
  time?: { created: number; updated?: number };
  location?: { directory?: string };
};

export type V2StructuredError = { type?: string; message?: string };

export type V2ToolContent =
  | { type: "text"; text?: string }
  | { type: "file"; mime?: string; name?: string | null; uri?: string };

export type V2AssistantState =
  | { status: "streaming"; input?: unknown }
  | { status: "running"; input?: unknown }
  | { status: "completed"; input?: unknown; content?: V2ToolContent[] }
  | { status: "error"; input?: unknown; error?: V2StructuredError };

export type V2MessagePart =
  | { type: "text"; text?: string }
  | {
      type: "reasoning";
      text?: string;
      time?: { created?: number; completed?: number };
    }
  | {
      type: "tool";
      name?: string;
      state?: V2AssistantState;
      time?: { created?: number; completed?: number };
    };

export type V2SessionMessage = {
  type?: string;
  id?: string;
  time?: { created?: number; completed?: number };
  text?: string;
  files?: Array<{ mime?: string; name?: string | null }>;
  finish?: string;
  error?: V2StructuredError;
  content?: V2MessagePart[];
};

export type V2ModelInfo = {
  providerID: string;
  modelID: string;
  enabled?: boolean;
  limit?: { context?: number };
};

export type V2ToolExecuteContext = {
  sessionID: string;
  agent: string;
  messageID: string;
  id: string;
  signal: AbortSignal;
  progress(update: Record<string, unknown>): Promise<void>;
};

export type V2ToolDefinition = {
  name: string;
  description: string;
  input: Record<string, unknown>;
  execute(
    input: unknown,
    context: V2ToolExecuteContext,
  ): Promise<{ content?: string; metadata?: Record<string, unknown> }>;
};

export type V2ToolEditor = {
  add(tool: V2ToolDefinition): void;
};

export type V2PermissionRule = {
  action: string;
  resource: string;
  effect: "allow" | "deny" | "ask";
};

export type V2AgentDraft = {
  id: string;
  permissions?: V2PermissionRule[];
};

export type V2AgentEditor = {
  list(): readonly V2AgentDraft[];
  update(id: string, update: (agent: V2AgentDraft) => void): void;
};

export type V2PromptEvent = {
  sessionID: string;
  messageID: string;
  prompt: { text?: string };
  metadata?: Record<string, unknown>;
};

export type V2ContextEvent = {
  sessionID: string;
  tools: Record<string, { description: string; input: unknown }>;
};

export type V2ToolHookEvent = {
  tool: string;
  sessionID: string;
  id: string;
  input: unknown;
  status?: "completed" | "error";
  result?: { metadata?: Record<string, unknown> };
};

export type V2Event = {
  type: string;
  data?: Record<string, unknown>;
};

export type V2Host = {
  location: { directory: string };
  session: {
    create(
      input: {
        parentID?: string | null;
        title?: string | null;
        location?: { directory: string } | null;
        agent?: string | null;
      },
      request?: V2Request,
    ): Promise<V2SessionInfo>;
    get(
      input: { sessionID: string },
      request?: V2Request,
    ): Promise<V2SessionInfo>;
    list(
      input: {
        parentID?: string | null;
        directory?: string;
        limit?: number;
        cursor?: string;
      },
      request?: V2Request,
    ): Promise<{
      data: V2SessionInfo[];
      cursor?: { next?: string | null };
    }>;
    prompt(
      input: {
        sessionID: string;
        id?: string | null;
        text: string;
        delivery?: "steer" | "queue" | null;
      },
      request?: V2Request,
    ): Promise<{ id: string }>;
    context(
      input: { sessionID: string },
      request?: V2Request,
    ): Promise<V2SessionMessage[]>;
    interrupt(
      input: { sessionID: string; resume?: boolean },
      request?: V2Request,
    ): Promise<{ interrupted: boolean }>;
    switchAgent(
      input: { sessionID: string; agent: string },
      request?: V2Request,
    ): Promise<void>;
    switchModel(
      input: { sessionID: string; model: { providerID: string; id: string } },
      request?: V2Request,
    ): Promise<void>;
    wait(input: { sessionID: string }, request?: V2Request): Promise<void>;
    hook(
      name: "prompt",
      callback: (event: V2PromptEvent) => void | Promise<void>,
    ): Promise<V2Registration>;
    hook(
      name: "context",
      callback: (event: V2ContextEvent) => void | Promise<void>,
    ): Promise<V2Registration>;
  };
  model: {
    list(request?: V2Request): Promise<{ data: V2ModelInfo[] }>;
  };
  tool: {
    transform(
      callback: (editor: V2ToolEditor) => void,
    ): Promise<V2Registration>;
    hook(
      name: "execute.before" | "execute.after",
      callback: (event: V2ToolHookEvent) => void | Promise<void>,
    ): Promise<V2Registration>;
  };
  agent: {
    transform(
      callback: (editor: V2AgentEditor) => void,
    ): Promise<V2Registration>;
  };
  permission: {
    assert(input: {
      sessionID: string;
      agent?: string;
      action: string;
      resources: readonly string[];
      save?: readonly string[];
      metadata?: Record<string, unknown>;
      source?: { type: "tool"; messageID: string; id: string };
    }): Promise<void>;
  };
  event: {
    subscribe(options?: { signal?: AbortSignal }): AsyncIterable<V2Event>;
  };
};
