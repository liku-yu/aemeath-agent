import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../memory/session.js";
import { joinApiUrl } from "../llm/base.js";
import { defaultConfig } from "../config/schema.js";
import { testConnectivity } from "../llm/connectivity.js";

/* ------------------------- session deletion ------------------------------ */

test("deleteSession removes the folder from disk (not just from the list)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aemeath-delsess-"));
  try {
    const s = await SessionStore.create(dir);
    await s.append({ role: "user", content: "hi" });
    const folder = join(dir, "sessions", s.id);
    assert.ok(existsSync(folder), "session folder should exist after create");

    await SessionStore.remove(dir, s.id);

    // The list must be empty AND the directory must be gone — the old
    // implementation used unlink() on a directory, which silently failed and
    // left the folder (so the session came back after a reload).
    assert.deepEqual(await SessionStore.list(dir), []);
    assert.equal(existsSync(folder), false, "session folder must be deleted");
    assert.deepEqual(readdirSync(join(dir, "sessions")), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------------------------- URL joining -------------------------------- */

test("joinApiUrl never duplicates the version segment", () => {
  // The bug: pasting a base URL that already ends in /v1 produced /v1/v1/...
  assert.equal(joinApiUrl("https://api.deepseek.com", "/v1/chat/completions"), "https://api.deepseek.com/v1/chat/completions");
  assert.equal(joinApiUrl("https://api.deepseek.com/v1", "/v1/chat/completions"), "https://api.deepseek.com/v1/chat/completions");
  assert.equal(joinApiUrl("https://api.deepseek.com/v1/", "/v1/chat/completions"), "https://api.deepseek.com/v1/chat/completions");
  // Gateway with a path prefix keeps its prefix
  assert.equal(joinApiUrl("https://token.example.invalid/v1", "/v1/chat/completions"), "https://token.example.invalid/v1/chat/completions");
  assert.equal(joinApiUrl("https://host/openai/v1", "/v1/chat/completions"), "https://host/openai/v1/chat/completions");
  // Other endpoints
  assert.equal(joinApiUrl("https://api.anthropic.com", "/v1/messages"), "https://api.anthropic.com/v1/messages");
  assert.equal(joinApiUrl("https://api.openai.com/v1", "/v1/responses"), "https://api.openai.com/v1/responses");
  // Trailing slashes on the base
  assert.equal(joinApiUrl("https://api.deepseek.com///", "/v1/chat/completions"), "https://api.deepseek.com/v1/chat/completions");
});

/* -------------------------- connectivity probe --------------------------- */

test("testConnectivity reports success and captures a sample", async () => {
  const original = globalThis.fetch;
  let calledUrl = "";
  globalThis.fetch = (async (url: any, init: any) => {
    calledUrl = String(url);
    const body = JSON.parse(init.body);
    assert.equal(body.model, "deepseek-chat");
    return new Response(
      JSON.stringify({
        model: "deepseek-chat",
        choices: [{ message: { content: "pong" } }],
        usage: { prompt_tokens: 3, completion_tokens: 1 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as any;
  try {
    const cfg = { ...defaultConfig(), baseUrl: "https://api.deepseek.com/v1", apiKey: "k", model: "deepseek-chat" };
    const res = await testConnectivity(cfg);
    assert.equal(res.ok, true);
    assert.equal(res.url, "https://api.deepseek.com/v1/chat/completions"); // no /v1/v1
    assert.equal(res.sample, "pong");
    assert.equal(res.usage?.outputTokens, 1);
    assert.equal(calledUrl, res.url);
  } finally {
    globalThis.fetch = original;
  }
});

test("testConnectivity turns 401/404 into actionable hints", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = (async () => new Response('{"error":"invalid api key"}', { status: 401 })) as any;
    let res = await testConnectivity({ ...defaultConfig(), apiKey: "bad", baseUrl: "https://api.deepseek.com" });
    assert.equal(res.ok, false);
    assert.equal(res.status, 401);
    assert.match(res.hint ?? "", /Key/);

    globalThis.fetch = (async () => new Response("not found", { status: 404 })) as any;
    res = await testConnectivity({ ...defaultConfig(), apiKey: "k", baseUrl: "https://api.deepseek.com" });
    assert.equal(res.ok, false);
    assert.match(res.hint ?? "", /\/v1/);
  } finally {
    globalThis.fetch = original;
  }
});

test("testConnectivity reports network failures with a hint", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("getaddrinfo ENOTFOUND bad.host");
  }) as any;
  try {
    const res = await testConnectivity({ ...defaultConfig(), apiKey: "k", baseUrl: "https://bad.host" });
    assert.equal(res.ok, false);
    assert.match(res.error ?? "", /网络错误/);
    assert.ok(res.hint);
  } finally {
    globalThis.fetch = original;
  }
});
