import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { defaultConfig, defaultBaseUrl, dataPaths, type AemeathConfig } from "./schema.js";
import { CredentialStore, type CredentialCipher } from "./credentials.js";

function readJson<T>(file: string): T | undefined {
  try {
    if (!existsSync(file)) return undefined;
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function writeJson(file: string, value: unknown) {
  mkdirSync(dirname(file), { recursive: true });
  const text = JSON.stringify(value, null, 2);
  writeFileSync(file, text, "utf8");
}

/**
 * Guard against regressions: the config file must never contain a secret.
 * Runs in development/verification so a future change cannot silently start
 * writing keys back into a shareable file.
 */
export function assertNoSecretsInConfig(cfg: Record<string, unknown>): string[] {
  const problems: string[] = [];
  // Only object *keys* are inspected, never array indices, and only the last
  // path segment counts. Otherwise something like `savedModels["…key…"][2]`
  // (a model name) would be mistaken for a secret.
  // Field *names* only (never array indices), matched as a suffix so
  // `someGatewayKey` is caught but a scope-map key like `custom@host#ab12:67` is not.
  const SECRET_FIELD = /(api[_-]?key|key|token|secret|password)$/i;
  const walk = (node: unknown, path: string, lastKey: string) => {
    if (typeof node === "string") {
      // A field literally named like a secret, holding something substantial.
      if (SECRET_FIELD.test(lastKey) && node.trim().length >= 12) problems.push(path || lastKey);
      return;
    }
    if (Array.isArray(node)) {
      /*
       * Array elements are *values*, not named fields, so the parent key is
       * dropped here.
       *
       * Carrying it down flagged every entry under a scope like
       * `savedModels["custom@host/v1#nokey"]` — the string "#nokey" ends in
       * "key", so each model name looked like a leaked credential. The result
       * was that a user who had not saved a key yet could not save a model list
       * at all. Secrets in this schema are always scalars, so nothing is lost.
       */
      return node.forEach((v, i) => walk(v, `${path}[${i}]`, ""));
    }
    if (node && typeof node === "object") {
      for (const [k, v] of Object.entries(node)) walk(v, path ? `${path}.${k}` : k, k);
    }
  };
  walk(cfg, "", "");
  return problems;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Deep-merge b over a (objects only; arrays replaced). */
function merge<T>(a: T, b: unknown): T {
  if (!isPlainObject(b)) return (b === undefined ? a : (b as T));
  if (!isPlainObject(a)) return b as T;
  const out: Record<string, unknown> = { ...a };
  for (const [k, v] of Object.entries(b)) {
    out[k] = k in out ? merge((a as Record<string, unknown>)[k], v) : v;
  }
  return out as T;
}

/** Read a simple KEY=VALUE .env file (no expansion, comments supported). */
function readEnvFile(file: string): Record<string, string> {
  if (!existsSync(file)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

/**
 * Load config with the documented precedence:
 *   real shell env > project .aemeath/.env > ~/.aemeath/config.json > defaults
 */
export function loadConfig(opts: { cwd?: string; overrides?: Partial<AemeathConfig> } = {}): AemeathConfig {
  const cwd = opts.cwd ?? process.cwd();
  let cfg = defaultConfig();
  cfg.cwd = cwd;

  // project .aemeath/.env
  const projectEnv = readEnvFile(join(cwd, ".aemeath", ".env"));
  const envVal = (key: string) => process.env[key] ?? projectEnv[key];

  /*
   * Resolve the data dir BEFORE reading the config file. Test/sandbox runs set
   * AEMEATH_DATA_DIR to a throwaway directory; if we read the real config first
   * its values would leak into the isolated run.
   */
  if (envVal("AEMEATH_DATA_DIR")) cfg.dataDir = resolve(envVal("AEMEATH_DATA_DIR")!);

  // <dataDir>/config.json
  const fromGlobal = readJson<Partial<AemeathConfig>>(dataPaths(cfg.dataDir).config);
  if (fromGlobal) cfg = merge(cfg, fromGlobal);

  // Real environment wins over the global config file.
  if (envVal("AEMEATH_PROVIDER")) cfg.provider = envVal("AEMEATH_PROVIDER")!;
  if (envVal("AEMEATH_API_MODE")) cfg.apiMode = envVal("AEMEATH_API_MODE") as typeof cfg.apiMode;
  if (envVal("AEMEATH_MODEL")) cfg.model = envVal("AEMEATH_MODEL")!;
  if (envVal("AEMEATH_BASE_URL")) cfg.baseUrl = envVal("AEMEATH_BASE_URL")!;

  /*
   * Key resolution order (first hit wins):
   *   1. AEMEATH_API_KEY          — explicit, provider-agnostic
   *   2. the saved credential     — already hydrated above, scoped to this endpoint
   *   3. a vendor env var *whose vendor actually matches the endpoint*
   *   4. ANTHROPIC_API_KEY        — only for an Anthropic endpoint
   *
   * Step 3 is deliberately vendor-matched. Blindly using DEEPSEEK_API_KEY for a
   * self-hosted gateway silently replaced the user's own key with an unrelated
   * one, which then failed auth in a confusing way.
   */
  const vendorKeyFor = (baseUrl: string): string | undefined => {
    if (/deepseek/i.test(baseUrl)) return envVal("DEEPSEEK_API_KEY");
    if (/moonshot/i.test(baseUrl)) return envVal("MOONSHOT_API_KEY");
    if (/siliconflow/i.test(baseUrl)) return envVal("SILICONFLOW_API_KEY");
    if (/openrouter/i.test(baseUrl)) return envVal("OPENROUTER_API_KEY");
    if (/anthropic\.com/i.test(baseUrl)) return envVal("ANTHROPIC_API_KEY");
    if (/dashscope|aliyuncs/i.test(baseUrl)) return envVal("DASHSCOPE_API_KEY");
    if (/bigmodel|zhipu/i.test(baseUrl)) return envVal("ZHIPU_API_KEY");
    return undefined;
  };

  if (envVal("AEMEATH_API_KEY")) {
    cfg.apiKey = envVal("AEMEATH_API_KEY")!;
  } else if (!cfg.apiKey) {
    cfg.apiKey = vendorKeyFor(cfg.baseUrl) ?? envVal("AEMEATH_ANTHROPIC_API_KEY") ?? "";
  }

  // Convenience for a first run: if the only thing configured is a vendor key
  // and the endpoint is still the untouched default, point at that vendor.
  if (
    !fromGlobal?.baseUrl &&
    !envVal("AEMEATH_BASE_URL") &&
    cfg.baseUrl === defaultBaseUrl &&
    envVal("DEEPSEEK_API_KEY")
  ) {
    cfg.baseUrl = "https://api.deepseek.com";
    if (!fromGlobal?.model) cfg.model = "deepseek-chat";
  }

  cfg.cwd = resolve(cwd);
  if (!isAbsolute(cfg.dataDir)) cfg.dataDir = resolve(cfg.dataDir);

  /*
   * Overrides first, so the credential lookup below is scoped to the endpoint
   * that will actually be used (provider + base URL). Looking it up earlier used
   * the pre-override URL, which could hand back another endpoint's key.
   */
  if (opts.overrides) cfg = merge(cfg, opts.overrides);

  /*
   * Secrets live in the encrypted credential store, never in config.json.
   * An explicit env key already won above; otherwise hydrate from the store for
   * this endpoint. A legacy plaintext key still sitting in the config file is
   * kept working and migrated out on the next save.
   */
  if (!cfg.apiKey) {
    const store = CredentialStore.open(cfg.dataDir);
    cfg.apiKey = store.get(credentialScope(cfg)) ?? "";
  }

  return cfg;
}

/**
 * Persist the global config.
 *
 * The API key is deliberately NOT written here: it goes to the encrypted
 * credential store instead, so `config.json` is safe to copy, diff or paste
 * into an issue without leaking a secret.
 */
export function saveGlobalConfig(cfg: AemeathConfig, options: { credentials?: CredentialStore } = {}) {
  const store = options.credentials ?? CredentialStore.open(cfg.dataDir);
  const scope = credentialScope(cfg);
  if (cfg.apiKey) store.set(scope, cfg.apiKey);

  const { apiKey: _omit, ...rest } = cfg;
  const leaks = assertNoSecretsInConfig(rest as Record<string, unknown>);
  if (leaks.length) {
    throw new Error(`拒绝写入配置：检测到疑似密钥字段 ${leaks.join(", ")}（密钥应存入凭据库）`);
  }
  writeJson(dataPaths(cfg.dataDir).config, rest);
}

/** Scope a credential to the endpoint it belongs to (provider + base URL). */
export function credentialScope(cfg: { provider?: string; baseUrl?: string }): string {
  const provider = (cfg.provider || "custom").trim() || "custom";
  const base = (cfg.baseUrl || "").trim().replace(/\/+$/, "").toLowerCase();
  return `${provider}@${base}`;
}

export function ensureDataDirs(cfg: AemeathConfig) {
  const p = dataPaths(cfg.dataDir);
  mkdirSync(p.sessions, { recursive: true });
  mkdirSync(p.logs, { recursive: true });
}

export type { AemeathConfig } from "./schema.js";
export { defaultConfig, dataPaths } from "./schema.js";
export { readEnvFile };
