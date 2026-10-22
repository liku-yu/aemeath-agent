import { test } from "node:test";
import assert from "node:assert/strict";
import { openaiStream } from "../llm/openai.js";
import { anthropicStream } from "../llm/anthropic.js";
import { defaultConfig } from "../config/schema.js";
import type { StreamSegment } from "../types.js";

/** Build a fake SSE Response from a list of JSON payloads. */
function sseResponse(chunks: unknown[]): Response {
  const body = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const cfg = { ...defaultConfig(), baseUrl: "https://api.example.com", apiKey: "k", model: "m" };

test("openai stream interleaves reasoning, text and tool calls in order", async () => {
  const original = globalThis.fetch;
  const chunks: unknown[] = [
    { choices: [{ delta: { reasoning_content: "思考A" }, finish_reason: null }] },
    { choices: [{ delta: { reasoning_content: "思考B" }, finish_reason: null }] },
    { choices: [{ delta: { content: "先说话" }, finish_reason: null }] },
    {
      choices: [
        {
          delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "read_file", arguments: '{"pa' } }] },
          finish_reason: null,
        },
      ],
    },
    {
      choices: [
        { delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"x"}' } }] }, finish_reason: null },
      ],
    },
    // text AFTER a tool call — this used to be lost / misordered
    { choices: [{ delta: { content: "工具之后的补充" }, finish_reason: null }] },
    { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    { usage: { prompt_tokens: 10, completion_tokens: 5 } },
  ];
  globalThis.fetch = (async () => sseResponse(chunks)) as any;

  try {
    const segments: StreamSegment[] = [];
    const result = await openaiStream(cfg, { system: "s", messages: [], tools: [] }, (s) => segments.push(s));

    // 1) segments arrived as an ordered log
    const kinds = segments.map((s) => s.kind);
    assert.deepEqual(kinds[0], "reasoning");
    // reasoning comes before text, and a tool_call appears between text blocks
    const firstText = kinds.indexOf("text");
    const firstTool = kinds.findIndex((k) => k === "tool_call");
    assert.ok(firstTool > firstText, "tool call must arrive after the first text");

    // 2) final content preserves production order and includes post-tool text
    const shape = result.content.map((b) => b.type);
    assert.deepEqual(shape, ["reasoning", "text", "tool_use", "text"]);

    const reasoning = result.content[0] as { type: "reasoning"; text: string };
    assert.equal(reasoning.text, "思考A思考B");
    const lastText = result.content[3] as { type: "text"; text: string };
    assert.equal(lastText.text, "工具之后的补充");
    const tool = result.content[2] as { type: "tool_use"; name: string; input: unknown };
    assert.equal(tool.name, "read_file");
    assert.deepEqual(tool.input, { path: "x" });
    assert.equal(result.stopReason, "tool_use");
  } finally {
    globalThis.fetch = original;
  }
});

test("anthropic stream keeps block order across thinking/text/tool_use", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    sseResponse([
      { type: "message_start", message: { usage: { input_tokens: 7 } } },
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "推理中" } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "回答" } },
      { type: "content_block_stop", index: 1 },
      { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "t1", name: "grep", input: {} } },
      { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"pattern":"x"}' } },
      { type: "content_block_stop", index: 2 },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 3 } },
    ])) as any;

  try {
    const segments: StreamSegment[] = [];
    const result = await anthropicStream(cfg, { system: "s", messages: [], tools: [] }, (s) => segments.push(s));

    assert.deepEqual(
      result.content.map((b) => b.type),
      ["reasoning", "text", "tool_use"],
    );
    assert.ok(segments.some((s) => s.kind === "reasoning"));
    assert.ok(segments.some((s) => s.kind === "tool_call"));
    assert.ok(segments.some((s) => s.kind === "segment_end"));
    const tool = result.content[2] as { type: "tool_use"; input: unknown };
    assert.deepEqual(tool.input, { pattern: "x" });
  } finally {
    globalThis.fetch = original;
  }
});
