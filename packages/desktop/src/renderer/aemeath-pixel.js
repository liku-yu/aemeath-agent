/*
 * Aemeath pixel character — shared renderer.
 *
 * Original pixel art drawn programmatically (no third-party sprite sheets, so
 * no asset-licensing concerns). Exposes window.AemeathPixel with:
 *   - GRID / PALETTE
 *   - draw(ctx, { scale, rows, mood, frame })   -> renders one pose
 *   - dataURL(scale, mood)                      -> static <img> source
 *
 * The grid is a symmetric 20x24 chibi: pink gradient hair, blue hairclip,
 * dark cloth. Rows are verified palindromic by the test suite.
 */
(function () {
  /** 20 columns x 24 rows. `.` = transparent. */
  const GRID = [
    //0123456789...
    "........HHHH........", // 0
    "......HHHHHHHH......", // 1
    "....HHHHHHHHHHHH....", // 2
    "...HHHHHHHHHHHHHH...", // 3
    "..HHHHHHHHHHHHHHHH..", // 4
    "..HHhhhhhhhhhhhhHH..", // 5
    "..HHhsssssssssshHH..", // 6
    "..HHssssssssssssHH..", // 7
    "..HHssssssssssssHH..", // 8
    "..HHsseesssseessHH..", // 9
    "..HHsseesssseessHH..", // 10
    "..HHpsssssssssspHH..", // 11
    "..HHssssssssssssHH..", // 12
    "..HHsssssmmsssssHH..", // 13
    "..HHssssssssssssHH..", // 14
    "...HHssssssssssHH...", // 15
    "....HHssssssssHH....", // 16
    "..HHHHHHHHHHHHHHHH..", // 17
    "..HH..cccccccc..HH..", // 18
    "..HHccccccccccccHH..", // 19
    "..HHccccccccccccHH..", // 20
    "..HHccccccccccccHH..", // 21
    "..DDccccccccccccDD..", // 22
    "......ccc..ccc......", // 23
  ];

  const PALETTE = {
    H: "#f2a0d2", // hair mid
    h: "#ffcbe9", // hair highlight
    D: "#c96fa8", // hair shade
    s: "#ffeaf3", // skin
    e: "#45223c", // eye
    p: "#ff9fc8", // blush
    m: "#b0557f", // mouth
    c: "#3a2740", // cloth
  };

  const COLS = 20;
  const ROWS = 24;

  /** Eye cells (used for blinking) and their highlight pixels. */
  const EYES = [
    { x: 6, y: 9 },
    { x: 12, y: 9 },
  ];
  const HIGHLIGHTS = [
    { x: 6, y: 9 },
    { x: 13, y: 9 },
  ];
  /** Blue hairclip overlay. */
  const CLIP = [
    { x: 4, y: 6 },
    { x: 15, y: 6 },
  ];

  const KEY_META = {
    idle: { bob: 1, blink: true },
    thinking: { bob: 1.4, blink: true, sway: true },
    working: { bob: 2.2, blink: false, sway: true },
    waiting: { bob: 0.8, blink: true, pulse: true },
    happy: { bob: 3.4, blink: false, jump: true },
    error: { bob: 0, shake: true },
  };

  function px(ctx, x, y, color, scale) {
    ctx.fillStyle = color;
    ctx.fillRect(x * scale, y * scale, scale, scale);
  }

  /**
   * Draw the character.
   * @param {CanvasRenderingContext2D} ctx
   * @param {{scale?:number, mood?:string, frame?:number, hairOffset?:number}} opts
   */
  function draw(ctx, opts) {
    opts = opts || {};
    const scale = opts.scale || 4;
    const mood = opts.mood || "idle";
    const t = opts.frame || 0;
    const meta = KEY_META[mood] || KEY_META.idle;

    const W = COLS * scale;
    const H = ROWS * scale;
    ctx.clearRect(0, 0, W, H);

    // ---- compute animation offsets -------------------------------------
    let dx = 0;
    let dy = 0;
    if (meta.bob) dy = Math.round(Math.sin(t / 14) * meta.bob);
    if (meta.jump) dy -= Math.abs(Math.round(Math.sin(t / 6) * 5));
    if (meta.shake) dx = Math.round(Math.sin(t / 2.2) * 2);
    const sway = meta.sway ? Math.sin(t / 10) : 0;
    const hairShift = opts.hairOffset !== undefined ? opts.hairOffset : sway * 0.6;

    const blinking = meta.blink && t % 160 > 150 && t % 160 < 158;

    ctx.save();
    ctx.translate(dx * scale * 0.4, dy * scale * 0.4);

    // ---- body ----------------------------------------------------------
    for (let y = 0; y < ROWS; y++) {
      const row = GRID[y];
      for (let x = 0; x < COLS; x++) {
        const ch = row[x];
        if (!ch || ch === ".") continue;
        const isHair = ch === "H" || ch === "h" || ch === "D";
        // Side hair sways; head stays put.
        const sx = isHair && x < 5 ? x + Math.round(hairShift) : isHair && x > 14 ? x - Math.round(hairShift) : x;
        px(ctx, sx, y, PALETTE[ch], scale);
      }
    }

    // ---- eyes (or closed lids) -----------------------------------------
    for (const e of EYES) {
      if (blinking) {
        // A closed eye = a short skin-colored lid over the eye cell.
        px(ctx, e.x, e.y, PALETTE.s, scale);
        px(ctx, e.x + 1, e.y, PALETTE.s, scale);
        px(ctx, e.x, e.y + 1, PALETTE.m, scale);
        px(ctx, e.x + 1, e.y + 1, PALETTE.m, scale);
      }
    }
    if (!blinking) {
      for (const hl of HIGHLIGHTS) px(ctx, hl.x, hl.y, "#ffffff", scale);
    }

    // ---- blue hairclip --------------------------------------------------
    for (const c of CLIP) px(ctx, c.x, c.y, "#8fd8ff", scale);

    ctx.restore();
  }

  /** Render to an offscreen canvas and return a PNG data URL (for <img>). */
  function dataURL(scale, mood) {
    scale = scale || 4;
    const c = document.createElement("canvas");
    c.width = COLS * scale;
    c.height = ROWS * scale;
    const ctx = c.getContext("2d");
    // Paint two frames apart so a highlight is visible but eyes stay open.
    draw(ctx, { scale: scale, mood: mood || "idle", frame: 5 });
    return c.toDataURL("image/png");
  }

  window.AemeathPixel = {
    GRID: GRID,
    PALETTE: PALETTE,
    COLS: COLS,
    ROWS: ROWS,
    EYES: EYES,
    draw: draw,
    dataURL: dataURL,
  };
})();
