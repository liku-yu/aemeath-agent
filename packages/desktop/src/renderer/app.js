/* Aemeath desktop renderer — plain JS (no build step), talks to main via window.aemeath */

const $ = (id) => document.getElementById(id);
const appEl = $("app");
const messagesEl = $("messages");
const inputEl = $("input");
const sendBtn = $("btn-send");
const avatarEl = $("avatar");
const speechEl = $("speech");
const moodLabel = $("mood-label");

/*
 * Surface every uncaught renderer error. Without this, a rejected IPC promise
 * (e.g. a failed save) disappears silently and the UI just "does nothing".
 */
function reportError(where, err) {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[aemeath] ${where}:`, err);
  const hint = document.getElementById("save-hint");
  if (hint && !document.getElementById("settings-overlay")?.classList.contains("hidden")) {
    hint.className = "save-hint err";
    hint.textContent = `${where}: ${msg}`;
    return;
  }
  try {
    addNotice(`✗ ${where}: ${msg}`, true);
  } catch {
    /* the notice helper itself may not be ready yet */
  }
}
window.addEventListener("error", (e) => reportError("渲染错误", e.error ?? e.message));

/*
 * A rejected IPC promise has no other owner: many main-process handlers
 * deliberately do not catch, so a failure would otherwise vanish into the
 * console while the button that triggered it just did nothing.
 *
 * Exactly one listener. Two would double-report every rejection, which is how
 * this looked the last time it was written.
 */
window.addEventListener("unhandledrejection", (e) => {
  const reason = e.reason;
  const msg = reason instanceof Error ? reason.message : String(reason);
  // Expected refusals are not incidents; surfacing them would train the user to
  // ignore the notices that do matter.
  if (/Missing permission|not found|被拒绝|超时|已取消/.test(msg)) return;
  reportError("后台操作失败", reason);
});

let streaming = false;
let currentAssistant = null; // { el, bubble }
let currentText = "";
let pendingPermissionKey = null;
let moodTimer = null;

/* ============================ Aemeath personality ======================== */

const MOOD_LABEL = {
  idle: "待机中",
  thinking: "思考中…",
  working: "忙碌中…",
  waiting: "等待你的决定～",
  happy: "任务完成 ✨",
  error: "遇到点问题…",
  hurt: "唔…被拦下来了",
};

/** Random in-character lines, grouped by situation. */
const LINES = {
  idle: [
    "今天想做点什么？",
    "我一直在这儿。有事喊我。",
    "要不要先跑个测试看看？",
    "自习室今天挺安静的。",
    "……我刚把你的小习惯记下来了。",
    "欉，你在啊。",
  ],
  thinking: [
    "让我想想。",
    "唔，这个有点意思。",
    "从哪儿下手呢……",
    "等下，我先捋一捋。",
    "别急，我在想最省事的做法。",
  ],
  working: [
    "我动一下手。",
    "交给我。",
    "一步步来，快了。",
    "嗯……打开工具箱。",
  ],
  waiting: [
    "等一下，这个有点危险。你确认下？",
    "我停下来了。要你点头。",
    "继续吗？我等你一句话。",
  ],
  happy: [
    "搞定。",
    "好了，是不是很靠谱？",
    "嘿嘿，又一个。",
    "收工。还要弄点别的吗？",
    "锵锵，任务完成。",
  ],
  error: [
    "……卡住了。我看看。",
    "啊，这步没成。原因我给你。",
    "出了点状况。别慌，我来查。",
    "这个我没搞定。老实说。",
  ],
  hurt: [
    "唔…这个动不了，换个办法？",
    "被拦住了。要不我们从别的地方入手。",
    "切，不让就不让嘛…我找别的路。",
  ],
};

/** Per-tool flavored speech, so it feels like she is narrating the work. */
const TOOL_LINES = {
  read_file: "看一眼这个文件。",
  write_file: "要写文件了，先给你过目。",
  edit_file: "动这几行，你看下。",
  list_dir: "先把目录列出来。",
  glob: "找找文件。",
  grep: "搜一下关键词。",
  run_command: "要跑命令了，盯着点。",
  web_fetch: "去网上翻一下。",
  todo: "理一下待办。",
  subagent: "派个人去查，我在这儿等。",
  note_save: "这个记本子上。",
  note_search: "翻翻我之前记的。",
  use_skill: "切到你教我的那套流程。",
};

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/** Aemeath says something (in the sidebar speech bubble). */
function say(text, { typing = false } = {}) {
  speechEl.textContent = text;
  speechEl.classList.remove("flash");
  void speechEl.offsetWidth; // restart animation
  speechEl.classList.add("flash");
  speechEl.classList.toggle("typing", typing);
}

const avatarCanvas = $("avatar-canvas");
const avatarCtx = avatarCanvas.getContext("2d");
const petCanvas = $("pet-canvas");
const petCtx = petCanvas.getContext("2d");
const petDock = $("pet-dock");
const petBubble = $("pet-bubble");
let petMood = "idle";
let petBubbleTimer = null;

/** Behaviour state machine for the embedded pet. */
const pet = window.AemeathPet.create();
/** Whether the agent is mid-run (suppresses self-directed idle actions). */
let agentActive = false;

/** Random in-character mutterings while she plays an idle action. */
const IDLE_MUTTER = [
  "……",
  "嗯哼~",
  "今天天气不错。",
  "要不要休息一下？",
  "唔，我在想事情。",
  "……你还在吗？",
  "雪绒豹豹今天也很乖。",
];

/** Show a speech bubble next to the embedded pet. */
function petSay(text, ms = 4000) {
  if (!text) return;
  petBubble.textContent = text;
  petBubble.classList.remove("hidden");
  if (petBubbleTimer) clearTimeout(petBubbleTimer);
  petBubbleTimer = setTimeout(() => petBubble.classList.add("hidden"), ms);
}

/**
 * Size a canvas so the character exactly fills `cssW` at device resolution,
 * returning the scale to use for draw().
 */
function fitCanvas(canvas, cssW, region) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const s = window.AemeathSprite.displaySize(1, region);
  const scale = (cssW * dpr) / s.w;
  canvas.width = Math.round(s.w * scale);
  canvas.height = Math.round(s.h * scale);
  canvas.style.width = cssW + "px";
  canvas.style.height = (s.h / s.w) * cssW + "px";
  return scale;
}

/**
 * Single rAF loop drives the avatar and the pet.
 * Animation is time-based (elapsed ms) so the variable per-frame durations from
 * the source art are reproduced exactly, independent of refresh rate.
 */
function startAvatarLoop() {
  // Avatars use the square "bust" crop so the face fills the frame.
  const avatarScale = fitCanvas(avatarCanvas, 40, "bust");
  // The pet shows the whole character, wings included.
  const petScale = fitCanvas(petCanvas, 128, "full");
  let last = performance.now();
  let lastAnim = null;

  const step = (now) => {
    const dt = Math.min(now - last, 100); // clamp after tab-switch stalls
    last = now;

    // Avatar mirrors the sidebar mood (always looping, never self-directed).
    window.AemeathSprite.draw(avatarCtx, {
      scale: avatarScale,
      mood: avatarEl.dataset.mood || "idle",
      elapsed: now,
      region: "bust",
    });

    if (!petDock.classList.contains("hidden")) {
      pet.update(dt, agentActive);
      const cur = pet.current();
      window.AemeathSprite.draw(petCtx, {
        scale: petScale,
        anim: cur.anim,
        elapsed: cur.elapsed,
        region: "full",
      });
      // Narrate occasionally when she starts a self-directed action.
      if (cur.anim !== lastAnim) {
        petDock.dataset.anim = cur.anim;
        if (!agentActive && (cur.anim === "waving" || cur.anim === "jumping") && Math.random() < 0.5) {
          petSay(pick(IDLE_MUTTER), 2200);
        }
        lastAnim = cur.anim;
      }
    }
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/** Set the avatar + pet mood; auto-returns to idle for transient moods. */
function setMood(mood, { line, sticky = false } = {}) {
  avatarEl.dataset.mood = mood;
  appEl.dataset.mood = mood;
  moodLabel.textContent = MOOD_LABEL[mood] ?? "";
  if (petMood !== mood) {
    petMood = mood;
    petDock.dataset.mood = mood;
    pet.setMood(mood);
  }
  if (line) {
    say(line);
    petSay(line);
  } else if (LINES[mood]) {
    const l = pick(LINES[mood]);
    say(l);
    petSay(l);
  }

  if (moodTimer) clearTimeout(moodTimer);
  if (!sticky && (mood === "happy" || mood === "error" || mood === "waiting" || mood === "hurt")) {
    moodTimer = setTimeout(() => {
      if (!streaming) {
        avatarEl.dataset.mood = "idle";
        appEl.dataset.mood = "idle";
        petMood = "idle";
        petDock.dataset.mood = "idle";
        pet.setMood("idle");
        moodLabel.textContent = MOOD_LABEL.idle;
      }
    }, mood === "happy" ? 4000 : mood === "hurt" ? 3500 : 6000);
  }
}

/** Greet the user (wave) — used on first load and after a long pause. */
function petGreet() {
  pet.play("waving");
}

/** Paint a static sprite frame into a container (message bubbles / modals). */
function paintAvatar(container, cls) {
  const wrap = document.createElement("div");
  wrap.className = cls;
  const c = document.createElement("canvas");
  const scale = fitCanvas(c, 26, "bust");
  window.AemeathSprite.draw(c.getContext("2d"), { scale, mood: "idle", elapsed: 0, region: "bust" });
  wrap.appendChild(c);
  container.replaceChildren(wrap);
  return wrap;
}

function avatarClone() {
  return paintAvatar(document.createElement("div"), "msg-avatar");
}

/* ------------------------------ helpers ---------------------------------- */

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/** Minimal markdown: fenced code, inline code, bold, links, lists. */
function renderMarkdown(text) {
  let out = escapeHtml(text);
  out = out.replace(/```(\w*)\n?([\s\S]*?)```/g, (_m, _lang, code) => `<pre><code>${code}</code></pre>`);
  out = out.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  out = out.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/(https?:\/\/[^\s<)]+)/g, '<a href="$1" target="_blank" rel="noreferrer">$1</a>');
  return out;
}

function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function addUserMessage(text) {
  const el = document.createElement("div");
  el.className = "msg user";
  el.innerHTML = `<div class="bubble">${escapeHtml(text)}</div>`;
  messagesEl.appendChild(el);
  scrollToBottom();
}

function beginAssistantMessage() {
  // The streaming renderer appends blocks in arrival order, so no empty bubble
  // is created here. Kept for history rendering compatibility.
  if (currentAssistant) return currentAssistant;
  const el = document.createElement("div");
  el.className = "msg assistant";
  el.appendChild(avatarClone());
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  el.appendChild(bubble);
  messagesEl.appendChild(el);
  currentAssistant = { el, bubble };
  currentText = "";
  return currentAssistant;
}

function appendAssistantDelta(text) {
  const a = currentAssistant ?? beginAssistantMessage();
  currentText += text;
  a.bubble.innerHTML = renderMarkdown(currentText);
  scrollToBottom();
}

function finalizeAssistantMessage() {
  if (currentAssistant && !currentText) currentAssistant.el.remove();
  currentAssistant = null;
  currentText = "";
}

/* ------------------- interleaved streaming renderer ---------------------- */

/** Tool cards by toolUseId (populated when the tool actually starts). */
const toolCards = new Map();

/** Open content blocks, keyed by the provider's segment index. */
const streamBlocks = new Map();
/** Tool cards created from stream segments, awaiting their tool_started event. */
let pendingToolCards = [];
let typingEl = null;

function showTyping() {
  if (typingEl) return;
  typingEl = document.createElement("div");
  typingEl.className = "msg assistant";
  typingEl.appendChild(avatarClone());
  const b = document.createElement("div");
  b.className = "bubble";
  b.innerHTML = `<span class="typing-bubble"><i></i><i></i><i></i></span>`;
  typingEl.appendChild(b);
  messagesEl.appendChild(typingEl);
  scrollToBottom();
}

function hideTyping() {
  if (typingEl) {
    typingEl.remove();
    typingEl = null;
  }
}

/** Append a reasoning block; subsequent reasoning deltas extend it. */
function appendReasoning(index, delta) {
  hideTyping();
  let b = streamBlocks.get(index);
  if (!b || b.kind !== "reasoning") {
    const el = document.createElement("div");
    el.className = "msg thinking";
    el.appendChild(avatarClone());
    const bubble = document.createElement("div");
    bubble.className = "bubble";
    bubble.innerHTML = `<span class="think-label">思考中…</span><span class="think-text"></span>`;
    el.appendChild(bubble);
    messagesEl.appendChild(el);
    b = { kind: "reasoning", el, textEl: bubble.querySelector(".think-text"), text: "" };
    streamBlocks.set(index, b);
  }
  b.text += delta;
  b.textEl.textContent = b.text;
  scrollToBottom();
}

/** Append an assistant text block; a new index starts a new paragraph. */
function appendText(index, delta) {
  hideTyping();
  let b = streamBlocks.get(index);
  if (!b || b.kind !== "text") {
    const el = document.createElement("div");
    el.className = "msg assistant";
    el.appendChild(avatarClone());
    const bubble = document.createElement("div");
    bubble.className = "bubble";
    el.appendChild(bubble);
    messagesEl.appendChild(el);
    b = { kind: "text", el, bubble, text: "" };
    streamBlocks.set(index, b);
  }
  b.text += delta;
  b.bubble.innerHTML = renderMarkdown(b.text);
  scrollToBottom();
}

/** A tool call started streaming: place the card at this exact position. */
function appendToolFromStream(index, name) {
  hideTyping();
  const existing = streamBlocks.get(index);
  if (existing && existing.kind === "tool") return existing.card;
  const card = addToolCard(name || "工具", {});
  streamBlocks.set(index, { kind: "tool", card, name: name || "" });
  pendingToolCards.push(card);
  return card;
}

/** Reset per-run streaming state. */
function resetStream() {
  streamBlocks.clear();
  pendingToolCards = [];
  hideTyping();
  currentAssistant = null;
  currentText = "";
}

/**
 * Tear down everything that belongs to a single run.
 *
 * `streaming`/`sendBtn` were reset on run end, but two pieces of per-run state
 * were not:
 *
 *   - a permission dialog left on screen after an abort. Its buttons then ran
 *     `permissionResult` against a run that no longer exists, and the dialog had
 *     to be dismissed by luck.
 *   - `toolCards` entries for tools that never reported `tool_finished` (an
 *     aborted run, a killed MCP server). Those accumulated across runs.
 */
function endRun() {
  streaming = false;
  agentActive = false;
  sendBtn.disabled = false;
  resetStream();

  if (pendingPermissionKey || !$("perm-overlay").classList.contains("hidden")) {
    $("perm-overlay").classList.add("hidden");
    pendingPermissionKey = null;
    addNotice("这次授权请求已经作废了（任务已结束）。");
  }
  for (const card of toolCards.values()) {
    const status = card.querySelector(".tool-status");
    if (status && status.textContent === "") status.textContent = "已中断";
  }
  toolCards.clear();
}

/** Apply an ordered StreamSegment from the core. */
function handleSegment(seg) {
  switch (seg.kind) {
    case "reasoning":
      if (seg.delta) appendReasoning(seg.index, seg.delta);
      break;
    case "text":
      if (seg.delta) appendText(seg.index, seg.delta);
      break;
    case "tool_call":
      if (seg.name) appendToolFromStream(seg.index, seg.name);
      break;
    case "segment_end":
      break;
  }
}

/** The model asked for a tool: bind its card (created during streaming). */
function bindToolCard(name, toolUseId) {
  hideTyping();
  const idx = pendingToolCards.findIndex((c) => c.dataset.name === name);
  const card = idx >= 0 ? pendingToolCards.splice(idx, 1)[0] : addToolCard(name, {});
  card.dataset.name = name;
  toolCards.set(toolUseId, card);
  return card;
}

function addToolCard(name, input) {
  const el = document.createElement("div");
  el.className = "tool";
  el.dataset.name = name;
  el.innerHTML = `
    <div class="tool-head">
      <span>⚙</span><span class="tool-name">${escapeHtml(name)}</span>
      <span class="tool-status">运行中…</span>
    </div>
    <div class="tool-input">${escapeHtml(JSON.stringify(input ?? {}).slice(0, 240))}</div>
    <div class="tool-detail collapsed"></div>`;
  el.querySelector(".tool-head").addEventListener("click", () => {
    el.querySelector(".tool-detail").classList.toggle("collapsed");
  });
  if (compactTools) el.querySelector(".tool-detail").classList.add("collapsed");
  messagesEl.appendChild(el);
  scrollToBottom();
  return el;
}

function setToolInput(card, input) {
  if (!card || !input) return;
  const box = card.querySelector(".tool-input");
  if (box) box.textContent = JSON.stringify(input).slice(0, 240);
}

function finishToolCard(el, result, ms) {
  const status = el.querySelector(".tool-status");
  status.textContent = result.isError ? `✗ ${ms}ms` : `✓ ${ms}ms`;
  el.classList.add(result.isError ? "err" : "ok");
  const detail = el.querySelector(".tool-detail");
  detail.textContent = result.content ?? "";
  if (result.isError) detail.classList.remove("collapsed");
  scrollToBottom();
}

/* ---------------------------- event handling ----------------------------- */

function handleEvent(ev) {
  switch (ev.type) {
    case "run_started":
      streaming = true;
      agentActive = true;
      sendBtn.disabled = true;
      resetStream();
      showTyping();
      setMood("thinking", { sticky: true });
      break;
    case "stream":
      handleSegment(ev.segment);
      break;
    case "thinking_delta":
      // Alias — the ordered "stream" event already handles reasoning. Ignore
      // here to avoid double-rendering; kept for API compatibility.
      break;
    case "assistant_delta":
      break;
    case "assistant_message":
      break;
    case "tool_started": {
      const card = bindToolCard(ev.name, ev.toolUseId);
      setToolInput(card, ev.input);
      setMood("working", { line: TOOL_LINES[ev.name] ?? pick(LINES.working), sticky: true });
      break;
    }
    case "tool_finished": {
      const card = toolCards.get(ev.toolUseId);
      if (card) finishToolCard(card, ev.result, ev.ms);
      toolCards.delete(ev.toolUseId);
      // A refusal or a timeout is worth an in-character reaction: it is the
      // "力竭 / 受击" moment, and it tells the user something changed.
      const denied = !!(ev.result && ev.result.display && ev.result.display.denied);
      const timedOut = !!(ev.result && ev.result.isError && /超时|已取消/.test(ev.result.content || ""));
      if (denied) {
        setMood("hurt", { line: pick(LINES.hurt) });
      } else if (timedOut) {
        setMood("hurt", { line: "这个卡太久了，我先撒手了…" });
      }
      break;
    }
    case "permission_requested":
      setMood("waiting", { sticky: true });
      showPermission(ev.request);
      break;
    case "compaction":
      addNotice(`↻ 上下文有点满啦，我把它压缩了一下：~${ev.before} → ~${ev.after} tokens`);
      setMood("thinking", { line: "记忆有点满…我整理一下再继续。" });
      break;
    case "run_finished":
      endRun();
      // run_finished always fires; only celebrate on a clean end.
      if (ev.stopReason === "end_turn") setMood("happy");
      else if (ev.stopReason === "aborted") setMood("idle", { line: "好，停下来了。" });
      else setMood("error");
      break;
    case "error":
      endRun();
      addNotice(`✗ ${ev.message}`, true);
      setMood("error");
      break;
    case "usage":
      /*
       * Emitted by the core on every step and previously dropped on the floor.
       * Surfacing it is what lets the header warn *before* a compaction rather
       * than only reporting one after the fact.
       */
      if (typeof ev.budget === "number" && ev.budget > 0) {
        const pct = Math.min(100, Math.round(((ev.contextTokens ?? 0) / ev.budget) * 100));
        const el = $("ctx-fill");
        if (el) {
          el.style.width = `${pct}%`;
          el.classList.toggle("warn", pct >= 70);
          el.classList.toggle("bad", pct >= 90);
          const wrap = $("ctx-meter");
          if (wrap) wrap.title = `上下文 ~${ev.contextTokens ?? 0} / ${ev.budget} tokens（${pct}%）`;
        }
      }
      break;
    case "permission_resolved":
      // Handled implicitly: `permission_requested` already drove the dialog, and
      // the core resolves it in the same turn.
      break;
    case "log":
      break;
    default:
      // A new core event the UI does not know about yet is a bug worth seeing,
      // not something to swallow silently.
      console.warn("[aemeath] 未处理的事件类型:", ev?.type);
      break;
  }
}

function addNotice(text, isError = false) {
  /*
   * Notices are system output, not conversation. Rendering them as `.msg >
   * .bubble` made them indistinguishable from the assistant's own messages —
   * a hint, a failure and a reply all looked like the same thing speaking.
   */
  const el = document.createElement("div");
  el.className = "notice" + (isError ? " err" : "");
  el.textContent = text;
  messagesEl.appendChild(el);
  scrollToBottom();
}

/* ------------------------ provider / model switcher ---------------------- */

/**
 * The topbar picker lets you switch which provider's which model is active
 * without opening settings — the flow mature harnesses optimise for, since
 * model choice is changed far more often than anything else.
 */
const picker = {
  open: false,
  provider: "",
  models: [],
  /** Index into the model list (-1 = none highlighted). */
  cursor: -1,
  search: "",
};

function providerLabel(id) {
  const p = currentPresets.find((x) => x.id === id);
  return p ? p.label : id || "自定义";
}

function renderSwitcher(st) {
  picker.provider = st.provider || "custom";
  $("pk-provider").textContent = providerLabel(picker.provider);
  $("pk-model").textContent = st.model || "—";
  $("btn-picker").title = `${providerLabel(picker.provider)} / ${st.model || "未选择"}`;
}

/**
 * Models for a provider in the picker.
 *
 * Scoping caveat: only the *current* endpoint has a trustworthy scope key
 * (provider + URL + key fingerprint). Other providers therefore show what we
 * actually know for them; we never synthesise a preset default.
 */
function modelsForProvider(st, providerId) {
  const isCurrent = providerId === (st.provider || "custom");
  if (isCurrent) return gatherModels(st);

  // Another provider: its cached lists are keyed by scopes that include a key
  // fingerprint we cannot reconstruct here. Aggregate every scope that starts
  // with this provider id — they were all really detected.
  const pick = (map) =>
    Object.entries(map ?? {})
      .filter(([scope]) => scope.startsWith(providerId + "@"))
      .flatMap(([, list]) => list ?? []);
  const merged = [...new Set([...pick(st.detectedModels), ...pick(st.savedModels)])];
  // The active model of another provider is not knowable; don't invent it.
  return merged;
}

async function openPicker() {
  const st = await window.aemeath.status();
  picker.provider = st.provider || "custom";
  picker.search = "";
  $("picker-search").value = "";
  $("picker-overlay").classList.remove("hidden");
  picker.open = true;
  renderPickerProviders(st);
  renderPickerModels(st);
  $("picker-search").focus();
}

function closePicker() {
  picker.open = false;
  $("picker-overlay").classList.add("hidden");
}

function renderPickerProviders(st) {
  const box = $("picker-providers");
  const q = picker.search.toLowerCase();
  const ids = currentPresets.map((p) => p.id);
  // Scope keys look like "provider@url#fingerprint" — surface any provider that
  // actually has detection results, even if it is not a registered preset.
  const scopedProviders = [...Object.keys(st.savedModels ?? {}), ...Object.keys(st.detectedModels ?? {})].map(
    (scope) => scope.split("@")[0],
  );
  for (const id of scopedProviders) {
    if (id && !ids.includes(id)) ids.push(id);
  }

  box.innerHTML = "";
  let shown = 0;
  for (const id of ids) {
    const label = providerLabel(id);
    const models = modelsForProvider(st, id);
    if (q && !label.toLowerCase().includes(q) && !models.some((m) => m.toLowerCase().includes(q))) continue;
    shown++;

    const row = document.createElement("button");
    row.type = "button";
    row.className = "picker-item provider" + (id === picker.provider ? " active" : "");
    row.innerHTML =
      `<span class="pi-label">${escapeHtml(label)}</span>` +
      `<span class="pi-count">${models.length || ""}</span>`;
    row.addEventListener("click", () => {
      picker.provider = id;
      picker.cursor = -1;
      renderPickerProviders(st);
      renderPickerModels(st);
    });
    box.appendChild(row);
  }
  if (!shown) box.innerHTML = '<div class="picker-empty">没有匹配的供应商</div>';
}

function renderPickerModels(st) {
  const box = $("picker-models");
  const q = picker.search.toLowerCase();
  const all = modelsForProvider(st, picker.provider);
  picker.models = q ? all.filter((m) => m.toLowerCase().includes(q)) : all;

  box.innerHTML = "";
  if (!picker.models.length) {
    box.innerHTML =
      '<div class="picker-empty">这个供应商还没有模型。<br/>在设置里「检测可用模型」或手动添加。</div>';
    return;
  }

  const activeModel = picker.provider === (st.provider || "custom") ? st.model : "";
  picker.models.forEach((m, i) => {
    const row = document.createElement("button");
    row.type = "button";
    row.className =
      "picker-item model" + (m === activeModel ? " active" : "") + (i === picker.cursor ? " cursor" : "");
    row.dataset.index = String(i);
    row.innerHTML =
      `<span class="pi-label">${escapeHtml(m)}</span>` +
      (m === activeModel ? '<span class="pi-check">✓</span>' : "");
    row.addEventListener("click", () => applyPicker(m));
    row.addEventListener("mouseenter", () => {
      picker.cursor = i;
      for (const r of box.querySelectorAll(".model")) r.classList.toggle("cursor", Number(r.dataset.index) === i);
    });
    box.appendChild(row);
  });
}

/** Switch provider+model immediately (no settings round-trip). */
async function applyPicker(modelId) {
  const provider = picker.provider;
  const preset = currentPresets.find((p) => p.id === provider);
  const patch = { provider, model: modelId };
  // Adopt the provider's endpoint/mode only when it differs from what we have.
  const st = await window.aemeath.status();
  if (preset && preset.id !== "custom" && provider !== st.provider) {
    patch.baseUrl = preset.baseUrl;
    if (preset.modes.length) patch.apiMode = preset.modes[0];
  }
  await window.aemeath.setConfig(patch);
  closePicker();
  await refreshStatus({ loadForm: true });
  renderBalance(await window.aemeath.getBalance().catch(() => null));
  addNotice(`已切换到 ${providerLabel(provider)} / ${modelId}`);
  setMood("happy", { line: `换成 ${modelId} 啦～` });
}

$("btn-picker").addEventListener("click", () => (picker.open ? closePicker() : openPicker()));
$("picker-manage").addEventListener("click", () => {
  closePicker();
  $("btn-settings").click();
  document.querySelector('.settings-tabs .tab[data-tab="model"]')?.click();
});
$("picker-overlay").addEventListener("click", (e) => {
  if (e.target === $("picker-overlay")) closePicker();
});
$("picker-search").addEventListener("input", async (e) => {
  picker.search = e.target.value.trim();
  picker.cursor = -1;
  const st = await window.aemeath.status();
  renderPickerProviders(st);
  renderPickerModels(st);
});
$("picker-search").addEventListener("keydown", (e) => {
  if (e.key === "Escape") return closePicker();
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    if (!picker.models.length) return;
    const dir = e.key === "ArrowDown" ? 1 : -1;
    picker.cursor = (picker.cursor + dir + picker.models.length) % picker.models.length;
    const box = $("picker-models");
    for (const r of box.querySelectorAll(".model")) {
      const on = Number(r.dataset.index) === picker.cursor;
      r.classList.toggle("cursor", on);
      if (on) r.scrollIntoView({ block: "nearest" });
    }
    return;
  }
  if (e.key === "Enter") {
    e.preventDefault();
    const pick = picker.models[picker.cursor] ?? picker.models[0];
    if (pick) applyPicker(pick);
  }
});


/* ---------------------------- confirm dialog ----------------------------- */

/**
 * Themed replacement for window.confirm().
 * @param {{title?:string, body?:string, note?:string, okText?:string, danger?:boolean}} opts
 * @returns {Promise<boolean>}
 */
function askConfirm(opts = {}) {
  return new Promise((resolve) => {
    const overlay = $("confirm-overlay");
    $("confirm-title").textContent = opts.title || "确认操作";
    $("confirm-body").textContent = opts.body || "";
    const note = $("confirm-note");
    if (opts.note) {
      note.textContent = opts.note;
      note.classList.remove("hidden");
    } else {
      note.classList.add("hidden");
    }
    const ok = $("confirm-ok");
    ok.textContent = opts.okText || "确定";
    ok.classList.toggle("danger", opts.danger !== false);

    /*
     * Optional input. Two dialogs that only differed by "and type a name" were
     * being written; folding the field in here keeps one code path (and one set
     * of keyboard/backdrop handlers) rather than two nearly-identical modals.
     */
    const inputWrap = $("confirm-input-wrap");
    const inputEl2 = $("confirm-input");
    const wantsInput = Boolean(opts.input);
    inputWrap.classList.toggle("hidden", !wantsInput);
    if (wantsInput) {
      $("confirm-input-label").textContent = opts.input.label ?? "";
      inputEl2.placeholder = opts.input.placeholder ?? "";
      inputEl2.value = opts.input.value ?? "";
      inputEl2.disabled = false;
    }

    // Swap the avatar mood while the dialog is up.
    paintAvatar($("confirm-avatar"), "mini-avatar");
    setMood("waiting", { sticky: true });

    const finish = (value) => {
      overlay.classList.add("hidden");
      ok.removeEventListener("click", onOk);
      cancel.removeEventListener("click", onCancel);
      overlay.removeEventListener("click", onBackdrop);
      document.removeEventListener("keydown", onKey);
      resolve(value);
    };
    const onOk = () => {
      if (!wantsInput) return finish(true);
      const value = inputEl2.value.trim();
      // An empty name is not a name; keep the dialog open instead of creating
      // a provider called "".
      if (!value) {
        inputEl2.focus();
        inputEl2.classList.add("shake");
        setTimeout(() => inputEl2.classList.remove("shake"), 400);
        return;
      }
      finish(value);
    };
    const onCancel = () => finish(false);
    const onBackdrop = (e) => {
      if (e.target === overlay) finish(false);
    };
    if (wantsInput) setTimeout(() => inputEl2.focus(), 30);
    inputEl2.onkeydown = (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        onOk();
      }
    };

    const onKey = (e) => {
      if (e.key === "Escape") finish(false);
      else if (e.key === "Enter") finish(true);
    };
    const cancel = $("confirm-cancel");

    ok.addEventListener("click", onOk);
    cancel.addEventListener("click", onCancel);
    overlay.addEventListener("click", onBackdrop);
    document.addEventListener("keydown", onKey);
    overlay.classList.remove("hidden");
    ok.focus();
  });
}

/* ---------------------------- permissions -------------------------------- */

function showPermission(req) {
  pendingPermissionKey = req.key;
  $("perm-title").textContent = `${req.title}`;
  $("perm-detail").textContent = req.detail;
  paintAvatar($("perm-avatar"), "mini-avatar");

  // "允许这一类" is only offered when widening the rule is meaningful and safe
  // (the core decides; dangerous commands never carry a suggestion).
  const classBtn = $("perm-class");
  const classHint = $("perm-class-hint");
  if (req.suggestion) {
    classBtn.style.display = "";
    classBtn.textContent = "允许这一类";
    classHint.textContent = `这一类 = ${req.suggestion}`;
  } else {
    classBtn.style.display = "none";
    classHint.textContent = "";
  }
  $("perm-overlay").classList.remove("hidden");
}

async function answerPermission(decision) {
  if (pendingPermissionKey) {
    await window.aemeath.permissionResult(pendingPermissionKey, decision);
    pendingPermissionKey = null;
  }
  $("perm-overlay").classList.add("hidden");
  const line =
    decision === "deny"
      ? "好的，我不动它～"
      : decision === "allow_always"
        ? "记下啦，以后这条不再烦你✨"
        : decision === "allow_class"
          ? "好，这一整类我都记下了✨"
          : "收到，我继续啦～";
  setMood(decision === "deny" ? "idle" : "working", { line, sticky: decision !== "deny" });
}

$("perm-deny").addEventListener("click", () => answerPermission("deny"));
$("perm-once").addEventListener("click", () => answerPermission("allow_once"));
$("perm-always").addEventListener("click", () => answerPermission("allow_always"));
$("perm-class").addEventListener("click", () => answerPermission("allow_class"));

/* ------------------------------ composer --------------------------------- */

async function send(textOverride) {
  const text = (textOverride ?? inputEl.value).trim();
  if (!text || streaming) return;
  inputEl.value = "";
  inputEl.style.height = "auto";
  const welcome = messagesEl.querySelector(".welcome");
  if (welcome) welcome.remove();
  addUserMessage(text);
  const res = await window.aemeath.send(text);
  if (res && res.ok === false) {
    // e.g. a run was already in flight; say so instead of showing nothing.
    addNotice(`✗ ${res.error}`, true);
    endRun();
  }
}

sendBtn.addEventListener("click", () => send());
inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});
inputEl.addEventListener("input", () => {
  inputEl.style.height = "auto";
  inputEl.style.height = Math.min(inputEl.scrollHeight, 200) + "px";
});

$("btn-stop").addEventListener("click", () => {
  window.aemeath.abort();
  setMood("idle", { line: "好，停下来了。" });
});

/* ---------------------------- harness controls --------------------------- */

let planMode = false;

function renderPlanButton() {
  const b = $("btn-plan");
  b.classList.toggle("active", planMode);
  b.textContent = planMode ? "📋 计划中" : "📋 计划";
  document.body.classList.toggle("plan-mode", planMode);
}

$("btn-plan").addEventListener("click", async () => {
  planMode = !planMode;
  await window.aemeath.setPlanMode(planMode);
  renderPlanButton();
  setMood(planMode ? "thinking" : "idle", {
    line: planMode ? "计划模式启动～我只看看，不动手✨" : "回到执行模式啦，可以动手了。",
    sticky: planMode,
  });
  addNotice(planMode ? "已进入计划模式：只读调研，不会修改任何文件。" : "已退出计划模式。");
});

$("btn-undo").addEventListener("click", async () => {
  const res = await window.aemeath.undo();
  if (res.ok) {
    addNotice(`↶ 已回滚：${res.label}（${res.files.join("、")}）`);
    setMood("happy", { line: "已经帮你撤销掉啦～" });
  } else {
    addNotice(res.message || "没有可回滚的改动", true);
  }
});
$("btn-new").addEventListener("click", async () => {
  await window.aemeath.newSession();
  messagesEl.innerHTML = "";
  renderWelcome();
  await refreshStatus();
  await refreshSessions();
  setMood("idle", { line: "开个新会话～这次想做什么？" });
});

/* ------------------------------ welcome ---------------------------------- */

const SUGGESTIONS = [
  "介绍一下这个项目",
  "找出所有 TODO 并汇总",
  "跑一遍测试看看有没有问题",
  "帮我写一个 README",
  "重构这段代码让它更清晰",
  "解释一下这个函数在做什么",
];

function renderWelcome() {
  if (messagesEl.querySelector(".msg")) return;
  const card = document.createElement("div");
  card.className = "welcome";
  card.innerHTML = `
    <h2>你好呀，我是爱弥斯 ✨</h2>
    <p>我是常驻在你桌面上的 AI 伙伴。给我一个目标，我会自己规划步骤、读文件、跑命令，<br/>一步一步做完给你看。</p>
    <div class="chips">
      ${SUGGESTIONS.map((s) => `<span class="chip">${escapeHtml(s)}</span>`).join("")}
    </div>`;
  card.querySelectorAll(".chip").forEach((chip) => {
    chip.addEventListener("click", () => send(chip.textContent));
  });
  messagesEl.appendChild(card);
}

/* ------------------------------ sessions --------------------------------- */

async function refreshSessions() {
  const list = await window.aemeath.listSessions();
  const st = await window.aemeath.status();
  const container = $("sessions");
  container.innerHTML = "";
  if (!list.length) {
    const empty = document.createElement("div");
    empty.className = "session-item empty";
    empty.textContent = "暂无会话";
    container.appendChild(empty);
    return;
  }
  const activeId = st.sessionId;
  for (const s of list.slice(0, 30)) {
    const el = document.createElement("div");
    el.className = "session-item" + (s.id === activeId ? " active" : "");
    el.title = `${s.title || "新会话"}\n${new Date(s.updatedAt).toLocaleString()}\n${s.id}`;

    const label = document.createElement("span");
    label.className = "label";
    label.textContent = `${s.title || "新会话"} · ${s.messageCount}条`;
    el.appendChild(label);

    const del = document.createElement("button");
    del.className = "x";
    del.type = "button";
    del.textContent = "×";
    del.title = "删除这个会话";
    del.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation(); // don't also switch to the session
      const okDel = await askConfirm({
        title: "删除会话",
        body: s.title || "新会话",
        note: `共 ${s.messageCount} 条消息，删除后无法恢复。`,
        okText: "删除",
      });
      if (!okDel) return;
      del.disabled = true;
      del.textContent = "…";
      try {
        const res = await window.aemeath.deleteSession(s.id);
        if (res && res.ok === false) throw new Error(res.error || "删除失败");
        // If we deleted the session we were viewing, clear the transcript.
        if (s.id === activeId) {
          messagesEl.innerHTML = "";
          renderWelcome();
        }
        await refreshSessions();
        await refreshStatus();
        addNotice(`已删除会话「${s.title || "新会话"}」。`);
      } catch (err) {
        del.disabled = false;
        del.textContent = "×";
        reportError("删除会话失败", err);
      }
    });
    el.appendChild(del);

    el.addEventListener("click", async () => {
      try {
        const history = await window.aemeath.resumeSession(s.id);
        messagesEl.innerHTML = "";
        renderHistory(history);
        if (!history.length) renderWelcome();
        await refreshStatus();
        document.querySelectorAll(".session-item").forEach((n) => n.classList.remove("active"));
        el.classList.add("active");
        setMood("idle", { line: "把之前的会话找回来啦～" });
      } catch (err) {
        reportError("打开会话失败", err);
      }
    });
    container.appendChild(el);
  }
}

function renderHistory(messages) {
  for (const m of messages) {
    if (typeof m.content === "string") {
      if (m.role === "user") addUserMessage(m.content);
      else if (m.role === "assistant") {
        beginAssistantMessage();
        appendAssistantDelta(m.content);
        finalizeAssistantMessage();
      }
      continue;
    }
    // Content blocks were stored in production order — render them the same way.
    for (const b of m.content) {
      if (b.type === "reasoning" && m.role === "assistant") {
        const el = document.createElement("div");
        el.className = "msg thinking";
        el.appendChild(avatarClone());
        const bubble = document.createElement("div");
        bubble.className = "bubble";
        bubble.innerHTML = `<span class="think-label">思考</span><span class="think-text"></span>`;
        el.appendChild(bubble);
        bubble.querySelector(".think-text").textContent = b.text;
        messagesEl.appendChild(el);
      } else if (b.type === "text" && m.role === "assistant") {
        beginAssistantMessage();
        appendAssistantDelta(b.text);
        finalizeAssistantMessage();
      } else if (b.type === "tool_use") {
        const card = addToolCard(b.name, b.input);
        finishToolCard(card, { content: "(历史记录)", isError: false }, 0);
      }
    }
  }
  scrollToBottom();
}

/* ------------------------------ status/settings --------------------------- */

/**
 * Refresh runtime status, and optionally reload the settings form.
 *
 * `loadForm` defaults to FALSE on purpose.
 *
 * Repopulating the form on every refresh was the real cause of "saving a key
 * jumps to 自定义": it reset provider, Base URL, model and apiMode back to the
 * *active* config, throwing away the provider the user had selected and was
 * editing. Anything that merely reads status (a session switch, a key save)
 * must not touch form fields the user owns.
 *
 * Pass `loadForm: true` only when the config genuinely changed underneath —
 * opening settings, saving them, or switching models from the toolbar.
 */
async function refreshStatus({ loadForm = false } = {}) {
  const st = await window.aemeath.status();

  // Runtime state: always safe to refresh.
  $("cwd").textContent = st.cwd;
  renderSwitcher(st);
  $("model-pill").textContent = st.model;
  $("pet-model").textContent = st.model;
  $("status").innerHTML = `会话: ${escapeHtml(st.sessionId || "-")}<br>工具: ${st.tools.length} 个${st.hasKey ? "" : "<br><span style='color:var(--red)'>未配置 API Key</span>"}`;
  $("config-path").textContent = st.configPath || "";
  savedProviderId = st.provider || "custom";
  savedKeyScopes = new Set(st.credentialStore?.savedScopes ?? []);

  if (loadForm) {
    $("cfg-baseUrl").value = st.baseUrl;
    $("cfg-model").value = st.model;
    $("cfg-cwd").value = st.cwd;
    $("cfg-provider").value = savedProviderId;
    $("cfg-apiMode").value = st.apiMode || "chat";
    $("cfg-maxTokens").value = st.maxTokens ?? 8192;
    $("cfg-temperature").value = st.temperature ?? 0.3;
    $("cfg-maxSteps").value = st.maxSteps ?? 40;
    $("cfg-contextBudget").value = st.contextBudget ?? 120000;
    $("cfg-persona-enabled").checked = st.personaEnabled !== false;
    $("cfg-persona-file").value = st.personaFile || "";
    $("cfg-perm-write").value = st.permissions?.writeFile ?? "ask";
    $("cfg-perm-exec").value = st.permissions?.runCommand ?? "ask";
  }

  updateModeHint();
  updateBaseUrlReset();
  // The key field tracks the *selected* provider, so ask for that one.
  await syncKeyState();
  return st;
}

let currentPresets = [];

/**
 * Show a "restore default" button whenever the Base URL differs from the
 * provider's own definition.
 *
 * Hand-editing an endpoint is the easiest way to break a working setup (a
 * stray slash, a missing /v1, a typo in the host), and the symptom is an opaque
 * 404 much later. Making the way back one click away is cheaper than debugging.
 */
function updateBaseUrlReset() {
  const btn = $("cfg-baseUrl-reset");
  const hint = $("cfg-baseUrl-hint");
  if (!btn) return;

  const preset = currentPresets.find((p) => p.id === $("cfg-provider").value);
  const current = $("cfg-baseUrl").value.trim().replace(/\/+$/, "");
  const canonical = (preset?.baseUrl ?? "").trim().replace(/\/+$/, "");

  const canReset = Boolean(canonical);
  const differs = canReset && current !== canonical;

  btn.classList.toggle("hidden", !differs);
  if (!differs) {
    hint.classList.add("hidden");
    hint.textContent = "";
    return;
  }
  hint.classList.remove("hidden");
  hint.innerHTML =
    `当前地址与 <b>${escapeHtml(preset.label)}</b> 的默认值不一致 —— 默认是 ` +
    `<code>${escapeHtml(canonical)}</code>`;
}

/**
 * Debounce the key lookup: the stored key is scoped to provider + base URL, so
 * editing the URL changes which credential applies. One IPC per keystroke would
 * be wasteful, so settle first.
 */
let keyScopeTimer = null;
function scheduleKeySync() {
  if (keyScopeTimer) clearTimeout(keyScopeTimer);
  keyScopeTimer = setTimeout(() => {
    keyScopeTimer = null;
    void syncKeyState();
  }, 350);
}

$("cfg-baseUrl").addEventListener("input", () => {
  updateBaseUrlReset();
  updateModeHint();
  scheduleKeySync();
  void updateLogoPreview();
});

$("cfg-baseUrl-reset").addEventListener("click", () => {
  const preset = currentPresets.find((p) => p.id === $("cfg-provider").value);
  if (!preset?.baseUrl) return;
  $("cfg-baseUrl").value = preset.baseUrl;
  // The protocol is part of the same definition, so restore it together —
  // a default URL paired with a hand-changed protocol is still broken.
  const mode = preset.apiMode || preset.modes?.[0];
  if (mode) $("cfg-apiMode").value = mode;
  updateBaseUrlReset();
  updateModeHint();
  addNotice(`已把 ${preset.label} 的 Base URL 恢复为默认值。`);
});

/**
 * Explain which endpoint the current provider+mode will actually call.
 *
 * The URL comes from the main process (same code path as a real request) rather
 * than being re-derived here — one implementation, so the hint cannot drift from
 * what we actually send.
 */
let modeHintSeq = 0;
async function updateModeHint() {
  const seq = ++modeHintSeq;
  const mode = $("cfg-apiMode").value;
  const base = ($("cfg-baseUrl").value || "").trim();
  const preset = currentPresets.find((p) => p.id === $("cfg-provider").value);
  const warn =
    preset && preset.modes?.length && !preset.modes.includes(mode)
      ? `  ⚠ 该供应商通常使用 ${preset.modes.join(" / ")}`
      : "";

  if (!base) {
    $("mode-hint").textContent = `将请求：(未设置 Base URL)${warn}`;
    return;
  }
  let url = "";
  try {
    url = await window.aemeath.endpointUrl(base, mode);
  } catch {
    url = "";
  }
  // A slower earlier call must not overwrite a newer result.
  if (seq !== modeHintSeq) return;
  $("mode-hint").textContent = `将请求：${url || base}${warn}`;
}

async function loadProviders() {
  try {
    currentPresets = await window.aemeath.providers();
  } catch {
    currentPresets = [];
  }
  // The hidden <select> stays the single source of truth for the rest of the
  // settings code; the visible card list just writes into it.
  const sel = $("cfg-provider");
  const keep = sel.value;
  sel.innerHTML = currentPresets
    .map((p) => `<option value="${p.id}">${escapeHtml(p.label)}</option>`)
    .join("");
  if (keep && currentPresets.some((p) => p.id === keep)) sel.value = keep;
  renderProviderNav();
  renderProviderDetail();
  renderProviderManage();
}

/* ===================== provider list (ZCode-style cards) ================== */

/**
 * Status for the list dot.
 *
 * Only the *active* provider's credential state is known locally, so we report
 * "disabled" for the rest rather than inventing a status we cannot verify.
 * Honesty beats a pretty list here: a green dot that means nothing is worse
 * than a grey one that means "unknown".
 */
/**
 * Status for a provider card.
 *
 * Derived from the credential store's scope list, so every card tells the truth
 * about *its own* key. Previously only the active provider's state was known, so
 * every other card had to show a meaningless "unknown" dot — which stopped being
 * acceptable once the key field started following the selection.
 */
function providerStatus(preset) {
  if (preset.needsKey === false) return "ready"; // local provider: nothing to configure
  // The selected card may have an edited (unsaved) URL, so prefer the scope the
  // main process reported for exactly that endpoint.
  const isSelected = preset.id === $("cfg-provider").value;
  const scope = (isSelected && selectedKeyScope) || preset.scope;
  return savedKeyScopes.has(scope) ? "ready" : "unavailable";
}

function renderProviderNav() {
  const list = $("prov-nav-list");
  if (!list) return;
  const activeId = $("cfg-provider").value;
  const builtin = currentPresets.filter((p) => !p.custom && p.id !== "custom");
  const custom = currentPresets.filter((p) => p.custom);
  // The free-form "custom" placeholder is not a template, so it normally stays
  // out of the list — but the active provider must never be invisible, or the
  // user cannot tell what they are editing.
  const freeform = currentPresets.find((p) => p.id === "custom");
  const customRows =
    savedProviderId === "custom" && freeform
      ? [...custom, { ...freeform, label: "自定义（自由填写）" }]
      : custom;
  const row = (p) => {
    const status = providerStatus(p);
    const dot = `<span class="prov-dot ${status}" title="${
      status === "ready" ? "可用" : status === "unavailable" ? "缺少 API Key" : "未在使用"
    }"></span>`;
    return (
      `<button type="button" class="prov-item${
        p.id === activeId ? " selected" : ""
      }" data-provider="${escapeHtml(p.id)}">` +
      `<span class="prov-item-glyph">${escapeHtml(p.logo || "✨")}</span>` +
      `<span class="prov-item-label">${escapeHtml(p.label)}</span>${dot}</button>`
    );
  };

  list.innerHTML =
    `<div class="prov-group-title">内置</div>` +
    builtin.map(row).join("") +
    (customRows.length ? `<div class="prov-group-title">自定义</div>` + customRows.map(row).join("") : "");

  for (const btn of list.querySelectorAll(".prov-item")) {
    btn.addEventListener("click", async () => {
      // Switching provider must leave the form, otherwise the detail pane keeps
      // showing the form and the new provider's settings are unreachable.
      if (btn.dataset.provider === $("cfg-provider").value && !closeProviderForm) return;
      if (!(await maybeCloseProviderForm())) return;
      $("cfg-provider").value = btn.dataset.provider;
      applyPreset(btn.dataset.provider);
      renderProviderNav();
    });
  }
}

/**
 * Live glyph for whatever endpoint is currently typed.
 *
 * The icon is derived, so it has to react to the URL — otherwise the only way to
 * see what a provider will look like is to save it first.
 */
let logoPreviewSeq = 0;
async function updateLogoPreview() {
  const preset = currentPresets.find((p) => p.id === $("cfg-provider").value);
  // Built-in templates already carry the vendor's mark; do not second-guess it.
  if (!preset || !preset.custom) return;
  const seq = ++logoPreviewSeq;
  try {
    const glyph = await window.aemeath.providerLogo($("cfg-baseUrl").value.trim(), preset.label);
    if (seq !== logoPreviewSeq) return;
    $("prov-detail-logo").textContent = glyph;
  } catch {
    /* preview only */
  }
}

/** Header of the detail pane: glyph, name, status dot, and where to get a key. */
function renderProviderDetail() {
  const id = $("cfg-provider").value;
  const preset = currentPresets.find((p) => p.id === id);
  const hasKey = $("cfg-key-state")?.classList.contains("ok") ?? false;

  $("prov-detail-logo").textContent = preset?.logo || "✨";
  $("prov-detail-name").textContent = preset?.label ?? "供应商";
  const dot = $("prov-detail-dot");
  const status = preset ? providerStatus(preset) : "disabled";
  dot.className = "prov-dot " + status;
  dot.title = status === "ready" ? "可用" : status === "unavailable" ? "缺少 API Key" : "未在使用";

  // Point at the vendor's key page when we know it — one less thing to search.
  const link = $("cfg-key-link");
  // Nothing to advertise once a key is stored — the hint would just be noise.
  const url = hasKey ? undefined : preset?.keyUrl;
  if (url) {
    link.classList.remove("hidden");
    link.innerHTML = `还没有 Key？<a href="#" id="cfg-key-goto">去 ${escapeHtml(
      preset.label,
    )} 获取</a>`;
    $("cfg-key-goto").addEventListener("click", (e) => {
      e.preventDefault();
      window.aemeath.openExternal?.(url);
    });
  } else {
    link.classList.add("hidden");
    link.textContent = "";
  }
}

/** Show a delete affordance when the selected provider is user-defined. */
/* ====================== provider management (CRUD) ======================= */

/**
 * Provider list + editor, modelled on Codex-X's Providers page.
 *
 * A provider is a *named endpoint*: id, label, base URL, default model, and an
 * optional balance path. Custom providers sit alongside the built-in presets and
 * can be edited, duplicated (handy for variants of one gateway) or deleted.
 */
let provEditing = null; // id being edited, or null when creating

/** Closes the open provider form. Set while one is on screen. */
let closeProviderForm = null;
/** Field values when the form opened, so "did the user type anything?" is exact. */
let providerFormBaseline = null;

function snapshotProviderForm() {
  const box = $("provider-manage");
  const out = {};
  for (const el of box?.querySelectorAll("input, select") ?? []) {
    if (!el.id) continue;
    out[el.id] = "checked" in el && el.type === "checkbox" ? String(el.checked) : el.value;
  }
  return out;
}

/**
 * Did the user change anything?
 *
 * Compared against the values the form opened with, so a template's prefill
 * does not count as work the user would miss.
 */
function providerFormIsDirty() {
  if (!closeProviderForm || !providerFormBaseline) return false;
  const now = snapshotProviderForm();
  for (const key of Object.keys(providerFormBaseline)) {
    if (now[key] !== providerFormBaseline[key]) return true;
  }
  return false;
}

/** Close the form, asking first only when there is something to lose. */
async function maybeCloseProviderForm() {
  if (!closeProviderForm) return true;
  if (providerFormIsDirty()) {
    const ok = await askConfirm({
      title: "放弃这个供应商？",
      body: "表单里填的内容还没有保存。",
      note: "点「放弃」会丢掉它们，回到供应商列表。",
      okText: "放弃",
    });
    if (!ok) return false;
  }
  closeProviderForm();
  return true;
}

/** Render the management panel for whatever provider is currently selected. */
function renderProviderManage() {
  const box = $("provider-manage");
  const selected = currentPresets.find((p) => p.id === $("cfg-provider").value);

  // While the form is open, keep it open (selection changes shouldn't wipe it).
  if (provEditing !== null) return;

  box.classList.remove("hidden");
  if (!selected?.custom) {
    // Built-in preset: the template is the definition, so there is nothing to
    // edit here. Say so instead of offering buttons that would not work.
    box.innerHTML = `<span class="pm-label">内置模板 · 需要改地址就用「＋」新建一个自定义供应商</span>`;
    return;
  }

  box.innerHTML =
    `<span class="pm-label">自定义` +
    (selected.balancePath ? ` · 余额 <code>${escapeHtml(selected.balancePath)}</code>` : " · 自动探测余额") +
    `</span>` +
    `<span class="pm-actions">` +
    `<button class="btn small" id="btn-edit-provider" type="button">✎ 编辑</button>` +
    `<button class="btn small" id="btn-dup-provider" type="button">⧉ 复制</button>` +
    `<button class="btn danger small" id="btn-del-provider" type="button">🗑 删除</button>` +
    `</span>`;

  $("btn-edit-provider").addEventListener("click", () => openProviderForm(selected));
  $("btn-dup-provider").addEventListener("click", async () => {
    const res = await window.aemeath.duplicateProvider(selected.id);
    if (!res?.ok) return addNotice(`复制失败: ${res?.error || "未知错误"}`, true);
    await loadProviders();
    $("cfg-provider").value = res.id;
    applyPreset(res.id);
    addNotice(`已复制为 ${res.id}`);
  });
  $("btn-del-provider").addEventListener("click", async () => {
    const ok = await askConfirm({
      title: "删除自定义供应商",
      body: selected.label,
      note: "会同时移除它缓存的模型列表。其他供应商不受影响。",
      okText: "删除",
    });
    if (!ok) return;
    const res = await window.aemeath.deleteProvider(selected.id);
    await loadProviders();
    // If the deleted one was active, the backend already fell back for us.
    if (res?.activeProvider) $("cfg-provider").value = res.activeProvider;
    applyPreset($("cfg-provider").value);
    const st = await window.aemeath.status();
    renderModelList(st);
    addNotice(`已删除供应商 ${selected.label}`);
  });
}

/**
 * Pick an id that collides with neither a built-in preset nor another custom
 * provider.
 *
 * Sharing an id with a built-in would make this entry unreachable: lookups take
 * the first match, which is always the built-in.
 */
function uniqueProviderId(base) {
  const taken = new Set(currentPresets.map((p) => p.id));
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

/**
 * Open the create/edit form.
 *
 * @param existing  provider to edit, or null to create
 * @param template  optional preset to prefill from (a template is a starting
 *                  point, not an identity — it always becomes a custom provider)
 */
function openProviderForm(existing, template) {
  const box = $("provider-manage");
  // Never stack two forms.
  if (closeProviderForm) closeProviderForm();
  provEditing = existing ? existing.id : "";
  box.classList.remove("hidden");
  const isEdit = Boolean(existing);
  const seed = existing ?? template ?? {};
  const seedId = existing?.id ?? (template ? uniqueProviderId(template.id) : "");
  box.innerHTML = `
    <div class="prov-form">
      <div class="pf-title">${
        isEdit
          ? `编辑供应商：${escapeHtml(existing.label || existing.id)}`
          : template
            ? `从模板新建：${escapeHtml(template.label)}`
            : "新增自定义供应商"
      }</div>
      <div class="row2">
        <label>名称<input id="pf-label" placeholder="例如 我的网关" value="${escapeHtml(seed.label ?? "")}" /></label>
        <label>ID（英文，不可改）<input id="pf-id" placeholder="my-gateway" value="${escapeHtml(seedId)}" ${isEdit ? "disabled" : ""} /></label>
      </div>
      <label>Base URL<input id="pf-url" placeholder="https://gateway.example.com/v1" value="${escapeHtml(seed.baseUrl ?? "")}" /></label>
      <div class="row2">
        <label>默认模型（可选）<input id="pf-model" placeholder="deepseek-chat" value="${escapeHtml(seed.defaultModel ?? "")}" /></label>
        <label>图标（跟随地址自动生成）
          <input id="pf-logo-preview" value="${escapeHtml(seed.logo ?? "✨")}" readonly />
        </label>
      </div>
      <div class="row2">
        <label>接口协议
          <select id="pf-mode">
            <option value="chat">Chat Completions（/chat/completions）</option>
            <option value="responses">Responses API（/responses）</option>
            <option value="messages">Messages API（/v1/messages · Anthropic）</option>
          </select>
        </label>
        <label>余额接口路径（可选）<input id="pf-balance" placeholder="/user/balance" value="${escapeHtml(existing?.balancePath ?? "")}" /></label>
      </div>
      <div class="row2">
        <button class="btn primary small" id="pf-save" type="button">${isEdit ? "保存修改" : "创建"}</button>
        <button class="btn ghost small" id="pf-cancel" type="button">取消</button>
      </div>
      <span class="hint">余额路径留空时会自动尝试常见接口；都查不到就显示本地用量统计。</span>
    </div>`;
  let logoSeq = 0;
  const refreshFormLogo = async () => {
    const seq = ++logoSeq;
    try {
      const glyph = await window.aemeath.providerLogo($("pf-url").value.trim(), $("pf-label").value.trim());
      if (seq === logoSeq) $("pf-logo-preview").value = glyph;
    } catch {
      /* preview only */
    }
  };
  $("pf-url").addEventListener("input", refreshFormLogo);
  $("pf-label").addEventListener("input", refreshFormLogo);
  void refreshFormLogo();

  try {
    $("pf-mode").value = seed.apiMode || seed.modes?.[0] || "chat";
  } catch {
    /* keep the default */
  }
  /*
   * The form lives in the detail pane, which is also where every other
   * provider's settings render. Without a way out, selecting a different
   * provider only moved the highlight while this form stayed put — you could
   * not get back to another provider's settings at all.
   */
  providerFormBaseline = snapshotProviderForm();
  // The form replaces the pane rather than sitting on top of it: otherwise the
  // previously selected provider's fields stay visible below, and the screen
  // shows two Base URL inputs with no clue which one matters.
  $("prov-detail-fields").classList.add("hidden");
  // The header names the *currently selected* provider, which is not what the
  // form is about. The form carries its own title instead.
  $("prov-title").classList.add("hidden");
  closeProviderForm = () => {
    closeProviderForm = null;
    providerFormBaseline = null;
    provEditing = null;
    box.innerHTML = "";
    $("prov-detail-fields").classList.remove("hidden");
    $("prov-title").classList.remove("hidden");
    renderProviderManage();
  };

  $("pf-label").focus();

  $("pf-cancel").addEventListener("click", () => closeProviderForm?.());
  // Esc is the reflex for "get me out of this form".
  box.onkeydown = (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      void maybeCloseProviderForm();
    }
  };

  $("pf-save").addEventListener("click", async () => {
    const label = $("pf-label").value.trim();
    const rawId = $("pf-id").value.trim() || label;
    const url = $("pf-url").value.trim();
    if (!url) {
      $("pf-url").focus();
      addNotice("Base URL 不能为空", true);
      return;
    }
    if (!rawId) {
      $("pf-id").focus();
      addNotice("ID 不能为空", true);
      return;
    }
    const res = await window.aemeath.saveProvider(rawId, {
      label: label || rawId,
      baseUrl: url,
      defaultModel: $("pf-model").value.trim(),
      balancePath: $("pf-balance").value.trim(),
      // Left to the backend, which derives it from the endpoint.
      apiMode: $("pf-mode").value,
      modes: [ $("pf-mode").value ],
    });
    if (!res || res.ok === false) {
      addNotice(`保存失败: ${res?.error || "未知错误"}`, true);
      return;
    }
    provEditing = null;
    await loadProviders();
    $("cfg-provider").value = res.id;
    applyPreset(res.id);
    const st = await window.aemeath.status();
    renderModelList(st);
    addNotice(isEdit ? `已更新供应商 ${label || res.id}` : `已创建供应商 ${label || res.id}`);
  });
}

/** Inline form for declaring a new provider (id / label / base URL / model / balance path). */
/** 「＋ 新增」opens a blank provider form (see openProviderForm). */
$("btn-add-provider").addEventListener("click", () => openTemplatePicker());

/** When the provider changes, show that provider's model list. */
function applyPreset(id) {
  const preset = currentPresets.find((p) => p.id === id);
  if (preset && preset.id !== "custom") {
    $("cfg-baseUrl").value = preset.baseUrl;
    // Only prefill the model when we would otherwise be inventing one; the model
    // list is the source of truth and a preset default is just a starting hint.
    if (preset.defaultModel) $("cfg-model").value = preset.defaultModel;
    // Prefer the protocol stored on the provider itself, so switching providers
    // restores the right wire format instead of inheriting the previous one.
    const mode = preset.apiMode || preset.modes?.[0];
    if (mode) $("cfg-apiMode").value = mode;
  }
  updateModeHint();
  updateBaseUrlReset();
  renderProviderDetail();
  // The management panel (edit / duplicate / delete) depends on the selection.
  renderProviderManage();
  // ...and so does the key field, and the derived icon.
  void syncKeyState();
  void updateLogoPreview();
}

/**
 * Create a provider from a name — the whole creation step.
 *
 * Modelled on the flow mature harnesses use: ask for a name, create the entry,
 * then let the *detail pane* collect the endpoint, the protocol and the key, all
 * of which can be tested in place before anything depends on them.
 *
 * The icon is never asked for: it is derived from the endpoint (see
 * `providerLogoFor`), which is the only thing about a provider that is
 * genuinely derivable.
 */
async function createProviderFromTemplate(template) {
  const name = await askConfirm({
    title: template ? `从模板新建：${template.label}` : "新建自定义供应商",
    body: "先起个名字，地址和 API Key 在右边填。",
    input: {
      label: "名称",
      value: template ? template.label : "",
      placeholder: "例如 我的网关",
    },
    okText: "创建",
    danger: false,
  });
  if (!name) return;

  const id = uniqueProviderId(
    (template?.id ?? name).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "provider",
  );
  const res = await window.aemeath.saveProvider(id, {
    label: name,
    // A template prefills its endpoint; a bare custom provider starts empty and
    // is filled in on the right.
    baseUrl: template?.baseUrl ?? "",
    defaultModel: template?.defaultModel ?? "",
    modes: template?.modes,
    apiMode: template?.modes?.[0],
    draft: !template,
  });
  if (!res?.ok) {
    addNotice(`创建失败: ${res?.error || "未知错误"}`, true);
    return;
  }
  await loadProviders();
  $("cfg-provider").value = res.id;
  applyPreset(res.id);
  renderProviderNav();
  addNotice(template ? `已创建「${name}」，接着填 API Key 就能用了。` : `已创建「${name}」，在右边填地址和 API Key。`);
}

/* ===================== add provider: template picker ====================== */

/**
 * Pick a provider from a template grid.
 *
 * The template carries the endpoint and the wire protocol, so the user only has
 * to paste a key afterwards. That is the whole point: nobody should have to know
 * whether a gateway speaks chat-completions or anthropic-messages to add it.
 */
function openTemplatePicker() {
  const overlay = $("tpl-overlay");
  const builtin = currentPresets.filter((p) => !p.custom);
  const custom = currentPresets.filter((p) => p.custom);

  const card = (p, sub) =>
    `<button type="button" class="tpl-card" data-tpl="${escapeHtml(p.id)}"${
      p.id === "custom" ? ' data-new-custom="1"' : ""
    }>` +
    `<span class="tpl-card-glyph">${escapeHtml(p.logo || "✨")}</span>` +
    `<span class="tpl-card-body">` +
    `<span class="tpl-card-label">${escapeHtml(p.label)}</span>` +
    `<span class="tpl-card-sub">${escapeHtml(sub)}</span>` +
    `</span><span class="tpl-card-chev">›</span></button>`;

  const host = (p) => {
    if (p.id === "custom") return "自定义网关：自己填地址和协议";
    try {
      return new URL(p.baseUrl).host;
    } catch {
      return p.baseUrl || "";
    }
  };

  $("tpl-grid-builtin").innerHTML = builtin.filter((p) => p.id !== "custom").map((p) => card(p, host(p))).join("");
  $("tpl-grid-custom").innerHTML =
    card(
      { id: "custom", label: "新建自定义供应商", logo: "＋" },
      "自己填 Base URL 与接口协议",
    ) +
    custom.map((p) => card(p, host(p))).join("");

  paintAvatar($("tpl-avatar"), "mini-avatar");
  overlay.classList.remove("hidden");

  const close = () => {
    overlay.classList.add("hidden");
    for (const b of overlay.querySelectorAll(".tpl-card")) b.onclick = null;
  };
  $("tpl-cancel").onclick = close;
  overlay.onclick = (e) => {
    if (e.target === overlay) close();
  };

  for (const btn of overlay.querySelectorAll(".tpl-card")) {
    // Template cards cannot be clicked twice while the first create is in flight.
    btn.onclick = async () => {
      const id = btn.dataset.tpl;
      if (btn.dataset.newCustom) {
        close();
        await createProviderFromTemplate(null);
        return;
      }
      const preset = currentPresets.find((p) => p.id === id);
      if (!preset) return;
      close();
      if (preset.custom) {
        // An existing custom provider: just select it, nothing to create.
        $("cfg-provider").value = id;
        applyPreset(id);
        renderProviderNav();
        return;
      }
      // A built-in template is a *starting point*. Selecting it as an entry would
      // collide with the built-in id and make the new entry unreachable, so a
      // template always creates a fresh, separately-named provider.
      await createProviderFromTemplate(preset);
    };
  }
}

/* -------------------------------- balance -------------------------------- */

/**
 * Render the balance / usage badges.
 *
 * Three cases, in order of preference:
 *   1. the provider exposes a balance API  → show the money
 *   2. it does not, but we have local usage → show this month's token usage
 *   3. neither                              → say so honestly instead of "—"
 */
function renderBalance(info) {
  if (!info) return;
  const top = $("topbar-balance");
  const side = $("side-balance");
  const pet = $("pet-balance");
  const usage = info.usage;

  const setAll = (text, title, cls) => {
    top.style.display = "";
    pet.style.display = "";
    top.textContent = text;
    side.textContent = text;
    pet.textContent = text.replace(/^余额\s*/, "");
    top.title = title;
    side.title = title;
    top.className = "pill coin" + (cls ? " " + cls : "");
    side.classList.toggle("low", cls === "low");
    pet.classList.toggle("low", cls === "low");
  };

  // 1) Real balance available.
  if (info.supported && info.total !== undefined) {
    const text = info.display ?? info.total.toFixed(2);
    const low = !!info.unavailable || info.total < 5;
    const detail = (info.details ?? []).map((d) => `${d.currency} ${d.total.toFixed(2)}`).join(" / ");
    setAll(`余额 ${text}`, (detail || text) + (info.strategy ? `\n来源: ${info.strategy}` : ""), low ? "low" : "");
    if (info.unavailable) petSay("漂泊者，余额用完啦…记得充值哦", 6000);
    else if (low) petSay(`余额只剩 ${text} 了，省着点用～`, 5000);
    return;
  }

  // 2) No balance API — fall back to locally recorded usage so a custom gateway
  //    is still observable.
  if (usage && (usage.requests > 0 || usage.inputTokens > 0 || usage.outputTokens > 0)) {
    const k = (n) => (n >= 1_000_000 ? (n / 1_000_000).toFixed(2) + "M" : n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n));
    const total = usage.inputTokens + usage.outputTokens;
    const top3 = usage.byModel.slice(0, 3).map((m) => `${m.model}: ${k(m.inputTokens + m.outputTokens)} (${m.requests}次)`).join("\n");
    setAll(
      `用量 ${k(total)}`,
      `本地统计（30 天）\n输入 ${usage.inputTokens} / 输出 ${usage.outputTokens}\n请求 ${usage.requests} 次\n---\n${top3}`,
      "unknown",
    );
    return;
  }

  // 3) Neither: be explicit rather than showing a bare dash.
  if (info.supported === false || info.source === "none") {
    const reason = info.message || "该供应商没有余额接口";
    setAll("用量 —", `${reason}\n\n提示：完成一次对话后这里会显示本地统计的 token 用量。`, "unknown");
    return;
  }

  setAll("余额 ?", info.message || "查询失败", "unknown");
}

/* -------------------------------- pet (embedded) ------------------------- */

function setPetVisible(visible) {
  petDock.classList.toggle("hidden", !visible);
  $("pet-toggle").checked = visible;
}

$("pet-toggle").addEventListener("change", async (e) => {
  const visible = e.target.checked;
  setPetVisible(visible);
  await window.aemeath.setPetPrefs({ enabled: visible });
  setMood("happy", { line: visible ? "桌宠出来啦～" : "那我先躲起来，需要就叫醒我。" });
});

$("pet-refresh").addEventListener("click", async () => {
  petSay("刷新一下余额…", 1500);
  renderBalance(await window.aemeath.getBalance());
});
$("pet-hide").addEventListener("click", async () => {
  setPetVisible(false);
  await window.aemeath.setPetPrefs({ enabled: false });
});

// Click the pet → say something in character.
petCanvas.addEventListener("click", () => {
  const lines = ["怎么啦，漂泊者？", "我一直在这儿哦～", "需要我帮忙吗？✨", "嘿嘿～", "摸摸头也可以哦。"];
  petSay(pick(lines), 2500);
});

// Drag the pet around inside the window (stored as a percentage offset).
let petDrag = null;
petDock.addEventListener("mousedown", (e) => {
  if (e.target.closest(".pet-btn")) return;
  const stage = $("stage-area").getBoundingClientRect();
  petDrag = { dx: e.clientX - petDock.getBoundingClientRect().left, dy: e.clientY - petDock.getBoundingClientRect().top, stage };
  e.preventDefault();
});
window.addEventListener("mousemove", (e) => {
  if (!petDrag) return;
  const { stage, dx, dy } = petDrag;
  let x = e.clientX - dx - stage.left;
  let y = e.clientY - dy - stage.top;
  x = Math.max(4, Math.min(x, stage.width - petDock.offsetWidth - 4));
  y = Math.max(4, Math.min(y, stage.height - petDock.offsetHeight - 4));
  petDock.style.left = x + "px";
  petDock.style.top = y + "px";
  petDock.style.right = "auto";
  petDock.style.bottom = "auto";
});
window.addEventListener("mouseup", () => {
  if (!petDrag) return;
  petDrag = null;
  try {
    localStorage.setItem(
      "aemeath.petPos",
      JSON.stringify({ left: petDock.style.left, top: petDock.style.top }),
    );
  } catch {
    /* ignore */
  }
});

function restorePetPos() {
  try {
    const raw = localStorage.getItem("aemeath.petPos");
    if (!raw) return;
    const { left, top } = JSON.parse(raw);
    if (left && top) {
      petDock.style.left = left;
      petDock.style.top = top;
      petDock.style.right = "auto";
      petDock.style.bottom = "auto";
    }
  } catch {
    /* ignore */
  }
}

/* -------------------------- settings page -------------------------------- */

// Tab switching
document.querySelectorAll(".settings-tabs .tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".settings-tabs .tab").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    document.querySelectorAll(".settings-body").forEach((b) => {
      b.classList.toggle("hidden", b.dataset.panel !== tab.dataset.tab);
    });
    if (tab.dataset.tab === "diag") refreshHealth();
  });
});

$("cfg-provider").addEventListener("change", async (e) => {
  provEditing = null; // switching providers abandons any open edit form
  applyPreset(e.target.value);
  const st = await window.aemeath.status();
  renderModelList(st);
});
$("cfg-apiMode").addEventListener("change", updateModeHint);
$("cfg-baseUrl").addEventListener("input", updateModeHint);

async function refreshSkillsPanel() {
  const list = await window.aemeath.skills();
  const box = $("skills-list");
  if (!list.length) {
    box.innerHTML = `<div class="skill-item"><span class="desc">未发现技能。把含 <code>SKILL.md</code> 的目录放进 <code>&lt;项目&gt;/skills/</code> 即可。</span></div>`;
    return;
  }
  box.innerHTML = list
    .map(
      (s) => `<div class="skill-item">
        <div class="name">${escapeHtml(s.name)}</div>
        <div class="desc">${escapeHtml(s.description)}</div>
        ${s.resources.length ? `<div class="res">${s.resources.map(escapeHtml).join(" · ")}</div>` : ""}
      </div>`,
    )
    .join("");
}

async function refreshMcpPanel() {
  const servers = await window.aemeath.mcpServers();
  $("mcp-list").innerHTML = servers.length
    ? servers.map((n) => `<div class="skill-item"><div class="name">${escapeHtml(n)}</div></div>`).join("")
    : `<div class="skill-item"><span class="desc">未配置 MCP server。</span></div>`;
}

async function refreshSessionManage() {
  const list = await window.aemeath.listSessions();
  const st = await window.aemeath.status();
  const box = $("session-manage");
  if (!list.length) {
    box.innerHTML = `<div class="session-row"><span class="title" style="color:var(--muted)">暂无会话</span></div>`;
    return;
  }
  box.innerHTML = list
    .map(
      (s) => `<div class="session-row ${s.id === st.sessionId ? "current" : ""}" data-id="${escapeHtml(s.id)}">
        <span class="title">${escapeHtml(s.title || "新会话")}</span>
        <span class="meta">${s.messageCount}条</span>
        <button class="del">删除</button>
      </div>`,
    )
    .join("");
  box.querySelectorAll(".session-row").forEach((row) => {
    row.querySelector(".del")?.addEventListener("click", async () => {
      const okDel = await askConfirm({
        title: "删除会话",
        body: "确定删除这个会话？",
        note: "删除后无法恢复。",
        okText: "删除",
      });
      if (!okDel) return;
      await window.aemeath.deleteSession(row.dataset.id);
      await refreshSessionManage();
      await refreshSessions();
      await refreshStatus();
      addNotice("已删除该会话。");
    });
  });
}

$("btn-settings").addEventListener("click", async () => {
  const st = await refreshStatus({ loadForm: true });
  renderModelList(st);
  await refreshSkillsPanel();
  await refreshMcpPanel();
  await refreshSessionManage();
  $("save-hint").textContent = "";
  $("save-hint").className = "save-hint";
  $("settings-overlay").classList.remove("hidden");
});
$("settings-close").addEventListener("click", () => {
  // Dropping the form here is deliberate: the dialog is closing, and keeping a
  // half-written provider around would resurface it the next time settings open.
  closeProviderForm?.();
  $("settings-overlay").classList.add("hidden");
});
$("cfg-pick").addEventListener("click", async () => {
  const dir = await window.aemeath.pickFolder();
  if (dir) $("cfg-cwd").value = dir;
});
$("cfg-clear-allow").addEventListener("click", async () => {
  await window.aemeath.clearAllowList();
  $("save-hint").textContent = '已清空"永远允许"记录';
  $("save-hint").className = "save-hint ok";
});
/* ------------------------------- health ---------------------------------- */

/**
 * Render the one-shot diagnostic report.
 * Being an integrated app, we can show every link of the chain in one place
 * instead of asking the user to inspect several components.
 */
async function refreshHealth() {
  const list = $("health-list");
  const summary = $("health-summary");
  list.innerHTML = '<div class="health-row"><span class="dim">检查中…</span></div>';
  try {
    const report = await window.aemeath.health();
    summary.textContent = report.ok ? "全部正常" : `${report.failed} 项需要注意`;
    summary.className = report.ok ? "hint ok" : "hint warn";
    list.innerHTML = report.checks
      .map((c) => {
        const mark = c.ok ? "✓" : "✕";
        const cls = c.ok ? "ok" : "bad";
        return (
          `<div class="health-row ${cls}">` +
          `<span class="health-mark">${mark}</span>` +
          `<span class="health-name">${escapeHtml(c.name)}</span>` +
          `<span class="health-detail">${escapeHtml(c.detail)}</span>` +
          (c.hint ? `<span class="health-hint">💡 ${escapeHtml(c.hint)}</span>` : "") +
          `</div>`
        );
      })
      .join("");
  } catch (err) {
    summary.textContent = "检查失败";
    summary.className = "hint warn";
    list.innerHTML = `<div class="health-row bad"><span class="dim">${escapeHtml(
      err instanceof Error ? err.message : String(err),
    )}</span></div>`;
  }
}

$("btn-health").addEventListener("click", () => refreshHealth());

$("btn-open-datadir").addEventListener("click", () => window.aemeath.openDataDir());
$("btn-delete-all").addEventListener("click", async () => {
  const okAll = await askConfirm({
    title: "删除全部会话",
    body: "这会清空所有历史会话。",
    note: "此操作不可撤销，且会立即开启一个新会话。",
    okText: "全部删除",
  });
  if (!okAll) return;
  const res = await window.aemeath.deleteAllSessions();
  await refreshSessionManage();
  await refreshSessions();
  messagesEl.innerHTML = "";
  renderWelcome();
  await refreshStatus();
  addNotice(`已删除 ${res.removed} 个会话，并开启新会话。`);
});

$("settings-save").addEventListener("click", async () => {
  const patch = {
    provider: $("cfg-provider").value,
    apiMode: $("cfg-apiMode").value,
    baseUrl: $("cfg-baseUrl").value.trim(),
    model: $("cfg-model").value.trim(),
    cwd: $("cfg-cwd").value.trim(),
    maxTokens: Number($("cfg-maxTokens").value) || 8192,
    temperature: Number($("cfg-temperature").value),
    maxSteps: Number($("cfg-maxSteps").value) || 40,
    contextBudget: Number($("cfg-contextBudget").value) || 120000,
    persona: { enabled: $("cfg-persona-enabled").checked, file: $("cfg-persona-file").value.trim() },
    permissions: {
      writeFile: $("cfg-perm-write").value,
      runCommand: $("cfg-perm-exec").value,
    },
  };
  // The key never travels inside this patch: it belongs in the encrypted
  // credential store, not in config.json.
  const typedKey = typedApiKey();

  /*
   * A custom provider may be created as a draft with no endpoint yet. Saving it
   * as the active provider would point every request at nothing, so it has to be
   * filled in first — and the message says which field and why.
   */
  const selectedPreset = currentPresets.find((p) => p.id === patch.provider);
  if (selectedPreset?.custom && !patch.baseUrl) {
    const hintEl = $("save-hint");
    hintEl.className = "save-hint err";
    hintEl.textContent = `「${selectedPreset.label}」还没有接口地址，请先填 Base URL。`;
    $("cfg-baseUrl").focus();
    return;
  }

  const btn = $("settings-save");
  const hint = $("save-hint");
  btn.disabled = true;
  hint.className = "save-hint";
  hint.textContent = "保存中…";

  try {
    /*
     * Save a key that was typed but not pushed through the key-specific button.
     *
     * This dialog has two 保存 buttons. The bottom one used to ignore the key
     * entirely, so typing a key and pressing 保存 silently threw it away — and
     * setConfig's key re-resolve then put the field back to "还没保存 Key".
     * Whichever button you press, what you typed is what gets saved.
     *
     * Runs BEFORE setConfig, which reloads the key for the endpoint from the
     * credential store.
     */
    if (typedKey) {
      const keyRes = await window.aemeath.saveApiKey(typedKey, {
        provider: patch.provider,
        baseUrl: patch.baseUrl,
      });
      if (!keyRes || keyRes.ok === false) {
        hint.className = "save-hint err";
        hint.textContent = `Key 保存失败: ${keyRes?.error || "未知错误"}`;
        return;
      }
      keyFieldMasked = false;
    }

    const res = await window.aemeath.setConfig(patch);
    if (!res || res.ok === false) {
      hint.className = "save-hint err";
      hint.textContent = res?.error || "保存失败";
      return; // keep the dialog open so the user can fix it
    }

    saveUiPrefs();
    // Remember the protocol on the provider itself, so switching away and back
    // restores the right wire format instead of whatever was selected last.
    const active = currentPresets.find((p) => p.id === patch.provider);
    if (active?.custom) {
      await window.aemeath.saveProvider(patch.provider, {
        label: active.label,
        baseUrl: patch.baseUrl,
        defaultModel: active.defaultModel,
        balancePath: active.balancePath,
        modes: active.modes,
        logo: active.logo,
        apiMode: patch.apiMode,
      });
      await loadProviders();
    }
    // The config changed underneath us, so reload the form (this also replaces
    // any plaintext key still sitting in the field with its masked preview).
    await refreshStatus({ loadForm: true });

    hint.className = "save-hint ok";
    hint.textContent = "已保存";
    $("settings-overlay").classList.add("hidden");
    if (res.warning) {
      addNotice(`⚠ ${res.warning}`, true);
    }
    setMood("happy", { line: "配置保存好啦～现在可以开始了✨" });
  } catch (err) {
    // IPC rejections used to be swallowed, which made saving look like a no-op.
    hint.className = "save-hint err";
    hint.textContent = `保存失败: ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    btn.disabled = false;
  }
});

/* ------------------------------ key field UX ----------------------------- */

/**
 * True while the input is showing the masked preview rather than a real key.
 *
 * This flag is the guard that stops the preview from ever being saved as if it
 * were a key: the mask is display-only and must never round-trip back to disk.
 */
let keyFieldMasked = false;
/** The endpoint scope the key field currently reflects (see `updateKeyState`). */
let keyFieldScope = "";
/** The provider id actually saved to disk. */
let savedProviderId = "";
/** Endpoint scopes that have a stored credential (from the status payload). */
let savedKeyScopes = new Set();
/** Scope the main process reported for the currently selected endpoint. */
let selectedKeyScope = "";
/** The masked preview of the saved key, so it can be restored. */
let keyPreviewText = "";

/**
 * Put the key field into one of its two states.
 *
 *   "masked" — a key is saved. The field keeps showing head+tail, stays
 *              read-only, and clicking it does nothing. Replacing the key is an
 *              explicit choice, not something a stray click can trigger.
 *   "edit"   — no key, or the user asked to replace one. Free text input.
 *
 * The earlier behaviour cleared the field on focus, which made a saved key look
 * like it had vanished the moment the user clicked it — exactly when they were
 * about to go edit that provider's model list.
 */
function setKeyFieldMode(mode) {
  const input = $("cfg-apiKey");
  const masked = mode === "masked";
  keyFieldMasked = masked;

  input.readOnly = masked;
  input.classList.toggle("masked", masked);
  // type=text while masked, so head and tail stay readable; the middle is dots.
  input.type = masked ? "text" : "password";

  $("cfg-key-eye").classList.toggle("hidden", masked);
  $("cfg-key-save").classList.toggle("hidden", masked);
  $("cfg-key-replace").classList.toggle("hidden", !masked);

  if (masked) {
    input.value = keyPreviewText;
    input.title = "已保存的 Key 只显示首尾，原文不离开主进程";
    input.placeholder = "";
  } else {
    input.title = "";
    input.placeholder = keyPreviewText
      ? "粘贴新 Key 以替换已保存的"
      : "粘贴 Key（不会写入配置文件）";
  }
}

/**
 * Render the key field + its explanation.
 *
 * Once a key is saved we keep a masked preview (head + tail) on screen instead
 * of an empty box, so the user can tell *which* key is in use without the value
 * ever leaving the main process.
 */
function updateKeyState(hasKey, cipher, preview, opts = {}) {
  const el = $("cfg-key-state");
  const input = $("cfg-apiKey");
  if (!el || !input) return;

  /*
   * Which endpoint the field currently describes.
   *
   * This is what makes "do not wipe what the user is typing" safe. That guard on
   * its own cannot tell a paste the user is still working on from a value left
   * behind by a *different* provider — and the leftover case leaked one
   * provider's plaintext key into another provider's field, still labelled as
   * that other provider. Switching scope always resets, no heuristics.
   */
  const scope = opts.scope ?? keyFieldScope;
  const scopeChanged = scope !== keyFieldScope;
  keyFieldScope = scope;
  const preserve = !opts.force && !scopeChanged;

  if (hasKey) {
    const where = cipher === "safeStorage" ? "系统钥匙串" : "本地加密存储";
    keyPreviewText = preview || "•".repeat(8);
    el.textContent = `✓ 已保存 Key（${where}，不写入 config.json）`;
    el.className = "hint ok";
    // Do not clobber a field the user is actively typing into, unless the scope
    // changed or the caller knows the edit is finished.
    const editing = preserve && !keyFieldMasked && document.activeElement === input;
    if (!editing) setKeyFieldMode("masked");
  } else {
    keyPreviewText = "";
    el.textContent = "⚠ 还没保存 Key。粘贴后点「保存」，它不会写进配置文件。";
    el.className = "hint warn";
    // Do not wipe a key the user has typed but not saved yet — a background
    // status refresh must not eat their paste. A scope change always wipes.
    const typing = preserve && !keyFieldMasked && input.value.trim() !== "";
    setKeyFieldMode("edit");
    if (!typing) input.value = "";
  }

  // The status dot in the provider list reflects exactly this.
  renderProviderNav();
  renderProviderDetail();
}

/**
 * Ask the main process about the credential for the *selected* provider.
 *
 * Not the active one: you can select "OpenAI" while "custom" is what the agent
 * actually runs on, and the field must describe what you are looking at. Reading
 * the active provider's state here is why an unconfigured provider used to show
 * a mask (and why you had to press 更换 to type into an empty field).
 */
let keyStateSeq = 0;

async function syncKeyState() {
  // Monotonic guard: this is called from six places (card clicks, a debounced
  // URL edit, every status refresh), so two calls can be in flight at once.
  // Without this, a slow lookup for provider A can land after a fast one for B
  // and paint A's key state onto B — which showed a mask for a provider that has
  // no key, leaving the field read-only and untypeable.
  const seq = ++keyStateSeq;
  const provider = currentProviderId();
  const baseUrl = $("cfg-baseUrl").value.trim();
  try {
    const r = await window.aemeath.keyState(provider, baseUrl);
    if (seq !== keyStateSeq) return; // superseded
    selectedKeyScope = r.scope || "";
    updateKeyState(!!r.hasKey, r.cipher, r.preview, { scope: r.scope || "" });
  } catch {
    if (seq !== keyStateSeq) return;
    updateKeyState(false);
  }
}

/**
 * The key the user has actually typed, or "" when the field is showing a saved
 * key's mask.
 *
 * The mask is a display artefact. Reading it as a key authenticated with the
 * literal masked preview — which is why detection
 * worked before a key was saved and stopped working straight after.
 */
function typedApiKey() {
  return keyFieldMasked ? "" : $("cfg-apiKey").value.trim();
}

/** Start editing a new key — the only way out of the masked state. */
function beginKeyReplace() {
  setKeyFieldMode("edit");
  $("cfg-apiKey").value = "";
  $("cfg-apiKey").focus();
}

$("cfg-key-replace").addEventListener("click", beginKeyReplace);

// Abandoning an edit without typing anything puts the preview back, so the user
// cannot leave the field looking empty while a key is actually stored.
$("cfg-apiKey").addEventListener("blur", () => {
  const input = $("cfg-apiKey");
  if (!keyFieldMasked && !input.value.trim() && keyPreviewText) setKeyFieldMode("masked");
});

$("cfg-apiKey").addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || keyFieldMasked) return;
  // Esc cancels the replacement and restores the saved key's preview.
  if (keyPreviewText) setKeyFieldMode("masked");
  $("cfg-apiKey").blur();
});

$("cfg-key-eye").addEventListener("click", () => {
  const inp = $("cfg-apiKey");
  if (keyFieldMasked) return;
  inp.type = inp.type === "password" ? "text" : "password";
});

/**
 * Save the key on its own, into the encrypted credential store.
 *
 * Kept separate from the general "save" so the key is never part of the object
 * written to config.json — that file must stay safe to copy and share.
 */
$("cfg-key-save").addEventListener("click", async () => {
  const input = $("cfg-apiKey");
  const value = input.value.trim();
  const hint = $("save-hint");
  if (keyFieldMasked) {
    // The box holds the masked preview of a key that is already saved.
    hint.className = "save-hint ok";
    hint.textContent = "Key 已经保存过了。要替换请点「✎ 更换」。";
    return;
  }
  if (!value) {
    hint.className = "save-hint err";
    hint.textContent = "请先粘贴 Key。";
    input.focus();
    return;
  }
  const btn = $("cfg-key-save");
  btn.disabled = true;
  try {
    const res = await window.aemeath.saveApiKey(value, {
      provider: currentProviderId(),
      baseUrl: $("cfg-baseUrl").value.trim(),
    });
    if (!res || res.ok === false) throw new Error(res?.error || "保存失败");
    keyFieldMasked = false;
    // force: the save is done, so the plaintext must be replaced by the preview
    // even if the field still has focus.
    updateKeyState(true, res.cipher, res.preview, { force: true, scope: res.scope || "" });
    input.blur();
    hint.className = "save-hint ok";
    hint.textContent = `Key 已加密保存 · ${res.preview ?? ""}`;
    await refreshStatus();
    await syncKeyState();
  } catch (err) {
    hint.className = "save-hint err";
    hint.textContent = `保存 Key 失败: ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    btn.disabled = false;
  }
});

$("cfg-key-clear").addEventListener("click", async () => {
  const okClear = await askConfirm({
    title: "清除 API Key",
    body: "将从本机配置中移除已保存的 Key。",
    note: "清除后需要重新填写才能继续调用模型。",
    okText: "清除",
  });
  if (!okClear) return;
  $("cfg-apiKey").value = "";
  const hint = $("save-hint");
  try {
    const res = await window.aemeath.clearApiKey({
      provider: currentProviderId(),
      baseUrl: $("cfg-baseUrl").value.trim(),
    });
    if (res && res.ok) {
      updateKeyState(false);
      hint.className = "save-hint ok";
      hint.textContent = "已清除 Key";
      await refreshStatus();
      await syncKeyState();
    }
  } catch (err) {
    hint.className = "save-hint err";
    hint.textContent = `清除失败: ${err instanceof Error ? err.message : String(err)}`;
  }
});

/* ---------------------------- connection test ---------------------------- */

/* --------------------------- model list ---------------------------------- */

/**
 * Models shown for the active provider: user-curated list first, then whatever
 * auto-detection last found, plus the currently selected model (so an existing
 * config always appears even before detection).
 */
let modelList = [];

function currentProviderId() {
  return $("cfg-provider").value || "custom";
}

/**
 * Models known for the CURRENT endpoint scope.
 *
 * Only real sources are used: what this exact key+URL detected, what the user
 * saved by hand. The provider preset's "defaultModel" is deliberately NOT
 * included — showing a guess as if it were a detected model is exactly the
 * fabrication we must avoid.
 */
function gatherModels(st) {
  const scope = st.modelScope || "";
  const saved = (st.savedModels ?? {})[scope] ?? [];
  const detected = (st.detectedModels ?? {})[scope] ?? [];
  const current = $("cfg-model").value.trim();
  return [...new Set([...detected, ...saved, ...(current ? [current] : [])])];
}

/**
 * Test hooks, installed only when the app runs under --selftest.
 *
 * They let the self-test drive the real UI (rather than a copy of it), which is
 * the only thing that has caught the renderer-only regressions so far. Kept out
 * of a normal run so the global namespace stays clean.
 */
function installTestHooks() {
  window.__renderModelList = renderModelList;
  window.__reloadProviders = loadProviders;
  window.__syncKeyState = syncKeyState;
  window.__testHooks = {
    endRun,
    runStarted: () => handleEvent({ type: "run_started", runId: "selftest" }),
    toolCardCount: () => toolCards.size,
  };
  window.__testHooksReady = true;
}

function renderModelList(st) {
  // The provider dots depend on key + model state, so refresh them here too.
  renderProviderNav();
  renderProviderDetail();
  updatePruneButton(st);
  const box = $("model-list");
  // Style the section header that owns the detect/add buttons.
  const label = box.previousElementSibling?.previousElementSibling;
  if (label && label.classList.contains("section-label")) label.classList.add("with-actions");
  const scope = st.modelScope || "";
  const detected = (st.detectedModels ?? {})[scope] ?? [];
  modelList = gatherModels(st);
  const active = $("cfg-model").value.trim() || st.model;

  box.innerHTML = "";
  if (!modelList.length) {
    box.innerHTML =
      '<div class="model-empty">还没有这个 Key 对应的模型列表。<br/>' +
      '点「⟳ 检测可用模型」获取；检测不到就用「＋ 手动」自己填。</div>';
    return;
  }
  // Mark which entries were actually detected vs. typed by hand.
  const detectedSet = new Set(detected);

  for (const id of modelList) {
    const row = document.createElement("div");
    row.className = "model-row" + (id === active ? " active" : "");
    row.dataset.model = id;

    const name = document.createElement("button");
    name.className = "model-name";
    name.type = "button";
    name.title = detectedSet.has(id) ? "设为当前模型（检测到）" : "设为当前模型（手动添加）";
    name.textContent = id;
    if (!detectedSet.has(id)) {
      const badge = document.createElement("span");
      badge.className = "model-badge";
      badge.textContent = "手动";
      badge.title = "不是检测到的，是你手动添加的";
      name.appendChild(badge);
    }
    name.addEventListener("click", () => {
      $("cfg-model").value = id;
      for (const r of box.querySelectorAll(".model-row")) r.classList.toggle("active", r.dataset.model === id);
    });
    row.appendChild(name);

    // Tiny per-model connectivity button.
    const test = document.createElement("button");
    test.className = "model-test";
    test.type = "button";
    test.title = `测试 ${id} 是否可用`;
    test.textContent = "⚡";
    test.addEventListener("click", () => testOneModel(id, test));
    row.appendChild(test);

    const del = document.createElement("button");
    del.className = "model-del";
    del.type = "button";
    del.title = "从列表移除";
    del.textContent = "×";
    del.addEventListener("click", async () => {
      modelList = modelList.filter((m) => m !== id);
      await window.aemeath.saveModels(scope, modelList);
      const st2 = await window.aemeath.status();
      renderModelList(st2);
    });
    row.appendChild(del);

    box.appendChild(row);
  }
}

/**
 * Probe a single model with one minimal request.
 * Runs immediately on click (no confirmation dialog) — it is a tiny, cheap call
 * and the button itself is the user's explicit intent.
 */
async function testOneModel(modelId, btn) {
  const typedKey = typedApiKey();
  const box = $("conn-result");
  const baseUrl = $("cfg-baseUrl").value.trim();

  if (!baseUrl) {
    box.className = "conn-result err";
    box.textContent = "请先填写 Base URL。";
    return;
  }
  if (!typedKey && !$("cfg-key-state").classList.contains("ok")) {
    box.className = "conn-result err";
    box.textContent = "请先填写 API Key。";
    return;
  }

  btn.disabled = true;
  btn.textContent = "…";
  box.className = "conn-result";
  box.innerHTML = `<div class="line dim">正在测试 ${escapeHtml(modelId)} …</div>`;

  const patch = {
    provider: currentProviderId(),
    apiMode: $("cfg-apiMode").value,
    baseUrl,
    model: modelId,
  };
  if (typedKey) patch.apiKey = typedKey;

  try {
    const r = await window.aemeath.testConnection(patch);
    if (r.ok) {
      btn.textContent = "✓";
      btn.classList.add("ok");
      box.className = "conn-result ok";
      box.innerHTML =
        `<div class="line"><b>✓ ${escapeHtml(modelId)} 可用</b> <span class="dim">${r.status} · ${r.ms}ms</span></div>` +
        (r.sample ? `<div class="line dim">回复: ${escapeHtml(r.sample)}</div>` : "") +
        (r.usage ? `<div class="line dim">tokens: in ${r.usage.inputTokens} / out ${r.usage.outputTokens}</div>` : "") +
        `<div class="line dim">${escapeHtml(r.url)}</div>`;
    } else {
      btn.textContent = "✗";
      btn.classList.add("err");
      box.className = "conn-result err";
      box.innerHTML =
        `<div class="line"><b>✗ ${escapeHtml(modelId)} 失败</b> <span class="dim">${r.status ?? "—"} · ${r.ms}ms</span></div>` +
        `<div class="line">${escapeHtml(r.error || "未知错误")}</div>` +
        (r.hint ? `<div class="line hint-line">💡 ${escapeHtml(r.hint)}</div>` : "") +
        `<div class="line dim">${escapeHtml(r.url)}</div>`;
    }
  } catch (err) {
    btn.textContent = "✗";
    btn.classList.add("err");
    box.className = "conn-result err";
    box.textContent = `测试失败: ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    btn.disabled = false;
    setTimeout(() => {
      btn.textContent = "⚡";
      btn.classList.remove("ok", "err");
    }, 4000);
  }
}

/* ---------------- detect / add / test-current-config --------------------- */

/**
 * Detect the models this Base URL + key can reach, and merge them into the list.
 *
 * Follows the convention used by mature harnesses: interrogate the endpoint the
 * form currently shows (an unsaved URL / unstored key work), and only ADD the
 * candidates — never overwrite a list the user curated by hand.
 */
/**
 * Offer to drop manual entries the current key cannot see.
 *
 * Detection results are cached per scope now, so anything left in the manual
 * bucket is either something the user typed or something that leaked in before
 * that scoping existed. The button only appears when there is something to
 * remove, and the dialog lists exactly what will go.
 */
function updatePruneButton(st) {
  const btn = $("btn-prune-models");
  if (!btn) return;
  const scope = st?.modelScope || "";
  const detected = new Set((st?.detectedModels ?? {})[scope] ?? []);
  const manual = (st?.savedModels ?? {})[scope] ?? [];
  const stale = manual.filter((m) => !detected.has(m));
  btn.classList.toggle("hidden", stale.length === 0);
  btn.dataset.stale = JSON.stringify(stale);
}

$("btn-prune-models").addEventListener("click", async () => {
  const stale = JSON.parse($("btn-prune-models").dataset.stale || "[]");
  if (!stale.length) return;
  const ok = await askConfirm({
    title: "只保留当前 Key 检测到的模型",
    body: `将从列表里移除 ${stale.length} 个模型：${stale.join("、")}`,
    note: "这些是这个 Key 检测不到的。检测结果本身不会被动到。",
    okText: "移除",
  });
  if (!ok) return;
  const st = await window.aemeath.status();
  await window.aemeath.saveModels(st.modelScope, []);
  const after = await window.aemeath.status();
  renderModelList(after);
  addNotice(`已移除 ${stale.length} 个检测不到的模型。`);
});

$("btn-detect-models").addEventListener("click", async () => {
  const btn = $("btn-detect-models");
  const hint = $("model-hint");
  const box = $("conn-result");

  const baseUrl = $("cfg-baseUrl").value.trim();
  if (!baseUrl) {
    hint.className = "hint warn";
    hint.textContent = "请先填写 Base URL。";
    $("cfg-baseUrl").focus();
    return;
  }
  const typedKey = typedApiKey();
  const hasSavedKey = $("cfg-key-state").classList.contains("ok");
  if (!typedKey && !hasSavedKey) {
    hint.className = "hint warn";
    hint.textContent = "请先填写 API Key（检测需要用它向供应商鉴权）。";
    $("cfg-apiKey").focus();
    return;
  }

  btn.disabled = true;
  const original = btn.textContent;
  btn.textContent = "⟳ 检测中…";
  hint.className = "hint";
  hint.textContent = "";
  box.className = "conn-result";
  box.innerHTML = '<div class="line dim">正在向供应商查询模型列表…</div>';

  const patch = {
    provider: currentProviderId(),
    apiMode: $("cfg-apiMode").value,
    baseUrl,
  };
  if (typedKey) patch.apiKey = typedKey;

  try {
    const r = await window.aemeath.listModels(patch);
    if (r.ok && r.models.length) {
      const ids = r.models.map((m) => m.id);

      /*
       * Do NOT merge with the list currently on screen.
       *
       * `modelList` may still hold the previous key's models (e.g. the key was
       * just retyped and nothing re-rendered yet). Merging folded those into
       * this scope and saved them into the *manual* bucket, where they stuck
       * around forever even though this key cannot see them.
       *
       * The main process already replaced the detected cache for this exact
       * scope, so the truth is one `status()` call away.
       */
      const st = await window.aemeath.status();
      renderModelList(st);

      const scopeMatches = (r.scope || "") === (st.modelScope || "");
      // Only manual entries count as "kept but invisible": the current model is
      // in the displayed list too, and it is not something the user typed.
      const manual = (st.savedModels ?? {})[st.modelScope || ""] ?? [];
      const stale = manual.filter((m) => !ids.includes(m));

      hint.className = "hint ok";
      hint.textContent = scopeMatches
        ? `当前 Key 能看到 ${r.models.length} 个模型`
        : `检测到 ${r.models.length} 个模型（属于尚未保存的 Key）`;
      box.className = "conn-result ok";
      box.innerHTML =
        `<div class="line"><b>✓ 检测成功</b> <span class="dim">${r.models.length} 个模型 · 按当前 Key 隔离</span></div>` +
        `<div class="line dim">${escapeHtml(r.url || baseUrl)}</div>` +
        `<div class="line dim">${escapeHtml(ids.slice(0, 8).join(", "))}${ids.length > 8 ? " …" : ""}</div>` +
        (scopeMatches
          ? ""
          : `<div class="line hint-line">💡 这个 Key 还没保存，所以列表里暂时看不到这些模型。点「保存」后就会显示。</div>`) +
        (scopeMatches && stale.length
          ? `<div class="line dim">列表里另有 ${stale.length} 个模型这个 Key 看不到（手动添加的，保留）</div>`
          : "");
    } else {
      // Be explicit: we could not get a list. Do NOT guess or fill in presets.
      hint.className = "hint warn";
      hint.textContent = r.hint || r.error || "检测不到模型";
      box.className = "conn-result err";
      box.innerHTML =
        `<div class="line"><b>检测不到模型</b> <span class="dim">${r.status ?? "—"}</span></div>` +
        `<div class="line">${escapeHtml(r.error || "该端点没有返回模型列表")}</div>` +
        (r.hint ? `<div class="line hint-line">💡 ${escapeHtml(r.hint)}</div>` : "") +
        (r.url ? `<div class="line dim">已尝试: ${escapeHtml((r.tried ?? [r.url]).join(", "))}</div>` : "") +
        `<div class="line dim">不会替你猜。你可以用「＋ 手动」填准确的模型名。</div>`;
    }
  } catch (err) {
    hint.className = "hint warn";
    hint.textContent = `检测失败: ${err instanceof Error ? err.message : String(err)}`;
    box.className = "conn-result err";
    box.textContent = `检测失败: ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
});

$("btn-add-model").addEventListener("click", () => {
  const box = $("model-list");
  if (box.querySelector(".inline-prompt")) return;

  const wrap = document.createElement("div");
  wrap.className = "inline-prompt";
  wrap.innerHTML =
    '<input id="inline-model-input" type="text" placeholder="模型名，例如 deepseek-chat" />' +
    '<button class="btn primary small" id="inline-model-ok">添加</button>' +
    '<button class="btn ghost small" id="inline-model-cancel">取消</button>';
  box.prepend(wrap);

  const inp = $("inline-model-input");
  inp.focus();

  const close = () => wrap.remove();
  const commit = async () => {
    const v = inp.value.trim();
    if (!v) return close();
    const providerId = currentProviderId();
    modelList = [...new Set([...modelList, v])];
    await window.aemeath.saveModels(providerId, modelList);
    $("cfg-model").value = v;
    const st = await window.aemeath.status();
    renderModelList(st);
  };
  $("inline-model-ok").addEventListener("click", commit);
  $("inline-model-cancel").addEventListener("click", close);
  inp.addEventListener("keydown", (e) => {
    if (e.key === "Enter") commit();
    else if (e.key === "Escape") close();
  });
});

/* ---------------------------- local UI prefs ----------------------------- */

// Test whatever is currently in the form (URL + key + model).
$("btn-test-conn").addEventListener("click", async () => {
  const model = $("cfg-model").value.trim();
  if (!model) {
    $("conn-result").className = "conn-result err";
    $("conn-result").textContent = "请先选择或填写一个模型。";
    return;
  }
  await testOneModel(model, $("btn-test-conn"));
});

/* ---------------------------- local UI prefs ----------------------------- */

const UI_PREF_KEYS = ["cfg-pet-enabled", "cfg-show-thinking", "cfg-compact-tools"];
/** Defaults when the user has never toggled them. */
const UI_PREF_DEFAULTS = { "cfg-pet-enabled": true, "cfg-show-thinking": true, "cfg-compact-tools": false };
let compactTools = false;

function loadUiPrefs() {
  for (const k of UI_PREF_KEYS) {
    let v = null;
    try {
      v = localStorage.getItem("aemeath." + k);
    } catch {
      /* ignore */
    }
    $(k).checked = v === null ? !!UI_PREF_DEFAULTS[k] : v === "1";
  }
  applyUiPrefs();
}

function saveUiPrefs() {
  for (const k of UI_PREF_KEYS) {
    try {
      localStorage.setItem("aemeath." + k, $(k).checked ? "1" : "0");
    } catch {
      /* ignore */
    }
  }
  applyUiPrefs();
}

function applyUiPrefs() {
  document.body.classList.toggle("hide-thinking", !$("cfg-show-thinking").checked);
  compactTools = $("cfg-compact-tools").checked;
  petDock.classList.toggle("hidden", !$("cfg-pet-enabled").checked);
}

for (const k of UI_PREF_KEYS) $(k).addEventListener("change", saveUiPrefs);

/* -------------------------------- boot ----------------------------------- */

window.aemeath.onEvent(handleEvent);
window.aemeath.onBalance(renderBalance);
window.aemeath.onMood((payload) => setMood(payload.mood, payload.text ? { line: payload.text } : {}));

(async function boot() {
  // Load the real Aemeath sprite sheet before starting the animation loop.
  try {
    await window.AemeathSprite.load("assets/pet/spritesheet.webp");
  } catch (err) {
    console.warn("精灵图加载失败，回退到内置像素画：", err);
  }
  startAvatarLoop();
  restorePetPos();
  // Ask the main process whether this is a self-test run; hooks stay off otherwise.
  window.aemeath
    .env()
    .then((e) => {
      if (e?.selfTest) installTestHooks();
    })
    .catch(() => {});
  await loadProviders();
  loadUiPrefs();
  renderWelcome();
  // Greet once the sprite is up.
  setTimeout(() => petGreet(), 600);
  let st = await refreshStatus({ loadForm: true });
  await refreshSessions();
  // Adopt the persisted pet visibility only if the user never chose in the UI.
  try {
    const prefs = await window.aemeath.getPetPrefs();
    const stored = localStorage.getItem("aemeath.cfg-pet-enabled");
    if (stored === null) setPetVisible(prefs.enabled !== false);
  } catch {
    /* keep UI pref */
  }
  // Sync the pet's model badge.
  $("pet-model").textContent = st.model || "—";
  // Fetch balance right away so the badges are populated.
  try {
    renderBalance(await window.aemeath.getBalance());
  } catch {
    /* ignore */
  }
  // The agent core initialises in the background; refresh once it is ready.
  if (!st.ready) {
    for (let i = 0; i < 40 && !st.ready; i++) {
      await new Promise((r) => setTimeout(r, 250));
      st = await refreshStatus({ loadForm: true });
    }
  }
  if (!st.hasKey) {
    setMood("waiting", { line: "先给我配一下 API Key 吧，我不然动不了呀～", sticky: true });
    $("btn-settings").click();
    addNotice("首次使用：请先填写 Base URL / API Key / 模型，然后保存。");
  } else {
    setMood("idle");
  }
  // Rotate idle chatter occasionally while nothing is happening.
  setInterval(() => {
    if (!streaming && avatarEl.dataset.mood === "idle") say(pick(LINES.idle));
  }, 45_000);
  inputEl.focus();
})();
