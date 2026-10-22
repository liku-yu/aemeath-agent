import type { Tool, ToolResult } from "../../types.js";
import { ToolRegistry } from "../registry.js";
import { builtinTools } from "./index.js";
import { AgentRunner } from "../../agent/loop.js";
import { SessionStore } from "../../memory/session.js";

/**
 * Spawn a sub-agent that works in an isolated context and only returns its
 * final text. Keeps the main conversation clean for long explorations.
 * The sub-agent runs read-only by default (no writes/commands) unless
 * `allowWrite` is explicitly requested.
 */
export const subagentTool: Tool = {
  name: "subagent",
  description:
    "Delegate a focused, self-contained investigation to a sub-agent with its own context. " +
    "It returns only a final summary. By default it is read-only (no file writes, no commands). " +
    "Use for broad searches or multi-file reading that would otherwise flood the main context.",
  inputSchema: {
    type: "object",
    properties: {
      task: { type: "string", description: "A clear, self-contained task description." },
      allowWrite: {
        type: "boolean",
        description: "Allow the sub-agent to write files / run commands. Default false.",
      },
    },
    required: ["task"],
  },
  async execute(input, ctx): Promise<ToolResult> {
    const { task, allowWrite } = input as { task: string; allowWrite?: boolean };

    const subTools = new ToolRegistry().registerAll(
      // Exclude the subagent tool itself to prevent unbounded recursion.
      builtinTools().filter((t) => t.name !== "subagent"),
    );
    const subSession = await SessionStore.create(ctx.config.dataDir, { title: `子任务: ${task.slice(0, 30)}` });
    const runner = new AgentRunner(ctx.config);

    let summary = "";
    const result = await runner.run({
      prompt: task,
      session: subSession,
      tools: subTools,
      policy: {
        preDecide: () => "deny",
        isRemembered: () => false,
        isDenied: () => false,
        rememberKey: () => {},
        denyKey: () => {},
        clearRemembered: () => {},
        modeFor: () => "ask",
      } as never,
      emit: (e) => {
        if (e.type === "assistant_message") {
          summary = e.content
            .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
            .map((b) => b.text)
            .join("\n");
        }
        if (e.type === "tool_started") {
          ctx.emit({ type: "log", level: "debug", message: `[subagent] ${e.name}` });
        }
      },
      askPermission: async () => "deny",
      readOnlyTools: allowWrite
        ? undefined
        : ["read_file", "list_dir", "glob", "grep", "note_search", "todo"],
      systemExtras: {
        extraSystem:
          "你是主 agent 派出的子 agent，只负责完成被指派的子任务并返回简洁结论。" +
          (allowWrite ? "" : "你没有写入/执行权限，只能读。"),
      },
      signal: ctx.signal,
    });

    const finalText = summary.trim() || "(子 agent 未返回文本)";
    return {
      content: `[子 agent 结果 · ${result.stopReason}]\n${finalText}`,
      isError: result.stopReason === "error",
      display: { stopReason: result.stopReason, tokens: result.usage.outputTokens },
    };
  },
};
