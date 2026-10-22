import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchBalance } from "../llm/balance.js";
import { UsageTracker } from "../memory/usage.js";
import { defaultConfig } from "../config/schema.js";

const base = () => ({ ...defaultConfig(), apiKey: "k" });

/** Serve canned JSON per URL suffix. */
function stubFetch(routes: Record<string, { status?: number; body?: unknown }>) {
  const calls: string[] = [];
  globalThis.fetch = (async (url: any) => {
    const u = String(url);
    calls.push(u);
    for (const [suffix, r] of Object.entries(routes)) {
      if (u.endsWith(suffix)) {
        return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200 });
      }
    }
    return new Response("not found", { status: 404 });
  }) as any;
  return calls;
}

test("deepseek balance is parsed from /user/balance", async () => {
  const original = globalThis.fetch;
  const calls = stubFetch({
    "/user/balance": {
      body: { is_available: true, balance_infos: [{ currency: "CNY", total_balance: "42.50", granted_balance: "2.5" }] },
    },
  });
  try {
    const info = await fetchBalance({ ...base(), baseUrl: "https://api.deepseek.com", provider: "deepseek" });
    assert.equal(info.supported, true);
    assert.equal(info.total, 42.5);
    assert.equal(info.currency, "CNY");
    assert.equal(info.source, "api");
    assert.ok(calls[0].endsWith("/user/balance"));
  } finally {
    globalThis.fetch = original;
  }
});

test("openrouter credits become a remaining balance", async () => {
  const original = globalThis.fetch;
  stubFetch({ "/credits": { body: { data: { total_credits: 10, total_usage: 3.25 } } } });
  try {
    const info = await fetchBalance({ ...base(), baseUrl: "https://openrouter.ai/api", provider: "openrouter" });
    assert.equal(info.supported, true);
    assert.equal(info.total, 6.75);
    assert.equal(info.currency, "USD");
  } finally {
    globalThis.fetch = original;
  }
});

test("a custom gateway is found through the generic probes", async () => {
  const original = globalThis.fetch;
  // Only /dashboard/billing/subscription answers — the generic strategy must find it.
  stubFetch({ "/dashboard/billing/subscription": { body: { hard_limit_usd: 25.5 } } });
  try {
    const info = await fetchBalance({
      ...base(),
      provider: "custom",
      baseUrl: "https://my-gateway.example.com/v1",
    });
    assert.equal(info.supported, true);
    assert.equal(info.total, 25.5);
    assert.match(info.strategy ?? "", /generic|dashboard/);
  } finally {
    globalThis.fetch = original;
  }
});

test("a user-declared balancePath wins over the generic probes", async () => {
  const original = globalThis.fetch;
  const calls = stubFetch({ "/my/balance": { body: { data: { balance: 7.5 } } } });
  try {
    const cfg = {
      ...base(),
      provider: "mygw",
      baseUrl: "https://gw.example.com/v1",
      customProviders: { mygw: { label: "我的网关", baseUrl: "https://gw.example.com/v1", balancePath: "/my/balance" } },
    };
    const info = await fetchBalance(cfg);
    assert.equal(info.total, 7.5);
    assert.match(info.strategy ?? "", /自定义/);
    assert.ok(calls[0].endsWith("/my/balance"), "should call the declared path first");
  } finally {
    globalThis.fetch = original;
  }
});

test("unsupported provider reports honestly instead of inventing a number", async () => {
  const original = globalThis.fetch;
  stubFetch({});
  try {
    const info = await fetchBalance({ ...base(), provider: "unknown", baseUrl: "https://nothing.example.com" });
    assert.equal(info.supported, false);
    assert.equal(info.total, undefined);
    assert.match(info.message ?? "", /没有公开的余额接口/);
  } finally {
    globalThis.fetch = original;
  }
});

test("balance requires a key and a base URL", async () => {
  const noKey = await fetchBalance({ ...base(), apiKey: "", baseUrl: "https://x.example.com" });
  assert.equal(noKey.supported, false);
  assert.match(noKey.message ?? "", /API Key/);
  const noUrl = await fetchBalance({ ...base(), baseUrl: "" });
  assert.equal(noUrl.supported, false);
  assert.match(noUrl.message ?? "", /Base URL/);
});

/* ----------------------------- usage tracker ----------------------------- */

test("usage tracker aggregates per model and per provider", () => {
  const dir = mkdtempSync(join(tmpdir(), "aemeath-usage-"));
  try {
    const t = UsageTracker.open(dir);
    t.record({ provider: "custom", model: "glm-5.3", inputTokens: 100, outputTokens: 20 });
    t.record({ provider: "custom", model: "glm-5.3", inputTokens: 200, outputTokens: 40 });
    t.record({ provider: "custom", model: "kimi-k2.7", inputTokens: 50, outputTokens: 10 });
    t.record({ provider: "deepseek", model: "deepseek-chat", inputTokens: 999, outputTokens: 1 });

    const s = t.summary({ provider: "custom" });
    assert.equal(s.inputTokens, 350);
    assert.equal(s.outputTokens, 70);
    assert.equal(s.requests, 3);
    assert.equal(s.byModel[0].model, "glm-5.3");
    assert.equal(s.byModel[0].requests, 2);

    // Other providers are excluded.
    const all = t.summary();
    assert.equal(all.requests, 4);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("usage tracker survives a reload", () => {
  const dir = mkdtempSync(join(tmpdir(), "aemeath-usage2-"));
  try {
    const t1 = UsageTracker.open(dir);
    t1.record({ provider: "custom", model: "m1", inputTokens: 10, outputTokens: 5 });

    const t2 = UsageTracker.open(dir);
    const s = t2.summary({ provider: "custom" });
    assert.equal(s.requests, 1);
    assert.equal(s.inputTokens, 10);

    t2.clear();
    assert.equal(UsageTracker.open(dir).summary().requests, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
