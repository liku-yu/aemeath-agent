/*
 * Runs in <head>, before the stylesheets are applied.
 *
 * When Chromium is compositing in software — no usable GPU driver, an RDP
 * session, some VMs — a blurred full-viewport layer plus the backdrop-filter
 * surfaces cost seconds per frame. Measured here: 6.1 s to first paint instead
 * of 1.2 s, with every renderer timer starved as a side effect.
 *
 * main.ts asks the GPU process for its status and passes ?gpu=off, so the very
 * first frame already uses the flat surfaces. Doing this from app.js instead
 * would mean painting the glass once — exactly the expensive part.
 */
if (new URLSearchParams(location.search).get("gpu") === "off") {
  document.documentElement.classList.add("no-gpu");
}
