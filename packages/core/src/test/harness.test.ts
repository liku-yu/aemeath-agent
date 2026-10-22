import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CheckpointStore } from "../memory/checkpoint.js";
import { webFetchTool } from "../tools/builtin/web.js";

test("checkpoint: restores modified file content", () => {
  const dir = mkdtempSync(join(tmpdir(), "aemeath-cp-"));
  try {
    const target = join(dir, "a.txt");
    writeFileSync(target, "ORIGINAL", "utf8");

    const store = CheckpointStore.open(dir, "sess1");
    store.create("edit a.txt", [target], dir);

    writeFileSync(target, "CHANGED", "utf8");
    assert.equal(readFileSync(target, "utf8"), "CHANGED");

    const restored = store.restore("latest");
    assert.ok(restored);
    assert.equal(readFileSync(target, "utf8"), "ORIGINAL");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("checkpoint: deletes files the agent created", () => {
  const dir = mkdtempSync(join(tmpdir(), "aemeath-cp2-"));
  try {
    const target = join(dir, "new.txt");
    const store = CheckpointStore.open(dir, "sess2");
    // Captured before it existed.
    store.create("write new.txt", [target], dir);
    writeFileSync(target, "created by agent", "utf8");
    assert.ok(existsSync(target));

    store.restore("latest");
    assert.equal(existsSync(target), false, "created file should be removed on undo");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("checkpoint: undoing an older checkpoint drops later ones", () => {
  const dir = mkdtempSync(join(tmpdir(), "aemeath-cp3-"));
  try {
    const a = join(dir, "a.txt");
    writeFileSync(a, "v1", "utf8");
    const store = CheckpointStore.open(dir, "sess3");
    const first = store.create("first", [a], dir);

    writeFileSync(a, "v2", "utf8");
    store.create("second", [a], dir);
    assert.equal(store.list().length, 2);

    store.restore(first.id);
    assert.equal(readFileSync(a, "utf8"), "v1");
    assert.equal(store.list().length, 0, "later checkpoints must be dropped");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("web_fetch blocks private / metadata addresses", async () => {
  const ctx: any = {
    cwd: process.cwd(),
    notes: { save: async () => {}, list: async () => [], search: async () => [] },
    emit: () => {},
    state: new Map(),
    config: { permissions: { denyCommands: [] } },
    requestPermission: async () => "allow_once",
  };
  for (const url of [
    "http://localhost:8080/x",
    "http://127.0.0.1/",
    "http://169.254.169.254/latest/meta-data/",
    "http://10.0.0.5/admin",
    "http://192.168.1.1/",
    "http://172.16.0.1/",
    "file:///etc/passwd",
  ]) {
    const res = await webFetchTool.execute({ url }, ctx);
    assert.equal(res.isError, true, `should block ${url}`);
  }
});
