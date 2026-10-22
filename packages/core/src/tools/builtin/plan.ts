import type { Tool } from "../../types.js";

/**
 * Plan-mode transition tools.
 *
 * Why these are tools rather than only a UI switch: the model should be able to
 * say "this task deserves reconnaissance before I touch anything". Following the
 * principle used by mature harnesses — **lowering privilege is free, raising it
 * must be approved**:
 *
 *   - `enter_plan_mode`  → read-only from here on, so it runs without a prompt
 *                          (making the agent safer should never be friction).
 *   - `exit_plan_mode`   → raises privilege back to writing/running, so it is
 *                          `mutating` and goes through the approval gate.
 *
 * The actual mode flip is performed by the runner: the tool records the intent in
 * the shared run state, and the loop applies it after the tool returns.
 */

export const PLAN_MODE_STATE_KEY = "__planModeRequest";

export const enterPlanModeTool: Tool = {
  name: "enter_plan_mode",
  description:
    "Switch to plan mode: from now on you may only read and investigate (no file writes, no commands). " +
    "Use this when a task is ambiguous, risky, or large enough that you should present a plan first. " +
    "Takes effect immediately and needs no approval.",
  inputSchema: {
    type: "object",
    properties: {
      reason: { type: "string", description: "One short sentence: why planning first is worthwhile." },
    },
  },
  async execute(input, ctx) {
    const { reason } = (input ?? {}) as { reason?: string };
    ctx.state.set(PLAN_MODE_STATE_KEY, "plan");
    return {
      content:
        `已进入计划模式。${reason ? `原因：${reason}\n` : "\n"}` +
        "接下来你只能读取与调研。请给出清晰的行动计划（目标、步骤、要改哪些文件、风险点），" +
        "然后用 exit_plan_mode 请用户批准执行。",
      display: { planMode: true },
    };
  },
};

export const exitPlanModeTool: Tool = {
  name: "exit_plan_mode",
  description:
    "Leave plan mode and go back to being able to write files and run commands. " +
    "Requires user approval, because it raises your privileges. Call it after presenting a plan.",
  mutating: true,
  inputSchema: {
    type: "object",
    properties: {
      plan: {
        type: "string",
        description: "The plan you are asking to execute. Shown to the user for approval.",
      },
    },
    required: ["plan"],
  },
  async execute(input, ctx) {
    const { plan } = input as { plan: string };
    const decision = await ctx.requestPermission({
      kind: "other",
      title: "批准执行计划",
      detail: plan,
      key: "exit_plan_mode",
    });
    if (decision === "deny") {
      return {
        content: "用户暂不批准执行，继续留在计划模式。可以补充或调整计划后再试。",
        isError: true,
        display: { denied: true },
      };
    }
    ctx.state.set(PLAN_MODE_STATE_KEY, "build");
    return { content: "已退出计划模式，可以开始动手了。", display: { planMode: false } };
  },
};
