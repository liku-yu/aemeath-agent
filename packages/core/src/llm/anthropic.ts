import type { AemeathConfig } from "../config/schema.js";
import type { ChatMessage, ContentBlock, LLMRequest, LLMResult, StreamSegment } from "../types.js";
import { emptyUsage, fetchWithRetry, endpointUrlFor, normalizeStopReason, sseLines, type LLMProvider } from "./base.js";

/** Convert our messages into the Anthropic Messages API shape. */
function toAnthropicMessages(messages: ChatMessage[]) {
  return messages
    .filter((m) => m.role !== "system")
    .map((m) => {
      if (typeof m.content === "string") {
        return { role: m.role, content: [{ type: "text", text: m.content }] };
      }
      const content: any[] = [];
      for (const b of m.content) {
        if (b.type === "text") content.push({ type: "text", text: b.text });
        else if (b.type === "reasoning") {
          // Reasoning is not replayed back to the API.
        } else if (b.type === "tool_use") content.push({ type: "tool_use", id: b.id, name: b.name, input: b.input });
        else content.push({
          type: "tool_result",
          tool_use_id: b.toolUseId,
          content: b.content,
          ...(b.isError ? { is_error: true } : {}),
        });
      }
      if (!content.length) content.push({ type: "text", text: "(空)" });
      return { role: m.role, content };
    });
}

export class AnthropicProvider implements LLMProvider {
  readonly name = "anthropic";
  readonly model: string;
  private cfg: AemeathConfig;

  constructor(cfg: AemeathConfig) {
    this.cfg = cfg;
    this.model = cfg.model;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
    };
    // Anthropic native uses x-api-key; many gateways accept bearer too.
    if (this.cfg.apiKey) {
      h["x-api-key"] = this.cfg.apiKey;
      h["authorization"] = `Bearer ${this.cfg.apiKey}`;
    }
    return h;
  }

  async complete(req: LLMRequest): Promise<LLMResult> {
    const url = endpointUrlFor(this.cfg.baseUrl, "messages");
    const body = {
      model: this.model,
      max_tokens: req.maxTokens ?? this.cfg.maxTokens,
      temperature: req.temperature ?? this.cfg.temperature,
      system: req.system,
      messages: toAnthropicMessages(req.messages),
      tools: req.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema,
      })),
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

    const data = (await res.json()) as {
      content?: ContentBlock[];
      stop_reason?: string;
      usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
    };

    const content: ContentBlock[] = (data.content ?? []).filter(
      (b) => b.type === "text" || b.type === "tool_use",
    ) as ContentBlock[];

    const usage = data.usage
      ? {
          inputTokens: data.usage.input_tokens ?? 0,
          outputTokens: data.usage.output_tokens ?? 0,
          cacheReadTokens: data.usage.cache_read_input_tokens,
          cacheWriteTokens: data.usage.cache_creation_input_tokens,
        }
      : emptyUsage();

    const hasTools = content.some((b) => b.type === "tool_use");
    return { content, stopReason: normalizeStopReason(data.stop_reason, hasTools), usage, model: this.model };
  }
}

/**
 * Streaming variant. Emits an ordered {@link StreamSegment} log so callers can
 * render reasoning / text / tool calls interleaved in the exact order the model
 * produced them. Returns the final aggregated result.
 */
export async function anthropicStream(
  cfg: AemeathConfig,
  req: LLMRequest,
  onSegment: (segment: StreamSegment) => void,
): Promise<LLMResult> {
  const url = endpointUrlFor(cfg.baseUrl, "messages");
  const body = {
    model: cfg.model,
    max_tokens: req.maxTokens ?? cfg.maxTokens,
    temperature: req.temperature ?? cfg.temperature,
    system: req.system,
    messages: toAnthropicMessages(req.messages),
    tools: req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })),
    stream: true,
  };

  const res = await fetchWithRetry(
    url,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        ...(cfg.apiKey ? { "x-api-key": cfg.apiKey, authorization: `Bearer ${cfg.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
    },
    { signal: req.signal },
  );
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    throw new Error(`LLM stream failed (${res.status}): ${text.slice(0, 800)}`);
  }

  const blocks = new Map<number, ContentBlock>();
  let stopReason = "end_turn";
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
    if (ev.type === "content_block_start") {
      const b = ev.content_block;
      if (b?.type === "text") {
        blocks.set(ev.index, { type: "text", text: b.text ?? "" });
        onSegment({ kind: "text", index: ev.index, delta: b.text ?? "" });
      } else if (b?.type === "thinking" || b?.type === "redacted_thinking") {
        blocks.set(ev.index, { type: "reasoning", text: b.thinking ?? "" });
        onSegment({ kind: "reasoning", index: ev.index, delta: b.thinking ?? "" });
      } else if (b?.type === "tool_use") {
        blocks.set(ev.index, { type: "tool_use", id: b.id, name: b.name, input: b.input ?? {} });
        onSegment({ kind: "tool_call", index: ev.index, id: b.id, name: b.name });
      }
    } else if (ev.type === "content_block_delta") {
      const b = blocks.get(ev.index);
      if (!b) continue;
      const d = ev.delta;
      if (d?.type === "text_delta" && b.type === "text") {
        b.text += d.text;
        onSegment({ kind: "text", index: ev.index, delta: d.text });
      } else if ((d?.type === "thinking_delta" || d?.type === "signature_delta") && b.type === "reasoning") {
        const piece = d.thinking ?? d.signature ?? "";
        if (piece) {
          b.text += piece;
          onSegment({ kind: "reasoning", index: ev.index, delta: piece });
        }
      } else if (d?.type === "input_json_delta" && b.type === "tool_use") {
        (b as any).__json = ((b as any).__json ?? "") + (d.partial_json ?? "");
        onSegment({ kind: "tool_call", index: ev.index, argsDelta: d.partial_json ?? "" });
      }
    } else if (ev.type === "content_block_stop") {
      onSegment({ kind: "segment_end", index: ev.index });
    } else if (ev.type === "message_delta") {
      if (ev.delta?.stop_reason) stopReason = ev.delta.stop_reason;
      if (ev.usage?.output_tokens) usage.outputTokens = ev.usage.output_tokens;
    } else if (ev.type === "message_start") {
      if (ev.message?.usage?.input_tokens) usage.inputTokens = ev.message.usage.input_tokens;
    }
  }

  // Preserve production order: sort by block index, which is exactly the order
  // the model emitted them (text/reasoning/tool_use may be interleaved).
  const content: ContentBlock[] = [];
  for (const [, b] of [...blocks.entries()].sort((a, c) => a[0] - c[0])) {
    if (b.type === "tool_use") {
      const j = (b as any).__json as string | undefined;
      if (j) {
        try {
          b.input = JSON.parse(j);
        } catch {
          /* keep start input */
        }
      }
      delete (b as any).__json;
    }
    if (typeof b === "object" && b !== null && "type" in b) content.push(b);
  }

  const hasTools = content.some((b) => b.type === "tool_use");
  return { content, stopReason: normalizeStopReason(stopReason, hasTools), usage, model: cfg.model };
}
