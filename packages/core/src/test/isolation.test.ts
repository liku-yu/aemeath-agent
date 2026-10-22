import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeKey } from "./fake.js";
import { loadConfig, saveGlobalConfig, dataPaths, credentialScope } from "../config/load.js";
import { CredentialStore } from "../config/credentials.js";

/**
 * AEMEATH_DATA_DIR isolates ALL data (config, sessions, checkpoints).
 * This guards against the bug where test/sandbox runs read and then overwrote
 * the user's real ~/.aemeath/config.json.
 */
test("AEMEATH_DATA_DIR isolates config reads and writes", () => {
  const iso = mkdtempSync(join(tmpdir(), "aemeath-iso-"));
  const prev = process.env.AEMEATH_DATA_DIR;
  process.env.AEMEATH_DATA_DIR = iso;
  try {
    const cfg = loadConfig({ cwd: iso });
    // The data dir must point at the sandbox.
    assert.equal(cfg.dataDir, iso);
    assert.equal(dataPaths(cfg.dataDir).config, join(iso, "config.json"));

    // A config written here must land in the sandbox, never in the real home.
    const marker = fakeKey("isolation-marker");
    saveGlobalConfig({ ...cfg, apiKey: marker });

    // config.json must NOT contain the key any more — it goes to the encrypted
    // credential store instead.
    const written = JSON.parse(readFileSync(join(iso, "config.json"), "utf8")) as { apiKey?: string };
    assert.equal(written.apiKey, undefined, "config.json must not carry the API key");
    assert.equal(readFileSync(join(iso, "config.json"), "utf8").includes(marker), false);

    // The key is readable back from the credential store in the same sandbox.
    const store = CredentialStore.open(iso);
    assert.equal(store.get(credentialScope(cfg)), marker);
    // And it is encrypted at rest.
    assert.equal(readFileSync(join(iso, "credentials.json"), "utf8").includes(marker), false);
  } finally {
    if (prev === undefined) delete process.env.AEMEATH_DATA_DIR;
    else process.env.AEMEATH_DATA_DIR = prev;
    rmSync(iso, { recursive: true, force: true });
  }
});

test("values inside the real config do not leak into an isolated run", () => {
  // Simulate a real home config with recognisable values.
  const realHome = mkdtempSync(join(tmpdir(), "aemeath-real-"));
  const iso = mkdtempSync(join(tmpdir(), "aemeath-iso2-"));
  const prev = process.env.AEMEATH_DATA_DIR;
  try {
    writeFileSync(
      join(realHome, "config.json"),
      JSON.stringify({ model: "LEAKED-MODEL", baseUrl: "https://leaked.example.com" }),
      "utf8",
    );

    // Point at the isolated dir, but read from a cwd whose parent holds the real one.
    process.env.AEMEATH_DATA_DIR = iso;
    const cfg = loadConfig({ cwd: iso });

    assert.notEqual(cfg.model, "LEAKED-MODEL", "model must not leak from the real config");
    assert.notEqual(cfg.baseUrl, "https://leaked.example.com", "baseUrl must not leak");
    // And the sandbox config file must not have been created just by reading.
    assert.equal(existsSync(join(iso, "config.json")), false);
  } finally {
    if (prev === undefined) delete process.env.AEMEATH_DATA_DIR;
    else process.env.AEMEATH_DATA_DIR = prev;
    rmSync(realHome, { recursive: true, force: true });
    rmSync(iso, { recursive: true, force: true });
  }
});
