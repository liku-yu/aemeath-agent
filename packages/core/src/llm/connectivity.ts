import type { AemeathConfig } from "../config/schema.js";
import { endpointUrlFor } from "./base.js";
import { resolveApiMode } from "./factory.js";

export interface ConnectivityResult {
  ok: boolean;
  /** The endpoint actually called (after normalising the base URL). */
  url: string;
  /** Which protocol was used. */
  apiMode: string;
  /** HTTP status, when a response was received. */
  status?: number;
  /** Round-trip time in ms. */
  ms: number;
  /** Model echoed back by the provider, when available. */
  model?: string;
  /** Short sample of the model's reply, to prove end-to-end inference. */
  sample?: string;
  /** Token usage from the probe request. */
  usage?: { inputTokens: number; outputTokens: number };
  /** Human-readable diagnosis on failure. */
  error?: string;
  /** Actionable suggestion when the failure is recognisable. */
  hint?: string;
}

/** Turn an HTTP failure into a diagnosis + a concrete suggestion. */
function diagnose(status: number, body: string): { error: string; hint: string } {
  const brief = body.replace(/\s+/g, " ").slice(0, 300);
  switch (status) {
    case 401:
      return {
        error: `401 鉴权失败：${brief}`,
        hint: "API Key 不正确或已失效，请检查是否复制完整（不要带多余空格）。",
      };
    case 402:
      return { error: `402 需要付费：${brief}`, hint: "账户余额不足，请在服务商后台充值。" };
    case 403:
      return { error: `403 被拒绝：${brief}`, hint: "Key 无权访问该模型，或该地区/IP 被限制。" };
    case 404:
      return {
        error: `404 路径不存在：${brief}`,
        hint: "Base URL 很可能多了或少了 /v1。可以试试在末尾加/去掉 /v1。",
      };
    case 429:
      return { error: `429 触发限流：${brief}`, hint: "请求太频繁或超出配额，稍后再试。" };
    default:
      if (status >= 500) return { error: `${status} 服务端错误：${brief}`, hint: "对方服务异常，不是你的配置问题，稍后重试。" };
      return { error: `${status} 请求失败：${brief}`, hint: "检查 Base URL、模型名与网络。" };
  }
}

/**
 * Probe the configured endpoint with a minimal real request.
 *
 * This intentionally performs a *real* API call, so the caller must have
 * obtained the user's permission (see the global API-key rule).
 */
export async function testConnectivity(
  cfg: AemeathConfig,
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<ConnectivityResult> {
  const started = Date.now();
  const mode = resolveApiMode(cfg);
  const timeoutMs = opts.timeoutMs ?? 20_000;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  opts.signal?.addEventListener("abort", onAbort, { once: true });

  // `mode` is the resolved protocol (a provider may force one), so use it here
  // rather than cfg.apiMode.
  const url = endpointUrlFor(cfg.baseUrl, mode);

  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cfg.apiKey) {
    if (mode === "messages") {
      headers["x-api-key"] = cfg.apiKey;
      headers["anthropic-version"] = "2023-06-01";
      headers["authorization"] = `Bearer ${cfg.apiKey}`;
    } else {
      headers["authorization"] = `Bearer ${cfg.apiKey}`;
    }
  }

  // A tiny, cheap request: ask for one short word.
  const body =
    mode === "messages"
      ? { model: cfg.model, max_tokens: 16, messages: [{ role: "user", content: "ping" }] }
      : mode === "responses"
        ? { model: cfg.model, max_output_tokens: 16, input: "ping" }
        : {
            model: cfg.model,
            max_tokens: 16,
            messages: [{ role: "user", content: "ping" }],
          };

  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const ms = Date.now() - started;
    const text = await res.text().catch(() => "");

    if (!res.ok) {
      const { error, hint } = diagnose(res.status, text);
      return { ok: false, url, apiMode: mode, status: res.status, ms, error, hint };
    }

    // Parse just enough to prove inference happened.
    let sample = "";
    let model: string | undefined;
    let usage: { inputTokens: number; outputTokens: number } | undefined;
    try {
      const data = JSON.parse(text) as any;
      model = data.model;
      if (data.usage) {
        usage = {
          inputTokens: data.usage.input_tokens ?? data.usage.prompt_tokens ?? 0,
          outputTokens: data.usage.output_tokens ?? data.usage.completion_tokens ?? 0,
        };
      }
      if (mode === "messages") {
        sample = (data.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
      } else if (mode === "responses") {
        sample = (data.output ?? [])
          .flatMap((o: any) => o.content ?? [])
          .filter((c: any) => c.type === "output_text")
          .map((c: any) => c.text)
          .join("");
      } else {
        sample = data.choices?.[0]?.message?.content ?? "";
      }
    } catch {
      sample = text.slice(0, 120);
    }

    return { ok: true, url, apiMode: mode, status: res.status, ms, model, sample: sample.trim().slice(0, 120), usage };
  } catch (err) {
    const ms = Date.now() - started;
    const msg = err instanceof Error ? err.message : String(err);
    if (/abort/i.test(msg)) {
      return {
        ok: false,
        url,
        apiMode: mode,
        ms,
        error: `请求超时（${timeoutMs / 1000}s）`,
        hint: "网络不通或地址错误。检查 Base URL 是否可达、是否需要代理。",
      };
    }
    return {
      ok: false,
      url,
      apiMode: mode,
      ms,
      error: `网络错误: ${msg}`,
      hint: "通常是地址写错、DNS 解析失败、或需要代理。也可能是自签名证书被拒绝。",
    };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
  }
}
