import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeKey } from "./fake.js";
import { CredentialStore, createLocalCipher, setCredentialCipher } from "../config/credentials.js";
import { loadConfig, saveGlobalConfig, dataPaths, credentialScope } from "../config/load.js";
import { modelScopeKey } from "../config/schema.js";

// Built at runtime: no literal key-shaped string in the repo.
const SECRET = fakeKey("credential");

function tmp() {
  return mkdtempSync(join(tmpdir(), "aemeath-cred-"));
}

/* --------------------------- credential store ---------------------------- */

test("a stored key is encrypted at rest and reads back", () => {
  const dir = tmp();
  try {
    const store = CredentialStore.open(dir);
    store.set("custom@https://gw.example.com", SECRET);

    const raw = readFileSync(join(dir, "credentials.json"), "utf8");
    assert.equal(raw.includes(SECRET), false, "ciphertext must not contain the plaintext key");
    assert.match(raw, /enc:v1:/);
    assert.equal(store.get("custom@https://gw.example.com"), SECRET);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("deleting a credential removes it", () => {
  const dir = tmp();
  try {
    const store = CredentialStore.open(dir);
    store.set("k", SECRET);
    assert.equal(store.has("k"), true);
    store.delete("k");
    assert.equal(store.has("k"), false);
    assert.equal(store.get("k"), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a corrupt store is quarantined, not silently overwritten", () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, "credentials.json"), "{ not json", "utf8");
    const store = CredentialStore.open(dir);
    assert.deepEqual(store.keys(), []);
    // The broken file was moved aside so the user can recover it.
    const files = readdirSync(dir);
    assert.ok(files.some((f) => f.includes("corrupt")), `expected a quarantined copy, got ${files.join(",")}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("values written under an old cipher still decrypt (fallback)", () => {
  const dir = tmp();
  try {
    // Write with the *machine-bound* local cipher (no custom secret), which is
    // exactly the cipher the store falls back to on read.
    const plain = new CredentialStore(join(dir, "credentials.json"), { cipher: createLocalCipher() });
    plain.set("k", SECRET);

    // Now read through a store whose *active* cipher is different — the local
    // fallback must still recover the value (this is what happens when the
    // desktop switches to the OS keychain).
    // Must reject foreign ciphertext (real safeStorage throws on invalid data);
    // a lenient fake would "succeed" with garbage and mask the fallback.
    const other = {
      kind: "fake-safeStorage",
      encrypt: (v: string) => "fake:" + Buffer.from(v).toString("base64"),
      decrypt: (v: string) => {
        if (!v.startsWith("fake:")) throw new Error("not my ciphertext");
        return Buffer.from(v.slice(5), "base64").toString("utf8");
      },
    };
    const reader = new CredentialStore(join(dir, "credentials.json"), { cipher: other });
    assert.equal(reader.get("k"), SECRET);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------- config.json must never hold a key ------------------- */

test("saving config keeps the API key out of config.json", () => {
  const dir = tmp();
  const prev = process.env.AEMEATH_DATA_DIR;
  try {
    process.env.AEMEATH_DATA_DIR = dir;
    const cfg = { ...loadConfig({ cwd: dir }), dataDir: dir, provider: "custom", baseUrl: "https://gw.example.com/v1" };
    cfg.apiKey = SECRET;
    saveGlobalConfig(cfg);

    const configText = readFileSync(dataPaths(dir).config, "utf8");
    assert.equal(configText.includes(SECRET), false, "config.json must not contain the key");
    assert.equal(configText.includes("apiKey"), false, "config.json must not even have the field");
    assert.equal(existsSync(join(dir, "credentials.json")), true, "key must be in the credential store");
  } finally {
    if (prev === undefined) delete process.env.AEMEATH_DATA_DIR;
    else process.env.AEMEATH_DATA_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the config write guard refuses to persist a leaked secret", () => {
  const dir = tmp();
  const prev = process.env.AEMEATH_DATA_DIR;
  try {
    process.env.AEMEATH_DATA_DIR = dir;
    const cfg = { ...loadConfig({ cwd: dir }), dataDir: dir };
    // Simulate a future refactor accidentally putting a key somewhere else.
    (cfg as any).someGatewayKey = fakeKey("left-behind");
    assert.throws(() => saveGlobalConfig(cfg), /密钥|refuse|拒绝/i);
  } finally {
    if (prev === undefined) delete process.env.AEMEATH_DATA_DIR;
    else process.env.AEMEATH_DATA_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a key stored for another endpoint does not leak into this one", () => {
  const dir = tmp();
  const prev = process.env.AEMEATH_DATA_DIR;
  try {
    process.env.AEMEATH_DATA_DIR = dir;
    const a = { ...loadConfig({ cwd: dir }), dataDir: dir, provider: "custom", baseUrl: "https://a.example.com/v1" };
    saveGlobalConfig({ ...a, apiKey: fakeKey("scope-a") });

    // Reading a *different* endpoint must not pick up A's key.
    const b = loadConfig({ cwd: dir, overrides: { baseUrl: "https://b.example.com/v1" } });
    assert.equal(b.apiKey, "");
  } finally {
    if (prev === undefined) delete process.env.AEMEATH_DATA_DIR;
    else process.env.AEMEATH_DATA_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadConfig hydrates the key from the credential store", () => {
  const dir = tmp();
  const prevEnv = { ...process.env };
  try {
    delete process.env.AEMEATH_API_KEY;
    delete process.env.DEEPSEEK_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    process.env.AEMEATH_DATA_DIR = dir;

    const cfg = { ...loadConfig({ cwd: dir }), dataDir: dir, provider: "custom", baseUrl: "https://gw.example.com/v1" };
    saveGlobalConfig({ ...cfg, apiKey: SECRET });

    const again = loadConfig({ cwd: dir, overrides: { dataDir: dir, provider: "custom", baseUrl: "https://gw.example.com/v1" } });
    // config.json has no key, so this value can only come from the store.
    assert.equal(again.apiKey, SECRET);
    assert.equal(credentialScope(cfg), "custom@https://gw.example.com/v1");
  } finally {
    process.env = prevEnv;
    setCredentialCipher(undefined);
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------- a foreign vendor env var must not hijack the key ---------- */

test("DEEPSEEK_API_KEY does not replace a key for a custom gateway", () => {
  const dir = tmp();
  const prev = process.env.DEEPSEEK_API_KEY;
  try {
    process.env.AEMEATH_DATA_DIR = dir;
    delete process.env.AEMEATH_API_KEY;
    // The user's own gateway key is stored for this endpoint.
    const cfg = { ...loadConfig({ cwd: dir }), dataDir: dir, provider: "custom", baseUrl: "https://gw.example.com/v1" };
    saveGlobalConfig({ ...cfg, apiKey: fakeKey("gateway") });

    // A totally unrelated vendor key is present in the environment.
    process.env.DEEPSEEK_API_KEY = fakeKey("deepseek-unrelated");

    const loaded = loadConfig({ cwd: dir, overrides: { dataDir: dir, provider: "custom", baseUrl: "https://gw.example.com/v1" } });
    assert.equal(loaded.apiKey, fakeKey("gateway"), "must not be hijacked by DEEPSEEK_API_KEY");
  } finally {
    if (prev === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = prev;
    delete process.env.AEMEATH_DATA_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------- scope key unchanged --------------------------- */

test("model scope keys are unaffected by the credential change", () => {
  const scope = modelScopeKey({ provider: "custom", baseUrl: "https://gw.example.com/v1", apiKey: "k" });
  assert.ok(scope.startsWith("custom@https://gw.example.com/v1#"));
});
