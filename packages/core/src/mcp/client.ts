import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { Tool, ToolResult } from "../types.js";

interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: Tool["inputSchema"];
}

interface Pending {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
}

/**
 * Minimal MCP client over stdio using newline-delimited JSON-RPC 2.0.
 * Enough to connect external MCP servers and expose their tools to the agent.
 */
export class McpClient {
  private child?: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private buffer = "";
  private tools: McpToolDef[] = [];
  private closed = false;

  constructor(
    readonly name: string,
    private opts: { command: string; args?: string[]; env?: Record<string, string> },
  ) {}

  async connect(timeoutMs = 15_000): Promise<void> {
    this.child = spawn(this.opts.command, this.opts.args ?? [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...(this.opts.env ?? {}) },
      windowsHide: true,
      shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(this.opts.command),
    });

    this.child.stdout.on("data", (c: Buffer) => this.onData(c));
    this.child.stderr.on("data", () => {
      /* MCP servers often log to stderr; ignore */
    });
    this.child.on("exit", () => {
      this.closed = true;
      for (const [, p] of this.pending) p.reject(new Error(`MCP server "${this.name}" exited`));
      this.pending.clear();
    });
    this.child.on("error", (err) => {
      this.closed = true;
      for (const [, p] of this.pending) p.reject(err);
      this.pending.clear();
    });

    await this.request(
      "initialize",
      {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "aemeath-agent", version: "0.1.0" },
      },
      timeoutMs,
    );
    this.notify("notifications/initialized", {});

    const list = await this.request("tools/list", {}, timeoutMs);
    this.tools = (list?.tools ?? []) as McpToolDef[];
  }

  private onData(chunk: Buffer) {
    this.buffer += chunk.toString("utf8");
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof msg.id === "number" && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
        else p.resolve(msg.result);
      }
    }
  }

  private send(obj: unknown) {
    if (!this.child || this.closed) throw new Error(`MCP server "${this.name}" not connected`);
    this.child.stdin.write(JSON.stringify(obj) + "\n");
  }

  private request(method: string, params: unknown, timeoutMs = 60_000): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`MCP request "${method}" timed out`));
      }, timeoutMs);
      const orig = this.pending.get(id)!;
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          orig.resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          orig.reject(e);
        },
      });
      try {
        this.send({ jsonrpc: "2.0", id, method, params });
      } catch (e) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(e as Error);
      }
    });
  }

  private notify(method: string, params: unknown) {
    this.send({ jsonrpc: "2.0", method, params });
  }

  /** Expose MCP tools as native agent tools. */
  asTools(): Tool[] {
    const client = this;
    return this.tools.map((t) => ({
      name: `${this.name}__${t.name}`,
      description: `[MCP:${this.name}] ${t.description ?? t.name}`,
      inputSchema: (t.inputSchema ?? { type: "object", properties: {} }) as Tool["inputSchema"],
      async execute(input): Promise<ToolResult> {
        try {
          const res = await client.call(t.name, input);
          return { content: res };
        } catch (err) {
          return { content: `MCP 调用失败: ${err instanceof Error ? err.message : String(err)}`, isError: true };
        }
      },
    }));
  }

  async call(tool: string, args: unknown, timeoutMs = 120_000): Promise<string> {
    const res = await this.request("tools/call", { name: tool, arguments: args ?? {} }, timeoutMs);
    const parts: string[] = [];
    for (const c of res?.content ?? []) {
      if (c.type === "text") parts.push(c.text);
      else parts.push(JSON.stringify(c));
    }
    const text = parts.join("\n") || "(空)";
    return res?.isError ? `[MCP error] ${text}` : text;
  }

  close() {
    this.closed = true;
    try {
      this.child?.kill();
    } catch {
      // The process may already have exited; there is nothing useful to do and
      // shutdown must not be held up by it.
    }
  }
}

/** Connect all configured MCP servers, returning their tools (best-effort). */
export async function connectMcpServers(
  servers: Record<string, { command: string; args?: string[]; env?: Record<string, string> }>,
  onLog?: (msg: string) => void,
): Promise<{ tools: Tool[]; clients: McpClient[] }> {
  const tools: Tool[] = [];
  const clients: McpClient[] = [];
  for (const [name, cfg] of Object.entries(servers)) {
    const client = new McpClient(name, cfg);
    try {
      await client.connect();
      tools.push(...client.asTools());
      clients.push(client);
      onLog?.(`MCP "${name}" 已连接（${client.asTools().length} 个工具）`);
    } catch (err) {
      onLog?.(`MCP "${name}" 连接失败: ${err instanceof Error ? err.message : String(err)}`);
      client.close();
    }
  }
  return { tools, clients };
}
