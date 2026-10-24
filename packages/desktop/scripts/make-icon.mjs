#!/usr/bin/env node
/**
 * Rasterise assets/icon-source.svg into icon.png + icon.ico.
 *
 * Why this exists: Windows wants an .ico with several sizes inside, and there is
 * no SVG rasteriser in the dependency tree. Electron is already a dependency and
 * its Chromium renders SVG correctly, so the generator re-spawns itself under
 * Electron and draws each size with a hidden window. That keeps the toolchain
 * Node-only — the alternative was adding sharp (or shelling out to ImageMagick)
 * for a job that runs once a year.
 *
 * Each size is rendered natively from the vector source rather than downscaled
 * from 256: a 16px icon rendered at 16px keeps its strokes consistent.
 *
 *   npm run icon
 */
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, "..");
const assetDir = join(pkgRoot, "assets");
const SRC = join(assetDir, "icon-source.svg");

/** Sizes inside the .ico. 256 is required by electron-builder and Explorer. */
const SIZES = [16, 24, 32, 48, 64, 128, 256];

// ---------------------------------------------------------------------------
// Node side: re-exec under Electron, then assemble the ICO from what it renders.
// ---------------------------------------------------------------------------
if (!process.versions.electron) {
  const require = createRequire(import.meta.url);
  const electronPath = require("electron"); // the binary path, not the module
  const child = spawn(electronPath, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
    stdio: "inherit",
  });
  child.on("exit", (code) => process.exit(code ?? 1));
} else {
  const { app, BrowserWindow } = await import("electron");

  /** DIB entry: 32-bit BGRA, bottom-up, plus the 1bpp AND mask Windows expects. */
  function dibEntry(rgba, size) {
    const header = Buffer.alloc(40);
    header.writeUInt32LE(40, 0); // biSize
    header.writeInt32LE(size, 4); // biWidth
    header.writeInt32LE(size * 2, 8); // biHeight (XOR + AND)
    header.writeUInt16LE(1, 12); // biPlanes
    header.writeUInt16LE(32, 14); // biBitCount
    header.writeUInt32LE(size * size * 4, 20); // biSizeImage

    const pixels = Buffer.alloc(size * size * 4);
    for (let y = 0; y < size; y++) {
      const srcRow = (size - 1 - y) * size * 4; // bottom-up
      for (let x = 0; x < size; x++) {
        const s = srcRow + x * 4;
        const d = (y * size + x) * 4;
        pixels[d] = rgba[s + 2]; // B
        pixels[d + 1] = rgba[s + 1]; // G
        pixels[d + 2] = rgba[s]; // R
        pixels[d + 3] = rgba[s + 3]; // A
      }
    }
    // Fully opaque icons still need the mask present; all-zero = "use alpha".
    const maskRow = Math.ceil(size / 32) * 4;
    const mask = Buffer.alloc(maskRow * size);
    return Buffer.concat([header, pixels, mask]);
  }

  function icoFile(entries) {
    const header = Buffer.alloc(6);
    header.writeUInt16LE(0, 0);
    header.writeUInt16LE(1, 2); // 1 = icon
    header.writeUInt16LE(entries.length, 4);

    const dir = Buffer.alloc(16 * entries.length);
    let offset = header.length + dir.length;
    entries.forEach((e, i) => {
      const p = i * 16;
      dir.writeUInt8(e.size >= 256 ? 0 : e.size, p); // 0 means 256
      dir.writeUInt8(e.size >= 256 ? 0 : e.size, p + 1);
      dir.writeUInt8(0, p + 2); // palette size
      dir.writeUInt8(0, p + 3); // reserved
      dir.writeUInt16LE(1, p + 4); // planes
      dir.writeUInt16LE(32, p + 6); // bit count
      dir.writeUInt32LE(e.data.length, p + 8);
      dir.writeUInt32LE(offset, p + 12);
      offset += e.data.length;
    });
    return Buffer.concat([header, dir, ...entries.map((e) => e.data)]);
  }

  app.whenReady().then(async () => {
    const svg = readFileSync(SRC, "utf8");
    const win = new BrowserWindow({ show: false, width: 64, height: 64 });
    const page = `<!doctype html><meta charset="utf-8"><body><script>
      const SVG = ${JSON.stringify(svg)};
      window.render = async (sizes) => {
        // The SVG carries width/height; strip them so the <img> can be any size.
        const scalable = SVG.replace(/width="512" height="512"/, "");
        const url = URL.createObjectURL(new Blob([scalable], { type: "image/svg+xml" }));
        const img = new Image();
        img.src = url;
        await img.decode();
        const out = {};
        for (const size of sizes) {
          const c = document.createElement("canvas");
          c.width = size; c.height = size;
          const ctx = c.getContext("2d");
          ctx.imageSmoothingQuality = "high";
          ctx.drawImage(img, 0, 0, size, size);
          const px = ctx.getImageData(0, 0, size, size).data;
          out[size] = { px: Array.from(px), png: c.toDataURL("image/png") };
        }
        return out;
      };
    </script></body>`;
    await win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(page));
    const rendered = await win.webContents.executeJavaScript(`render(${JSON.stringify(SIZES)})`);

    const entries = SIZES.map((size) => {
      const { px, png } = rendered[size];
      const data =
        size >= 256
          ? Buffer.from(png.split(",")[1], "base64") // PNG is required at 256
          : dibEntry(Buffer.from(px), size);
      return { size, data };
    });

    mkdirSync(assetDir, { recursive: true });
    const ico = icoFile(entries);
    writeFileSync(join(assetDir, "icon.ico"), ico);
    writeFileSync(
      join(assetDir, "icon.png"),
      Buffer.from(rendered[256].png.split(",")[1], "base64"),
    );
    process.stdout.write(
      `icon.ico ${(ico.length / 1024).toFixed(1)} KB（${SIZES.join("/")}）+ icon.png 256\n`,
    );
    app.exit(0);
  });
}
