import type { Tool } from "../../types.js";

interface Todo {
  id: number;
  text: string;
  status: "pending" | "in_progress" | "done";
}

/**
 * A tiny task list the agent maintains for itself (AemeathCode has one too).
 * Stored in per-run scratch state so the UI can render it.
 */
function todos(ctx: { state: Map<string, unknown> }): Todo[] {
  if (!ctx.state.has("__todos")) ctx.state.set("__todos", [] as Todo[]);
  return ctx.state.get("__todos") as Todo[];
}

export const todoTool: Tool = {
  name: "todo",
  description:
    "Maintain a short task list for the current run so progress is visible. " +
    "Actions: add (text), update (id, status), list, clear.",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["add", "update", "list", "clear"] },
      text: { type: "string" },
      id: { type: "number" },
      status: { type: "string", enum: ["pending", "in_progress", "done"] },
    },
    required: ["action"],
  },
  async execute(input, ctx) {
    const { action, text, id, status } = input as {
      action: string;
      text?: string;
      id?: number;
      status?: Todo["status"];
    };
    const list = todos(ctx);
    if (action === "add") {
      if (!text) return { content: "text 必填", isError: true };
      list.push({ id: (list.at(-1)?.id ?? 0) + 1, text, status: "pending" });
    } else if (action === "update") {
      const t = list.find((x) => x.id === id);
      if (!t) return { content: `未找到任务 ${id}`, isError: true };
      if (status) t.status = status;
      if (text) t.text = text;
    } else if (action === "clear") {
      list.length = 0;
    }
    const rendered = list.map((t) => `${t.status === "done" ? "✓" : t.status === "in_progress" ? "▶" : "○"} ${t.id}. ${t.text}`);
    ctx.emit({
      type: "log",
      level: "debug",
      message: `todos: ${rendered.join(" | ") || "(empty)"}`,
    });
    return { content: rendered.join("\n") || "(空)", display: { todos: list } };
  },
};
