import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Tool } from "../../types.js";
import { relativeTo, safeResolve } from "../registry.js";

const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", ".next", ".cache",
  "coverage", "__pycache__", ".venv", "venv", ".idea", ".vscode",
]);

export const grepTool: Tool = {
  name: "grep",
  description:
    "Search file contents with a regular expression across the workspace. Returns matching lines with file:line. Skips node_modules/.git/build dirs.",
  inputSchema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "JavaScript regular expression source." },
      path: { type: "string", description: "Subdirectory or file to search (default '.')." },
      glob: { type: "string", description: "Only files whose name contains this substring, e.g. '.ts'." },
      ignoreCase: { type: "boolean" },
      maxResults: { type: "number", description: "Default 100." },
    },
    required: ["pattern"],
  },
  async execute(input, ctx) {
    const { pattern, path = ".", glob, ignoreCase, maxResults = 100 } = input as {
      pattern: string;
      path?: string;
      glob?: string;
      ignoreCase?: boolean;
      maxResults?: number;
    };
    let re: RegExp;
    try {
      re = new RegExp(pattern, ignoreCase ? "i" : "");
    } catch (e) {
      return { content: `Invalid regex: ${(e as Error).message}`, isError: true };
    }
    const root = safeResolve(ctx.cwd, path);
    const results: string[] = [];
    const MAX_FILE_BYTES = 2_000_000;

    const walk = async (dir: string): Promise<void> => {
      if (results.length >= maxResults) return;
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (results.length >= maxResults) return;
        const full = join(dir, e.name);
        if (e.isDirectory()) {
          if (SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue;
          await walk(full);
        } else if (e.isFile()) {
          if (glob && !e.name.includes(glob)) continue;
          try {
            const s = await stat(full);
            if (s.size > MAX_FILE_BYTES) continue;
            const text = await readFile(full, "utf8");
            const lines = text.split(/\r?\n/);
            for (let i = 0; i < lines.length && results.length < maxResults; i++) {
              if (re.test(lines[i]!)) {
                results.push(`${relativeTo(ctx.cwd, full)}:${i + 1}: ${lines[i]!.slice(0, 300)}`);
              }
            }
          } catch {
            /* binary or unreadable */
          }
        }
      }
    };

    const st = await stat(root).catch(() => null);
    if (!st) return { content: `Path not found: ${path}`, isError: true };
    if (st.isFile()) {
      const text = await readFile(root, "utf8");
      text.split(/\r?\n/).forEach((l, i) => {
        if (re.test(l) && results.length < maxResults) results.push(`${relativeTo(ctx.cwd, root)}:${i + 1}: ${l.slice(0, 300)}`);
      });
    } else {
      await walk(root);
    }

    return {
      content: results.length
        ? `${results.length} 处匹配:\n${results.join("\n")}`
        : "无匹配。",
      display: { count: results.length },
    };
  },
};

export const globTool: Tool = {
  name: "glob",
  description: "List files in the workspace matching a simple glob pattern (supports * and ** and ?).",
  inputSchema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "e.g. src/**/*.ts" },
      maxResults: { type: "number", description: "Default 200." },
    },
    required: ["pattern"],
  },
  async execute(input, ctx) {
    const { pattern, maxResults = 200 } = input as { pattern: string; maxResults?: number };
    const re = globToRegExp(pattern);
    const out: string[] = [];
    const walk = async (dir: string) => {
      if (out.length >= maxResults) return;
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (out.length >= maxResults) return;
        const full = join(dir, e.name);
        if (e.isDirectory()) {
          if (SKIP_DIRS.has(e.name)) continue;
          await walk(full);
        } else {
          const rel = relativeTo(ctx.cwd, full);
          if (re.test(rel)) out.push(rel);
        }
      }
    };
    await walk(ctx.cwd);
    return { content: out.length ? out.join("\n") : "无匹配文件。" };
  },
};

function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
        if (glob[i + 1] === "/") i++;
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") re += "[^/]";
    else if (".+^${}()|[]\\".includes(c)) re += "\\" + c;
    else re += c;
  }
  return new RegExp("^" + re + "$");
}
