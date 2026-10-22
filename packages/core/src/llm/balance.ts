import type { AemeathConfig } from "../config/schema.js";

export interface BalanceInfo {
  /** Whether a balance/quota source applies to this provider at all. */
  supported: boolean;
  /** Currency code, e.g. "CNY" / "USD". */
  currency?: string;
  /** Remaining total balance (all buckets summed), if known. */
  total?: number;
  /** Per-bucket breakdown, if the provider returns one. */
  details?: Array<{ currency: string; total: number; granted?: number; toppedUp?: number }>;
  /** True when the account cannot pay. */
  unavailable?: boolean;
  /** Human readable status / error. */
  message?: string;
  /** Where the number came from, so the UI can be honest about it. */
  source?: "api" | "local" | "none";
  /** Which balance strategy matched. */
  strategy?: string;
  /** When the balance was fetched. */
  fetchedAt: number;
}

/** Per-provider balance strategies. Adding support = adding one entry. */
interface BalanceStrategy {
  id: string;
  label: string;
  /** Does this strategy apply to the given endpoint? */
  matches(cfg: AemeathConfig): boolean;
  fetch(cfg: AemeathConfig, signal: AbortSignal | undefined, now: number): Promise<BalanceInfo>;
}

/** Join without doubling a version segment (mirrors the LLM URL builder). */
function joinUrl(base: string, path: string): string {
  const clean = (base || "").trim().replace(/\/+$/, "");
  const versionMatch = /^(\/v\d+(?:\.\d+)?)(\/.*)?$/.exec(path);
  if (versionMatch && new RegExp(`${versionMatch[1]}$`, "i").test(clean)) {
    return clean + (versionMatch[2] ?? "");
  }
  return clean + path;
}

function num(v: unknown): number | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * DeepSeek: GET /user/balance
 * { is_available, balance_infos: [{ currency, total_balance, granted_balance, topped_up_balance }] }
 */
const deepseekStrategy: BalanceStrategy = {
  id: "deepseek",
  label: "DeepSeek /user/balance",
  matches: (cfg) => /deepseek/i.test(cfg.baseUrl) || /deepseek/i.test(cfg.provider ?? ""),
  async fetch(cfg, signal, now) {
    return getJsonBalance(cfg, joinUrl(cfg.baseUrl, "/user/balance"), signal, now, (data) => {
      const details = (data.balance_infos ?? []).map((b: any) => ({
        currency: b.currency ?? "CNY",
        total: num(b.total_balance) ?? 0,
        granted: num(b.granted_balance),
        toppedUp: num(b.topped_up_balance),
      }));
      return {
        currency: details[0]?.currency,
        total: details.length ? details.reduce((s: number, d: any) => s + d.total, 0) : undefined,
        details,
        unavailable: data.is_available === false,
        message: data.is_available === false ? "账户余额不足" : undefined,
      };
    });
  },
};

/**
 * OpenRouter: GET /api/v1/credits (or /v1/credits)
 * { data: { total_credits, total_usage } } → remaining = total - usage
 */
const openrouterStrategy: BalanceStrategy = {
  id: "openrouter",
  label: "OpenRouter /credits",
  matches: (cfg) => /openrouter/i.test(cfg.baseUrl) || /openrouter/i.test(cfg.provider ?? ""),
  async fetch(cfg, signal, now) {
    for (const path of ["/api/v1/credits", "/v1/credits", "/credits"]) {
      const out = await getJsonBalance(cfg, joinUrl(cfg.baseUrl, path), signal, now, (data) => {
        const d = data?.data ?? data;
        const totalCredits = num(d?.total_credits);
        const used = num(d?.total_usage);
        if (totalCredits === undefined) return undefined;
        const remaining = totalCredits - (used ?? 0);
        return { currency: "USD", total: remaining, unavailable: remaining <= 0 };
      });
      if (out.supported && out.total !== undefined) return out;
    }
    return { supported: false, message: "OpenRouter 余额接口不可用", fetchedAt: now };
  },
};

/**
 * Moonshot: GET /v1/users/me/balance
 * { data: { available_balance, voucher_balance, cash_balance } }
 */
const moonshotStrategy: BalanceStrategy = {
  id: "moonshot",
  label: "Moonshot /users/me/balance",
  matches: (cfg) => /moonshot/i.test(cfg.baseUrl) || /moonshot/i.test(cfg.provider ?? ""),
  async fetch(cfg, signal, now) {
    return getJsonBalance(cfg, joinUrl(cfg.baseUrl, "/v1/users/me/balance"), signal, now, (data) => {
      const d = data?.data ?? data;
      const total = num(d?.available_balance);
      if (total === undefined) return undefined;
      return { currency: "CNY", total, unavailable: total <= 0 };
    });
  },
};

/**
 * SiliconFlow: GET /v1/user/info
 * { data: { totalBalance, chargeBalance, balance } }  (balance is a string like "12.34")
 */
const siliconflowStrategy: BalanceStrategy = {
  id: "siliconflow",
  label: "SiliconFlow /user/info",
  matches: (cfg) => /siliconflow/i.test(cfg.baseUrl) || /siliconflow/i.test(cfg.provider ?? ""),
  async fetch(cfg, signal, now) {
    return getJsonBalance(cfg, joinUrl(cfg.baseUrl, "/v1/user/info"), signal, now, (data) => {
      const d = data?.data ?? data;
      const total = num(d?.totalBalance) ?? num(d?.balance);
      if (total === undefined) return undefined;
      return { currency: "CNY", total, unavailable: total <= 0 };
    });
  },
};

/**
 * Generic OpenAI-compatible probes, tried last for unknown providers.
 * Many gateways (one-api / new-api / v3 forks) expose one of these.
 */
const genericStrategy: BalanceStrategy = {
  id: "generic",
  label: "通用 /dashboard/billing · /user/balance · /user/info",
  matches: () => true,
  async fetch(cfg, signal, now) {
    const attempts: Array<{ path: string; map: (data: any) => Partial<BalanceInfo> | undefined }> = [
      {
        // one-api / new-api family: quota is a large integer scaled by 500000
        path: "/dashboard/billing/subscription",
        map: (data) => {
          const quota = num(data?.hard_limit_usd) ?? num(data?.soft_limit_usd) ?? num(data?.system_hard_limit_usd);
          if (quota === undefined) return undefined;
          return { currency: "USD", total: quota, unavailable: quota <= 0 };
        },
      },
      {
        path: "/dashboard/billing/credit_grants",
        map: (data) => {
          const total = num(data?.total_available) ?? num(data?.total_granted);
          if (total === undefined) return undefined;
          return { currency: "USD", total, unavailable: total <= 0 };
        },
      },
      {
        // new-api style: { data: { quota } } where quota/500000 = USD
        path: "/api/user/self",
        map: (data) => {
          const quota = num(data?.data?.quota);
          if (quota === undefined) return undefined;
          const usd = quota / 500000;
          return { currency: "USD", total: usd, unavailable: usd <= 0 };
        },
      },
      {
        path: "/api/user/self/groups",
        map: (data) => {
          const quota = num(data?.data?.quota);
          if (quota === undefined) return undefined;
          const usd = quota / 500000;
          return { currency: "USD", total: usd, unavailable: usd <= 0 };
        },
      },
      {
        path: "/user/balance",
        map: (data) => {
          const details = (data?.balance_infos ?? []).map((b: any) => ({
            currency: b.currency ?? "CNY",
            total: num(b.total_balance) ?? 0,
          }));
          if (!details.length) return undefined;
          return { currency: details[0].currency, total: details.reduce((s: number, d: any) => s + d.total, 0), details };
        },
      },
      {
        path: "/user/info",
        map: (data) => {
          const d = data?.data ?? data;
          const total = num(d?.totalBalance) ?? num(d?.balance);
          if (total === undefined) return undefined;
          return { currency: "CNY", total, unavailable: total <= 0 };
        },
      },
      {
        // new-api usage/credits variant
        path: "/api/usage/credits",
        map: (data) => {
          const d = data?.data ?? data;
          const total = num(d?.remaining) ?? num(d?.balance);
          if (total === undefined) return undefined;
          return { currency: "USD", total, unavailable: total <= 0 };
        },
      },
    ];

    for (const a of attempts) {
      const res = await getJsonBalance(cfg, joinUrl(cfg.baseUrl, a.path), signal, now, a.map, true);
      // A successful JSON parse with a mapped value is a hit.
      if (res.supported && res.total !== undefined) {
        return { ...res, strategy: `generic ${a.path}` };
      }
    }
    return { supported: false, message: "该供应商没有公开的余额接口", fetchedAt: now };
  },
};

/** Strategies in priority order (first match wins). */
const STRATEGIES: BalanceStrategy[] = [
  deepseekStrategy,
  openrouterStrategy,
  moonshotStrategy,
  siliconflowStrategy,
  genericStrategy,
];

/**
 * Query the configured provider for its remaining balance / quota.
 *
 * The endpoint differs per vendor, so this tries a registry of strategies.
 * Unknown providers fall through to a set of generic OpenAI-compatible probes;
 * if none work the caller gets `supported:false` and should show local usage
 * instead (see `UsageTracker`), which is what mature harnesses do.
 */
/**
 * How long the whole probe may take.
 *
 * A balance endpoint is optional decoration; it must never hold a request open
 * indefinitely. Gateways that ignore unknown paths can otherwise leave the fetch
 * pending forever, and this runs on a timer and after every settings save.
 */
const BALANCE_TIMEOUT_MS = 8_000;

export async function fetchBalance(
  cfg: AemeathConfig,
  signal?: AbortSignal,
  opts: { timeoutMs?: number } = {},
): Promise<BalanceInfo> {
  const timeoutMs = opts.timeoutMs ?? BALANCE_TIMEOUT_MS;
  const now = Date.now();
  if (!cfg.apiKey) {
    return { supported: false, source: "none", message: "未配置 API Key", fetchedAt: now };
  }
  if (!cfg.baseUrl) {
    return { supported: false, source: "none", message: "未配置 Base URL", fetchedAt: now };
  }

  const strategy = STRATEGIES.find((s) => s.matches(cfg)) ?? genericStrategy;

  // One deadline for every attempt the chosen strategy makes.
  const timed = new AbortController();
  const timer = setTimeout(() => timed.abort(), timeoutMs);
  const onAbort = () => timed.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  const bounded: AbortSignal = timed.signal;

  try {
    // A user-declared provider may name its own balance endpoint — honour it first.
    const customPath = cfg.customProviders?.[cfg.provider ?? ""]?.balancePath;
    if (customPath) {
      const res = await getJsonBalance(cfg, joinUrl(cfg.baseUrl, customPath), bounded, now, (data) => {
        // Accept the common shapes for an arbitrary endpoint.
        const d = data?.data ?? data;
        const total =
          num(d?.total_balance) ??
          num(d?.available_balance) ??
          num(d?.balance) ??
          num(d?.totalBalance) ??
          num(d?.quota);
        const details = (data?.balance_infos ?? []).map((b: any) => ({
          currency: b.currency ?? "CNY",
          total: num(b.total_balance) ?? 0,
        }));
        if (details.length) {
          return { currency: details[0].currency, total: details.reduce((s: number, x: any) => s + x.total, 0), details };
        }
        if (total === undefined) return undefined;
        return { currency: "CNY", total, unavailable: total <= 0 };
      });
      if (res.supported && res.total !== undefined) {
        return { source: "api", strategy: `自定义 ${customPath}`, ...res, fetchedAt: now };
      }
    }

    const info = await strategy.fetch(cfg, bounded, now);

    /*
     * Each strategy funnels its own errors into a `message`, and an abort looks
     * like any other fetch failure from in there. Report the deadline explicitly
     * so the UI can say "timed out" rather than echoing a raw abort string.
     */
    if (timed.signal.aborted && info.total === undefined) {
      return {
        supported: true,
        source: "none",
        strategy: strategy.label,
        message: `余额查询超时（${timeoutMs / 1000}s）`,
        fetchedAt: now,
      };
    }
    return { source: info.total !== undefined ? "api" : "none", strategy: strategy.label, ...info, fetchedAt: now };
  } catch (err) {
    const aborted = timed.signal.aborted;
    return {
      supported: true,
      source: "none",
      strategy: strategy.label,
      message: aborted
        ? `余额查询超时（${timeoutMs / 1000}s）`
        : `余额查询异常: ${err instanceof Error ? err.message : String(err)}`,
      fetchedAt: now,
    };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

/** GET JSON and map it; with `quiet` a failure returns supported:false instead of an error message. */
async function getJsonBalance(
  cfg: AemeathConfig,
  url: string,
  signal: AbortSignal | undefined,
  now: number,
  map: (data: any) => Partial<BalanceInfo> | undefined,
  quiet = false,
): Promise<BalanceInfo> {
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        authorization: `Bearer ${cfg.apiKey}`,
        accept: "application/json",
      },
      signal,
    });
    if (!res.ok) {
      if (quiet) return { supported: false, fetchedAt: now };
      const text = await res.text().catch(() => "");
      return {
        supported: true,
        message: `余额查询失败 (${res.status})${text ? ": " + text.slice(0, 120) : ""}`,
        fetchedAt: now,
      };
    }
    const data = await res.json().catch(() => undefined);
    const mapped = map(data);
    if (!mapped) return { supported: quiet ? false : true, message: quiet ? undefined : "响应里没有可识别的余额字段", fetchedAt: now };
    return { supported: true, ...mapped, fetchedAt: now } as BalanceInfo;
  } catch (err) {
    if (quiet) return { supported: false, fetchedAt: now };
    return {
      supported: true,
      message: `余额查询异常: ${err instanceof Error ? err.message : String(err)}`,
      fetchedAt: now,
    };
  }
}

/** Format a balance for compact display, e.g. "¥12.34". */
export function formatBalance(info: BalanceInfo): string {
  if (!info.supported) return "—";
  if (info.total === undefined) return info.message ? "查询失败" : "—";
  const symbol = info.currency === "USD" ? "$" : info.currency === "CNY" ? "¥" : "";
  return `${symbol}${info.total.toFixed(2)}`;
}
