import type { Tool } from "../../types.js";

/** Cross-session long-term note tools (backed by NoteStore in ToolContext). */
export const noteSaveTool: Tool = {
  name: "note_save",
  description:
    "Save a long-term note that persists across sessions (project facts, user preferences, decisions). Use sparingly — only durable, reusable knowledge.",
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string", description: "Short title." },
      body: { type: "string", description: "Note content." },
      tags: { type: "array", items: { type: "string" }, description: "Optional tags." },
    },
    required: ["title", "body"],
  },
  async execute(input, ctx) {
    const { title, body, tags } = input as { title: string; body: string; tags?: string[] };
    await ctx.notes.save({ title, body, tags });
    return { content: `已记住: ${title}`, display: { title } };
  },
};

export const noteSearchTool: Tool = {
  name: "note_search",
  description: "Search previously saved long-term notes by keyword.",
  inputSchema: {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
  },
  async execute(input, ctx) {
    const { query } = input as { query: string };
    const hits = await ctx.notes.search(query);
    if (!hits.length) return { content: "没有找到相关笔记。" };
    return {
      content: hits.map((n) => `## ${n.title}\n${n.body}`).join("\n\n---\n\n"),
      display: { count: hits.length },
    };
  },
};
