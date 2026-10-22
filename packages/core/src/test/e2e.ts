/**
 * Headless end-to-end check: run one prompt through the real agent loop.
 * Usage: node --import tsx packages/core/src/test/e2e.ts "your prompt"
 * Requires DEEPSEEK_API_KEY (or AEMEATH_API_KEY) in the environment.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../config/load.js";
import { AgentRunner } from "../agent/loop.js";
import { SessionStore } from "../memory/session.js";
import { PermissionPolicy } from "../permissions/policy.js";
import { ToolRegistry } from "../tools/registry.js";
import { builtinTools } from "../tools/builtin/index.js";

async function main() {
  const prompt = process.argv[2] ?? "请只回复两个字：你好";
  const workdir = mkdtempSync(join(tmpdir(), "aemeath-e2e-"));
  const cfg = loadConfig({ cwd: workdir });
  cfg.dataDir = mkdtempSync(join(tmpdir(), "aemeath-data-"));

  const tools = new ToolRegistry().registerAll(builtinTools());
  const policy = new PermissionPolicy(cfg, join(cfg.dataDir, "permissions.json"));
  const session = await SessionStore.create(cfg.dataDir);
  const runner = new AgentRunner(cfg);

  const events: string[] = [];
  let answer = "";
  const res = await runner.run({
    prompt,
    session,
    tools,
    policy,
    emit: (e) => {
      events.push(e.type);
      if (e.type === "assistant_delta") answer += e.text;
      if (e.type === "tool_started") process.stderr.write(`[tool] ${e.name}\n`);
      if (e.type === "error") process.stderr.write(`[error] ${e.message}\n`);
    },
    askPermission: async () => "allow_once",
    readOnlyTools: undefined,
  });

  process.stdout.write(
    JSON.stringify(
      {
        model: cfg.model,
        baseUrl: cfg.baseUrl,
        stopReason: res.stopReason,
        usage: res.usage,
        answer: answer.trim(),
        eventTypes: [...new Set(events)],
      },
      null,
      2,
    ) + "\n",
  );
}

main().catch((err) => {
  console.error("E2E FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
