import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeKey } from "./fake.js";
import { modelScopeKey, keyFingerprint } from "../config/schema.js";
import { listModels } from "../llm/models.js";
import { defaultConfig } from "../config/schema.js";

/* ----------------------------- scope keys -------------------------------- */

test("the same provider with different keys is a different scope", () => {
  const a = { provider: "custom", baseUrl: "https://gw.example.com/v1", apiKey: fakeKey("a") };
  const b = { provider: "custom", baseUrl: "https://gw.example.com/v1", apiKey: fakeKey("b") };
  // Different plans/groupings under one provider really do expose different
  // model sets, so the cache key MUST differ.
  assert.notEqual(modelScopeKey(a), modelScopeKey(b));
});

test("the same key + endpoint is one scope regardless of URL cosmetics", () => {
  const a = { provider: "custom", baseUrl: "https://gw.example.com/v1", apiKey: "k" };
  const b = { provider: "custom", baseUrl: "https://gw.example.com/v1/", apiKey: "k" };
  const c = { provider: "custom", baseUrl: "HTTPS://GW.EXAMPLE.COM/v1", apiKey: "k" };
  assert.equal(modelScopeKey(a), modelScopeKey(b));
  assert.equal(modelScopeKey(a), modelScopeKey(c));
});

test("scope keys never contain the plaintext key", () => {
  const secret = fakeKey("super-secret");
  const scope = modelScopeKey({ provider: "custom", baseUrl: "https://x.example.com", apiKey: secret });
  assert.equal(scope.includes(secret), false);
  assert.equal(scope.includes("super"), false);
});

test("a different base URL is a different scope", () => {
  const a = modelScopeKey({ provider: "custom", baseUrl: "https://a.example.com", apiKey: "k" });
  const b = modelScopeKey({ provider: "custom", baseUrl: "https://b.example.com", apiKey: "k" });
  assert.notEqual(a, b);
});

test("keyFingerprint is stable and distinguishes keys", () => {
  assert.equal(keyFingerprint("abc"), keyFingerprint("abc"));
  assert.notEqual(keyFingerprint("abc"), keyFingerprint("abd"));
  assert.equal(keyFingerprint(""), "nokey");
  assert.equal(keyFingerprint(undefined), "nokey");
});

/* ------------------------- detection honesty ----------------------------- */

test("detection failure is reported as failure, never a guessed list", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response("nope", { status: 404 })) as any;
  try {
    const res = await listModels({
      ...defaultConfig(),
      provider: "custom",
      baseUrl: "https://gw.example.com/v1",
      apiKey: "k",
    });
    assert.equal(res.ok, false);
    // Absolutely no fabricated models.
    assert.deepEqual(res.models, []);
    assert.ok(res.error, "must explain why");
    assert.ok(res.hint, "must suggest what to do");
  } finally {
    globalThis.fetch = original;
  }
});

test("an empty model payload counts as failure, not as zero models", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ data: [] }), { status: 200 })) as any;
  try {
    const res = await listModels({
      ...defaultConfig(),
      provider: "custom",
      baseUrl: "https://gw.example.com/v1",
      apiKey: "k",
    });
    assert.equal(res.ok, false);
    assert.deepEqual(res.models, []);
    assert.match(res.hint ?? "", /手动|模型列表/);
  } finally {
    globalThis.fetch = original;
  }
});

test("401 explains that the key may lack list permission", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response("unauthorized", { status: 401 })) as any;
  try {
    const res = await listModels({
      ...defaultConfig(),
      provider: "custom",
      baseUrl: "https://gw.example.com/v1",
      apiKey: "k",
    });
    assert.equal(res.ok, false);
    assert.match(res.error ?? "", /不能列出模型|鉴权/);
    assert.match(res.hint ?? "", /权限|分组|计划|Key/);
  } finally {
    globalThis.fetch = original;
  }
});

test("a successful detection reports exactly what the endpoint returned", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ data: [{ id: "only-this-one" }] }), { status: 200 })) as any;
  try {
    const res = await listModels({
      ...defaultConfig(),
      provider: "custom",
      baseUrl: "https://gw.example.com/v1",
      apiKey: "k",
    });
    assert.equal(res.ok, true);
    // No extra "default model" sneaked in.
    assert.deepEqual(res.models.map((m) => m.id), ["only-this-one"]);
  } finally {
    globalThis.fetch = original;
  }
});
