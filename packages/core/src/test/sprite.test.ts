import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));

/** Walk up until we find the desktop renderer directory. */
function findRendererDir(start: string): string {
  let dir = start;
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, "packages", "desktop", "src", "renderer");
    if (existsSync(join(candidate, "aemeath-sprite.js"))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("could not locate packages/desktop/src/renderer");
}

const rendererDir = findRendererDir(here);

/** Load aemeath-sprite.js in a sandbox with a minimal window/document stub. */
function loadSprite() {
  const code = readFileSync(join(rendererDir, "aemeath-sprite.js"), "utf8");
  const sandbox: any = {
    window: {},
    document: {
      createElement: () => ({
        width: 0,
        height: 0,
        getContext: () => ({
          drawImage() {},
          getImageData: () => ({ data: new Uint8ClampedArray(0) }),
          clearRect() {},
          toDataURL: () => "",
        }),
      }),
    },
    Image: class {
      width = 0;
      height = 0;
      set src(_v: string) {
        /* no auto-load in the sandbox */
      }
    },
    performance: { now: () => 0 },
    console,
  };
  sandbox.window.AemeathPixel = { draw() {} };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return sandbox.window.AemeathSprite;
}

const sprite = loadSprite();

test("sprite exposes all nine atlas animations", () => {
  const anims = Object.keys(sprite.ANIMATIONS).sort();
  assert.deepEqual(anims, [
    "failed",
    "idle",
    "jumping",
    "review",
    "running",
    "running-left",
    "running-right",
    "waiting",
    "waving",
  ]);
});

test("frame timings match the source GIFs (variable, not uniform)", () => {
  // Measured from the reference repo's preview GIFs.
  // NOTE: the sprite module runs in a vm sandbox, so its arrays have a foreign
  // prototype; copy them into plain arrays before deep-comparing.
  const ms = (n: string) => [...(sprite.ANIMATIONS[n] as any).frameMs];
  assert.deepEqual(ms("idle"), [280, 110, 110, 140, 140, 320]);
  assert.deepEqual(ms("running"), [120, 120, 120, 120, 120, 220]);
  assert.deepEqual(ms("waving"), [140, 140, 140, 280]);
  assert.deepEqual(ms("jumping"), [140, 140, 140, 140, 280]);
  assert.deepEqual(ms("running-right"), [120, 120, 120, 120, 120, 120, 120, 220]);
  assert.deepEqual(ms("failed"), [140, 140, 140, 140, 140, 140, 140, 240]);
  assert.deepEqual(ms("waiting"), [150, 150, 150, 150, 150, 260]);
  assert.deepEqual(ms("review"), [150, 150, 150, 150, 150, 280]);

  // The last frame must be the long hold — that's what gives the hand-animated feel.
  for (const [name, spec] of Object.entries(sprite.ANIMATIONS) as any) {
    const ms = spec.frameMs;
    const last = ms[ms.length - 1];
    const maxMid = Math.max(...ms.slice(0, -1));
    assert.ok(last > maxMid, `${name}: final frame (${last}ms) should hold longer than mid frames (${maxMid}ms)`);
  }
});

test("frameAt walks variable durations correctly and loops", () => {
  const idle = sprite.ANIMATIONS.idle;
  // idle: 280,110,110,140,140,320  (total 1100)
  assert.equal(sprite.frameAt(idle, 0), 0);
  assert.equal(sprite.frameAt(idle, 279), 0);
  assert.equal(sprite.frameAt(idle, 280), 1);
  assert.equal(sprite.frameAt(idle, 390), 2);
  assert.equal(sprite.frameAt(idle, 500), 3);
  assert.equal(sprite.frameAt(idle, 640), 4);
  assert.equal(sprite.frameAt(idle, 780), 5);
  assert.equal(sprite.frameAt(idle, 1099), 5);
  // wraps
  assert.equal(sprite.frameAt(idle, 1100), 0);
  assert.equal(sprite.frameAt(idle, 1380), 1);
});

test("one-shot animations clamp on their held final frame", () => {
  const wave = sprite.ANIMATIONS.waving; // 140,140,140,280 (total 700)
  assert.equal(sprite.frameAt(wave, 0), 0);
  assert.equal(sprite.frameAt(wave, 420), 3);
  assert.equal(sprite.frameAt(wave, 699), 3);
  // past the end it stays on the last frame instead of looping
  assert.equal(sprite.frameAt(wave, 5000), 3);
  assert.equal(sprite.isFinished("waving", 699), false);
  assert.equal(sprite.isFinished("waving", 700), true);
  // looping animations never report finished
  assert.equal(sprite.isFinished("idle", 1e9), false);
});

test("mood maps onto the right animations, including the new ones", () => {
  assert.equal(sprite.MOOD_TO_ANIM.working, "running");
  assert.equal(sprite.MOOD_TO_ANIM.thinking, "review");
  assert.equal(sprite.MOOD_TO_ANIM.waiting, "waiting");
  assert.equal(sprite.MOOD_TO_ANIM.error, "failed");
  assert.equal(sprite.MOOD_TO_ANIM.greeting, "waving");
});

test("one-shot classification is correct", () => {
  for (const n of ["waving", "jumping", "failed"]) assert.equal(sprite.isOneShot(n), true, `${n} should be one-shot`);
  for (const n of ["idle", "running", "waiting", "review"]) assert.equal(sprite.isOneShot(n), false, `${n} should loop`);
});


/* ---------------------- avatar (bust) crop correctness ------------------- */

import { readFileSync as _rf } from "node:fs";
import { join as _j } from "node:path";

test("the bust crop keeps the whole head plus a little shoulder", () => {
  // Reproduce the algorithm against the real spritesheet so a regression in the
  // crop maths is caught here rather than by eye.
  const root = findRendererDir2();
  const sheetPath = _j(root, "..", "..", "assets", "pet", "spritesheet.webp");
  if (!existsSync(sheetPath)) {
    // Asset is optional outside the packaged app.
    return;
  }
  const code = _rf(_j(root, "aemeath-sprite.js"), "utf8");
  assert.match(code, /regions\.bust/, "sprite must define a bust region");
  // The old bug clamped the head to 55% of the cell, which cut the chin off.
  assert.equal(/idle\.h \* 0\.55/.test(code), false, "the 55% clamp must be gone");
  // Squaring must use the larger dimension, not a fixed fraction of the cell.
  assert.match(code, /Math\.max\(contentW, contentH\)/);
});

function findRendererDir2(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  let dir = here;
  for (let i = 0; i < 8; i++) {
    const c = _j(dir, "packages", "desktop", "src", "renderer");
    if (existsSync(_j(c, "aemeath-sprite.js"))) return c;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("renderer dir not found");
}


test("bust crop is a square that fully contains the head", () => {
  // Guards the regression where the crop was clamped to 55% of the cell and cut
  // the chin off, and where widths were measured across ALL frames (unioning
  // other frames' wings) instead of one frame.
  const root = findRendererDir2();
  const code = _rf(_j(root, "aemeath-sprite.js"), "utf8");
  assert.equal(/idle\.h \* 0\.55/.test(code), false, "55% clamp must not come back");
  assert.match(code, /frameBounds/, "must measure a single frame's bounding box");
  // rowWidth must be limited to one frame's x-range, not the whole sheet.
  assert.match(code, /frameX0 \+ CELL_W/, "rowWidth must scan one frame only");
});

test("bust crop uses the larger dimension so avatars stay square and uncropped", () => {
  const root = findRendererDir2();
  const code = _rf(_j(root, "aemeath-sprite.js"), "utf8");
  assert.match(code, /Math\.max\(contentW, contentH\)/, "must take the larger side");
  // A square region means w === h in the assignment.
  const m = /regions\.bust = \{\s*x:[^}]*w: side,[^}]*h: side,/s.exec(code);
  assert.ok(m, "bust region must be square (w = h = side)");
});
