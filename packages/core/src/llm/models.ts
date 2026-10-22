import type { AemeathConfig } from "../config/schema.js";
import { joinApiUrl } from "./base.js";
import { resolveApiMode } from "./factory.js";

export interface ModelInfo {
  /** Model id to send in requests. */
  id: string;
  /** Human-friendly label, when the provider supplies one. */
  label?: string;
  /** Owner / vendor, when supplied. */
  ownedBy?: string;
  /** Context window, when the provider advertises it. */
  contextLength?: number;
}

export interface ListModelsResult {
  ok: boolean;
  /** Discovered models, sorted by id. */
  models: ModelInfo[];
  /** Endpoint that was queried. */
  url?: string;
  /** How many endpoints were tried (for debugging). */
  tried?: string[];
  /** Error / hint when discovery fails. */
  error?: string;
  hint?: string;
}

/** Read a JWT/opaque token's exp claim, when it is a JWT. */
function jwtExpired(token: string): boolean | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64").toString("utf8")) as { exp?: number };
    if (typeof payload.exp !== "number") return null;
    return payload.exp * 1000 < Date.now();
  } catch {
    return null;
  }
}

/**
 * Discover the models a provider offers.
 *
 * Strategy: try the OpenAI-compatible `/v1/models` first (most gateways support
 * it), then Ollama's native `/api/tags`. Every candidate is tried with the same
 * credentials, and the first success wins.
 */
export async function listModels(
  cfg: AemeathConfig,
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<ListModelsResult> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  opts.signal?.addEventListener("abort", onAbort, { once: true });

  const headers: Record<string, string> = { accept: "application/json" };
  if (cfg.apiKey) {
    headers["authorization"] = `Bearer ${cfg.apiKey}`;
    if (resolveApiMode(cfg) === "messages") {
      headers["x-api-key"] = cfg.apiKey;
      headers["anthropic-version"] = "2023-06-01";
    }
  }

  const candidates: string[] = [
    joinApiUrl(cfg.baseUrl, "/v1/models"),
    // Some gateways expose models at the bare root.
    `${(cfg.baseUrl || "").replace(/\/+$/, "")}/models`,
  ];
  // Ollama's native listing (also works when running locally without a key).
  if (/localhost|127\.0\.0\.1/.test(cfg.baseUrl) || /ollama/i.test(cfg.baseUrl)) {
    candidates.push(`${(cfg.baseUrl || "").replace(/\/+$/, "")}/api/tags`);
  }

  const tried: string[] = [];
  let lastError = "";
  let lastStatus: number | undefined;

  try {
    for (const url of candidates) {
      tried.push(url);
      let res: Response;
      try {
        res = await fetch(url, { method: "GET", headers, signal: controller.signal });
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        continue;
      }
      if (!res.ok) {
        lastStatus = res.status;
        lastError = `HTTP ${res.status}`;
        // A 401/403 will not improve on another path — stop early.
        if (res.status === 401 || res.status === 403) break;
        continue;
      }

      let data: any;
      try {
        data = await res.json();
      } catch {
        lastError = "响应不是合法 JSON";
        continue;
      }

      const models = normalizeModels(data);
      if (models.length) {
        return { ok: true, models, url, tried };
      }
      lastError = "响应里没有解析到模型列表";
    }

    // Diagnose precisely. We never fall back to a guessed model list: if the
    // endpoint does not tell us, the answer is "detection failed".
    let hint: string;
    let reason: string;
    if (lastStatus === 401 || lastStatus === 403) {
      const expired = cfg.apiKey ? jwtExpired(cfg.apiKey) : null;
      reason = "这个 Key 不能列出模型（鉴权失败）";
      hint =
        expired === true
          ? "这个 Key 看起来是 JWT，且已过期，请重新获取。"
          : "检查 API Key 是否正确、完整，以及它是否有权限列出模型。有些分组/计划不开放该接口。";
    } else if (lastStatus === 404) {
      reason = "该地址没有模型列表接口";
      hint = "Base URL 可能多了或少了 /v1；也可能这个供应商根本不提供 /v1/models。";
    } else if (/fetch failed|ENOTFOUND|ECONNREFUSED|abort|timeout/i.test(lastError)) {
      reason = "网络不通或超时";
      hint = "检查 Base URL、代理，或本机服务是否已启动。";
    } else if (lastStatus) {
      reason = `接口返回 ${lastStatus}`;
      hint = "该端点没有给出可解析的模型列表。";
    } else {
      reason = "接口返回的内容里没有可解析的模型列表";
      hint = "该供应商可能不提供模型列表接口，请用「＋ 手动」填写准确的模型名。";
    }
    return {
      ok: false,
      models: [],
      url: tried[tried.length - 1],
      tried,
      error: reason,
      hint,
    };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
  }
}

/** Accept the shapes used by OpenAI, Anthropic, Ollama and common gateways. */
function normalizeModels(data: any): ModelInfo[] {
  const out: ModelInfo[] = [];
  const push = (id: unknown, label?: unknown, ownedBy?: unknown, ctx?: unknown) => {
    if (typeof id !== "string" || !id.trim()) return;
    out.push({
      id: id.trim(),
      label: typeof label === "string" && label.trim() ? label.trim() : undefined,
      ownedBy: typeof ownedBy === "string" && ownedBy.trim() ? ownedBy.trim() : undefined,
      contextLength: typeof ctx === "number" && ctx > 0 ? ctx : undefined,
    });
  };

  // OpenAI / Anthropic / most gateways: { data: [{ id, ... }] }
  if (Array.isArray(data?.data)) {
    for (const m of data.data) {
      push(m?.id ?? m?.name, m?.display_name ?? m?.displayName, m?.owned_by ?? m?.ownedBy, m?.context_length ?? m?.context_window);
    }
  }
  // Ollama: { models: [{ name, model }] }
  if (Array.isArray(data?.models)) {
    for (const m of data.models) {
      push(m?.id ?? m?.model ?? m?.name, m?.name, undefined, m?.context_length);
    }
  }
  // Bare array
  if (Array.isArray(data)) {
    for (const m of data) {
      if (typeof m === "string") push(m);
      else push(m?.id ?? m?.name, m?.display_name, m?.owned_by);
    }
  }

  // Dedupe by id, then sort.
  const seen = new Map<string, ModelInfo>();
  for (const m of out) if (!seen.has(m.id)) seen.set(m.id, m);
  return [...seen.values()].sort((a, b) => a.id.localeCompare(b.id));
}
