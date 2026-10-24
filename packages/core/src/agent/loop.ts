import type {
  AgentEvent,
  ChatMessage,
  ContentBlock,
  PermissionDecision,
  PermissionRequest,
  ToolContext,
  TokenUsage,
} from "../types.js";
import type { AemeathConfig } from "../config/schema.js";
import type { SessionStore } from "../memory/session.js";
import { estimateTokens, newId, JsonNoteStore } from "../memory/session.js";
import { ToolRegistry } from "../tools/registry.js";
import { PermissionPolicy, suggestRule } from "../permissions/policy.js";
import { streamComplete } from "../llm/factory.js";
import { buildSystemPrompt } from "../persona/persona.js";
import { discoverSkills, skillSearchDirs, skillsIndex, useSkillTool } from "../skills/skills.js";
import { dataPaths } from "../config/schema.js";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { safeResolve } from "../tools/registry.js";
import { PLAN_MODE_STATE_KEY } from "../tools/builtin/plan.js";

export interface RunOptions {
  prompt: string;
  session: SessionStore;
  tools: ToolRegistry;
  policy: PermissionPolicy;
  emit: (e: AgentEvent) => void;
  /** Interactive permission prompt (host-provided). */
  askPermission: (req: PermissionRequest) => Promise<PermissionDecision>;
  signal?: AbortSignal;
  /** Capability overrides (used by sub-agents to keep them text-only, etc.). */
  systemExtras?: { skillsIndex?: string; projectMemory?: string; extraSystem?: string };
  /** When true, only text tools are allowed (sub-agent read-only mode). */
  readOnlyTools?: string[];
  /** Plan mode: explore and propose, but never mutate the workspace. */
  planMode?: boolean;
  /** Session-scoped checkpoint store; when present, mutations are snapshotted. */
  checkpoints?: import("../memory/checkpoint.js").CheckpointStore;
  /** Optional local usage tracker; when present every LLM call is recorded. */
  usageTracker?: import("../memory/usage.js").UsageTracker;
  /**
   * Skills shipped with a packaged build (electron-builder extraResources).
   * The host passes this; the core has no idea it is running inside Electron.
   */
  bundledSkillsDir?: string;
}

/** Default ceiling for a single tool call. */
const TOOL_TIMEOUT_MS = 180_000;

/**
 * Run a tool with a hard ceiling and abort support.
 *
 * Without this, a wedged MCP server or a hung fetch leaves the whole turn
 * pending forever. The timeout surfaces as a normal tool_result error, which
 * keeps the tool_use / tool_result pairing intact.
 */
async function withToolTimeout<T>(work: Promise<T>, name: string, signal?: AbortSignal): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`工具 ${name} 超时（${TOOL_TIMEOUT_MS / 1000}s）`)), TOOL_TIMEOUT_MS);
      }),
      new Promise<never>((_, reject) => {
        if (!signal) return;
        onAbort = () => reject(new Error(`工具 ${name} 已取消`));
        signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  }
}

const ZERO: TokenUsage = { inputTokens: 0, outputTokens: 0 };

function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: (a.cacheReadTokens ?? 0) + (b.cacheReadTokens ?? 0),
    cacheWriteTokens: (a.cacheWriteTokens ?? 0) + (b.cacheWriteTokens ?? 0),
  };
}

/** Read AEMEATH.md project memory from the workspace, if present. */
export function readProjectMemory(cwd: string): string {
  for (const name of ["AEMEATH.md", "AEMEATH.MD", ".aemeath/AEMEATH.md"]) {
    const p = join(cwd, name);
    if (existsSync(p)) {
      try {
        return readFileSync(p, "utf8").slice(0, 8000);
      } catch {
        // Present but unreadable (permissions, a directory with that name).
        // Project memory is optional context, so move on rather than failing the
        // whole run over it.
      }
    }
  }
  return "";
}

export class AgentRunner {
  /**
   * Plan mode persists across turns: once the agent (or the user) enters it, the
   * next turn starts in it too. Per-run `opts.planMode` overrides it.
   */
  private planMode = false;

  constructor(private cfg: AemeathConfig) {}

  /** Current plan-mode state (for the UI to display). */
  getPlanMode(): boolean {
    return this.planMode;
  }

  /** Explicitly set plan mode (from the UI toggle). */
  setPlanMode(on: boolean): void {
    this.planMode = on;
  }

  /**
   * Tools that only read the workspace. Used to enforce plan mode and to
   * constrain sub-agents. Anything not in this list must not be run in plan mode.
   */
  readOnlyAllowedTools(): string[] {
    return [
      "read_file",
      "list_dir",
      "glob",
      "grep",
      "note_search",
      "note_save",
      "todo",
      "use_skill",
      "subagent",
      // `exit_plan_mode` is the only way out of plan mode, so it must stay
      // callable. It is not a loophole: the tool itself goes through the
      // approval gate (`mutating: true`), so a write can still never happen
      // without the user agreeing.
      "exit_plan_mode",
    ];
  }

  /** Build a ToolContext for a single run. */
  private makeContext(
    runId: string,
    opts: RunOptions,
    perms: Map<string, PermissionDecision>,
  ): ToolContext {
    const emit = opts.emit;
    return {
      cwd: this.cfg.cwd,
      signal: opts.signal,
      notes: makeNotes(this.cfg),
      emit,
      state: new Map(),
      config: this.cfg,
      requestPermission: async (req) => {
        // Cache decisions made in this run.
        const cached = perms.get(req.key);
        if (cached) return cached;

        const pre = opts.policy.preDecide(req);
        if (pre) {
          emit({ type: "permission_resolved", runId, key: req.key, decision: pre });
          perms.set(req.key, pre);
          return pre;
        }
        // Offer a wider rule when widening is meaningful and safe.
        const withSuggestion = req.suggestion ? req : { ...req, suggestion: suggestRule(req.key) };
        emit({ type: "permission_requested", runId, request: withSuggestion });
        const decision = await opts.askPermission(withSuggestion);
        emit({ type: "permission_resolved", runId, key: req.key, decision });
        if (decision === "allow_always") {
          opts.policy.rememberKey(req.key);
        } else if (decision === "allow_class") {
          // Remember the wider pattern so the whole class stops asking.
          opts.policy.rememberKey(withSuggestion.suggestion ?? req.key);
        } else if (decision === "deny") {
          opts.policy.denyKey(req.key);
        }
        perms.set(req.key, decision);
        return decision;
      },
    };
  }

  /**
   * Execute one user turn end-to-end: the ReAct loop until the model stops
   * asking for tools, or we hit maxSteps / abort / error.
   */
  async run(opts: RunOptions): Promise<{ stopReason: string; usage: TokenUsage }> {
    const runId = newId();
    const started = Date.now();
    const { session, emit } = opts;
    const perms = new Map<string, PermissionDecision>();
    const ctx = this.makeContext(runId, opts, perms);

    const skills = discoverSkills(
      skillSearchDirs(this.cfg, { bundled: opts.bundledSkillsDir }),
    );
    if (skills.length && !opts.tools.has("use_skill")) {
      opts.tools.register(useSkillTool(skills));
    }

    const projectMemory = opts.systemExtras?.projectMemory ?? readProjectMemory(this.cfg.cwd);
    let system = buildSystemPrompt(this.cfg, {
      tools: opts.tools.names(),
      skillsIndex: opts.systemExtras?.skillsIndex ?? skillsIndex(skills),
      projectMemory,
    });
    if (opts.systemExtras?.extraSystem) system += "\n\n" + opts.systemExtras.extraSystem;

    if (opts.planMode !== undefined) this.planMode = opts.planMode;
    if (this.planMode) {
      system += `\n\n## 计划模式（重要）\n你正在**计划模式**下工作：\n- 只允许读取与调研（读文件 / 搜索 / 列目录 / 笔记）。\n- **绝对不要**写文件、编辑文件或执行命令。\n- 先充分调研，然后输出一份清晰的行动计划：目标、步骤、要改哪些文件、风险点。\n- 由用户批准后才会切回执行模式。`;
    }

    /*
     * The allowed-tool set is recomputed per step, because the agent can switch
     * modes mid-run via enter_plan_mode / exit_plan_mode.
     */
    const readOnlyNow = () => (this.planMode ? this.readOnlyAllowedTools() : opts.readOnlyTools);

    session.setTitle(opts.prompt);
    await session.append({ role: "user", content: opts.prompt });
    emit({ type: "run_started", runId, sessionId: session.id, prompt: opts.prompt });

    let totalUsage: TokenUsage = { ...ZERO };
    let stopReason = "end_turn";

    for (let step = 0; step < this.cfg.maxSteps; step++) {
      if (opts.signal?.aborted) {
        stopReason = "aborted";
        break;
      }

      // ---- Context budget check → compact if needed ----
      const messages = session.getMessages();
      const ctxTokens = estimateTokens(messages, system);
      emit({ type: "usage", runId, usage: totalUsage, contextTokens: ctxTokens, budget: this.cfg.contextBudget });
      if (ctxTokens > this.cfg.contextBudget) {
        const before = ctxTokens;
        const compacted = await this.compact(messages, runId, emit);
        if (compacted) {
          await session.replaceAll(compacted.messages, compacted.summary);
          emit({ type: "compaction", runId, before, after: estimateTokens(compacted.messages, system), summary: compacted.summary });
        }
      }

      // ---- Call the model (streaming) ----
      let result;
      try {
        result = await streamComplete(
          this.cfg,
          { system, messages: session.getMessages(), tools: opts.tools.schemas(), signal: opts.signal },
          (segment) => {
            // Emit the ordered segment, plus a convenience alias so simple
            // renderers that only understand text/thinking keep working.
            emit({ type: "stream", runId, segment });
            if (segment.kind === "text" && segment.delta) {
              emit({ type: "assistant_delta", runId, text: segment.delta, index: segment.index });
            } else if (segment.kind === "reasoning" && segment.delta) {
              emit({ type: "thinking_delta", runId, text: segment.delta, index: segment.index });
            }
          },
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (opts.signal?.aborted || /aborted/i.test(msg)) {
          stopReason = "aborted";
          break;
        }
        emit({ type: "error", runId, message: msg, stack: err instanceof Error ? err.stack : undefined });
        stopReason = "error";
        break;
      }

      totalUsage = addUsage(totalUsage, result.usage);
      // Local accounting: lets providers without a balance API still be tracked.
      try {
        opts.usageTracker?.record({
          provider: this.cfg.provider || "custom",
          model: this.cfg.model,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          cacheReadTokens: result.usage.cacheReadTokens,
        });
      } catch {
        /* accounting must never break a run */
      }
      emit({ type: "assistant_message", runId, content: result.content });
      await session.append({ role: "assistant", content: result.content });

      const toolUses = result.content.filter((b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use");

      if (result.stopReason !== "tool_use" || toolUses.length === 0) {
        stopReason = result.stopReason;
        break;
      }

      // ---- Execute each tool, collect tool_results in order ----
      const results: ContentBlock[] = [];
      for (const call of toolUses) {
        if (opts.signal?.aborted) break;
        const tool = opts.tools.get(call.name);
        const t0 = Date.now();
        emit({ type: "tool_started", runId, toolUseId: call.id, name: call.name, input: call.input });

        let out: { content: string; isError?: boolean; display?: Record<string, unknown> };
        if (!tool) {
          out = { content: `未知工具: ${call.name}`, isError: true };
        } else if (readOnlyNow() && !readOnlyNow()!.includes(call.name)) {
          out = {
            content: this.planMode
              ? `当前处于计划模式，不能执行会修改环境的工具（${call.name}）。请只做调研并输出计划，然后用 exit_plan_mode 请求批准。`
              : `该工具在当前（只读）模式下不可用: ${call.name}`,
            isError: true,
          };
        } else {
          // Snapshot mutating tools so the turn can be rolled back.
          if (opts.checkpoints && (call.name === "write_file" || call.name === "edit_file")) {
            try {
              const p = (call.input as { path?: string })?.path;
              if (p) {
                const abs = safeResolve(ctx.cwd, p);
                const cp = opts.checkpoints.create(`${call.name}: ${p}`, [abs], ctx.cwd);
                emit({ type: "log", level: "info", message: `已建立检查点 ${cp.id}（${p}）` });
              }
            } catch {
              /* path escapes workspace — the tool will report it */
            }
          }
          try {
            out = await withToolTimeout(tool.execute(call.input, ctx), call.name, ctx.signal);
          } catch (err) {
            out = { content: `工具执行失败: ${err instanceof Error ? err.message : String(err)}`, isError: true };
          }
        }

        emit({
          type: "tool_finished",
          runId,
          toolUseId: call.id,
          name: call.name,
          result: { content: out.content, isError: out.isError, display: out.display },
          ms: Date.now() - t0,
        });
        results.push({ type: "tool_result", toolUseId: call.id, content: out.content, isError: !!out.isError });

        // A plan-mode tool may have asked to switch modes.
        const requested = ctx.state.get(PLAN_MODE_STATE_KEY);
        if (requested === "plan" && !this.planMode) {
          this.planMode = true;
          emit({ type: "log", level: "info", message: "已进入计划模式（只读）" });
        } else if (requested === "build" && this.planMode) {
          this.planMode = false;
          emit({ type: "log", level: "info", message: "已退出计划模式" });
        }
        if (requested) ctx.state.delete(PLAN_MODE_STATE_KEY);
      }

      await session.append({ role: "user", content: results });
      if (step === this.cfg.maxSteps - 1) stopReason = "max_steps";
    }

    emit({ type: "run_finished", runId, stopReason: stopReason as any, usage: totalUsage, ms: Date.now() - started });
    return { stopReason, usage: totalUsage };
  }

  /**
   * Summarise older turns with a helper LLM call, keeping the last few turns
   * verbatim. Only the in-memory working copy is compacted (disk stays intact).
   */
  private async compact(
    messages: ChatMessage[],
    runId: string,
    emit: (e: AgentEvent) => void,
  ): Promise<{ messages: ChatMessage[]; summary: string } | null> {
    if (messages.length < 6) return null;
    const keepTail = 6;
    const head = messages.slice(0, messages.length - keepTail);
    const tail = messages.slice(messages.length - keepTail);

    const transcript = head
      .map((m) => {
        const text =
          typeof m.content === "string"
            ? m.content
            : m.content
                .map((b) =>
                  b.type === "text"
                    ? b.text
                    : b.type === "reasoning"
                      ? `[思考] ${b.text}`
                      : b.type === "tool_use"
                        ? `[tool:${b.name}]`
                        : `[tool_result]`,
                )
                .join(" ");
        return `${m.role}: ${text.slice(0, 2000)}`;
      })
      .join("\n");

    const prompt = `请把以下对话压缩成一段简洁的中文摘要，保留：目标、已完成的动作与结果、关键文件路径、未决问题。不要遗漏重要事实。\n\n${transcript}`;
    try {
      const res = await streamComplete(
        this.cfg,
        {
          system: "你是一个严谨的对话压缩器，只输出摘要正文。",
          messages: [{ role: "user", content: prompt }],
          tools: [],
          maxTokens: 1200,
        },
        () => {},
      );
      const summary = res.content
        .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
      if (!summary) return null;
      const first = messages[0]!;
      const compacted: ChatMessage[] = [
        first,
        { role: "user", content: `[历史摘要]\n${summary}` },
        ...tail,
      ];
      emit({ type: "log", level: "info", message: `上下文已压缩：${head.length} 条历史 → 摘要` });
      return { messages: compacted, summary };
    } catch (err) {
      emit({ type: "log", level: "warn", message: `压缩失败，跳过：${err instanceof Error ? err.message : err}` });
      return null;
    }
  }
}

function makeNotes(cfg: AemeathConfig) {
  return new JsonNoteStore(dataPaths(cfg.dataDir).notes);
}
