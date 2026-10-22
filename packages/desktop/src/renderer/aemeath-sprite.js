/*
 * Aemeath sprite engine — renders the real Q-style pixel Aemeath pet.
 *
 * Sprite sheet: cuNuo/aemeath-mini-codex-pet (MIT License), derived from the
 * MIT pixel pet project gitee.com/lzy-buaa-jdi/ameath. See assets/pet/NOTICE.md.
 *
 * Atlas: 1536x1872, 8 columns x 9 rows, each cell 192x208.
 *   row 0 idle (6)          row 5 failed (8)
 *   row 1 running-right (8) row 6 waiting (6)
 *   row 2 running-left (8)  row 7 running/work (6)
 *   row 3 waving (4)        row 8 review (6)
 *   row 4 jumping (5)
 *
 * TIMING: the source GIFs use *variable* frame durations (mid frames ~120-150ms,
 * the final frame holds 220-320ms). We reproduce those exact timings rather than
 * a uniform fps, which is what makes the animation read as hand-animated rather
 * than robotic. Animation is driven by elapsed milliseconds, not frame counters,
 * so it stays correct regardless of display refresh rate.
 *
 * TWO CROP REGIONS (the character is head + body + big wings, so a single crop
 * cannot look good in both a square avatar and a full-height pet):
 *   - "full"  tight union bbox of every cell → whole character, wings included
 *   - "bust"  square head-and-shoulders crop → used for avatars so the face
 *             fills the frame instead of being letterboxed by the wings
 *
 * If the sheet fails to load, draw() falls back to the built-in pixel drawing
 * in aemeath-pixel.js, so the UI never goes blank.
 */
(function () {
  const CELL_W = 192;
  const CELL_H = 208;
  const COLS = 8;
  const ROWS = 9;

  /**
   * Per-animation atlas row + the exact per-frame durations measured from the
   * source GIFs. `loop:false` clips hold their final frame until the caller
   * switches away (one-shot animations).
   */
  const ANIMATIONS = {
    idle: { row: 0, frameMs: [280, 110, 110, 140, 140, 320], loop: true },
    "running-right": { row: 1, frameMs: [120, 120, 120, 120, 120, 120, 120, 220], loop: true },
    "running-left": { row: 2, frameMs: [120, 120, 120, 120, 120, 120, 120, 220], loop: true },
    waving: { row: 3, frameMs: [140, 140, 140, 280], loop: false },
    jumping: { row: 4, frameMs: [140, 140, 140, 140, 280], loop: false },
    failed: { row: 5, frameMs: [140, 140, 140, 140, 140, 140, 140, 240], loop: false },
    waiting: { row: 6, frameMs: [150, 150, 150, 150, 150, 260], loop: true },
    running: { row: 7, frameMs: [120, 120, 120, 120, 120, 220], loop: true },
    review: { row: 8, frameMs: [150, 150, 150, 150, 150, 280], loop: true },
  };
  for (const k of Object.keys(ANIMATIONS)) {
    ANIMATIONS[k].frames = ANIMATIONS[k].frameMs.length;
    ANIMATIONS[k].totalMs = ANIMATIONS[k].frameMs.reduce((a, b) => a + b, 0);
  }

  /** Mood → animation. `hint` is an optional one-shot override. */
  const MOOD_TO_ANIM = {
    idle: "idle",
    thinking: "review",
    working: "running",
    waiting: "waiting",
    happy: "jumping",
    error: "failed",
    hurt: "failed",      // tool refused / timed out — the "力竭" reaction
    greeting: "waving",
  };

  /** One-shot animations: play once, then return to the caller's base anim. */
  function isOneShot(name) {
    const spec = ANIMATIONS[name];
    return !!spec && !spec.loop;
  }

  let sheet = null;
  let ready = false;
  /** Map<regionName, {x,y,w,h}> in cell-local coordinates. */
  const regions = {};

  function load(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        sheet = img;
        computeRegions();
        ready = true;
        resolve();
      };
      img.onerror = () => reject(new Error("failed to load sprite sheet: " + url));
      img.src = url;
    });
  }

  function isReady() {
    return ready;
  }

  function computeRegions() {
    try {
      const c = document.createElement("canvas");
      c.width = sheet.width;
      c.height = sheet.height;
      const ctx = c.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(sheet, 0, 0);
      const cols = Math.floor(sheet.width / CELL_W);
      // Read the whole atlas once; per-pixel getImageData would be far too slow.
      const img = ctx.getImageData(0, 0, sheet.width, sheet.height).data;
      const alphaAt = (x, y) => img[(y * sheet.width + x) * 4 + 3];

      // ---- "full": union of every animation row ----
      let minX = CELL_W, minY = CELL_H, maxX = -1, maxY = -1;
      const perRow = {};
      for (const key of Object.keys(ANIMATIONS)) {
        const row = ANIMATIONS[key].row;
        let bx = CELL_W, by = CELL_H, bxx = -1, byy = -1;
        for (let y = 0; y < CELL_H; y++) {
          for (let x = 0; x < cols * CELL_W; x++) {
            if (alphaAt(x, row * CELL_H + y) > 8) {
              const lx = x - Math.floor(x / CELL_W) * CELL_W;
              if (lx < bx) bx = lx;
              if (lx > bxx) bxx = lx;
              if (y < by) by = y;
              if (y > byy) byy = y;
            }
          }
        }
        if (bxx < 0) continue;
        const b = { x: bx, y: by, w: bxx - bx + 1, h: byy - by + 1 };
        perRow[key] = b;
        minX = Math.min(minX, b.x);
        minY = Math.min(minY, b.y);
        maxX = Math.max(maxX, b.x + b.w - 1);
        maxY = Math.max(maxY, b.y + b.h - 1);
      }
      if (maxX < 0) throw new Error("empty sheet");
      regions.full = { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };

      // ---- "bust": head-and-shoulders crop, used for avatars ----
      //
      // The idle row is head + body + wings. Wings are much wider than the body,
      // so the head ends where the silhouette suddenly widens. A *local* rate of
      // change is used (comparing y against y-LEAD): a running maximum keeps
      // raising the bar and never fires. A previous version also clamped the
      // result to 55% of the cell height, which cropped the chin — so the clamp
      // is now only a last-resort fallback.
      const idleRow = ANIMATIONS.idle.row;
      // Bounding box of ONE frame (not the union across frames — the union
      // includes other frames' wings and would mask the head's true width).
      const frameBounds = (row, col, cols) => {
        let bx = CELL_W, by = CELL_H, bxx = -1, byy = -1;
        for (let y = 0; y < CELL_H; y++) {
          for (let x = col * CELL_W; x < (col + 1) * CELL_W; x++) {
            if (alphaAt(x, row * CELL_H + y) > 8) {
              const lx = x - col * CELL_W;
              if (lx < bx) bx = lx;
              if (lx > bxx) bxx = lx;
              if (y < by) by = y;
              if (y > byy) byy = y;
            }
          }
        }
        return bxx < 0 ? null : { x: bx, y: by, w: bxx - bx + 1, h: byy - by + 1 };
      };
      const idle = frameBounds(idleRow, 0, cols) ?? perRow.idle ?? regions.full;
      /*
       * Width of the silhouette on one row, measured **inside a single frame**.
       * Scanning every frame and unioning them measured the wings of other
       * frames, which made the "head" look far wider than it is.
       */
      const frameX0 = 0; // frame 0 of the idle row
      const rowWidth = (y) => {
        let x0 = CELL_W, x1 = -1;
        for (let x = frameX0; x < frameX0 + CELL_W; x++) {
          if (alphaAt(x, idleRow * CELL_H + y) > 8) {
            const lx = x - frameX0;
            if (lx < x0) x0 = lx;
            if (lx > x1) x1 = lx;
          }
        }
        return x1 < 0 ? null : { x0, x1, w: x1 - x0 + 1 };
      };

      const idleBottom = idle.y + idle.h;

      /*
       * Find where the wings begin.
       *
       * The profile of a frame is: hair widens gradually to a peak (the head),
       * then narrows at the neck, then the wings appear as one large step. So we
       * locate the head's *peak* width, then look for the first big step after
       * it. Looking for the first step anywhere tripped on normal hair growth,
       * and measuring across all frames unioned the wings of other frames.
       */
      const widths = [];
      for (let y = idle.y; y < idleBottom; y++) {
        const r = rowWidth(y);
        widths.push(r ? r.w : 0);
      }
      const at = (i) => widths[i] ?? 0;

      // Head peak: the widest row in the upper half of the figure.
      const upperEnd = Math.max(1, Math.floor(widths.length * 0.6));
      let peak = 0;
      for (let i = 1; i < upperEnd; i++) if (at(i) > at(peak)) peak = i;

      // Wings: the first row after the peak where the width steps up sharply
      // relative to the peak and keeps growing.
      let headBottom = idle.y + widths.length;
      for (let i = peak + 2; i < widths.length - 2; i++) {
        const prev = at(i - 2);
        const jump = at(i) - prev;
        if (prev > 0 && at(i) > at(peak) * 1.25 && jump > 30) {
          headBottom = idle.y + i;
          break;
        }
      }
      if (headBottom >= idle.y + widths.length) {
        // No wing step found: generous fallback so the chin is never cut.
        headBottom = Math.min(idle.y + Math.round(idle.h * 0.85), idleBottom);
      }

      // Horizontal extent of the head+shoulders region, so the crop is centred
      // on the character rather than on the cell.
      let hx0 = CELL_W, hx1 = -1;
      for (let y = idle.y; y < headBottom; y++) {
        const r = rowWidth(y);
        if (!r) continue;
        hx0 = Math.min(hx0, r.x0);
        hx1 = Math.max(hx1, r.x1);
      }
      const contentW = hx1 >= 0 ? hx1 - hx0 + 1 : CELL_W;
      const contentH = headBottom - idle.y;

      /*
       * Square crop so avatars never distort. Uses the larger of width/height
       * plus a little breathing room; the previous version clamped to a fraction
       * of the cell, which truncated the chin.
       */
      const side = Math.round(Math.max(contentW, contentH) * 1.06);
      const cx = hx1 >= 0 ? (hx0 + hx1 + 1) / 2 : CELL_W / 2;
      const cy = idle.y + contentH / 2;

      regions.bust = {
        x: Math.round(cx - side / 2),
        y: Math.round(cy - side / 2),
        w: side,
        h: side,
      };

    } catch (err) {
      console.warn("[aemeath] region detection failed:", err);
      // Tainted canvas or unexpected layout → sensible fallbacks.
      regions.full = { x: 0, y: 0, w: CELL_W, h: CELL_H };
      regions.bust = { x: 26, y: 28, w: 140, h: 140 };
    }
  }

  function region(name) {
    return regions[name] || regions.full || { x: 0, y: 0, w: CELL_W, h: CELL_H };
  }

  /** Output pixel size for a scale + region. Callers size their canvas with this. */
  function displaySize(scale, regionName) {
    const b = region(regionName);
    const s = scale || 1;
    return { w: b.w * s, h: b.h * s };
  }

  /**
   * Frame index for an animation at a given elapsed time (ms).
   * Uses the source's variable per-frame durations; loops wrap, one-shots clamp
   * on their held final frame.
   */
  function frameAt(spec, elapsedMs) {
    const ms = spec.frameMs;
    const t = Math.max(0, elapsedMs || 0);
    if (spec.loop) {
      const local = t % spec.totalMs;
      let acc = 0;
      for (let i = 0; i < ms.length; i++) {
        acc += ms[i];
        if (local < acc) return i;
      }
      return ms.length - 1;
    }
    let acc = 0;
    for (let i = 0; i < ms.length; i++) {
      acc += ms[i];
      if (t < acc) return i;
    }
    return ms.length - 1; // hold the last frame
  }

  /** True once a one-shot animation has finished playing. */
  function isFinished(animName, elapsedMs) {
    const spec = ANIMATIONS[animName];
    if (!spec) return true;
    if (spec.loop) return false;
    return (elapsedMs || 0) >= spec.totalMs;
  }

  /**
   * Draw the current animation cell.
   * @param {CanvasRenderingContext2D} ctx
   * @param {{mood?:string, anim?:string, scale?:number, elapsed?:number,
   *          tick?:number, region?:string}} opts
   *   `elapsed` = ms since the current animation started (preferred).
   *   `tick`    = rAF frame count (legacy; converted to ms at ~60fps).
   */
  function draw(ctx, opts) {
    opts = opts || {};
    const scale = opts.scale || 1;
    const regionName = opts.region || "full";
    const animName = opts.anim || MOOD_TO_ANIM[opts.mood] || "idle";
    const spec = ANIMATIONS[animName] || ANIMATIONS.idle;
    const b = region(regionName);
    const w = b.w * scale;
    const h = b.h * scale;

    ctx.clearRect(0, 0, w, h);

    if (!ready || !sheet) {
      if (window.AemeathPixel) window.AemeathPixel.draw(ctx, { scale: scale, mood: opts.mood, frame: opts.tick });
      return;
    }

    const elapsed = opts.elapsed !== undefined ? opts.elapsed : (opts.tick || 0) * (1000 / 60);
    const col = frameAt(spec, elapsed);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(
      sheet,
      col * CELL_W + b.x,
      spec.row * CELL_H + b.y,
      b.w,
      b.h,
      0,
      0,
      w,
      h,
    );
  }

  /** Data URL of a specific frame (for static thumbnails). */
  function frameDataURL(mood, scale, frame, regionName) {
    const size = displaySize(scale || 1, regionName);
    const c = document.createElement("canvas");
    c.width = size.w;
    c.height = size.h;
    const spec = ANIMATIONS[MOOD_TO_ANIM[mood] || "idle"] || ANIMATIONS.idle;
    // Pick an elapsed time that lands on the requested frame.
    let t = 0;
    for (let i = 0; i < Math.min(frame ?? 0, spec.frameMs.length); i++) t += spec.frameMs[i];
    draw(c.getContext("2d"), {
      mood: mood || "idle",
      scale: scale || 1,
      elapsed: t + 1,
      region: regionName,
    });
    return c.toDataURL("image/png");
  }

  window.AemeathSprite = {
    load: load,
    isReady: isReady,
    draw: draw,
    displaySize: displaySize,
    frameDataURL: frameDataURL,
    frameAt: frameAt,
    isFinished: isFinished,
    isOneShot: isOneShot,
    regions: regions,
    ANIMATIONS: ANIMATIONS,
    MOOD_TO_ANIM: MOOD_TO_ANIM,
    CELL_W: CELL_W,
    CELL_H: CELL_H,
    COLS: COLS,
    ROWS: ROWS,
  };
})();
