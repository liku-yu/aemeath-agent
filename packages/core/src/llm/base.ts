import type { LLMRequest, LLMResult, ContentBlock, StopReason, TokenUsage } from "../types.js";

export interface LLMProvider {
  readonly name: string;
  readonly model: string;
  complete(req: LLMRequest): Promise<LLMResult>;
}

/**
 * Join a base URL with an API path without duplicating a version segment.
 *
 * Users paste base URLs in many shapes:
 *   https://api.deepseek.com            + /v1/chat/completions
 *   https://api.deepseek.com/v1         + /v1/chat/completions   → must NOT become /v1/v1/...
 *   https://api.deepseek.com/v1/        → same
 *   https://host/openai/v1              → keep the /openai prefix
 *
 * So: if the base already ends with the path's version segment, drop it.
 */
export function joinApiUrl(base: string, path: string): string {
  const cleanBase = (base || "").trim().replace(/\/+$/, "");
  const versionMatch = /^(\/v\d+(?:\.\d+)?)(\/.*)?$/.exec(path);
  if (versionMatch) {
    const version = versionMatch[1];
    const rest = versionMatch[2] ?? "";
    // base already carries the same version segment → don't repeat it
    if (new RegExp(`${version.replace(".", "\\.")}$`, "i").test(cleanBase)) {
      return cleanBase + rest;
    }
  }
  return cleanBase + path;
}

/**
 * The request path for each wire protocol.
 *
 * Single source of truth: the settings UI, the connectivity probe and every
 * provider used to spell these out separately, which is exactly how a hint ends
 * up showing a URL we never actually call.
 */
export function endpointPathFor(mode: "chat" | "responses" | "messages"): string {
  if (mode === "messages") return "/v1/messages";
  if (mode === "responses") return "/v1/responses";
  return "/v1/chat/completions";
}

/** The exact URL a request will go to for this endpoint + protocol. */
export function endpointUrlFor(baseUrl: string, mode: "chat" | "responses" | "messages"): string {
  return joinApiUrl(baseUrl, endpointPathFor(mode));
}

const RETRYABLE = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((res, rej) => {
    const t = setTimeout(res, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      rej(new Error("aborted"));
    }, { once: true });
  });

/** fetch with exponential backoff + Retry-After support. */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  opts: { retries?: number; signal?: AbortSignal; onRetry?: (n: number, err: unknown) => void } = {},
): Promise<Response> {
  const retries = opts.retries ?? 4;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { ...init, signal: opts.signal });
      if (res.ok) return res;
      if (!RETRYABLE.has(res.status) || attempt === retries) return res;

      const ra = Number(res.headers.get("retry-after"));
      const wait = Number.isFinite(ra) && ra > 0 ? ra * 1000 : Math.min(8000, 500 * 2 ** attempt);
      lastErr = new Error(`HTTP ${res.status}`);
      opts.onRetry?.(attempt + 1, lastErr);
      await sleep(wait, opts.signal);
    } catch (err) {
      if (opts.signal?.aborted) throw new Error("aborted");
      lastErr = err;
      if (attempt === retries) break;
      opts.onRetry?.(attempt + 1, err);
      await sleep(Math.min(8000, 500 * 2 ** attempt), opts.signal);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** Minimal SSE line reader over a ReadableStream of bytes. */
export async function* sseLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n")) !== -1) {
        let line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        yield line;
      }
    }
    if (buf.trim()) yield buf;
  } finally {
    reader.releaseLock();
  }
}

export function emptyUsage(): TokenUsage {
  return { inputTokens: 0, outputTokens: 0 };
}

export function normalizeStopReason(raw: string | undefined | null, hasTools: boolean): StopReason {
  switch ((raw ?? "").toLowerCase()) {
    case "end_turn":
    case "stop":
    case "stop_sequence":
      return "end_turn";
    case "tool_use":
    case "tool_calls":
    case "function_call":
      return "tool_use";
    case "max_tokens":
    case "length":
      return "max_tokens";
    case "refusal":
    case "content_filter":
      return "refusal";
    default:
      return hasTools ? "tool_use" : "end_turn";
  }
}

export function isTextBlock(b: ContentBlock): b is { type: "text"; text: string } {
  return b.type === "text";
}
