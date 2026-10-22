import { spawn } from "node:child_process";
import type { Tool } from "../../types.js";
import { commandRisk, relativeTo, safeResolve } from "../registry.js";

const MAX_OUTPUT = 60_000;

/** Pick a shell command-line appropriate for the current platform. */
export function shellCommand(command: string): { file: string; args: string[] } {
  if (process.platform === "win32") {
    const comspec = process.env.ComSpec || "cmd.exe";
    // Use cmd.exe for maximum compatibility; PowerShell available via `powershell -c`.
    return { file: comspec, args: ["/d", "/s", "/c", command] };
  }
  return { file: "/bin/sh", args: ["-c", command] };
}

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  ms: number;
}

/** Run a command, streaming output lines via onData. Never throws on non-zero exit. */
export function runCommand(
  command: string,
  opts: { cwd: string; timeoutMs?: number; signal?: AbortSignal; onData?: (chunk: string) => void },
): Promise<ExecResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    const { file, args } = shellCommand(command);
    const child = spawn(file, args, {
      cwd: opts.cwd,
      windowsHide: true,
      env: { ...process.env, AEMEATH: "1" },
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let done = false;

    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, opts.timeoutMs)
      : undefined;

    const onAbort = () => child.kill("SIGKILL");
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    const push = (chunk: Buffer, which: "out" | "err") => {
      const s = chunk.toString("utf8");
      if (which === "out") stdout += s;
      else stderr += s;
      opts.onData?.(s);
    };
    child.stdout?.on("data", (c) => push(c, "out"));
    child.stderr?.on("data", (c) => push(c, "err"));

    const finish = (code: number | null) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve({ code, stdout, stderr, timedOut, ms: Date.now() - started });
    };

    child.on("error", (err) => {
      stderr += `\n[spawn error] ${err.message}`;
      finish(null);
    });
    child.on("close", (code) => finish(code));
  });
}

function truncate(s: string): string {
  if (s.length <= MAX_OUTPUT) return s;
  const half = Math.floor(MAX_OUTPUT / 2);
  return `${s.slice(0, half)}\n\n... [${s.length - MAX_OUTPUT} chars truncated] ...\n\n${s.slice(-half)}`;
}

export const runCommandTool: Tool = {
  name: "run_command",
  description:
    "Execute a shell command in the workspace and return stdout/stderr/exit code. " +
    "On Windows this runs through cmd.exe; on Linux/macOS through /bin/sh. Requires approval for non-allowlisted commands.",
  mutating: true,
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string", description: "The command line to execute." },
      cwd: { type: "string", description: "Optional working dir relative to workspace root." },
      timeoutMs: { type: "number", description: "Timeout in ms (default 120000)." },
    },
    required: ["command"],
  },
  async execute(input, ctx) {
    const { command, cwd, timeoutMs } = input as { command: string; cwd?: string; timeoutMs?: number };
    const workdir = cwd ? safeResolve(ctx.cwd, cwd) : ctx.cwd;

    const risk = commandRisk(command, ctx.config.permissions.denyCommands);
    if (risk) {
      return { content: `命令被安全策略拒绝：${risk}\n命令: ${command}`, isError: true, display: { blocked: true } };
    }

    const decision = await ctx.requestPermission({
      kind: "run_command",
      title: `执行命令`,
      detail: `目录: ${workdir}\n命令: ${command}`,
      key: `run_command:${command}`,
    });
    if (decision === "deny") return { content: "用户拒绝执行该命令。", isError: true, display: { denied: true } };

    ctx.emit({ type: "log", level: "info", message: `$ ${command}` });
    const res = await runCommand(command, {
      cwd: workdir,
      timeoutMs: timeoutMs ?? 120_000,
      signal: ctx.signal,
      onData: (c) => {
        const last = ctx.state.get("__live") as string | undefined;
        ctx.state.set("__live", (last ?? "") + c);
      },
    });

    const parts: string[] = [];
    parts.push(`exit code: ${res.code}${res.timedOut ? " (超时)" : ""}  (${res.ms}ms)`);
    if (res.stdout.trim()) parts.push(`--- stdout ---\n${truncate(res.stdout)}`);
    if (res.stderr.trim()) parts.push(`--- stderr ---\n${truncate(res.stderr)}`);
    if (!res.stdout.trim() && !res.stderr.trim()) parts.push("(无输出)");
    return {
      content: parts.join("\n"),
      isError: res.code !== 0,
      display: { code: res.code, cwd: relativeTo(ctx.cwd, workdir), ms: res.ms },
    };
  },
};
