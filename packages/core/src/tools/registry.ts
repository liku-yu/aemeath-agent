import { isAbsolute, normalize, relative, resolve, sep } from "node:path";
import type { Tool, ToolSchema } from "../types.js";

/**
 * Resolve a user/model supplied path against the workspace root and ensure it
 * does not escape it. Returns the absolute path or throws.
 */
export function safeResolve(cwd: string, p: string, opts: { allowEscape?: boolean } = {}): string {
  const abs = isAbsolute(p) ? normalize(p) : resolve(cwd, p);
  if (opts.allowEscape) return abs;
  const rel = relative(cwd, abs);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return abs;
  throw new Error(`Path escapes the workspace: ${p}`);
}

/** Cross-platform-ish check for obviously dangerous commands. */
export function commandRisk(command: string, denyPrefixes: string[]): string | null {
  const c = command.trim().toLowerCase();
  for (const bad of denyPrefixes) {
    if (c.startsWith(bad.toLowerCase())) return `matches deny rule: ${bad}`;
  }
  const patterns: Array<[RegExp, string]> = [
    [/\brm\s+(-[a-z]*\s+)*\/\s*$/, "rm on filesystem root"],
    [/\brm\s+-[a-z]*r[a-z]*f?\s+~\b/, "recursive delete of home"],
    [/\bmkfs(\.|\s)/, "format filesystem"],
    [/\bdd\s+.*of=\/dev\//, "raw disk write"],
    [/:\s*\(\s*\)\s*\{.*\|\s*:.*\}\s*;/, "fork bomb"],
    [/\b(shutdown|reboot|poweroff)\b/, "system power control"],
    [/\bgit\s+push\s+.*--force\b/, "force push"],
    [/\bcurl\b[^|]*\|\s*(ba)?sh\b/, "pipe remote script to shell"],
  ];
  for (const [re, why] of patterns) if (re.test(c)) return why;
  return null;
}

export class ToolRegistry {
  private tools = new Map<string, Tool>();

  register(tool: Tool): this {
    if (this.tools.has(tool.name)) throw new Error(`Duplicate tool: ${tool.name}`);
    this.tools.set(tool.name, tool);
    return this;
  }

  registerAll(tools: Tool[]): this {
    for (const t of tools) this.register(t);
    return this;
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  list(): Tool[] {
    return [...this.tools.values()];
  }

  schemas(): ToolSchema[] {
    return this.list().map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
  }

  names(): string[] {
    return [...this.tools.keys()];
  }
}

export function relativeTo(cwd: string, p: string): string {
  const r = relative(cwd, p);
  return r === "" ? "." : r.split(sep).join("/");
}
