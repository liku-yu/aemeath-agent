import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { Tool } from "../../types.js";
import { relativeTo, safeResolve } from "../registry.js";

/**
 * Exact-string replacement edit (aider / claude-code style). Requires the
 * oldText to appear exactly once, preventing ambiguous edits.
 */
export const editFileTool: Tool = {
  name: "edit_file",
  description:
    "Replace an exact snippet in a file. oldText must match exactly once. Prefer this over write_file for small changes.",
  mutating: true,
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string" },
      oldText: { type: "string", description: "Exact text to find (must be unique)." },
      newText: { type: "string", description: "Replacement text." },
    },
    required: ["path", "oldText", "newText"],
  },
  async execute(input, ctx) {
    const { path, oldText, newText } = input as { path: string; oldText: string; newText: string };
    const abs = safeResolve(ctx.cwd, path);
    if (!existsSync(abs)) return { content: `File not found: ${path}`, isError: true };
    const text = await readFile(abs, "utf8");
    const first = text.indexOf(oldText);
    if (first === -1) return { content: "oldText 未在文件中找到。", isError: true };
    if (text.indexOf(oldText, first + oldText.length) !== -1) {
      return { content: "oldText 出现多次，请提供更长的唯一片段。", isError: true };
    }
    const updated = text.slice(0, first) + newText + text.slice(first + oldText.length);

    const decision = await ctx.requestPermission({
      kind: "write_file",
      title: `编辑文件 ${relativeTo(ctx.cwd, abs)}`,
      detail: `目标: ${abs}\n\n----- 删除 -----\n${oldText}\n\n----- 新增 -----\n${newText}`,
      key: `edit_file:${relativeTo(ctx.cwd, abs)}`,
    });
    if (decision === "deny") return { content: "用户拒绝编辑。", isError: true, display: { denied: true } };

    await writeFile(abs, updated, "utf8");
    return {
      content: `已编辑 ${relativeTo(ctx.cwd, abs)}（-${oldText.split("\n").length} +${newText.split("\n").length} 行）`,
      display: { path: relativeTo(ctx.cwd, abs) },
    };
  },
};
