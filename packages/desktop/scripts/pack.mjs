#!/usr/bin/env node
/**
 * Package the desktop app into a Windows installer.
 *
 * electron-builder refuses to work from a semver range: it has to download the
 * platform binaries for one specific Electron release, and a range cannot be
 * resolved without guessing. Rather than duplicating the version inside the
 * build config — where it would silently go stale the moment the dependency is
 * bumped — read the version that is actually installed and pass it explicitly.
 *
 * Spawned from Node (not a shell one-liner) for the same reason as launch.mjs:
 * npm runs scripts through cmd.exe on Windows, which mangles `&&` chains.
 *
 * Only the installer is kept. electron-builder always stages an unpacked tree
 * (`win-unpacked/`) as an intermediate for NSIS, and also emits a `.blockmap`
 * (differential-update metadata, useless without an updater) and
 * `builder-debug.yml`. Shipping those alongside the Setup .exe makes the release
 * folder 5x larger for files nobody downloads, so they are removed once the
 * build succeeds. Set AEMEATH_KEEP_UNPACKED=1 to keep the tree for testing.
 */
import { spawn } from "node:child_process";
import { readdirSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, "..");
const releaseDir = join(pkgRoot, "release");
const require = createRequire(import.meta.url);

function electronVersion() {
  try {
    return require("electron/package.json").version;
  } catch {
    throw new Error("找不到 electron，请先 npm install");
  }
}

/** Resolve electron-builder's CLI without relying on PATH. */
function resolveBuilder() {
  const candidates = [
    join(pkgRoot, "node_modules", "electron-builder", "cli.js"),
    join(pkgRoot, "..", "..", "node_modules", "electron-builder", "cli.js"),
  ];
  for (const c of candidates) {
    try {
      require.resolve(c);
      return c;
    } catch {
      /* try next */
    }
  }
  throw new Error("找不到 electron-builder，请先 npm install");
}

/**
 * Leave only the installer behind.
 *
 * Deletion is best-effort: on Windows a still-running copy of the app keeps
 * app.asar locked, and failing the whole build over leftover scratch files would
 * be worse than leaving them.
 */
function keepOnlyInstaller() {
  if (process.env.AEMEATH_KEEP_UNPACKED) return [];
  let entries;
  try {
    entries = readdirSync(releaseDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const removed = [];
  for (const entry of entries) {
    if (entry.isFile() && /\.exe$/i.test(entry.name)) continue;
    try {
      rmSync(join(releaseDir, entry.name), { recursive: true, force: true });
      removed.push(entry.name);
    } catch {
      process.stdout.write(`  ! 无法删除 ${entry.name}（可能仍在运行）\n`);
    }
  }
  return removed;
}

function reportInstaller() {
  const installers = readdirSync(releaseDir).filter((f) => /\.exe$/i.test(f));
  for (const f of installers) {
    const mb = (statSync(join(releaseDir, f)).size / 1048576).toFixed(2);
    process.stdout.write(`\n产物: release/${f}  ${mb} MB\n`);
  }
  return installers.length;
}

const version = electronVersion();
const builder = resolveBuilder();
process.stdout.write(`packaging with electron ${version}\n`);

const args = [builder, `--config.electronVersion=${version}`, ...process.argv.slice(2)];

const child = spawn(process.execPath, args, { cwd: pkgRoot, stdio: "inherit" });
child.on("error", (err) => {
  console.error("打包失败:", err.message);
  process.exit(1);
});
child.on("exit", (code) => {
  if (code !== 0) process.exit(code ?? 1);
  const removed = keepOnlyInstaller();
  if (removed.length) {
    process.stdout.write(`\n已清理中间产物: ${removed.join(", ")}\n`);
  }
  process.exit(reportInstaller() > 0 ? 0 : 1);
});
