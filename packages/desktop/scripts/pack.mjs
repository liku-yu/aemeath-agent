#!/usr/bin/env node
/**
 * Package the desktop app into an installer / portable .exe.
 *
 * electron-builder refuses to work from a semver range: it has to download the
 * platform binaries for one specific Electron release, and a range cannot be
 * resolved without guessing. Rather than duplicating the version inside the
 * build config — where it would silently go stale the moment the dependency is
 * bumped — read the version that is actually installed and pass it explicitly.
 *
 * Spawned from Node (not a shell one-liner) for the same reason as launch.mjs:
 * npm runs scripts through cmd.exe on Windows, which mangles `&&` chains.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, "..");
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

const version = electronVersion();
const builder = resolveBuilder();
process.stdout.write(`packaging with electron ${version}\n`);

const args = [builder, `--config.electronVersion=${version}`, ...process.argv.slice(2)];

const child = spawn(process.execPath, args, { cwd: pkgRoot, stdio: "inherit" });
child.on("error", (err) => {
  console.error("打包失败:", err.message);
  process.exit(1);
});
child.on("exit", (code) => process.exit(code ?? 1));
