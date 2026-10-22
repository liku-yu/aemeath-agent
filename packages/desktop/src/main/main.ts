import { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme, safeStorage } from "electron";
import { runSelfTest } from "./selftest.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync, writeFileSync, existsSync, readFileSync, statSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import {
  loadConfig,
  saveGlobalConfig,
  ensureDataDirs,
  dataPaths,
  AgentRunner,
  SessionStore,
  PermissionPolicy,
  ToolRegistry,
  builtinTools,
  connectMcpServers,
  CheckpointStore,
  discoverSkills,
  PROVIDER_PRESETS,
  modelScopeKey,
  CredentialStore,
  setCredentialCipher,
  credentialScope,
  fetchBalance,
  formatBalance,
  testConnectivity,
  listModels,
  UsageTracker,
  type AemeathConfig,
  type AgentEvent,
  type PermissionRequest,
  type McpClient,
  type BalanceInfo,
  maskSecret,
  providerLogoFor,
  endpointUrlFor,
} from "@aemeath/core";

const __dirname = dirname(fileURLToPath(import.meta.url));
/*
 * Name the app before anything touches userData.
 *
 * Electron derives the userData directory from `app.getName()`, which reads the
 * top-level `productName` and falls back to `name`. Our package name is the npm
 * scope `@aemeath/desktop`, and the slash in it became a *path separator*:
 * caches were written to `%APPDATA%\@aemeath/desktop`, which failed with
 * "access denied" and took the GPU and network services down with it — the app
 * exited with code 3 before a window ever appeared.
 *
 * Setting the name explicitly keeps that independent of packaging metadata.
 */
app.setName("Aemeath");

const APP_START = Date.now();

/* --------------------------- host error handling -------------------------- */

/** Append a line to ~/.aemeath/logs/host.log, capped so it cannot grow forever. */
function logHost(level: "error" | "warn" | "info", message: string, detail?: unknown): void {
  try {
    const dir = dataPaths(cfg.dataDir).logs;
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "host.log");
    // Keep the file under ~512 KB by truncating from the front when it grows.
    if (existsSync(file) && statSync(file).size > 512 * 1024) {
      const kept = readFileSync(file, "utf8").split("\n").slice(-500).join("\n");
      writeFileSync(file, kept, "utf8");
    }
    const tail = detail === undefined ? "" : ` ${safeJson(detail)}`;
    writeFileSync(file, `[${new Date().toISOString()}] ${level.toUpperCase()} ${message}${tail}
`, { flag: "a" });
  } catch {
    /* logging must never throw */
  }
}

function safeJson(value: unknown, limit = 400): string {
  try {
    const seen = new WeakSet();
    const text = JSON.stringify(value, (_k, v) => {
      if (typeof v === "object" && v !== null) {
        if (seen.has(v)) return "[circular]";
        seen.add(v);
      }
      if (typeof v === "string" && v.length > 200) return v.slice(0, 200) + "…";
      return v;
    });
    return (text ?? String(value)).slice(0, limit);
  } catch {
    return String(value).slice(0, limit);
  }
}

/**
 * An allocation failure raised from a native callback is recoverable: the
 * request that triggered it will time out and retry, so killing the whole app
 * would be worse than the original error.
 */
function isRecoverableHostError(err: unknown): boolean {
  return err instanceof RangeError && /allocate memory/i.test(err.message);
}

process.on("uncaughtException", (err, origin) => {
  logHost("error", `uncaughtException (${origin})`, { message: err.message, stack: err.stack?.slice(0, 800) });
  if (isRecoverableHostError(err)) {
    send({ type: "log", level: "warn", message: `主进程瞬时分配失败，已忽略：${err.message}` });
    return;
  }
  // Make it visible instead of vanishing silently.
  send({ type: "error", runId: "host", message: `主进程异常：${err.message}` });
  dialog.showErrorBox("爱弥斯遇到问题", `${err.message}

日志：${
    dataPaths(cfg.dataDir).logs
  }

详情见 host.log`);
  app.exit(1);
});

process.on("unhandledRejection", (reason) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  logHost("error", "unhandledRejection", { message });
  send({ type: "error", runId: "host", message: `未处理的异步错误：${message}` });
  // Never exit on this one — it is usually a single failed request.
});
const isDev = process.argv.includes("--dev");
const isSmoke = process.argv.includes("--smoke");
const isSelfTest = process.argv.includes("--selftest");

/*
 * Test modes must never touch the user's real config, sessions or checkpoints.
 * They write to a throwaway data dir instead. Set AEMEATH_DATA_DIR explicitly to
 * override (e.g. to inspect the artefacts afterwards).
 */
if ((isSmoke || isSelfTest || isDev) && !process.env.AEMEATH_DATA_DIR) {
  process.env.AEMEATH_DATA_DIR = join(tmpdir(), "aemeath-test", String(process.pid));
}

/*
 * Prefer the OS keychain (Electron safeStorage) for the credential cipher, so
 * saved API keys are encrypted with a key the OS protects. Falls back to the
 * machine-bound AES-GCM cipher when unavailable.
 */
if (safeStorage.isEncryptionAvailable()) {
  setCredentialCipher({
    kind: "safeStorage",
    encrypt: (plain) => "ss:" + safeStorage.encryptString(plain).toString("base64"),
    decrypt: (value) => {
      const raw = value.startsWith("ss:") ? value.slice(3) : value;
      return safeStorage.decryptString(Buffer.from(raw, "base64"));
    },
  });
}

let win: BrowserWindow | null = null;
let cfg: AemeathConfig = loadConfig();
let tools: ToolRegistry;
let policy: PermissionPolicy;
let session: SessionStore;
let runner: AgentRunner;
let mcpClients: McpClient[] = [];
let currentAbort: AbortController | null = null;
let bootstrapPromise: Promise<void> | null = null;
let checkpoints: CheckpointStore;
let usageTracker: UsageTracker;
let planMode = false;
let balance: BalanceInfo = { supported: false, fetchedAt: 0 };
let balanceTimer: NodeJS.Timeout | null = null;

/** Persisted UI prefs for the pet window (position / visibility / size). */
const petPrefs = { enabled: true, x: -1, y: -1, scale: 1, alwaysOnTop: true };

/** queue of pending permission prompts (resolved by renderer) */
const pendingPermissions = new Map<string, (d: "allow_once" | "allow_always" | "deny") => void>();

/**
 * Initialise the agent core exactly once, lazily. The window is created
 * immediately so startup feels instant; this runs in the background.
 */
function ensureAgent(): Promise<void> {
  if (!bootstrapPromise) {
    bootstrapPromise = bootstrapAgent().catch((err) => {
      // Allow retrying after a failed init instead of caching the rejection.
      bootstrapPromise = null;
      throw err;
    });
  }
  return bootstrapPromise;
}

async function bootstrapAgent() {
  cfg = loadConfig();
  ensureDataDirs(cfg);
  tools = new ToolRegistry().registerAll(builtinTools());
  policy = new PermissionPolicy(cfg, dataPaths(cfg.dataDir).permissions);
  session = await SessionStore.create(cfg.dataDir);
  checkpoints = CheckpointStore.open(cfg.dataDir, session.id);
  usageTracker = UsageTracker.open(cfg.dataDir);

  if (Object.keys(cfg.mcpServers ?? {}).length) {
    const res = await connectMcpServers(cfg.mcpServers, (m) => send({ type: "log", level: "info", message: m }));
    tools.registerAll(res.tools);
    mcpClients = res.clients;
  }
  runner = new AgentRunner(cfg);
}

function send(event: AgentEvent) {
  win?.webContents.send("agent:event", event);
  // Keep the pet in sync with what the agent is doing.
  if (event.type === "run_started") pushMood("thinking", "交给我吧！");
  else if (event.type === "tool_started") pushMood("working", null);
  else if (event.type === "permission_requested") pushMood("waiting", "等你哦～");
  else if (event.type === "run_finished") {
    // run_finished is always emitted (even after an error), so only celebrate
    // on a genuinely clean finish; otherwise keep the error/aborted mood.
    if (event.stopReason === "end_turn") pushMood("happy", "搞定啦 ✨");
    else if (event.stopReason === "aborted") pushMood("idle", "好，停下来了。");
    else pushMood("error", null);
  } else if (event.type === "error") pushMood("error", "唔…出错了");
}

function pushMood(mood: string, text: string | null) {
  // The pet lives inside the main window, so one channel covers both.
  win?.webContents.send("pet:mood", { mood, text });
}

/* --------------------- pet preferences (embedded pet) --------------------- */

function loadPetPrefs() {
  try {
    const f = join(cfg.dataDir, "pet.json");
    if (existsSync(f)) Object.assign(petPrefs, JSON.parse(readFileSync(f, "utf8")));
  } catch {
    /* defaults */
  }
}

function savePetPrefs() {
  try {
    mkdirSync(cfg.dataDir, { recursive: true });
    writeFileSync(join(cfg.dataDir, "pet.json"), JSON.stringify(petPrefs, null, 2), "utf8");
  } catch {
    /* best-effort */
  }
}

/* ------------------------------ balance ----------------------------------- */

/**
 * How long a balance result is reused.
 *
 * `fetchBalance` falls through to a generic set of probes for unknown gateways,
 * which is up to seven HTTP requests each carrying the API key. Refreshing on
 * every settings save — including saves that only touched `maxTokens` — was
 * needless traffic and needless key exposure.
 */
const BALANCE_TTL_MS = 60_000;

/** Endpoint + key identity: either changing invalidates the cached balance. */
function balanceIdentity(): string {
  return `${credentialScope(cfg)}#${cfg.apiKey ? "key" : "nokey"}`;
}

let balanceIdentityCache = "";
let balanceFetchedAt = 0;

/**
 * A cached answer is reused when it is for the same endpoint+key and is still
 * young. Changing the endpoint or the key changes the identity, so it misses the
 * cache on its own — there is deliberately no "force" escape hatch, because the
 * callers that want one are exactly the ones that produced the request storm.
 */
async function refreshBalance(): Promise<BalanceInfo> {
  const identity = balanceIdentity();
  if (identity === balanceIdentityCache && Date.now() - balanceFetchedAt < BALANCE_TTL_MS) {
    return balance;
  }

  try {
    balance = await fetchBalance(cfg);
    balanceIdentityCache = identity;
    balanceFetchedAt = Date.now();
  } catch (err) {
    balance = { supported: true, message: err instanceof Error ? err.message : String(err), fetchedAt: Date.now() };
  }
  // Attach local usage so providers without a balance API still show something.
  const usage = usageTracker
    ? usageTracker.summary({ provider: cfg.provider || "custom", sinceMs: 30 * 24 * 60 * 60 * 1000 })
    : undefined;
  const payload = {
    ...balance,
    display: formatBalance(balance),
    usage,
    provider: cfg.provider,
    model: cfg.model,
  };
  win?.webContents.send("balance:update", payload);
  return payload;
}

function startBalancePolling() {
  if (balanceTimer) clearInterval(balanceTimer);
  refreshBalance().catch(() => {});
  // Every 10 minutes; cheap and keeps the pet's coin badge fresh.
  balanceTimer = setInterval(() => refreshBalance().catch(() => {}), 10 * 60_000);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: "#140f17",
    title: "爱弥斯 · Aemeath Agent",
    autoHideMenuBar: true,
    show: true,
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      // Sandboxed: the preload is CJS precisely so this can be true. The renderer
      // is untrusted (it renders model output and fetched pages), so give it the
      // strongest boundary available rather than only CSP + escaping.
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });

  win.loadFile(join(__dirname, "..", "renderer", "index.html"));
  if (isDev) win.webContents.openDevTools({ mode: "detach" });

  win.webContents.setWindowOpenHandler(({ url }) => {
    // Same protocol guard as the IPC route; never deny silently without logging.
    void openExternalSafely(url).then((r) => {
      if (!r.ok) logHost("warn", "blocked window.open", { url, error: r.error });
    });
    return { action: "deny" };
  });
}

/* ------------------------------- IPC ------------------------------------- */

/**
 * Refresh `cfg.apiKey` for whatever endpoint `cfg` currently points at.
 *
 * `cfg.apiKey` is a cache of "the key for the active endpoint". When the provider
 * or base URL changes that cache is stale — and because `saveGlobalConfig` writes
 * `cfg.apiKey` back into the credential store, a stale cache does not merely
 * display wrong: it copies one provider's key onto another provider's scope.
 *
 * Only the credential store is consulted. Environment-provided keys are resolved
 * once at startup; re-reading the environment on every settings save would
 * silently undo whatever the user just chose.
 */
function reloadActiveKey(): void {
  try {
    const store = CredentialStore.open(cfg.dataDir);
    cfg = { ...cfg, apiKey: store.get(credentialScope(cfg)) ?? "" };
  } catch {
    cfg = { ...cfg, apiKey: "" };
  }
}

ipcMain.handle("agent:status", async () => ({
  model: cfg.model,
  baseUrl: cfg.baseUrl,
  provider: cfg.provider,
  apiMode: cfg.apiMode,
  cwd: cfg.cwd,
  maxTokens: cfg.maxTokens,
  temperature: cfg.temperature,
  maxSteps: cfg.maxSteps,
  contextBudget: cfg.contextBudget,
  modelScope: modelScopeKey(cfg),
  credentialStore: (() => {
    try {
      const store = CredentialStore.open(cfg.dataDir);
      return { cipher: store.cipherKind, savedScopes: store.keys() };
    } catch {
      return { cipher: "unknown", savedScopes: [] };
    }
  })(),
  /**
   * Display-only masked preview of the key in use (head + dots + tail).
   * The renderer never receives the real key, only this.
   */
  keyPreview: cfg.apiKey ? maskSecret(cfg.apiKey) : "",
  savedModels: cfg.savedModels ?? {},
  detectedModels: cfg.detectedModels ?? {},
  personaEnabled: cfg.persona.enabled,
  personaFile: cfg.persona.file,
  permissions: cfg.permissions,
  hasKey: !!cfg.apiKey,
  sessionId: session?.id,
  tools: tools?.names() ?? [],
  ready: !!runner,
  planMode: runner?.getPlanMode() ?? planMode,
  configPath: dataPaths(cfg.dataDir).config,
}));

/**
 * Store an API key in the encrypted credential store for a specific endpoint.
 * Never touches config.json.
 */
ipcMain.handle(
  "agent:saveApiKey",
  async (_e, value: string, target?: { provider?: string; baseUrl?: string }) => {
    try {
      if (!value || !value.trim()) return { ok: false, error: "Key 不能为空" };
      const scope = credentialScope({ provider: target?.provider ?? cfg.provider, baseUrl: target?.baseUrl ?? cfg.baseUrl });
      const activeScope = credentialScope(cfg);
      const store = CredentialStore.open(cfg.dataDir);
      store.set(scope, value.trim());
      /*
       * Only adopt the key when it belongs to the endpoint we are actually using.
       *
       * Saving a key for a provider you merely have selected must not overwrite
       * the running configuration: doing so left `cfg` describing provider A's
       * endpoint while carrying provider B's key, so the next request
       * authenticated against the wrong service.
       */
      if (scope === activeScope) {
        cfg = { ...cfg, apiKey: value.trim() };
        void refreshBalance().catch(() => {});
      }
      const models = cfg.detectedModels?.[modelScopeKey(cfg)] ?? [];
      return {
        ok: true,
        scope,
        cipher: store.cipherKind,
        detectedForScope: models.length,
        preview: maskSecret(value.trim()),
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
);

/** Remove the stored key for an endpoint. */
ipcMain.handle("agent:clearApiKey", async (_e, target?: { provider?: string; baseUrl?: string }) => {
  try {
    const scope = credentialScope({ provider: target?.provider ?? cfg.provider, baseUrl: target?.baseUrl ?? cfg.baseUrl });
    const store = CredentialStore.open(cfg.dataDir);
    store.delete(scope);
    cfg = { ...cfg, apiKey: "" };
    return { ok: true, scope };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});

/**
 * Fields the renderer is allowed to change through `agent:setConfig`.
 *
 * An allow-list (not a deny-list) so a compromised or buggy renderer cannot
 * inject unknown keys, and so `apiKey` can never arrive this way — it has its
 * own dedicated channel. `Object.hasOwn` guards against prototype pollution.
 */
const CONFIG_FIELDS = [
  "provider",
  "apiMode",
  "model",
  "baseUrl",
  "maxTokens",
  "temperature",
  "maxSteps",
  "contextBudget",
  "persona",
  "permissions",
  "mcpServers",
  "savedModels",
  "detectedModels",
  "customProviders",
] as const;

function sanitizeConfigPatch(
  raw: unknown,
  opts: { allowApiKey?: boolean } = {},
): Partial<AemeathConfig> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("配置载荷格式不正确");
  }
  const out: Record<string, unknown> = {};
  for (const key of CONFIG_FIELDS) {
    if (Object.hasOwn(raw, key)) out[key] = (raw as Record<string, unknown>)[key];
  }
  /*
   * `apiKey` is excluded above because a settings save must never carry one —
   * that is the whole point of the separate credential channel.
   *
   * The probe endpoints are the exception: "test this key before I save it" is
   * exactly their purpose, and the key is used for one request and discarded.
   * Opt-in per call site so the default stays closed.
   */
  if (opts.allowApiKey && Object.hasOwn(raw, "apiKey")) {
    const value = (raw as Record<string, unknown>).apiKey;
    if (typeof value !== "string") throw new Error("apiKey 必须是字符串");
    out.apiKey = value;
  }
  return out as Partial<AemeathConfig>;
}

ipcMain.handle("agent:setConfig", async (_e, rawPatch: unknown) => {
  let patch: Partial<AemeathConfig>;
  try {
    patch = sanitizeConfigPatch(rawPatch);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  try {
    // Config editing must never depend on the agent being initialised — the most
    // common reason someone opens settings is that the current setup is broken.
    const endpointChanged = patch.provider !== undefined || patch.baseUrl !== undefined;
    cfg = { ...cfg, ...patch };
    // Must run BEFORE the save: saveGlobalConfig persists cfg.apiKey into the
    // credential store, so a stale key would be written onto the new scope.
    if (endpointChanged) reloadActiveKey();
    saveGlobalConfig(cfg);
    if (runner) runner = new AgentRunner(cfg);

    // Only the coin badge's inputs matter here: a save that changed neither the
    // endpoint nor the key cannot change the balance.
    if (endpointChanged) refreshBalance().catch(() => {});

    // Surface an agent-init problem as a warning instead of a failed save.
    let warning: string | undefined;
    try {
      await ensureAgent();
    } catch (err) {
      warning = `配置已保存，但 agent 初始化失败: ${err instanceof Error ? err.message : String(err)}`;
    }
    return { ok: true, warning, hasKey: !!cfg.apiKey, configPath: dataPaths(cfg.dataDir).config };
  } catch (err) {
    return {
      ok: false,
      error: `保存失败: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
});

ipcMain.handle("agent:listSessions", async () => SessionStore.list(cfg.dataDir));

ipcMain.handle("agent:deleteSession", async (_e, id: string) => {
  try {
    await SessionStore.remove(cfg.dataDir, id);
    // If we just deleted the active session, start a fresh one.
    if (session?.id === id) {
      session = await SessionStore.create(cfg.dataDir);
      checkpoints = CheckpointStore.open(cfg.dataDir, session.id);
    }
    return { ok: true, sessionId: session?.id };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});

ipcMain.handle("agent:deleteAllSessions", async () => {
  const list = await SessionStore.list(cfg.dataDir);
  for (const s of list) await SessionStore.remove(cfg.dataDir, s.id);
  session = await SessionStore.create(cfg.dataDir);
  checkpoints = CheckpointStore.open(cfg.dataDir, session.id);
  return { ok: true, removed: list.length, sessionId: session.id };
});

/** Built-in presets plus any user-declared providers. */
function allProviders() {
  const custom = cfg.customProviders ?? {};
  const customRows = Object.entries(custom).map(([id, p]) => ({
    id,
    label: p.label || id,
    baseUrl: p.baseUrl || "",
    scope: credentialScope({ provider: id, baseUrl: p.baseUrl || "" }),
    defaultModel: p.defaultModel || "",
    modes: p.modes ?? ["chat"],
    balance: !!p.balancePath,
    needsKey: true,
    // Older entries predate auto-detection; derive one rather than showing a
    // generic sparkle forever.
    logo: p.logo || providerLogoFor(p.baseUrl || "", p.label || id),
    custom: true,
    balancePath: p.balancePath,
    apiMode: p.apiMode,
  }));
  // Each row carries the scope its credential would live under, so the renderer
  // never has to re-implement the scoping rule.
  const presetRows = PROVIDER_PRESETS.filter((p) => p.id !== "custom").map((p) => ({
    ...p,
    scope: credentialScope({ provider: p.id, baseUrl: p.baseUrl }),
  }));
  const freeform = PROVIDER_PRESETS.find((p) => p.id === "custom")!;
  return [...presetRows, ...customRows, { ...freeform, scope: credentialScope({ provider: "custom", baseUrl: cfg.baseUrl }) }];
}

/**
 * One-shot diagnostic report.
 *
 * This is the payoff of an integrated design: a plugin-based agent can only let
 * each component report itself, whereas here we can check every link of the
 * chain in one place and hand the user a single answer.
 *
 * Deliberately does NOT call the network — reachability is an explicit,
 * user-triggered action (see `agent:testConnection`).
 */
ipcMain.handle("agent:health", async () => {
  const check = (name: string, run: () => { ok: boolean; detail: string; hint?: string }) => {
    try {
      return { name, ...run() };
    } catch (err) {
      return { name, ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  };

  const checks = [];

  checks.push(check("配置文件", () => {
    const file = dataPaths(cfg.dataDir).config;
    const exists = existsSync(file);
    // Prove writability with a throwaway file, then remove it so the data
    // directory is left exactly as we found it.
    mkdirSync(cfg.dataDir, { recursive: true });
    const probe = join(cfg.dataDir, `.write-test-${process.pid}`);
    let writable = false;
    try {
      writeFileSync(probe, "ok", "utf8");
      writable = existsSync(probe);
    } finally {
      try {
        rmSync(probe, { force: true });
      } catch {
        /* best-effort cleanup */
      }
    }
    return {
      ok: exists && writable,
      detail: `${file}${exists ? "" : " (尚未创建)"} · ${writable ? "可写" : "不可写"}`,
      hint: writable ? undefined : "检查目录权限。",
    };
  }));

  checks.push(check("API Key", () => {
    const store = CredentialStore.open(cfg.dataDir);
    const scope = credentialScope(cfg);
    const hasKey = !!cfg.apiKey;
    const fromEnv = !store.has(scope) && hasKey;
    return {
      ok: hasKey,
      detail: hasKey
        ? fromEnv
          ? "来自环境变量（未存入凭据库）"
          : `已加密保存于${store.cipherKind === "safeStorage" ? "系统钥匙串" : "本地凭据库"}`
        : "未配置",
      hint: hasKey ? undefined : "在设置里粘贴 Key 后点「保存」。",
    };
  }));

  checks.push(check("供应商", () => ({
    ok: !!cfg.baseUrl,
    detail: `${cfg.provider || "custom"} → ${cfg.baseUrl || "(未设置)"} · ${cfg.apiMode}`,
    hint: cfg.baseUrl ? undefined : "填写 Base URL。",
  })));

  checks.push(check("模型列表", () => {
    const scope = modelScopeKey(cfg);
    const detected = cfg.detectedModels?.[scope] ?? [];
    const saved = cfg.savedModels?.[scope] ?? [];
    const total = new Set([...detected, ...saved]).size;
    return {
      ok: total > 0,
      detail: total
        ? `${total} 个（检测 ${detected.length} / 手动 ${saved.length}）· 当前 ${cfg.model}`
        : "当前 Key 下还没有模型列表",
      hint: total ? undefined : "点「检测可用模型」，或手动添加。",
    };
  }));

  checks.push(check("权限策略", () => ({
    ok: true,
    detail: `写文件=${cfg.permissions.writeFile} / 执行命令=${cfg.permissions.runCommand}`,
    hint:
      cfg.permissions.writeFile === "allow" && cfg.permissions.runCommand === "allow"
        ? "当前是「自动允许」，风险较高。"
        : undefined,
  })));

  checks.push(check("Skills", () => {
    const dirs = [
      join(cfg.cwd, ".aemeath", "skills"),
      join(cfg.cwd, ".claude", "skills"),
      join(cfg.cwd, "skills"),
      join(cfg.dataDir, "skills"),
      join(homedir(), ".aemeath", "skills"),
    ];
    const skills = discoverSkills(dirs);
    return {
      ok: true,
      detail: skills.length
        ? `${skills.length} 个：${skills.map((s) => s.name).join(", ")}`
        : "未发现技能",
      hint: skills.length ? undefined : "把含 SKILL.md 的目录放进 skills/。",
    };
  }));

  checks.push(check("MCP", () => {
    const names = Object.keys(cfg.mcpServers ?? {});
    return {
      ok: true,
      detail: names.length ? `已配置 ${names.length} 个：${names.join(", ")}` : "未配置",
    };
  }));

  checks.push(check("最近的主进程错误", () => {
    const file = join(dataPaths(cfg.dataDir).logs, "host.log");
    if (!existsSync(file)) return { ok: true, detail: "无" };
    const lines = readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
    const errors = lines.filter((l) => l.includes(" ERROR "));
    const last = errors.at(-1);
    return {
      ok: errors.length === 0,
      detail: errors.length ? `${errors.length} 条，最近：${(last ?? "").slice(0, 120)}` : "无",
      hint: errors.length ? file : undefined,
    };
  }));

  const failed = checks.filter((c) => !c.ok).length;
  return { ok: failed === 0, checks, failed, dataDir: cfg.dataDir };
});

/**
 * The URL a request would go to for a given endpoint + protocol.
 *
 * The renderer asks for this instead of string-concatenating "/v1/..." itself:
 * the version-segment rule lives in the core, and a second copy in the UI is how
 * a settings hint ends up advertising a URL we never call.
 */
ipcMain.handle("agent:endpointUrl", async (_e, baseUrl: unknown, apiMode: unknown) => {
  const mode = apiMode === "messages" || apiMode === "responses" ? apiMode : "chat";
  return endpointUrlFor(String(baseUrl ?? ""), mode);
});

/**
 * Credential state for an arbitrary endpoint.
 *
 * The settings panel edits whichever provider is *selected*, which is not
 * necessarily the active one. Reporting the active provider's state there made
 * an unconfigured provider look configured (and made its key field show a mask
 * that belonged to a different provider).
 */
ipcMain.handle("agent:keyState", async (_e, provider?: unknown, baseUrl?: unknown) => {
  const scope = credentialScope({
    provider: String(provider ?? cfg.provider),
    baseUrl: String(baseUrl ?? cfg.baseUrl),
  });
  try {
    const store = CredentialStore.open(cfg.dataDir);
    const stored = store.get(scope);
    return {
      hasKey: !!stored,
      cipher: store.cipherKind,
      preview: stored ? maskSecret(stored) : "",
      scope,
    };
  } catch {
    return { hasKey: false, cipher: "unknown", preview: "", scope };
  }
});

/**
 * Resolve which API key a request to `candidate` should use.
 *
 * An explicitly supplied key (the user is testing something they just typed)
 * always wins. Otherwise the answer depends on whether this is the endpoint the
 * app is actually running on:
 *
 *   - same endpoint  → keep cfg.apiKey, which may have come from the environment
 *   - any other      → the credential stored for *that* endpoint's scope
 *
 * `cfg.apiKey` is only a cache for the active endpoint. Reusing it for whichever
 * provider the settings panel happens to be showing sent the wrong credential,
 * which surfaced as "detection works before saving the key, then stops".
 */
function keyForCandidate(candidate: AemeathConfig, supplied?: string): string {
  if (supplied) return supplied;
  const candidateScope = credentialScope(candidate);
  if (candidateScope === credentialScope(cfg)) return cfg.apiKey;
  try {
    return CredentialStore.open(cfg.dataDir).get(candidateScope) ?? "";
  } catch {
    return "";
  }
}

/**
 * Which mode the app is running in.
 *
 * The renderer needs this to decide whether to install its test hooks. Doing it
 * via IPC keeps `window.__*` out of a normal run entirely, while still letting
 * the self-test drive the real UI rather than a copy of it.
 */
ipcMain.handle("agent:env", async () => ({ selfTest: isSelfTest, dev: isDev }));

/**
 * The glyph a provider would get for an endpoint. Used for the live preview in
 * the add/edit form so the icon is never something the user has to choose.
 */
ipcMain.handle("agent:providerLogo", async (_e, baseUrl?: unknown, label?: unknown) =>
  providerLogoFor(String(baseUrl ?? ""), String(label ?? "")),
);

ipcMain.handle("agent:providers", async () => allProviders());

/** Create or update a user-declared provider. */
ipcMain.handle(
  "agent:saveProvider",
  async (
    _e,
    id: string,
    def: {
      label: string;
      baseUrl: string;
      defaultModel?: string;
      balancePath?: string;
      apiMode?: AemeathConfig["apiMode"];
      modes?: AemeathConfig["apiMode"][];
      logo?: string;
      /** Allow an empty Base URL: creating a placeholder to fill in later. */
      draft?: boolean;
    },
  ) => {
    const key = String(id || "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "-");
    if (!key) return { ok: false, error: "供应商 id 不能为空" };
    /*
     * A draft may have no endpoint yet.
     *
     * Adding a provider should ask for a name and nothing else — the endpoint,
     * the protocol and the key are filled in on the detail pane, where they can
     * be tested before they matter. Requiring a URL up front forced people to
     * know the answer before they had a place to put it.
     */
    const baseUrl = String(def?.baseUrl ?? "").trim();
    if (!baseUrl && !def?.draft) return { ok: false, error: "Base URL 不能为空" };
    // A custom provider must not shadow a built-in id: lookups take the first
    // match, so the entry would exist but never be reachable.
    if (key !== "custom" && PROVIDER_PRESETS.some((p) => p.id === key)) {
      return { ok: false, error: `「${key}」是内置模板 id，请换一个（例如 ${key}-2）` };
    }
    const VALID_MODES = ["chat", "responses", "messages"];
    const modes = (def.modes ?? []).filter((m) => VALID_MODES.includes(m));
    const apiMode = def.apiMode && VALID_MODES.includes(def.apiMode) ? def.apiMode : undefined;
    cfg = {
      ...cfg,
      customProviders: {
        ...(cfg.customProviders ?? {}),
        [key]: {
          label: def.label || key,
          baseUrl,
          defaultModel: def.defaultModel || "",
          modes: modes.length ? modes : ["chat"],
          balancePath: def.balancePath || undefined,
          // Derived from the endpoint when not given explicitly; a provider card
          // without an icon is just noise in the list.
          logo: def.logo || providerLogoFor(baseUrl, def.label || key),
          apiMode,
        },
      },
    };
    saveGlobalConfig(cfg);
    return { ok: true, id: key, providers: allProviders() };
  },
);

ipcMain.handle("agent:deleteProvider", async (_e, id: string) => {
  const next = { ...(cfg.customProviders ?? {}) };
  delete next[id];
  cfg = { ...cfg, customProviders: next };
  // Detach this provider's cached model lists so nothing lingers.
  const dropScoped = (m?: Record<string, string[]>) =>
    Object.fromEntries(Object.entries(m ?? {}).filter(([scope]) => !scope.startsWith(id + "@")));
  cfg = { ...cfg, savedModels: dropScoped(cfg.savedModels), detectedModels: dropScoped(cfg.detectedModels) };
  saveGlobalConfig(cfg);
  // If the deleted provider was active, fall back to a sane default.
  if (cfg.provider === id) {
    cfg = { ...cfg, provider: "deepseek", model: "deepseek-chat", baseUrl: "https://api.deepseek.com" };
    saveGlobalConfig(cfg);
  }
  return { ok: true, providers: allProviders(), activeProvider: cfg.provider };
});

/** Duplicate a provider definition so variants are one click to create. */
ipcMain.handle("agent:duplicateProvider", async (_e, id: string) => {
  const src = cfg.customProviders?.[id];
  if (!src) return { ok: false, error: "只能复制自定义供应商" };
  let n = 2;
  let newId = `${id}-${n}`;
  while (cfg.customProviders?.[newId]) newId = `${id}-${++n}`;
  cfg = {
    ...cfg,
    customProviders: { ...(cfg.customProviders ?? {}), [newId]: { ...src, label: `${src.label} ${n}` } },
  };
  saveGlobalConfig(cfg);
  return { ok: true, id: newId, providers: allProviders() };
});

/**
 * Auto-detect the models this exact endpoint exposes.
 *
 * Scoped by provider + base URL + key fingerprint, because the same provider
 * can hand out different model sets for different keys (plans / groupings).
 * The candidate key from the form is used, so this works before saving.
 */
ipcMain.handle("agent:listModels", async (_e, rawPatch?: unknown) => {
  // Same allow-list as setConfig: `{...cfg, ...patch}` with an arbitrary object
  // would let the renderer inject unknown keys (and, without `Object.hasOwn`,
  // reach the prototype).
  let patch: Partial<AemeathConfig>;
  try {
    patch = rawPatch === undefined ? {} : sanitizeConfigPatch(rawPatch, { allowApiKey: true });
  } catch (err) {
    return { ok: false, models: [], error: err instanceof Error ? err.message : String(err) };
  }
  const candidate = { ...cfg, ...patch };
  candidate.apiKey = keyForCandidate(candidate, patch?.apiKey);
  const scope = modelScopeKey(candidate);
  const res = await listModels(candidate);
  // Only cache a *successful* result, and only under this scope.
  if (res.ok && res.models.length) {
    cfg = {
      ...cfg,
      detectedModels: { ...(cfg.detectedModels ?? {}), [scope]: res.models.map((m) => m.id) },
    };
    saveGlobalConfig(cfg);
  }
  return { ...res, scope };
});

/**
 * Replace the *detected* cache for a scope with exactly what the endpoint said.
 *
 * Separate from `saveModels` on purpose: that one holds models the user typed in
 * by hand and must never be overwritten by a detection run. Keeping the two
 * buckets apart is what lets the UI say "only what this key can see" without
 * throwing away deliberate manual entries.
 */
ipcMain.handle("agent:saveDetectedModels", async (_e, scope: string, models: string[]) => {
  const key = String(scope || "").trim();
  if (!key) return { ok: false, error: "缺少 scope" };
  const clean = [...new Set((models ?? []).map((m) => String(m).trim()).filter(Boolean))].sort();
  cfg = { ...cfg, detectedModels: { ...(cfg.detectedModels ?? {}), [key]: clean } };
  saveGlobalConfig(cfg);
  return { ok: true, scope: key, models: clean };
});

/** Persist the user's curated model list for one endpoint scope. */
ipcMain.handle("agent:saveModels", async (_e, scope: string, models: string[]) => {
  const key = String(scope || "").trim();
  if (!key) return { ok: false, error: "缺少 scope" };
  const clean = [...new Set((models ?? []).map((m) => String(m).trim()).filter(Boolean))];
  cfg = { ...cfg, savedModels: { ...(cfg.savedModels ?? {}), [key]: clean } };
  saveGlobalConfig(cfg);
  return { ok: true, scope: key, models: clean };
});

/** Look up the models cached for the *current* endpoint scope. */
ipcMain.handle("agent:currentModels", async () => {
  const scope = modelScopeKey(cfg);
  return {
    scope,
    detected: cfg.detectedModels?.[scope] ?? [],
    saved: cfg.savedModels?.[scope] ?? [],
  };
});

/**
 * Probe the configured (or supplied) endpoint with a real minimal request.
 * The renderer must confirm with the user first — this spends a tiny amount of
 * credit and uses their API key.
 */
ipcMain.handle("agent:testConnection", async (_e, rawPatch?: unknown) => {
  let patch: Partial<AemeathConfig>;
  try {
    patch = rawPatch === undefined ? {} : sanitizeConfigPatch(rawPatch, { allowApiKey: true });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  const candidate = { ...cfg, ...patch };
  candidate.apiKey = keyForCandidate(candidate, patch?.apiKey);
  const res = await testConnectivity(candidate);
  return res;
});

ipcMain.handle("agent:skills", async () => {
  const dirs = [
    join(cfg.cwd, ".aemeath", "skills"),
    join(cfg.cwd, ".claude", "skills"),
    join(cfg.cwd, "skills"),
    join(cfg.dataDir, "skills"),
    join(homedir(), ".aemeath", "skills"),
    join(homedir(), ".claude", "skills"),
  ];
  return discoverSkills(dirs).map((s) => ({
    name: s.name,
    description: s.description,
    dir: s.dir,
    file: s.file,
    resources: s.resources,
  }));
});

ipcMain.handle("agent:mcpServers", async () => Object.keys(cfg.mcpServers ?? {}));

ipcMain.handle("agent:clearAllowList", async () => {
  await ensureAgent();
  policy.clearRemembered();
  return { ok: true };
});

/**
 * Open a link in the system browser, allowing only http/https.
 *
 * Handing an arbitrary scheme to the OS shell is a well-known escape hatch
 * (`file:`, `ms-msdt:`, …), so the check lives in one place and every entry
 * point routes through it — including `setWindowOpenHandler`, which previously
 * passed whatever it was given straight to `shell.openExternal`.
 */
async function openExternalSafely(url: unknown): Promise<{ ok: boolean; error?: string }> {
  let parsed: URL;
  try {
    parsed = new URL(String(url));
  } catch {
    return { ok: false, error: "不是合法的链接" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: `只允许打开 http/https 链接（收到 ${parsed.protocol}）` };
  }
  try {
    await shell.openExternal(parsed.toString());
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

ipcMain.handle("agent:openExternal", async (_e, url: unknown) => openExternalSafely(url));

ipcMain.handle("agent:openDataDir", async () => {
  await shell.openPath(cfg.dataDir);
  return { ok: true };
});

ipcMain.handle("agent:newSession", async () => {
  await ensureAgent();
  session = await SessionStore.create(cfg.dataDir);
  checkpoints = CheckpointStore.open(cfg.dataDir, session.id);
  return session.id;
});

ipcMain.handle("agent:resumeSession", async (_e, id: string) => {
  await ensureAgent();
  session = await SessionStore.open(cfg.dataDir, id);
  checkpoints = CheckpointStore.open(cfg.dataDir, session.id);
  return session.getMessages();
});

ipcMain.handle("agent:history", async () => {
  await ensureAgent();
  return session.getMessages();
});

ipcMain.handle("agent:abort", async () => {
  currentAbort?.abort();
  return { ok: true };
});

ipcMain.handle("agent:permissionResult", async (_e, key: string, decision: "allow_once" | "allow_always" | "deny") => {
  const resolve = pendingPermissions.get(key);
  if (resolve) {
    resolve(decision);
    pendingPermissions.delete(key);
  }
  return { ok: true };
});

ipcMain.handle("agent:pickFolder", async () => {
  const res = await dialog.showOpenDialog(win!, { properties: ["openDirectory"] });
  if (res.canceled || !res.filePaths[0]) return null;
  return res.filePaths[0];
});

/* ---------------------------- balance / pet ------------------------------ */

ipcMain.handle("balance:get", async () => refreshBalance());

ipcMain.handle("agent:setPlanMode", async (_e, on: boolean) => {
  planMode = !!on;
  // The runner owns the live state (the agent can also toggle it from a tool).
  await ensureAgent().catch(() => {});
  runner?.setPlanMode(planMode);
  return { planMode };
});

ipcMain.handle("agent:undo", async () => {
  await ensureAgent();
  const restored = checkpoints.restore("latest");
  if (!restored) return { ok: false, message: "没有可回滚的改动" };
  return { ok: true, label: restored.label, files: restored.files.map((f) => f.rel) };
});

ipcMain.handle("agent:checkpoints", async () => {
  await ensureAgent();
  return checkpoints.list().map((c) => ({ id: c.id, label: c.label, ts: c.ts, files: c.files.map((f) => f.rel) }));
});

ipcMain.handle("pet:getPrefs", async () => petPrefs);

ipcMain.handle("pet:setPrefs", async (_e, patch: Partial<typeof petPrefs>) => {
  Object.assign(petPrefs, patch);
  savePetPrefs();
  return petPrefs;
});

/**
 * True while a run is executing.
 *
 * The renderer guards on its own `streaming` flag, but that is only set once the
 * `run_started` event comes back — so two sends fired in the same tick both pass
 * that check. Overlapping runs share one `session` and one `tools` registry, and
 * the second would overwrite `currentAbort`, making the first unabortable.
 */
let runInFlight = false;

ipcMain.handle("agent:send", async (_e, prompt: unknown) => {
  if (typeof prompt !== "string" || !prompt.trim()) {
    return { ok: false, error: "消息不能为空" };
  }
  if (runInFlight) {
    return { ok: false, error: "已有任务在运行中，请先等它结束或点停止。" };
  }
  await ensureAgent();
  runInFlight = true;
  const abort = new AbortController();
  currentAbort = abort;

  const askPermission = (req: PermissionRequest) =>
    new Promise<"allow_once" | "allow_always" | "deny">((resolve) => {
      pendingPermissions.set(req.key, resolve);
      // Fallback: if renderer never answers (window closed), deny after 5 min.
      setTimeout(() => {
        if (pendingPermissions.delete(req.key)) resolve("deny");
      }, 5 * 60_000);
    });

  try {
    await runner.run({
      prompt,
      session,
      tools,
      policy,
      emit: send,
      askPermission,
      signal: abort.signal,
      // planMode intentionally omitted: the runner keeps it across turns, and
      // the agent may have changed it mid-run via enter/exit_plan_mode.
      checkpoints,
      usageTracker,
    });
  } catch (err) {
    send({ type: "error", runId: "desktop", message: err instanceof Error ? err.message : String(err) });
  } finally {
    currentAbort = null;
    runInFlight = false;
  }
  return { ok: true };
});

/* ---------------------------- app lifecycle ------------------------------ */

app.whenReady().then(async () => {
  nativeTheme.themeSource = "dark";
  mkdirSync(cfg.dataDir, { recursive: true });
  loadPetPrefs();

  if (isSmoke) {
    await ensureAgent();
    const summary = {
      ok: true,
      model: cfg.model,
      sessionId: session.id,
      tools: tools.names(),
      hasApiKey: !!cfg.apiKey,
      dataDir: cfg.dataDir,
      petPrefs,
    };
    process.stdout.write("SMOKE:" + JSON.stringify(summary) + "\n");
    for (const c of mcpClients) c.close();
    app.exit(0);
    return;
  }

  // Show the window immediately; initialise the agent in the background.
  createWindow();
  ensureAgent().catch((err) =>
    send({ type: "error", runId: "desktop", message: `初始化失败: ${err instanceof Error ? err.message : err}` }),
  );
  startBalancePolling();

  if (isSelfTest && win) {
    await runSelfTest(win, {
      exit: (code) => app.exit(code),
      startedAt: APP_START,
      closeMcp: () => {
        for (const c of mcpClients) c.close();
      },
    });
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  for (const c of mcpClients) c.close();
  if (process.platform !== "darwin") app.quit();
});

/**
 * Graceful shutdown.
 *
 * Each step is timed independently: a wedged MCP server or a stuck session
 * flush must not prevent the app from closing. Nothing here can throw out.
 */
let shuttingDown = false;
async function gracefulShutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  const steps: Array<[string, () => void | Promise<void>, number]> = [
    ["abort-run", () => currentAbort?.abort(), 2_000],
    ["stop-balance", () => {
      if (balanceTimer) clearInterval(balanceTimer);
    }, 500],
    ["close-mcp", () => mcpClients.forEach((c) => c.close()), 3_000],
    ["close-windows", () => {
      for (const w of BrowserWindow.getAllWindows()) {
        if (!w.isDestroyed()) w.destroy();
      }
    }, 1_000],
  ];

  for (const [name, run, timeoutMs] of steps) {
    const started = Date.now();
    const outcome = await Promise.race([
      Promise.resolve()
        .then(run)
        .then(() => "done" as const)
        .catch((err) => {
          logHost("warn", `shutdown step failed: ${name}`, { message: String(err) });
          return "failed" as const;
        }),
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), timeoutMs)),
    ]);
    logHost("info", `shutdown ${name}: ${outcome}`, { ms: Date.now() - started });
  }
}

app.on("before-quit", (event) => {
  if (shuttingDown) return; // already ran; let it quit
  event.preventDefault();
  void gracefulShutdown().finally(() => {
    shuttingDown = false;
    app.quit();
  });
});
