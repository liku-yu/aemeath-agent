import { test } from "node:test";
import assert from "node:assert/strict";
import { listModels } from "../llm/models.js";
import { defaultConfig } from "../config/schema.js";

function cfg(over: Partial<ReturnType<typeof defaultConfig>> = {}) {
  return { ...defaultConfig(), apiKey: "k", baseUrl: "https://api.example.com", ...over };
}

test("listModels parses the OpenAI-compatible shape", async () => {
  const original = globalThis.fetch;
  let calledUrl = "";
  globalThis.fetch = (async (url: any) => {
    calledUrl = String(url);
    return new Response(
      JSON.stringify({
        data: [
          { id: "deepseek-chat", owned_by: "deepseek" },
          { id: "deepseek-reasoner", owned_by: "deepseek" },
          { id: "deepseek-chat" }, // duplicate must be dropped
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as any;
  try {
    const res = await listModels(cfg());
    assert.equal(res.ok, true);
    assert.deepEqual(res.models.map((m) => m.id), ["deepseek-chat", "deepseek-reasoner"]);
    assert.equal(calledUrl, "https://api.example.com/v1/models");
  } finally {
    globalThis.fetch = original;
  }
});

test("listModels keeps the /v1 prefix exactly once", async () => {
  const original = globalThis.fetch;
  let calledUrl = "";
  globalThis.fetch = (async (url: any) => {
    calledUrl = String(url);
    return new Response(JSON.stringify({ data: [{ id: "m" }] }), { status: 200 });
  }) as any;
  try {
    await listModels(cfg({ baseUrl: "https://api.example.com/v1" }));
    assert.equal(calledUrl, "https://api.example.com/v1/models");
    await listModels(cfg({ baseUrl: "https://api.example.com/v1/" }));
    assert.equal(calledUrl, "https://api.example.com/v1/models");
    await listModels(cfg({ baseUrl: "https://gateway.test/openai/v1" }));
    assert.equal(calledUrl, "https://gateway.test/openai/v1/models");
  } finally {
    globalThis.fetch = original;
  }
});

test("listModels parses Ollama's native shape", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ models: [{ name: "qwen2.5:14b", model: "qwen2.5:14b" }, { name: "llama3" }] }), {
      status: 200,
    })) as any;
  try {
    const res = await listModels(cfg({ baseUrl: "http://localhost:11434", apiKey: "" }));
    assert.equal(res.ok, true);
    assert.deepEqual(res.models.map((m) => m.id).sort(), ["llama3", "qwen2.5:14b"]);
  } finally {
    globalThis.fetch = original;
  }
});

test("listModels falls back to the bare /models when /v1/models 404s", async () => {
  const original = globalThis.fetch;
  const tried: string[] = [];
  globalThis.fetch = (async (url: any) => {
    tried.push(String(url));
    if (String(url).endsWith("/v1/models")) return new Response("nope", { status: 404 });
    return new Response(JSON.stringify({ data: [{ id: "gpt-x" }] }), { status: 200 });
  }) as any;
  try {
    const res = await listModels(cfg());
    assert.equal(res.ok, true);
    assert.deepEqual(res.models.map((m) => m.id), ["gpt-x"]);
    assert.equal(tried.length, 2);
  } finally {
    globalThis.fetch = original;
  }
});

test("listModels gives actionable hints on auth failure", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response("unauthorized", { status: 401 })) as any;
  try {
    const res = await listModels(cfg({ apiKey: "bad" }));
    assert.equal(res.ok, false);
    assert.match(res.hint ?? "", /Key/);
  } finally {
    globalThis.fetch = original;
  }
});

test("listModels flags an expired JWT key", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response("unauthorized", { status: 401 })) as any;
  try {
    // {"exp": 1} — long expired
    const expired = "a." + Buffer.from(JSON.stringify({ exp: 1 })).toString("base64url") + ".c";
    const res = await listModels(cfg({ apiKey: expired }));
    assert.equal(res.ok, false);
    assert.match(res.hint ?? "", /过期/);
  } finally {
    globalThis.fetch = original;
  }
});
