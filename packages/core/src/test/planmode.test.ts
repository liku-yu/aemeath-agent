import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRunner } from "../agent/loop.js";
import { SessionStore } from "../memory/session.js";
import { CheckpointStore } from "../memory/checkpoint.js";
import { PermissionPolicy } from "../permissions/policy.js";
import { ToolRegistry } from "../tools/registry.js";
import { builtinTools } from "../tools/builtin/index.js";
import { defaultConfig } from "../config/schema.js";

/**
 * Plan mode must be enforced in the harness, not just asked for in the prompt:
 * even if the model calls a mutating tool, it must be refused and the file must
 * stay untouched. We stub the model by injecting a fake fetch.
 */
test("plan mode refuses mutating tools and leaves the workspace unchanged", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "aemeath-plan-"));
  const dataDir = mkdtempSync(join(tmpdir(), "aemeath-plandata-"));
  const target = "should-not-exist.txt";

  // Stub global fetch so the "model" asks to write a file.
  const originalFetch = globalThis.fetch;
  let toolResultSeen = "";
  globalThis.fetch = (async (url: string, init: any) => {
    const body = JSON.parse(init.body);
    const msgs = body.messages as any[];
    const last = msgs[msgs.length - 1];
    // OpenAI-compatible tool results arrive as a separate role:"tool" message.
    const isToolResult =
      last?.role === "tool" ||
      (Array.isArray(last?.content) && last.content.some((b: any) => b.type === "tool_result"));
    if (isToolResult) {
      // Capture the tool error text so we can assert on it.
      toolResultSeen = JSON.stringify(last.content);
    }
    // OpenAI-compatible streaming SSE response
    const payload = isToolResult
      ? { choices: [{ delta: { content: "好的，我不写。" }, finish_reason: "stop" }] }
      : {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_1",
                    function: { name: "write_file", arguments: JSON.stringify({ path: target, content: "x" }) },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        };
    const sse =
      `data: ${JSON.stringify(payload)}\n\n` +
      `data: ${JSON.stringify({ usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\n` +
      "data: [DONE]\n\n";
    return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as any;

  try {
    const cfg = { ...defaultConfig(), cwd: workdir, dataDir, apiKey: "test", baseUrl: "https://example.com/v1" };
    const tools = new ToolRegistry().registerAll(builtinTools());
    const policy = new PermissionPolicy(cfg, join(dataDir, "perm.json"));
    const session = await SessionStore.create(dataDir);
    const runner = new AgentRunner(cfg);

    const result = await runner.run({
      prompt: "创建文件",
      session,
      tools,
      policy,
      emit: () => {},
      askPermission: async () => "allow_once", // user would allow, but plan mode must still block
      planMode: true,
      checkpoints: CheckpointStore.open(dataDir, session.id),
    });

    assert.equal(result.stopReason, "end_turn");
    assert.equal(existsSync(join(workdir, target)), false, "plan mode must not create the file");
    assert.match(toolResultSeen, /计划模式/, "the refusal must explain plan mode");
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(workdir, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("checkpoint is created before a mutating tool runs", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "aemeath-cprun-"));
  const dataDir = mkdtempSync(join(tmpdir(), "aemeath-cprundata-"));
  writeFileSync(join(workdir, "f.txt"), "before", "utf8");

  const originalFetch = globalThis.fetch;
  let call = 0;
  globalThis.fetch = (async (_url: string, init: any) => {
    const body = JSON.parse(init.body);
    const last = body.messages[body.messages.length - 1];
    const isToolResult =
      last?.role === "tool" ||
      (Array.isArray(last?.content) && last.content.some((b: any) => b.type === "tool_result"));
    call++;
    const payload = isToolResult
      ? { choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }
      : {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "c1",
                    function: { name: "edit_file", arguments: JSON.stringify({ path: "f.txt", oldText: "before", newText: "after" }) },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        };
    return new Response(`data: ${JSON.stringify(payload)}\n\n data: [DONE]\n\n`.replace(/\n data/, "\ndata"), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }) as any;

  try {
    const cfg = { ...defaultConfig(), cwd: workdir, dataDir, apiKey: "t", baseUrl: "https://example.com/v1" };
    const tools = new ToolRegistry().registerAll(builtinTools());
    const policy = new PermissionPolicy(cfg, join(dataDir, "perm.json"));
    const session = await SessionStore.create(dataDir);
    const store = CheckpointStore.open(dataDir, session.id);
    const runner = new AgentRunner(cfg);

    await runner.run({
      prompt: "edit",
      session,
      tools,
      policy,
      emit: () => {},
      askPermission: async () => "allow_once",
      checkpoints: store,
    });

    const list = store.list();
    assert.equal(list.length, 1, "expected exactly one checkpoint");
    assert.match(list[0].label, /edit_file/);

    // Undo must bring the original content back.
    store.restore("latest");
    const back = (await import("node:fs")).readFileSync(join(workdir, "f.txt"), "utf8");
    assert.equal(back, "before");
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(workdir, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  }
});
