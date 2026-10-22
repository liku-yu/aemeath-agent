import type { AemeathConfig, ApiMode } from "../config/schema.js";
import type { StreamSegment } from "../types.js";
import type { LLMProvider } from "./base.js";
import { AnthropicProvider, anthropicStream } from "./anthropic.js";
import { OpenAICompatProvider, openaiStream } from "./openai.js";
import { OpenAIResponsesProvider, openaiResponsesStream } from "./responses.js";

export type ProviderKind = "anthropic" | "openai" | "auto";

/** Decide which wire protocol to use. Explicit apiMode wins; else infer from URL. */
export function detectProvider(baseUrl: string, explicit?: ProviderKind): "anthropic" | "openai" {
  if (explicit && explicit !== "auto") return explicit;
  if (/anthropic\.com/i.test(baseUrl)) return "anthropic";
  // DeepSeek, OpenAI, Moonshot, Ollama, most gateways are OpenAI-compatible.
  return "openai";
}

/** Resolve the effective API mode from config (apiMode wins, else URL sniffing). */
export function resolveApiMode(cfg: AemeathConfig): ApiMode {
  if (cfg.apiMode === "messages") return "messages";
  if (cfg.apiMode === "responses") return "responses";
  if (cfg.apiMode === "chat") {
    // Respect an explicit "chat" even for anthropic.com (rare, but user's call).
    return "chat";
  }
  return detectProvider(cfg.baseUrl) === "anthropic" ? "messages" : "chat";
}

export function createProvider(cfg: AemeathConfig): LLMProvider {
  switch (resolveApiMode(cfg)) {
    case "messages":
      return new AnthropicProvider(cfg);
    case "responses":
      return new OpenAIResponsesProvider(cfg);
    default:
      return new OpenAICompatProvider(cfg);
  }
}

/** Streaming completion — returns final result, forwards ordered segments. */
export async function streamComplete(
  cfg: AemeathConfig,
  req: Parameters<typeof anthropicStream>[1],
  onSegment: (segment: StreamSegment) => void,
) {
  switch (resolveApiMode(cfg)) {
    case "messages":
      return anthropicStream(cfg, req, onSegment);
    case "responses":
      return openaiResponsesStream(cfg, req, onSegment);
    default:
      return openaiStream(cfg, req, onSegment);
  }
}

export type { LLMProvider };
