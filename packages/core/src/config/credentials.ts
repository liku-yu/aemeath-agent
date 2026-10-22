import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { platform, homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";

/**
 * Encrypted credential store, kept separate from the main config.
 *
 * Why: API keys must never be written into `config.json` as plaintext. The
 * config file is the thing people copy around, paste into issues, and sync to
 * dotfile repos. Following the approach used by ZCode's credential service, the
 * secrets live in their own file, encrypted, and the rest of the app only asks
 * this store for a value by key.
 *
 * Storage: <dataDir>/credentials.json
 *   { "<scopeKey>": "enc:v1:<iv>.<tag>.<ciphertext>" }   (all base64url)
 *
 * Encryption: AES-256-GCM. The key is derived from a secret that the host can
 * supply — the Electron main process passes an OS-keychain-backed secret
 * (`safeStorage`) when available. Otherwise we fall back to a machine-bound
 * value, which still keeps the key out of the config file and off casual eyes.
 */

const PREFIX = "enc:v1:";
const ALGO = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** Pluggable so the desktop can supply an OS-keychain-backed cipher. */
export interface CredentialCipher {
  encrypt(plaintext: string): string;
  decrypt(ciphertext: string): string;
  /** Short id for diagnostics, e.g. "safeStorage" | "aes-gcm". */
  readonly kind: string;
}

/** Default cipher: AES-256-GCM with a machine-bound key. */
export function createLocalCipher(secret?: string): CredentialCipher {
  const material = secret && secret.trim() ? secret : fallbackSecret();
  const key = createHash("sha256").update(material).digest();
  return {
    kind: "aes-gcm",
    encrypt(plaintext) {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv(ALGO, key, iv);
      const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      const tag = cipher.getAuthTag();
      return [PREFIX, iv.toString("base64url"), ".", tag.toString("base64url"), ".", body.toString("base64url")].join("");
    },
    decrypt(value) {
      if (!value.startsWith(PREFIX)) return value;
      const parts = value.slice(PREFIX.length).split(".");
      if (parts.length !== 3) throw new Error("凭据格式不正确");
      const [iv, tag, body] = parts;
      const decipher = createDecipheriv(ALGO, key, Buffer.from(iv, "base64url"));
      decipher.setAuthTag(Buffer.from(tag, "base64url"));
      return Buffer.concat([decipher.update(Buffer.from(body, "base64url")), decipher.final()]).toString("utf8");
    },
  };
}

function fallbackSecret(): string {
  let user = "unknown";
  try {
    user = userInfo().username;
  } catch {
    /* some environments deny this */
  }
  // Deliberately not a secret in the cryptographic sense: it only scopes the
  // file to this machine+user. The real win is that the key is no longer sitting
  // in the config file in plaintext.
  return `aemeath-credential-v1:${platform()}:${homedir()}:${user}`;
}

/**
 * Process-wide default cipher.
 *
 * The Electron main process installs an OS-keychain-backed cipher here
 * (safeStorage) before any config is loaded, so every CredentialStore opened
 * afterwards — including the one used during config hydration — uses it.
 */
let defaultCipher: CredentialCipher | undefined;

export function setCredentialCipher(cipher: CredentialCipher | undefined): void {
  defaultCipher = cipher;
}

export function getCredentialCipher(): CredentialCipher | undefined {
  return defaultCipher;
}

/**
 * Build a display-only preview of a secret: a short head and tail with the
 * middle masked.
 *
 * Two deliberate choices:
 *   - The mask is a fixed width, so the preview does not leak the exact length
 *     of the key.
 *   - Keys short enough that a head+tail would reveal most of them show no
 *     characters at all.
 *
 * The preview is for the UI only. It must never be written to disk or compared
 * against a real key.
 */
export function maskSecret(secret: string, opts: { head?: number; tail?: number } = {}): string {
  const value = secret ?? "";
  const head = opts.head ?? 4;
  const tail = opts.tail ?? 4;
  const MASK = "•".repeat(8);
  // Below this length, revealing both ends would expose most of the secret.
  if (value.length < head + tail + 4) return "•".repeat(8);
  return `${value.slice(0, head)}${MASK}${value.slice(-tail)}`;
}

export interface CredentialStoreOptions {
  /** Cipher to use. Defaults to the machine-bound AES-GCM cipher. */
  cipher?: CredentialCipher;
}

export class CredentialStore {
  private cipher: CredentialCipher;
  /**
   * Extra ciphers tried on read only.
   *
   * The active cipher can change between releases (e.g. the desktop switching to
   * the OS keychain). Values written under the old cipher must still decrypt, so
   * we fall back to the machine-bound one. A successful fallback read is
   * re-encrypted with the active cipher on the next write.
   */
  private fallbackCiphers: CredentialCipher[];
  private records: Record<string, string> = {};
  private loaded = false;

  constructor(private file: string, options: CredentialStoreOptions = {}) {
    this.cipher = options.cipher ?? defaultCipher ?? createLocalCipher();
    const local = createLocalCipher();
    this.fallbackCiphers = [local].filter((c) => c !== this.cipher && c.kind !== this.cipher.kind);
  }

  static open(dataDir: string, options: CredentialStoreOptions = {}): CredentialStore {
    return new CredentialStore(join(dataDir, "credentials.json"), options);
  }

  /** Cipher in use (for the settings UI to report where keys are kept). */
  get cipherKind(): string {
    return this.cipher.kind;
  }

  private load() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      if (!existsSync(this.file)) return;
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as unknown;
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        this.records = raw as Record<string, string>;
      }
    } catch {
      // A corrupt store must never be silently overwritten — that would destroy
      // every other saved key. Keep it on disk and start empty for this session.
      try {
        renameSync(this.file, `${this.file}.corrupt-${Date.now()}`);
      } catch {
        /* best effort */
      }
      this.records = {};
    }
  }

  private persist() {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    // Write with owner-only permissions where the platform supports it.
    writeFileSync(tmp, JSON.stringify(this.records, null, 2), { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, this.file);
  }

  /** Store a secret. Passing an empty value deletes it. */
  set(key: string, value: string): void {
    this.load();
    if (!value) return this.delete(key);
    this.records[key] = this.cipher.encrypt(value);
    this.persist();
  }

  /** Read a secret, or null when absent/undecryptable. */
  get(key: string): string | null {
    this.load();
    const stored = this.records[key];
    if (!stored) return null;
    try {
      return this.cipher.decrypt(stored);
    } catch {
      /* try the fallbacks below */
    }
    for (const c of this.fallbackCiphers) {
      try {
        const value = c.decrypt(stored);
        if (value) return value;
      } catch {
        /* next */
      }
    }
    // Wrong machine/user, or tampered data. Treat as missing rather than crash.
    return null;
  }

  has(key: string): boolean {
    this.load();
    return Boolean(this.records[key]);
  }

  delete(key: string): void {
    this.load();
    if (key in this.records) {
      delete this.records[key];
      this.persist();
    }
  }

  /** All stored keys (never their values). */
  keys(): string[] {
    this.load();
    return Object.keys(this.records);
  }

  /** Remove everything. */
  clear(): void {
    this.load();
    this.records = {};
    this.persist();
  }

  /**
   * Move a plaintext secret out of an already-loaded config object.
   * Returns true when a migration happened.
   */
  migrateFromConfig(configValue: string | undefined, key: string): boolean {
    const value = (configValue ?? "").trim();
    if (!value) return false;
    if (!this.has(key)) this.set(key, value);
    return true;
  }
}

/** Cryptographically-random secret for hosts that can persist one themselves. */
export function generateCipherSecret(): string {
  return randomBytes(32).toString("base64url");
}
