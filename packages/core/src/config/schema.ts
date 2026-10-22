import { homedir } from "node:os";
import { join } from "node:path";

export type PermissionMode = "ask" | "allow" | "deny";

/** Which wire protocol to speak. */
export type ApiMode = "chat" | "responses" | "messages";

/**
 * A provider template.
 *
 * The settings UI renders these as a picker grid, and instantiating one creates
 * a provider entry. Modelled on the config-driven templates used by other
 * harnesses: the template carries everything needed to *start* using a provider
 * (protocol, endpoint, a sensible default model, and where to obtain a key), so
 * the user never has to know the wire protocol up front.
 */
export interface ProviderPreset {
  id: string;
  label: string;
  baseUrl: string;
  defaultModel: string;
  /** Which API modes this provider supports. */
  modes: ApiMode[];
  /** Whether /user/balance is available. */
  balance: boolean;
  needsKey: boolean;
  /** Short glyph shown on the provider card (no image assets to ship). */
  logo: string;
  /** Where the user goes to create an API key — shown next to the key field. */
  keyUrl?: string;
}

/** Built-in provider presets (also served to the settings UI). */
export const PROVIDER_PRESETS: ProviderPreset[] = [
  { id: "deepseek", label: "DeepSeek", logo: "🐋", baseUrl: "https://api.deepseek.com", defaultModel: "deepseek-chat", modes: ["chat"], balance: true, needsKey: true, keyUrl: "https://platform.deepseek.com/api_keys" },
  { id: "openai", label: "OpenAI", logo: "⬢", baseUrl: "https://api.openai.com", defaultModel: "gpt-4o", modes: ["chat", "responses"], balance: false, needsKey: true, keyUrl: "https://platform.openai.com/api-keys" },
  { id: "anthropic", label: "Anthropic", logo: "🅐", baseUrl: "https://api.anthropic.com", defaultModel: "claude-sonnet-4-5-20250929", modes: ["messages"], balance: false, needsKey: true, keyUrl: "https://console.anthropic.com/settings/keys" },
  { id: "moonshot", label: "Moonshot（Kimi）", logo: "🌙", baseUrl: "https://api.moonshot.cn", defaultModel: "moonshot-v1-8k", modes: ["chat"], balance: true, needsKey: true, keyUrl: "https://platform.moonshot.cn/console/api-keys" },
  { id: "dashscope", label: "阿里百炼", logo: "☁", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode", defaultModel: "qwen-plus", modes: ["chat"], balance: false, needsKey: true, keyUrl: "https://bailian.console.aliyun.com/?apiKey=1" },
  { id: "zhipu", label: "智谱 GLM", logo: "🧠", baseUrl: "https://open.bigmodel.cn/api/paas/v4", defaultModel: "glm-4-plus", modes: ["chat"], balance: false, needsKey: true, keyUrl: "https://bigmodel.cn/usercenter/apikeys" },
  { id: "siliconflow", label: "硅基流动", logo: "🌊", baseUrl: "https://api.siliconflow.cn", defaultModel: "deepseek-ai/DeepSeek-V3", modes: ["chat"], balance: false, needsKey: true, keyUrl: "https://cloud.siliconflow.cn/account/ak" },
  { id: "openrouter", label: "OpenRouter", logo: "🔀", baseUrl: "https://openrouter.ai/api", defaultModel: "anthropic/claude-sonnet-4.5", modes: ["chat"], balance: true, needsKey: true, keyUrl: "https://openrouter.ai/keys" },
  { id: "ollama", label: "Ollama（本地）", logo: "🦙", baseUrl: "http://localhost:11434", defaultModel: "qwen2.5:14b", modes: ["chat"], balance: false, needsKey: false },
  { id: "custom", label: "自定义", logo: "✨", baseUrl: "", defaultModel: "", modes: ["chat", "responses", "messages"], balance: false, needsKey: true },
];

/** Host of a base URL, or "" when it cannot be parsed. */
function hostOf(baseUrl: string): string {
  const raw = (baseUrl || "").trim();
  if (!raw) return "";
  try {
    return new URL(raw.includes("://") ? raw : `https://${raw}`).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/**
 * Choose a glyph for a provider from its endpoint.
 *
 * Nobody should have to pick an emoji to add a gateway, so the icon is derived:
 *
 *   1. a known provider host reuses that provider's glyph (the vendor's mark)
 *   2. a loopback address gets the local-server glyph
 *   3. anything else gets a monogram of its domain — "api.mygateway.com" → "M"
 *
 * A monogram is deliberately preferred over a random emoji: it is stable, it
 * distinguishes similar entries, and it carries information (which domain this
 * is) rather than decoration.
 */
export function providerLogoFor(baseUrl: string, label = ""): string {
  const host = hostOf(baseUrl);
  const LOOPBACK = ["localhost", "127.0.0.1", "0.0.0.0", "[::1]"];

  if (host && LOOPBACK.includes(host)) return "\u{1F5A5}\uFE0F";

  if (host) {
    for (const preset of PROVIDER_PRESETS) {
      if (preset.id === "custom") continue;
      const presetHost = hostOf(preset.baseUrl);
      if (!presetHost) continue;
      // Match the host itself or any subdomain of it.
      if (host === presetHost || host.endsWith(`.${presetHost}`)) return preset.logo;
    }
  }

  // Second-level label: "api.mygateway.com" → "mygateway" → "M".
  const labels = (host || label).split(".").filter(Boolean);
  const stem = labels.length >= 2 ? labels[labels.length - 2]! : (labels[0] ?? "");
  const ch = stem.replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, "").charAt(0);
  return ch ? ch.toUpperCase() : "\u2728";
}

export interface AemeathConfig {

  /** Active provider preset id ("custom" = free-form). */
  provider: string;
  /** Which wire protocol to use. */
  apiMode: ApiMode;
  /** Model id understood by the provider. */
  model: string;
  /** Base URL (Anthropic / OpenAI / any compatible gateway). */
  baseUrl: string;
  apiKey: string;
  maxTokens: number;
  temperature: number;
  /** Max tool-use iterations per run (safety valve). */
  maxSteps: number;
  /** Context window budget in tokens before auto-compaction kicks in. */
  contextBudget: number;
  /** Working directory the agent operates in. */
  cwd: string;
  /** Global data dir for sessions/notes/logs. */
  dataDir: string;
  permissions: {
    writeFile: PermissionMode;
    runCommand: PermissionMode;
    /** Commands that are always denied, matched by prefix. */
    denyCommands: string[];
    /** Extra allowed command prefixes. */
    allowCommands: string[];
  };
  persona: {
    enabled: boolean;
    /** Path to a custom persona markdown; empty = built-in Aemeath persona. */
    file: string;
  };
  /** MCP servers (stdio). */
  mcpServers: Record<string, { command: string; args?: string[]; env?: Record<string, string> }>;
  /**
   * User-curated model list.
   *
   * Keys are **endpoint scopes**, not bare provider ids: the same provider can
   * expose different model sets per API key (different plans / groupings), so a
   * scope is derived from provider + base URL + a key fingerprint.
   * See `modelScopeKey()`.
   */
  savedModels?: Record<string, string[]>;
  /**
   * Last detected model list, cached per endpoint scope (see `modelScopeKey`).
   * Detection results are only ever shown for the scope they came from.
   */
  detectedModels?: Record<string, string[]>;
  /**
   * User-defined providers, keyed by id. These show up alongside the built-in
   * presets so a private gateway / proxy becomes a first-class choice.
   */
  customProviders?: Record<
    string,
    {
      label: string;
      baseUrl: string;
      defaultModel?: string;
      modes?: ApiMode[];
      balancePath?: string;
      /**
       * The protocol this provider speaks. Stored per provider so switching
       * between providers restores the right wire format instead of inheriting
       * whatever the previously selected provider used.
       */
      apiMode?: ApiMode;
      /** Glyph shown on the provider card. */
      logo?: string;
    }
  >;
}

export const defaultBaseUrl = "https://api.anthropic.com";

export function defaultConfig(): AemeathConfig {
  const dataDir = join(homedir(), ".aemeath");
  return {
    provider: "deepseek",
    apiMode: "chat",
    model: process.env.AEMEATH_MODEL ?? "claude-sonnet-4-5-20250929",
    baseUrl: process.env.AEMEATH_BASE_URL ?? defaultBaseUrl,
    apiKey: process.env.AEMEATH_API_KEY ?? process.env.ANTHROPIC_API_KEY ?? "",
    maxTokens: 8192,
    temperature: 0.3,
    maxSteps: 40,
    contextBudget: 120_000,
    cwd: process.cwd(),
    dataDir,
    permissions: {
      writeFile: "ask",
      runCommand: "ask",
      denyCommands: [
        "rm -rf /",
        "mkfs",
        "dd if=",
        ":(){:|:&};:",
        "shutdown",
        "format ",
      ],
      allowCommands: ["ls", "dir", "cat", "git status", "git diff", "node -v", "npm -v"],
    },
    persona: { enabled: true, file: "" },
    mcpServers: {},
    savedModels: {},
    detectedModels: {},
  };
}

/** Paths derived from the data dir. */
/**
 * Stable, non-secret fingerprint of an API key.
 *
 * We must NOT store the key here, but two different keys on the same provider
 * really do expose different model sets (plans / groupings), so the cache key
 * has to differ per key. A short hash is enough and leaks nothing usable.
 */
export function keyFingerprint(apiKey: string | undefined): string {
  const k = (apiKey ?? "").trim();
  if (!k) return "nokey";
  // FNV-1a, 32-bit, hex — cheap and dependency-free.
  let h = 0x811c9dc5;
  for (let i = 0; i < k.length; i++) {
    h ^= k.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0") + ":" + k.length;
}

/**
 * Scope key for cached model lists.
 *
 * The same provider with different keys (or a different base URL) is a
 * different endpoint, and therefore a different model catalogue. Using
 * `provider` alone made two keys share one cached list — so a model that only
 * exists for key A would wrongly appear for key B.
 */
export function modelScopeKey(cfg: { provider?: string; baseUrl?: string; apiKey?: string }): string {
  const provider = (cfg.provider || "custom").trim() || "custom";
  const base = (cfg.baseUrl || "").trim().replace(/\/+$/, "").toLowerCase();
  return `${provider}@${base}#${keyFingerprint(cfg.apiKey)}`;
}

export function dataPaths(dataDir: string) {
  return {
    root: dataDir,
    config: join(dataDir, "config.json"),
    sessions: join(dataDir, "sessions"),
    notes: join(dataDir, "notes.json"),
    logs: join(dataDir, "logs"),
    permissions: join(dataDir, "permissions.json"),
  };
}
