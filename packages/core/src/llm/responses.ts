import type { AemeathConfig } from "../config/schema.js";
import type { ChatMessage, ContentBlock, LLMRequest, LLMResult, StreamSegment } from "../types.js";
import { emptyUsage, fetchWithRetry, endpointUrlFor, normalizeStopReason, sseLines, type LLMProvider } from "./base.js";

/**
 * OpenAI **Responses API** (`/v1/responses`) — the newer endpoint that unifies
 * chat, tools and reasoning items into a single ordered output array.
 *
 * Notable differences from chat/completions:
 *   - `input` is a flat list of items (messages + function_call + function_call_output)
 *   - tools use a flat shape: { type: "function", name, description, parameters }
 *   - the stream uses semantic events: response.output_item.added,
 *     response.output_text.delta, response.reasoning_summary_text.delta,
 *     response.function_call_arguments.delta, response.completed
 *
 * We map those events onto the same ordered {@link StreamSegment} log the rest
 * of the app consumes, so reasoning / text / tool calls can interleave freely.
 */
function toResponsesInput(system: string, messages: ChatMessage[]) {
  const input: any[] = [];
  for (const m of messages) {
    if (typeof m.content === "string") {
      input.push({ role: m.role, content: m.content });
      continue;
    }
    if (m.role === "assistant") {
      for (const b of m.content) {
        if (b.type === "text") {
          input.push({ role: "assistant", content: b.text });
        } else if (b.type === "reasoning") {
          // Reasoning items are not replayed.
        } else if (b.type === "tool_use") {
          input.push({
            type: "function_call",
            call_id: b.id,
            name: b.name,
            arguments: JSON.stringify(b.input ?? {}),
          });
        }
      }
      continue;
    }
    for (const b of m.content) {
      if (b.type === "text") input.push({ role: "user", content: b.text });
      else if (b.type === "tool_result") {
        input.push({ type: "function_call_output", call_id: b.toolUseId, output: b.content || "" });
      }
    }
  }
  return { instructions: system, input };
}

export class OpenAIResponsesProvider implements LLMProvider {
  readonly name = "openai-responses";
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
    const url = endpointUrlFor(this.cfg.baseUrl, "responses");
    const { instructions, input } = toResponsesInput(req.system, req.messages);
    const body = {
      model: this.model,
      instructions,
      input,
      max_output_tokens: req.maxTokens ?? this.cfg.maxTokens,
      temperature: req.temperature ?? this.cfg.temperature,
      tools: req.tools.length
        ? req.tools.map((t) => ({
            type: "function",
            name: t.name,
            description: t.description,
            parameters: t.inputSchema,
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
    const content: ContentBlock[] = [];
    for (const item of data.output ?? []) {
      if (item.type === "message") {
        for (const c of item.content ?? []) {
          if (c.type === "output_text" && c.text) content.push({ type: "text", text: c.text });
        }
      } else if (item.type === "reasoning") {
        const text = (item.summary ?? []).map((s: any) => s.text ?? "").join("");
        if (text) content.push({ type: "reasoning", text });
      } else if (item.type === "function_call") {
        let parsed: unknown = {};
        try {
          parsed = item.arguments ? JSON.parse(item.arguments) : {};
        } catch {
          parsed = { __raw: item.arguments };
        }
        content.push({ type: "tool_use", id: item.call_id ?? item.id, name: item.name, input: parsed });
      }
    }
    const usage = {
      inputTokens: data.usage?.input_tokens ?? 0,
      outputTokens: data.usage?.output_tokens ?? 0,
      cacheReadTokens: data.usage?.input_tokens_details?.cached_tokens,
    };
    const hasTools = content.some((b) => b.type === "tool_use");
    return { content, stopReason: normalizeStopReason(data.status === "incomplete" ? "max_tokens" : undefined, hasTools), usage, model: this.model };
  }
}

/** Streaming variant for the Responses API. */
export async function openaiResponsesStream(
  cfg: AemeathConfig,
  req: LLMRequest,
  onSegment: (segment: StreamSegment) => void,
): Promise<LLMResult> {
  const url = endpointUrlFor(cfg.baseUrl, "responses");
  const { instructions, input } = toResponsesInput(req.system, req.messages);
  const body = {
    model: cfg.model,
    instructions,
    input,
    max_output_tokens: req.maxTokens ?? cfg.maxTokens,
    temperature: req.temperature ?? cfg.temperature,
    tools: req.tools.length
      ? req.tools.map((t) => ({
          type: "function",
          name: t.name,
          description: t.description,
          parameters: t.inputSchema,
        }))
      : undefined,
    stream: true,
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

  /** Ordered output items, keyed by OpenAI's output_index. */
  const order: number[] = [];
  const items = new Map<number, ContentBlock & { __json?: string }>();
  const usage = emptyUsage();
  let incomplete = false;

  const ensure = (index: number, make: () => ContentBlock) => {
    let it = items.get(index);
    if (!it) {
      it = make() as ContentBlock & { __json?: string };
      items.set(index, it);
      order.push(index);
    }
    return it;
  };

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
    const idx = ev.output_index ?? 0;

    switch (ev.type) {
      case "response.output_item.added": {
        const item = ev.item ?? {};
        if (item.type === "message") ensure(idx, () => ({ type: "text", text: "" }));
        else if (item.type === "reasoning") ensure(idx, () => ({ type: "reasoning", text: "" }));
        else if (item.type === "function_call") {
          const b = ensure(idx, () => ({ type: "tool_use", id: item.call_id ?? item.id ?? "", name: item.name ?? "", input: {} }));
          void b;
          onSegment({ kind: "tool_call", index: idx, id: item.call_id ?? item.id, name: item.name });
        }
        break;
      }
      case "response.output_text.delta": {
        const b = ensure(idx, () => ({ type: "text", text: "" }));
        if (b.type === "text") {
          b.text += ev.delta ?? "";
          onSegment({ kind: "text", index: idx, delta: ev.delta ?? "" });
        }
        break;
      }
      case "response.reasoning_summary_text.delta":
      case "response.reasoning_text.delta": {
        const b = ensure(idx, () => ({ type: "reasoning", text: "" }));
        if (b.type === "reasoning") {
          b.text += ev.delta ?? "";
          onSegment({ kind: "reasoning", index: idx, delta: ev.delta ?? "" });
        }
        break;
      }
      case "response.function_call_arguments.delta": {
        const b = ensure(idx, () => ({ type: "tool_use", id: "", name: "", input: {} }));
        if (b.type === "tool_use") {
          b.__json = (b.__json ?? "") + (ev.delta ?? "");
          onSegment({ kind: "tool_call", index: idx, argsDelta: ev.delta ?? "" });
        }
        break;
      }
      case "response.output_item.done": {
        const item = ev.item ?? {};
        if (item.type === "function_call") {
          const b = ensure(idx, () => ({ type: "tool_use", id: item.call_id ?? "", name: item.name ?? "", input: {} }));
          if (b.type === "tool_use") {
            b.id = item.call_id ?? item.id ?? b.id;
            b.name = item.name ?? b.name;
            try {
              b.input = item.arguments ? JSON.parse(item.arguments) : {};
            } catch {
              b.input = { __raw: item.arguments };
            }
          }
        }
        onSegment({ kind: "segment_end", index: idx });
        break;
      }
      case "response.completed":
      case "response.incomplete": {
        if (ev.type === "response.incomplete") incomplete = true;
        const u = ev.response?.usage;
        if (u) {
          usage.inputTokens = u.input_tokens ?? usage.inputTokens;
          usage.outputTokens = u.output_tokens ?? usage.outputTokens;
          usage.cacheReadTokens = u.input_tokens_details?.cached_tokens;
        }
        break;
      }
      default:
        break;
    }
  }

  const content: ContentBlock[] = [];
  for (const i of order) {
    const b = items.get(i)!;
    if (b.type === "tool_use") {
      if (b.__json) {
        try {
          b.input = JSON.parse(b.__json);
        } catch {
          /* keep */
        }
      }
      delete (b as any).__json;
    }
    if (b.type === "text" && !b.text) continue;
    if (b.type === "reasoning" && !b.text) continue;
    content.push(b);
  }

  const hasTools = content.some((b) => b.type === "tool_use");
  return {
    content,
    stopReason: incomplete ? "max_tokens" : normalizeStopReason(undefined, hasTools),
    usage,
    model: cfg.model,
  };
}
