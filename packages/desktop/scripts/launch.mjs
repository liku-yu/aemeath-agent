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
import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, "..");
const require = createRequire(import.meta.url);

// Steps ahead of Electron's own argv (e.g. `--dev`, `--smoke`).
const passthrough = process.argv.slice(2);

/**
 * Fail early, and loudly, when the workspace directory is marked Low Integrity.
 *
 * A Low-integrity directory (Windows shows it as
 * `Mandatory Label\Low Mandatory Level`) cannot be written by Chromium's
 * sandboxed processes, which are themselves low integrity. Electron then dies
 * during startup with **exit code 3 and no output at all** — no window, no log,
 * nothing to search for. The CLI keeps working, because plain Node does not use
 * that sandbox, so it looks like a build problem when it is not.
 *
 * Sandboxed agent workspaces can do this: whatever a Low-IL process creates
 * inherits its integrity level. This check runs before Electron so the symptom
 * comes with an explanation and a fix.
 *
 * Read-only: it never changes the ACL itself.
 */
function lowIntegrityLevel(dir) {
  if (process.platform !== "win32") return null;
  try {
    // `icacls <dir>` prints a SACL line only when an explicit label is set.
    const out = execFileSync("icacls", [dir], { encoding: "utf8", windowsHide: true });
    if (!/Low Mandatory Level/i.test(out)) return null;
    return dir;
  } catch {
    // icacls missing or denied: not worth failing the launch over.
    return null;
  }
}

function warnIfLowIntegrity(dir) {
  const bad = lowIntegrityLevel(dir);
  if (!bad) return;

  const fix = `icacls "${bad}" /remove:d Everyone`;
  const fix2 = `icacls "${bad}" /setintegritylevel (OI)(CI)M`;
  process.stderr.write(
    [
      "",
      "[aemeath] 工作目录带「低完整性」标签，桌面端会启动即退出（退出码 3，无任何输出）。",
      "          原因：Chromium 的沙箱子进程本身就是低完整性，写不进这个目录。",
      "          命令行版本不受影响，所以看起来像构建问题，其实不是。",
      "",
      `          目录：${bad}`,
      "          修复（在 PowerShell 里执行，不影响文件内容）：",
      `            ${fix}`,
      `            ${fix2}`,
      "",
      "          如果你把项目放在沙箱化工具（如某些 AI agent）的工作区里，",
      "          它可能会重新打上这个标签。把项目移到普通目录里最省事。",
      "",
    ].join("\n"),
  );
}

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
  // Checked before anything else: this failure mode produces no other signal.
  warnIfLowIntegrity(join(pkgRoot, "..", ".."));
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
