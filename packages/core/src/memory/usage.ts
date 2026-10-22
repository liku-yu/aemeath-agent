import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Local usage accounting.
 *
 * Providers without a public balance endpoint (most custom gateways) can still
 * be monitored: we record every request's token usage locally and let the UI
 * show spend/usage instead of a balance. This mirrors what mature harnesses do
 * (e.g. ZCode reads its own `model_usage` table when no quota API exists).
 */
export interface UsageEntry {
  ts: number;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** Cache-related tokens, when the provider reports them. */
  cacheReadTokens?: number;
  /** Number of requests aggregated into this entry. */
  requests: number;
}

export interface UsageSummary {
  inputTokens: number;
  outputTokens: number;
  requests: number;
  /** Earliest timestamp included. */
  since?: number;
  /** Per-model breakdown, sorted by total tokens desc. */
  byModel: Array<{ model: string; inputTokens: number; outputTokens: number; requests: number }>;
}

/** Rolling window kept on disk; older entries are pruned. */
const MAX_ENTRIES = 2000;
const MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

export class UsageTracker {
  private entries: UsageEntry[] = [];

  constructor(private file: string) {
    this.load();
  }

  static open(dataDir: string): UsageTracker {
    return new UsageTracker(join(dataDir, "usage.json"));
  }

  private load() {
    try {
      if (!existsSync(this.file)) return;
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as UsageEntry[];
      const cutoff = Date.now() - MAX_AGE_MS;
      this.entries = (Array.isArray(raw) ? raw : []).filter((e) => e && e.ts >= cutoff);
    } catch {
      this.entries = [];
    }
  }

  private persist() {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify(this.entries.slice(-MAX_ENTRIES)), "utf8");
    } catch {
      /* best-effort */
    }
  }

  /** Record one completed request. */
  record(entry: Omit<UsageEntry, "ts" | "requests"> & { ts?: number }): void {
    this.entries.push({ ...entry, ts: entry.ts ?? Date.now(), requests: 1 });
    if (this.entries.length > MAX_ENTRIES) this.entries = this.entries.slice(-MAX_ENTRIES);
    this.persist();
  }

  /** Aggregate usage, optionally restricted to a provider and/or a time window. */
  summary(opts: { provider?: string; sinceMs?: number } = {}): UsageSummary {
    const since = opts.sinceMs ? Date.now() - opts.sinceMs : 0;
    const rows = this.entries.filter((e) => (!opts.provider || e.provider === opts.provider) && e.ts >= since);

    const byModel = new Map<string, { inputTokens: number; outputTokens: number; requests: number }>();
    let inputTokens = 0;
    let outputTokens = 0;
    let requests = 0;
    let earliest: number | undefined;

    for (const e of rows) {
      inputTokens += e.inputTokens || 0;
      outputTokens += e.outputTokens || 0;
      requests += e.requests || 0;
      earliest = earliest === undefined ? e.ts : Math.min(earliest, e.ts);
      const cur = byModel.get(e.model) ?? { inputTokens: 0, outputTokens: 0, requests: 0 };
      cur.inputTokens += e.inputTokens || 0;
      cur.outputTokens += e.outputTokens || 0;
      cur.requests += e.requests || 0;
      byModel.set(e.model, cur);
    }

    return {
      inputTokens,
      outputTokens,
      requests,
      since: earliest,
      byModel: [...byModel.entries()]
        .map(([model, v]) => ({ model, ...v }))
        .sort((a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens)),
    };
  }

  /** Wipe recorded usage. */
  clear() {
    this.entries = [];
    this.persist();
  }
}

/**
 * Estimate a cost from usage when the provider publishes per-1M-token prices.
 * Unknown models return undefined rather than a made-up number.
 */
export function estimateCostUsd(
  model: string,
  usage: { inputTokens: number; outputTokens: number },
  pricing: Record<string, { input: number; output: number }>,
): number | undefined {
  const p = pricing[model];
  if (!p) return undefined;
  return (usage.inputTokens / 1_000_000) * p.input + (usage.outputTokens / 1_000_000) * p.output;
}
