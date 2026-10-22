import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Tool } from "../../types.js";
import { relativeTo, safeResolve } from "../registry.js";

const MAX_READ_BYTES = 400_000;

export const readFileTool: Tool = {
  name: "read_file",
  description:
    "Read a UTF-8 text file from the workspace. Supports optional 1-indexed line window (offset, limit).",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path relative to the workspace root." },
      offset: { type: "number", description: "1-indexed starting line." },
      limit: { type: "number", description: "Max lines to return." },
    },
    required: ["path"],
  },
  async execute(input, ctx) {
    const { path, offset, limit } = input as { path: string; offset?: number; limit?: number };
    const abs = safeResolve(ctx.cwd, path);
    if (!existsSync(abs)) return { content: `File not found: ${path}`, isError: true };
    const buf = await readFile(abs);
    if (buf.byteLength > MAX_READ_BYTES) {
      return { content: `File too large (${buf.byteLength} bytes). Use offset/limit or grep.`, isError: true };
    }
    const all = buf.toString("utf8").split(/\r?\n/);
    const start = Math.max(0, (offset ?? 1) - 1);
    const slice = all.slice(start, limit ? start + limit : undefined);
    const numbered = slice
      .map((l, i) => `${String(start + i + 1).padStart(5)}  ${l}`)
      .join("\n");
    return {
      content: `# ${relativeTo(ctx.cwd, abs)} (${all.length} lines)\n${numbered}`,
      display: { path: relativeTo(ctx.cwd, abs), lines: all.length },
    };
  },
};

export const writeFileTool: Tool = {
  name: "write_file",
  description: "Create or overwrite a text file in the workspace. Requires user approval.",
  mutating: true,
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string" },
      content: { type: "string" },
    },
    required: ["path", "content"],
  },
  async execute(input, ctx) {
    const { path, content } = input as { path: string; content: string };
    const abs = safeResolve(ctx.cwd, path);
    const decision = await ctx.requestPermission({
      kind: "write_file",
      title: `写入文件 ${relativeTo(ctx.cwd, abs)}`,
      detail: `目标: ${abs}\n大小: ${Buffer.byteLength(content)} bytes\n\n----- 内容 -----\n${content}`,
      key: `write_file:${relativeTo(ctx.cwd, abs)}`,
    });
    if (decision === "deny") return { content: "用户拒绝写入。", isError: true, display: { denied: true } };
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf8");
    return {
      content: `已写入 ${relativeTo(ctx.cwd, abs)} (${Buffer.byteLength(content)} bytes)`,
      display: { path: relativeTo(ctx.cwd, abs), bytes: Buffer.byteLength(content) },
    };
  },
};

export const listDirTool: Tool = {
  name: "list_dir",
  description: "List entries of a directory in the workspace (non-recursive).",
  inputSchema: {
    type: "object",
    properties: { path: { type: "string", description: "Directory, defaults to '.'" } },
  },
  async execute(input, ctx) {
    const p = (input as { path?: string }).path ?? ".";
    const abs = safeResolve(ctx.cwd, p);
    const { readdir, stat } = await import("node:fs/promises");
    const entries = await readdir(abs, { withFileTypes: true });
    const rows = await Promise.all(
      entries.slice(0, 500).map(async (e) => {
        let size = "";
        try {
          const s = await stat(join(abs, e.name));
          size = e.isDirectory() ? "dir" : `${s.size}b`;
        } catch {
          size = "?";
        }
        return `${e.isDirectory() ? "d" : "-"} ${size.padStart(8)}  ${e.name}`;
      }),
    );
    return { content: `# ${relativeTo(ctx.cwd, abs)}\n${rows.join("\n") || "(empty)"}` };
  },
};
