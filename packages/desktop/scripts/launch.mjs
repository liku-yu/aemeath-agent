#!/usr/bin/env node
/**
 * Cross-platform launcher: build-if-needed, then start Electron.
 *
 * Why a script instead of `a; b` in package.json: npm runs scripts through
 * cmd.exe on Windows, and cmd.exe does NOT treat `;` as a command separator.
 * A chained `node build.mjs --check || node build.mjs; electron .` therefore
 * silently skipped Electron whenever the build was up to date.
 *
 * Spawning Electron from Node avoids the shell entirely and works identically
 * on Windows, Linux and macOS.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, "..");
const require = createRequire(import.meta.url);

// Steps ahead of Electron's own argv (e.g. `--dev`, `--smoke`).
const passthrough = process.argv.slice(2);

async function ensureBuilt() {
  // build.mjs --check builds when stale and exits 0 when up-to-date.
  const buildScript = join(here, "build.mjs");
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [buildScript, "--check"], { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`build failed (${code})`))));
  });
}

/** Resolve the Electron executable without relying on PATH/shell. */
function resolveElectron() {
  try {
    // In a plain Node context, requiring "electron" returns the binary path.
    const p = require("electron");
    if (typeof p === "string" && existsSync(p)) return p;
  } catch {
    /* fall through */
  }
  // Fallback: node_modules/.bin
  const bin = join(pkgRoot, "..", "..", "node_modules", ".bin", process.platform === "win32" ? "electron.cmd" : "electron");
  if (existsSync(bin)) return bin;
  throw new Error("找不到 Electron 可执行文件，请先运行 npm install");
}

async function main() {
  await ensureBuilt();
  const electron = resolveElectron();
  const child = spawn(electron, [pkgRoot, ...passthrough], { stdio: "inherit" });
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 0);
  });
}

main().catch((err) => {
  console.error("启动失败:", err instanceof Error ? err.message : err);
  process.exit(1);
});
