/**
 * Core domain types for Aemeath Agent.
 * Kept deliberately framework-free so the same types run in CLI, daemon and desktop.
 */

export type Role = "system" | "user" | "assistant";

/** A single content block inside a message (text or tool call/result). */
/**
 * A single content block inside a message (text, reasoning, or a tool call/result).
 */
export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; toolUseId: string; content: string; isError: boolean };

export interface ChatMessage {
  role: Role;
  /** Text + blocks representation. For convenience we keep `text` for plain messages. */
  content: string | ContentBlock[];
  /** Monotonic id assigned by the session store. */
  id?: string;
  ts?: number;
}

export type StopReason =
  | "end_turn"
  | "tool_use"
  | "max_tokens"
  | "refusal"
  | "max_steps"
  | "aborted"
  | "error";

/**
 * A streamed output segment. Providers can interleave these in ANY order:
 * reasoning → text → tool_call → more text → more tool calls.
 * The renderer must therefore treat them as an ordered event log, not as
 * "all thinking, then all text, then all tools".
 */
export type StreamSegment =
  | { kind: "reasoning"; index: number; delta: string }
  | { kind: "text"; index: number; delta: string }
  | { kind: "tool_call"; index: number; id?: string; name?: string; argsDelta?: string }
  | { kind: "tool_call_end"; index: number }
  | { kind: "segment_end"; index: number };

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface LLMResult {
  /**
   * Ordered content blocks exactly as produced (text / reasoning / tool_use can
   * be interleaved). Text blocks that came after tool calls appear after them.
   */
  content: ContentBlock[];
  stopReason: StopReason;
  usage: TokenUsage;
  /** Raw provider response for debugging (optional). */
  raw?: unknown;
  model: string;
}

export interface LLMRequest {
  system: string;
  messages: ChatMessage[];
  tools: ToolSchema[];
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}

/** JSON-schema-ish tool definition handed to the model. */
export interface ToolSchema {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    [k: string]: unknown;
  };
}

export interface ToolResult {
  /** Text returned to the model. */
  content: string;
  isError?: boolean;
  /** Optional structured data for the UI (not sent to the model). */
  display?: Record<string, unknown>;
}

export interface ToolContext {
  cwd: string;
  signal?: AbortSignal;
  /** Ask the host (CLI/desktop) for permission. Resolves true when allowed. */
  requestPermission(req: PermissionRequest): Promise<PermissionDecision>;
  /** Long-term note store. */
  notes: NoteStore;
  /** Emit a UI event. */
  emit(event: AgentEvent): void;
  /** Per-run scratch state shared between tool calls. */
  state: Map<string, unknown>;
  config: import("./config/schema.js").AemeathConfig;
}

export interface Tool {
  name: string;
  description: string;
  inputSchema: ToolSchema["inputSchema"];
  /** If true the tool mutates the world and is gated by permissions. */
  mutating?: boolean;
  execute(input: unknown, ctx: ToolContext): Promise<ToolResult>;
}

export interface PermissionRequest {
  kind: "write_file" | "run_command" | "network" | "other";
  /** Human readable summary. */
  title: string;
  /** Full, untruncated detail (file contents / command). */
  detail: string;
  /** Stable key so "always allow" can remember it. */
  key: string;
  /**
   * A broader rule the UI may offer alongside "allow once", e.g.
   * `run_command:npm *` for `run_command:npm run build`.
   * Undefined means widening is not offered (dangerous or meaningless).
   */
  suggestion?: string;
}

export type PermissionDecision =
  | "allow_once"
  | "allow_always"   // remember this exact key
  | "allow_class"    // remember the broader `suggestion` rule instead
  | "deny";

export interface NoteStore {
  save(note: { title: string; body: string; tags?: string[] }): Promise<void>;
  list(): Promise<Array<{ title: string; body: string; tags: string[]; ts: number }>>;
  search(query: string): Promise<Array<{ title: string; body: string; tags: string[]; ts: number }>>;
}

/* ------------------------------- Events ---------------------------------- */

export type AgentEvent =
  | { type: "run_started"; runId: string; sessionId: string; prompt: string }
  /** Ordered stream segment — may interleave reasoning / text / tool calls. */
  | { type: "stream"; runId: string; segment: StreamSegment }
  /** Convenience aliases kept for simple renderers. */
  | { type: "assistant_delta"; runId: string; text: string; index?: number }
  | { type: "thinking_delta"; runId: string; text: string; index?: number }
  | { type: "assistant_message"; runId: string; content: ContentBlock[] }
  | { type: "tool_started"; runId: string; toolUseId: string; name: string; input: unknown }
  | { type: "tool_finished"; runId: string; toolUseId: string; name: string; result: ToolResult; ms: number }
  | { type: "permission_requested"; runId: string; request: PermissionRequest }
  | { type: "permission_resolved"; runId: string; key: string; decision: PermissionDecision }
  | { type: "usage"; runId: string; usage: TokenUsage; contextTokens: number; budget: number }
  | { type: "compaction"; runId: string; before: number; after: number; summary: string }
  | { type: "run_finished"; runId: string; stopReason: StopReason; usage: TokenUsage; ms: number }
  | { type: "error"; runId: string; message: string; stack?: string }
  | { type: "log"; level: "debug" | "info" | "warn" | "error"; message: string };

export type EventSink = (event: AgentEvent) => void;
