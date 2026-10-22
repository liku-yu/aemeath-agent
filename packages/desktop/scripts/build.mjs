#!/usr/bin/env node
/**
 * Fast desktop build using esbuild.
 *
 * Why esbuild: the previous `tsc` build took seconds on every launch. esbuild
 * bundles the main process + preload in ~100ms, inlining @aemeath/core from
 * source so no separate core build (and no runtime workspace resolution) is
 * needed. Use `--check` to skip the build entirely when nothing changed.
 */
import { build } from "esbuild";
import { cpSync, mkdirSync, statSync, readdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, "..");
const repoRoot = join(pkgRoot, "..", "..");
const coreSrc = join(repoRoot, "packages", "core", "src", "index.ts");
const distDir = join(pkgRoot, "dist");
const mainOut = join(distDir, "main", "main.js");
const check = process.argv.includes("--check");

/** Newest mtime across a set of source directories. */
function newestMtime(dirs) {
  let newest = 0;
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === "node_modules" || e.name === "dist") continue;
        walk(full);
      } else if (/\.(ts|js|mjs|html|css|json)$/.test(e.name)) {
        try {
          newest = Math.max(newest, statSync(full).mtimeMs);
        } catch {
          /* ignore */
        }
      }
    }
  };
  for (const d of dirs) walk(d);
  return newest;
}

const srcDirs = [
  join(pkgRoot, "src"),
  join(repoRoot, "packages", "core", "src"),
];
const srcFiles = [join(pkgRoot, "scripts", "build.mjs")];
const assetDirs = [join(pkgRoot, "assets")];

if (check && existsSync(mainOut)) {
  const outMtime = statSync(mainOut).mtimeMs;
  let srcMtime = newestMtime([...srcDirs, ...assetDirs]);
  for (const f of srcFiles) {
    try {
      srcMtime = Math.max(srcMtime, statSync(f).mtimeMs);
    } catch {
      /* ignore */
    }
  }
  if (outMtime > srcMtime) {
    process.stdout.write("desktop up-to-date (skipping build)\n");
    process.exit(0);
  }
}

const t0 = Date.now();
mkdirSync(join(distDir, "main"), { recursive: true });

// Renderer is static — copy as-is (including pet sprite assets).
mkdirSync(join(distDir, "renderer"), { recursive: true });
cpSync(join(pkgRoot, "src", "renderer"), join(distDir, "renderer"), { recursive: true });
const assetsDir = join(pkgRoot, "assets");
if (existsSync(assetsDir)) {
  cpSync(assetsDir, join(distDir, "renderer", "assets"), { recursive: true });
}

const common = {
  bundle: true,
  platform: "node",
  target: "node20",
  sourcemap: true,
  logLevel: "warning",
  // Electron is provided by the runtime; never bundle it.
  external: ["electron"],
  alias: { "@aemeath/core": coreSrc },
  define: { "process.env.NODE_ENV": JSON.stringify(process.env.NODE_ENV ?? "production") },
};

await Promise.all([
  build({
    ...common,
    entryPoints: [join(pkgRoot, "src", "main", "main.ts")],
    outfile: mainOut,
    format: "esm",
  }),
  build({
    ...common,
    entryPoints: [join(pkgRoot, "src", "main", "preload.ts")],
    /*
     * CommonJS on purpose.
     *
     * A sandboxed renderer only supports a CommonJS preload, and the sandbox is
     * worth more than the module syntax: it puts an OS-level boundary around the
     * renderer instead of relying on the CSP and our own escaping alone.
     * `electron` is the only import, so CJS works unchanged.
     */
    outfile: join(distDir, "main", "preload.cjs"),
    format: "cjs",
    // The package is "type": "module", so a .js file would be treated as ESM.
    // The explicit .cjs extension is what makes Node load it as CommonJS.
    external: ["electron"],
  }),
]);

process.stdout.write(`desktop built in ${Date.now() - t0}ms\n`);
