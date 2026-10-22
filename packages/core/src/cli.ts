import { createInterface, type Interface } from "node:readline";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AgentEvent, PermissionDecision, PermissionRequest } from "./types.js";
import { loadConfig, saveGlobalConfig, ensureDataDirs, dataPaths } from "./config/load.js";
import type { AemeathConfig } from "./config/schema.js";
import { AgentRunner } from "./agent/loop.js";
import { SessionStore } from "./memory/session.js";
import { CheckpointStore } from "./memory/checkpoint.js";
import { PermissionPolicy } from "./permissions/policy.js";
import { ToolRegistry } from "./tools/registry.js";
import { builtinTools } from "./tools/builtin/index.js";
import { connectMcpServers, type McpClient } from "./mcp/client.js";

const C = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  pink: "\x1b[38;5;218m",
  blue: "\x1b[38;5;111m",
  green: "\x1b[38;5;114m",
  yellow: "\x1b[38;5;222m",
  red: "\x1b[38;5;203m",
  gray: "\x1b[38;5;245m",
};

function banner(cfg: AemeathConfig) {
  const line = `${C.pink}${C.bold}爱弥斯${C.reset} ${C.gray}· Aemeath Agent CLI${C.reset}`;
  console.log(line);
  console.log(`${C.gray}model=${cfg.model}  cwd=${cfg.cwd}${C.reset}`);
  console.log(`${C.gray}输入 /help 查看命令，/exit 退出${C.reset}\n`);
}

function helpText() {
  return `${C.bold}命令${C.reset}
  /help            显示帮助
  /exit /quit      退出
  /new             开始新会话
  /sessions        列出历史会话
  /delete <id>     删除指定会话
  /delete-all      删除所有会话（需确认）
  /resume <id>     恢复会话
  /model <name>    切换模型（当前进程内生效）
  /about           显示配置概况
  /usage           显示本次会话 token 用量
  /allow           清空"永远允许"记录
  /yolo            本会话内写入/命令自动允许（危险）
  /plan            切换计划模式（只读调研，不改工作区）
  /undo            撤销最近一次文件改动（回滚检查点）
  /checkpoints     列出本会话的文件改动检查点
  /init            扫描项目并生成 AEMEATH.md 项目记忆
  /compact         立即压缩上下文`;
}

export interface CliOptions {
  cwd?: string;
  model?: string;
  prompt?: string;
  resume?: string;
  yolo?: boolean;
  plan?: boolean;
}

export async function main(argv: string[]): Promise<void> {
  const opts: CliOptions = {};
  const args = [...argv];
  while (args.length) {
    const a = args.shift()!;
    if (a === "--model" || a === "-m") opts.model = args.shift();
    else if (a === "--cwd" || a === "-C") opts.cwd = args.shift();
    else if (a === "--prompt" || a === "-p") opts.prompt = args.shift();
    else if (a === "--resume" || a === "-r") opts.resume = args.shift();
    else if (a === "--yolo") opts.yolo = true;
    else if (a === "--plan") opts.plan = true;
    else if (a === "--help" || a === "-h") {
      console.log(
        `aemeath — 爱弥斯 Agent\n\n` +
          `用法: aemeath [--cwd DIR] [--model NAME] [--yolo] [--plan] [--resume ID] [-p "一次性提示"]\n\n` +
          `  --plan   计划模式（只读调研，不改动工作区）\n` +
          `  --yolo   自动写入/执行命令（谨慎）\n` +
          `  --resume 恢复会话\n\n` +
          `REPL 命令: /plan /undo /checkpoints /init /compact /sessions /resume /delete /delete-all /model /usage /allow /yolo /about /help /exit`,
      );
      return;
    }
  }

  let cfg = loadConfig({ cwd: opts.cwd });
  if (opts.model) cfg.model = opts.model;
  if (opts.yolo) {
    cfg = { ...cfg, permissions: { ...cfg.permissions, writeFile: "allow", runCommand: "allow" } };
  }

  // First-run setup wizard if no API key.
  if (!cfg.apiKey) {
    const done = await setupWizard(cfg);
    if (!done) return;
    cfg = loadConfig({ cwd: opts.cwd });
    if (opts.model) cfg.model = opts.model;
  }

  ensureDataDirs(cfg);

  // Tools: builtin + MCP.
  const tools = new ToolRegistry().registerAll(builtinTools());
  let mcpClients: McpClient[] = [];
  if (Object.keys(cfg.mcpServers).length) {
    const { tools: mcpTools, clients } = await connectMcpServers(cfg.mcpServers, (m) =>
      console.log(`${C.gray}${m}${C.reset}`),
    );
    tools.registerAll(mcpTools);
    mcpClients = clients;
  }

  const policy = new PermissionPolicy(cfg, dataPaths(cfg.dataDir).permissions);

  let session = opts.resume
    ? await SessionStore.open(cfg.dataDir, opts.resume)
    : await SessionStore.create(cfg.dataDir);
  console.log(`${C.gray}会话: ${session.id}${C.reset}`);

  const runner = new AgentRunner(cfg);
  let checkpoints = CheckpointStore.open(cfg.dataDir, session.id);
  let planMode = !!opts.plan;
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdout.isTTY });

  let totalUsage = { inputTokens: 0, outputTokens: 0 } as { inputTokens: number; outputTokens: number };

  const emit: (e: AgentEvent) => void = (e) => {
    switch (e.type) {
      case "assistant_delta":
        process.stdout.write(e.text);
        break;
      case "tool_started":
        process.stdout.write(`\n${C.blue}⚙ ${e.name}${C.reset} ${C.gray}${shortJson(e.input)}${C.reset}\n`);
        break;
      case "tool_finished":
        process.stdout.write(`${C.gray}  ${e.result.isError ? C.red + "✗" : C.green + "✓"} ${e.name} (${e.ms}ms)${C.reset}\n`);
        if (e.result.isError) process.stdout.write(`${C.red}${indent(e.result.content, 4)}${C.reset}\n`);
        break;
      case "permission_resolved":
        if (e.decision === "deny") process.stdout.write(`${C.red}  ✗ 已拒绝${C.reset}\n`);
        break;
      case "compaction":
        process.stdout.write(`\n${C.yellow}↻ 上下文压缩: ~${e.before} → ~${e.after} tokens${C.reset}\n`);
        break;
      case "usage":
        totalUsage = { inputTokens: e.usage.inputTokens, outputTokens: e.usage.outputTokens };
        break;
      case "run_finished":
        process.stdout.write(`\n${C.gray}— ${e.stopReason} · in ${e.usage.inputTokens} / out ${e.usage.outputTokens} tokens · ${(e.ms / 1000).toFixed(1)}s${C.reset}\n\n`);
        break;
      case "error":
        process.stdout.write(`\n${C.red}✗ ${e.message}${C.reset}\n\n`);
        break;
      case "log":
        if (process.env.AEMEATH_DEBUG) process.stdout.write(`${C.gray}[${e.level}] ${e.message}${C.reset}\n`);
        break;
    }
  };

  const askPermission = async (req: PermissionRequest): Promise<PermissionDecision> => {
    console.log(`\n${C.yellow}⚠ 需要授权: ${req.title}${C.reset}`);
    console.log(`${C.gray}${indent(req.detail, 2)}${C.reset}`);
    const answer = await new Promise<string>((res) => rl.question(`${C.bold}[y]本次允许  [a]永远允许  [n]拒绝 > ${C.reset}`, res));
    const a = answer.trim().toLowerCase();
    if (a === "a" || a === "always") return "allow_always";
    if (a === "y" || a === "yes" || a === "") return "allow_once";
    return "deny";
  };

  const runPrompt = async (prompt: string) => {
    try {
      await runner.run({ prompt, session, tools, policy, emit, askPermission, planMode, checkpoints });
    } catch (err) {
      console.log(`${C.red}运行失败: ${err instanceof Error ? err.message : String(err)}${C.reset}`);
    }
  };

  if (opts.prompt) {
    await runPrompt(opts.prompt);
    cleanup(rl, mcpClients);
    return;
  }

  banner(cfg);

  const handleCommand = async (input: string): Promise<boolean> => {
    const [cmd, ...rest] = input.trim().split(/\s+/);
    const arg = rest.join(" ");
    switch (cmd) {
      case "/exit":
      case "/quit":
        return false;
      case "/help":
        console.log(helpText());
        return true;
      case "/new":
        session = await SessionStore.create(cfg.dataDir);
        checkpoints = CheckpointStore.open(cfg.dataDir, session.id);
        console.log(`${C.gray}新会话: ${session.id}${C.reset}`);
        return true;
      case "/sessions": {
        const list = await SessionStore.list(cfg.dataDir);
        for (const s of list.slice(0, 20)) {
          console.log(`${C.gray}${s.id}  ${new Date(s.updatedAt).toLocaleString()}  ${s.messageCount}条  ${s.title}${C.reset}`);
        }
        return true;
      }
      case "/delete": {
        if (!arg) {
          console.log("用法: /delete <会话ID>（可用 /sessions 查看）");
          return true;
        }
        await SessionStore.remove(cfg.dataDir, arg);
        console.log(`${C.gray}已删除会话 ${arg}${C.reset}`);
        if (session.id === arg) {
          session = await SessionStore.create(cfg.dataDir);
          checkpoints = CheckpointStore.open(cfg.dataDir, session.id);
          console.log(`${C.gray}新会话: ${session.id}${C.reset}`);
        }
        return true;
      }
      case "/delete-all": {
        const list = await SessionStore.list(cfg.dataDir);
        if (!list.length) {
          console.log(`${C.gray}没有会话可删除。${C.reset}`);
          return true;
        }
        const ans = await new Promise<string>((res) =>
          rl.question(`${C.red}确认删除全部 ${list.length} 个会话？[y/N] ${C.reset}`, res),
        );
        if (!/^y(es)?$/i.test(ans.trim())) {
          console.log(`${C.gray}已取消。${C.reset}`);
          return true;
        }
        for (const s2 of list) await SessionStore.remove(cfg.dataDir, s2.id);
        session = await SessionStore.create(cfg.dataDir);
        checkpoints = CheckpointStore.open(cfg.dataDir, session.id);
        console.log(`${C.green}已删除全部会话，并开启新会话。${C.reset}`);
        return true;
      }
      case "/resume":
        if (!arg) {
          console.log("用法: /resume <id>");
          return true;
        }
        try {
          session = await SessionStore.open(cfg.dataDir, arg);
          checkpoints = CheckpointStore.open(cfg.dataDir, session.id);
          console.log(`${C.gray}已恢复 ${session.id}（${session.getMessages().length} 条历史）${C.reset}`);
        } catch {
          console.log(`${C.red}无法恢复 ${arg}${C.reset}`);
        }
        return true;
      case "/model":
        if (arg) {
          cfg = { ...cfg, model: arg };
          console.log(`${C.gray}模型已切换为 ${arg}${C.reset}`);
        } else console.log(`当前模型: ${cfg.model}`);
        return true;
      case "/about":
        console.log(`${C.gray}model: ${cfg.model}\nbaseUrl: ${cfg.baseUrl}\ncwd: ${cfg.cwd}\ndataDir: ${cfg.dataDir}\ntools: ${tools.names().join(", ")}${C.reset}`);
        return true;
      case "/usage":
        console.log(`${C.gray}累计 in ${totalUsage.inputTokens} / out ${totalUsage.outputTokens} tokens${C.reset}`);
        return true;
      case "/allow":
        policy.clearRemembered();
        console.log(`${C.gray}已清空"永远允许"记录${C.reset}`);
        return true;
      case "/yolo":
        cfg = { ...cfg, permissions: { ...cfg.permissions, writeFile: "allow", runCommand: "allow" } };
        console.log(`${C.red}已开启自动允许（本会话）${C.reset}`);
        return true;
      case "/plan":
        planMode = !planMode;
        console.log(
          planMode
            ? `${C.yellow}已进入计划模式：只读调研，不会修改任何文件${C.reset}`
            : `${C.gray}已退出计划模式${C.reset}`,
        );
        return true;
      case "/checkpoints": {
        const list = checkpoints.list();
        if (!list.length) {
          console.log(`${C.gray}本会话还没有文件改动记录。${C.reset}`);
          return true;
        }
        for (const cp of list.slice(-20)) {
          console.log(
            `${C.gray}${cp.id}  ${new Date(cp.ts).toLocaleTimeString()}  ${cp.label}${C.reset}`,
          );
        }
        return true;
      }
      case "/undo": {
        const restored = checkpoints.restore(arg || "latest");
        if (!restored) {
          console.log(`${C.red}没有可回滚的检查点。${C.reset}`);
          return true;
        }
        console.log(`${C.green}已回滚：${restored.label}${C.reset}`);
        for (const f of restored.files) {
          console.log(`${C.gray}  ${f.existed ? "恢复" : "删除"} ${f.rel}${C.reset}`);
        }
        return true;
      }
      case "/compact":
        console.log(`${C.gray}将在下一次请求前按预算自动压缩（当前预算 ${cfg.contextBudget} tokens）${C.reset}`);
        return true;
      case "/init":
        await runPrompt(
          "请扫描当前项目：阅读 package.json / 配置文件 / 目录结构，然后**只输出**一份可直接写入 AEMEATH.md 的项目记忆（技术栈、常用命令、目录约定、注意事项），用 Markdown。不要写入文件。",
        );
        return true;
      default:
        console.log(`未知命令 ${cmd}`);
        return true;
    }
  };

  // REPL
  await new Promise<void>((resolve) => {
    const promptNext = () => rl.question(`${C.pink}你${planMode ? C.yellow + "（计划）" : ""}${C.pink} ▸ ${C.reset}`, async (input) => {
      const text = input.trim();
      if (!text) return promptNext();
      if (text.startsWith("/")) {
        const cont = await handleCommand(text);
        if (!cont) return resolve();
        return promptNext();
      }
      await runPrompt(text);
      promptNext();
    });
    rl.on("close", () => resolve());
    promptNext();
  });

  cleanup(rl, mcpClients);
}

function cleanup(rl: Interface, mcpClients: McpClient[]) {
  rl.close();
  for (const c of mcpClients) c.close();
}

function shortJson(v: unknown): string {
  try {
    const s = JSON.stringify(v);
    return s.length > 120 ? s.slice(0, 120) + "…" : s;
  } catch {
    return "";
  }
}

function indent(s: string, n: number): string {
  const pad = " ".repeat(n);
  return s
    .split(/\r?\n/)
    .slice(0, 20)
    .map((l) => pad + l)
    .join("\n");
}

/** Interactive first-run setup, writes ~/.aemeath/config.json. */
async function setupWizard(cfg: AemeathConfig): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string) => new Promise<string>((r) => rl.question(q, r));
  console.log(`\n${C.pink}${C.bold}欢迎使用爱弥斯 Agent${C.reset} — 先做一次初始配置\n`);
  try {
    const baseUrl = (await ask(`API Base URL ${C.gray}[默认 ${cfg.baseUrl}]${C.reset}: `)).trim() || cfg.baseUrl;
    const isAnthropic = /anthropic\.com/i.test(baseUrl);
    const keyHint = /deepseek/i.test(baseUrl) ? "DeepSeek" : isAnthropic ? "Anthropic" : "服务商";
    const apiKey = (await ask(`${keyHint} API Key: `)).trim();
    const defaultModel = /deepseek/i.test(baseUrl) ? "deepseek-chat" : cfg.model;
    const model = (await ask(`模型名 ${C.gray}[默认 ${defaultModel}]${C.reset}: `)).trim() || defaultModel;

    if (!apiKey) {
      console.log(`${C.red}未提供 API Key，已取消。${C.reset}`);
      return false;
    }
    const next = { ...cfg, baseUrl, apiKey, model };
    mkdirSync(cfg.dataDir, { recursive: true });
    saveGlobalConfig(next);
    console.log(`${C.green}配置已保存到 ${join(cfg.dataDir, "config.json")}${C.reset}\n`);
    return true;
  } finally {
    rl.close();
  }
}

// Entry
if (process.argv[1]?.includes("cli")) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
