import type { AemeathConfig } from "../config/schema.js";
import type { ChatMessage, ContentBlock, LLMRequest, LLMResult, StreamSegment } from "../types.js";
import { emptyUsage, fetchWithRetry, endpointUrlFor, normalizeStopReason, sseLines, type LLMProvider } from "./base.js";

/** Convert our messages into OpenAI chat-completions shape. */
function toOpenAIMessages(system: string, messages: ChatMessage[]) {
  const out: any[] = [{ role: "system", content: system }];
  for (const m of messages) {
    if (typeof m.content === "string") {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    if (m.role === "assistant") {
      const text = m.content.filter((b) => b.type === "text").map((b: any) => b.text).join("");
      const toolCalls = m.content
        .filter((b) => b.type === "tool_use")
        .map((b: any) => ({
          id: b.id,
          type: "function",
          function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
        }));
      out.push({
        role: "assistant",
        content: text || null,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      });
      continue;
    }
    // user: may contain plain text and/or tool results
    for (const b of m.content) {
      if (b.type === "text") out.push({ role: "user", content: b.text });
      else if (b.type === "tool_result")
        out.push({ role: "tool", tool_call_id: b.toolUseId, content: b.content || (b.isError ? "(error)" : "") });
    }
  }
  return out;
}

export class OpenAICompatProvider implements LLMProvider {
  readonly name = "openai-compat";
  readonly model: string;
  constructor(private cfg: AemeathConfig) {
    this.model = cfg.model;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "content-type": "application/json" };
    if (this.cfg.apiKey) h["authorization"] = `Bearer ${this.cfg.apiKey}`;
    return h;
  }

  async complete(req: LLMRequest): Promise<LLMResult> {
    const url = endpointUrlFor(this.cfg.baseUrl, "chat");
    const body = {
      model: this.model,
      max_tokens: req.maxTokens ?? this.cfg.maxTokens,
      temperature: req.temperature ?? this.cfg.temperature,
      messages: toOpenAIMessages(req.system, req.messages),
      tools: req.tools.length
        ? req.tools.map((t) => ({
            type: "function",
            function: { name: t.name, description: t.description, parameters: t.inputSchema },
          }))
        : undefined,
      stream: false,
    };

    const res = await fetchWithRetry(
      url,
      { method: "POST", headers: this.headers(), body: JSON.stringify(body) },
      { signal: req.signal },
    );
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`LLM request failed (${res.status}): ${text.slice(0, 800)}`);
    }
    const data = (await res.json()) as any;
    const choice = data.choices?.[0];
    const msg = choice?.message ?? {};
    const content: ContentBlock[] = [];
    if (msg.content) content.push({ type: "text", text: String(msg.content) });
    for (const tc of msg.tool_calls ?? []) {
      let input: unknown = {};
      try {
        input = tc.function?.arguments ? JSON.parse(tc.function.arguments) : {};
      } catch {
        input = { __raw: tc.function?.arguments };
      }
      content.push({ type: "tool_use", id: tc.id, name: tc.function?.name, input });
    }
    const usage = {
      inputTokens: data.usage?.prompt_tokens ?? 0,
      outputTokens: data.usage?.completion_tokens ?? 0,
      cacheReadTokens: data.usage?.prompt_tokens_details?.cached_tokens,
    };
    const hasTools = content.some((b) => b.type === "tool_use");
    return { content, stopReason: normalizeStopReason(choice?.finish_reason, hasTools), usage, model: this.model };
  }
}

/**
 * Streaming variant for OpenAI-compatible endpoints.
 *
 * Emits an ordered {@link StreamSegment} log. Supports:
 *   - reasoning_content / reasoning (DeepSeek-R1, QwQ, o1-style models)
 *   - interleaved text and tool calls
 * so the caller can render them in the order they actually arrived.
 */
export async function openaiStream(
  cfg: AemeathConfig,
  req: LLMRequest,
  onSegment: (segment: StreamSegment) => void,
): Promise<LLMResult> {
  const url = endpointUrlFor(cfg.baseUrl, "chat");
  const body = {
    model: cfg.model,
    max_tokens: req.maxTokens ?? cfg.maxTokens,
    temperature: req.temperature ?? cfg.temperature,
    messages: toOpenAIMessages(req.system, req.messages),
    tools: req.tools.length
      ? req.tools.map((t) => ({
          type: "function",
          function: { name: t.name, description: t.description, parameters: t.inputSchema },
        }))
      : undefined,
    stream: true,
    stream_options: { include_usage: true },
  };
  const res = await fetchWithRetry(
    url,
    {
      method: "POST",
      headers: { "content-type": "application/json", ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}) },
      body: JSON.stringify(body),
    },
    { signal: req.signal },
  );
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    throw new Error(`LLM stream failed (${res.status}): ${text.slice(0, 800)}`);
  }

  /** Ordered accumulation: one entry per content block, in production order. */
  const parts: Array<
    | { kind: "text"; text: string }
    | { kind: "reasoning"; text: string }
    | { kind: "tool"; id: string; name: string; args: string }
  > = [];
  // OpenAI mixes text and reasoning under the same delta object, so keep the
  // *current* text/reasoning part open and append to it (text and reasoning
  // never interleave within one choice, but tool calls can come between them).
  let openText: number | null = null;
  let openReasoning: number | null = null;
  let finish = "stop";
  const toolIndex = new Map<number, number>(); // tool_call.index -> parts index
  const usage = emptyUsage();

  for await (const line of sseLines(res.body)) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    let ev: any;
    try {
      ev = JSON.parse(payload);
    } catch {
      continue;
    }
    if (ev.usage) {
      usage.inputTokens = ev.usage.prompt_tokens ?? usage.inputTokens;
      usage.outputTokens = ev.usage.completion_tokens ?? usage.outputTokens;
    }
    const choice = ev.choices?.[0];
    if (!choice) continue;
    if (choice.finish_reason) finish = choice.finish_reason;
    const delta = choice.delta ?? {};

    // --- reasoning / thinking (DeepSeek-R1, QwQ, o1, some gateways) ---
    const reasoningPiece: string | undefined = delta.reasoning_content ?? delta.reasoning;
    if (reasoningPiece) {
      if (openReasoning === null) {
        parts.push({ kind: "reasoning", text: "" });
        openReasoning = parts.length - 1;
        openText = null;
      }
      const p = parts[openReasoning];
      if (p.kind === "reasoning") p.text += reasoningPiece;
      onSegment({ kind: "reasoning", index: openReasoning, delta: reasoningPiece });
    }

    // --- visible text ---
    if (delta.content) {
      if (openText === null) {
        parts.push({ kind: "text", text: "" });
        openText = parts.length - 1;
        openReasoning = null;
      }
      const p = parts[openText];
      if (p.kind === "text") p.text += delta.content;
      onSegment({ kind: "text", index: openText, delta: delta.content });
    }

    // --- tool calls (may appear after text, or interleaved) ---
    for (const tc of delta.tool_calls ?? []) {
      const idx = tc.index ?? 0;
      let slot = toolIndex.get(idx);
      if (slot === undefined) {
        parts.push({ kind: "tool", id: tc.id ?? "", name: tc.function?.name ?? "", args: "" });
        slot = parts.length - 1;
        toolIndex.set(idx, slot);
        // A tool call closes any open text/reasoning segment.
        openText = null;
        openReasoning = null;
        onSegment({ kind: "tool_call", index: slot, id: tc.id, name: tc.function?.name });
      }
      const p = parts[slot];
      if (p.kind === "tool") {
        if (tc.id) p.id = tc.id;
        if (tc.function?.name) p.name = tc.function.name;
        if (tc.function?.arguments) {
          p.args += tc.function.arguments;
          onSegment({ kind: "tool_call", index: slot, argsDelta: tc.function.arguments });
        }
      }
    }
  }

  // Build content blocks in the exact order the model produced them.
  const content: ContentBlock[] = [];
  for (const p of parts) {
    if (p.kind === "text") {
      if (p.text) content.push({ type: "text", text: p.text });
    } else if (p.kind === "reasoning") {
      if (p.text) content.push({ type: "reasoning", text: p.text });
    } else {
      let input: unknown = {};
      try {
        input = p.args ? JSON.parse(p.args) : {};
      } catch {
        input = { __raw: p.args };
      }
      content.push({
        type: "tool_use",
        id: p.id || `call_${Math.random().toString(36).slice(2)}`,
        name: p.name,
        input,
      });
    }
  }
  const hasTools = content.some((b) => b.type === "tool_use");
  return { content, stopReason: normalizeStopReason(finish, hasTools), usage, model: cfg.model };
}
