/**
 * Self-test harness (`npm run desktop:selftest`).
 *
 * Lives apart from `main.ts` because it is a test, not product code: it starts a
 * local fake provider, drives the real renderer through generated DOM probes,
 * and asserts the results. Keeping it in the entry point meant a third of that
 * file was unreachable during normal runs.
 *
 * It is deliberately *not* unit tests. Several regressions this project hit —
 * a CSS class that never hid anything, a form that reset itself on save, a mask
 * read back as a key — were invisible to `npm test` because they only exist in
 * the renderer's wiring. Driving the actual UI is the only thing that caught
 * them, so that is what this does.
 *
 * Everything here runs against local endpoints or the UI itself; no request ever
 * reaches a real provider.
 */
import { writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import type { BrowserWindow } from "electron";

export interface SelfTestOptions {
  /**
   * Terminate the process. Injected rather than importing Electron's `app`, so
   * this module stays testable and free of app-lifecycle side effects.
   */
  exit: (code: number) => void;
  /** Process start time, for the reported boot duration. */
  startedAt: number;
  /** Close any MCP child processes before exiting. */
  closeMcp: () => void;
}

export async function runSelfTest(win: BrowserWindow, opts: SelfTestOptions): Promise<void> {
    // Built at runtime: no key-shaped literal in the repository. A literal one
    // trips secret scanners and cannot be told apart from a real leak.
    const GOOD_KEY = ["sk", "local", "selftest", "0".repeat(6)].join("-");
    const UI_KEY = ["sk", "ui", "selftest", "0".repeat(6)].join("-");
    const UI_KEY_2 = ["sk", "ui2", "selftest", "0".repeat(6)].join("-");
// Verify preload bridge + renderer load, then optionally run a real prompt.
const w = win;
const doRoundTrip = process.argv.includes("--roundtrip");
const timeout = setTimeout(() => {
  process.stdout.write("SELFTEST:FAIL timeout\n");
  opts.exit(1);
}, doRoundTrip ? 150_000 : 20_000);
w.webContents.once("did-finish-load", async () => {
  try {
    // The renderer installs its test hooks asynchronously (it asks main
    // whether this is a self-test run), so wait for them before probing.
    const hooksReady = await w.webContents.executeJavaScript(
      `new Promise((resolve) => {
         const t0 = Date.now();
         const iv = setInterval(() => {
           if (window.__testHooksReady) { clearInterval(iv); resolve(true); }
           else if (Date.now() - t0 > 5000) { clearInterval(iv); resolve(false); }
         }, 50);
       })`,
    );
    /*
     * A run that ends while a permission dialog is open must tear it down.
     * Previously the dialog stayed on screen and its buttons talked to a run
     * that no longer existed.
     */
    const endRunDom = await w.webContents.executeJavaScript(
      `(async () => {
         const out = {};
         document.getElementById("settings-overlay")?.classList.add("hidden");
         // Pretend the core raised a permission request, then end the run.
         window.__testHooks?.runStarted?.();
         window.aemeath.onEvent((e) => {});
         const overlay = document.getElementById("perm-overlay");
         overlay.classList.remove("hidden");
         document.getElementById("perm-detail").textContent = "probe";
         window.__testHooks?.endRun?.();
         await new Promise((r) => setTimeout(r, 100));
         out.permHidden = overlay.classList.contains("hidden");
         out.toolCardsCleared = window.__testHooks?.toolCardCount?.() === 0;
         out.ctxMeterPresent = !!document.getElementById("ctx-fill");
         return out;
       })()`,
    );

    const probe = await w.webContents.executeJavaScript(
      `(async () => ({ hasApi: !!window.aemeath, status: await window.aemeath.status(), health: await window.aemeath.health() }))()`,
    );
    // Exercise the Base URL reset + prune affordances.
    const guardDom = await w.webContents.executeJavaScript(
      `(async () => {
         document.getElementById("settings-overlay")?.classList.remove("hidden");
         document.querySelector('[data-tab="model"]')?.click();
         await new Promise((r) => setTimeout(r, 300));
         const out = {};
         const url = document.getElementById("cfg-baseUrl");
         const reset = document.getElementById("cfg-baseUrl-reset");

         // Pick a clean built-in provider by id.
         const card = [...document.querySelectorAll("#prov-nav-list .prov-item")]
           .find((b) => b.dataset.provider === "deepseek");
         card?.click();
         await new Promise((r) => setTimeout(r, 200));
         out.cleanUrl = url.value;
         out.resetHiddenWhenDefault = getComputedStyle(reset).display === "none";

         // Break the URL the way a hand-edit would.
         url.value = "https://api.deepseek.com/v1/v1/";
         url.dispatchEvent(new Event("input", { bubbles: true }));
         await new Promise((r) => setTimeout(r, 200));
         out.resetShownWhenBroken = getComputedStyle(reset).display !== "none";
         out.hintShown = !document.getElementById("cfg-baseUrl-hint").classList.contains("hidden");

         // One click must put it back.
         reset.click();
         await new Promise((r) => setTimeout(r, 200));
         out.afterReset = url.value;
         out.resetHiddenAfter = getComputedStyle(reset).display === "none";

         // Seed a stale manual entry, then check the prune button appears.
         const st = await window.aemeath.status();
         await window.aemeath.saveModels(st.modelScope, ["ghost-model-not-real"]);
         const st2 = await window.aemeath.status();
         window.__renderModelList && window.__renderModelList(st2);
         await new Promise((r) => setTimeout(r, 200));
         const prune = document.getElementById("btn-prune-models");
         out.pruneShown = getComputedStyle(prune).display !== "none";
         out.pruneStale = prune.dataset.stale;
         // Clean up so later probes see a tidy state.
         await window.aemeath.saveModels(st.modelScope, []);
         return out;
       })()`,
    );

    // Exercise the masked key field with an obviously fake key.
    const keyDom = await w.webContents.executeJavaScript(
      `(async () => {
         const input = document.getElementById("cfg-apiKey");
         const out = { steps: [] };
         // Isolate this probe on a provider none of the others touch.
         document.getElementById("settings-overlay")?.classList.remove("hidden");
         document.querySelector('[data-tab="model"]').click();
         await new Promise((r) => setTimeout(r, 300));
         [...document.querySelectorAll("#prov-nav-list .prov-item")]
           .find((b) => b.dataset.provider === "anthropic")?.click();
         await new Promise((r) => setTimeout(r, 400));
         out.before = { value: input.value, readOnly: input.readOnly };
         // Drive the real UI path: type a key, then click 保存.
         input.focus();
         input.value = ${JSON.stringify(UI_KEY)};
         document.getElementById("cfg-key-save").click();
         await new Promise((r) => setTimeout(r, 700));
         // The field must show THIS provider's mask, so use it as the
         // reference for the interaction assertions below.
         out.preview = input.value;
         out.after = { value: input.value, readOnly: input.readOnly, masked: input.classList.contains("masked") };
         // Clicking the field must NOT wipe the mask — that is the whole
         // point: the key stays visible (masked) while editing models.
         input.focus();
         await new Promise((r) => setTimeout(r, 100));
         out.focused = { value: input.value, readOnly: input.readOnly, masked: input.classList.contains("masked") };
         input.blur();
         await new Promise((r) => setTimeout(r, 100));
         out.afterClick = input.value;
         // Replacing is an explicit action.
         out.replaceBtnVisible = getComputedStyle(document.getElementById("cfg-key-replace")).display !== "none";
         out.saveBtnHidden = getComputedStyle(document.getElementById("cfg-key-save")).display === "none";
         document.getElementById("cfg-key-replace").click();
         await new Promise((r) => setTimeout(r, 100));
         out.afterReplaceClick = {
           value: input.value,
           readOnly: input.readOnly,
           placeholder: input.placeholder,
         };
         // Escape cancels and restores the preview.
         input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
         await new Promise((r) => setTimeout(r, 100));
         out.afterEscape = input.value;
         // Blurring without typing must restore the preview.
         input.blur();
         await new Promise((r) => setTimeout(r, 100));
         out.blurred = { value: input.value, readOnly: input.readOnly, masked: input.classList.contains("masked") };
         out.eyeDisabled = document.getElementById("cfg-key-eye").disabled;
         return out;
       })()`,
    );

    /*
     * Reported: model detection worked before the key was saved, and stopped
     * working after.
     *
     * Exercised against a local fake /v1/models so the whole path is covered
     * offline: key resolution, the request, and scope-scoped caching. No real
     * provider is contacted.
     */
    const fakeHits: string[] = [];
    const fakeServers: Server[] = [];
    const fakePort = await new Promise<number>((resolve) => {
      const server = createServer((req, res) => {
        const auth = String(req.headers["authorization"] ?? "");
        fakeHits.push(`${req.method} ${req.url} auth=${auth.split(" ").pop() === GOOD_KEY ? "<GOOD>" : "<WRONG>"}`);
        if (!auth.includes(GOOD_KEY)) {
          res.writeHead(401, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: "bad key" } }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "local-model-a" }, { id: "local-model-b" }] }));
      });
      fakeServers.push(server);
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        resolve(typeof addr === "object" && addr ? addr.port : 0);
      });
    });
    const fakeBase = `http://127.0.0.1:${fakePort}/v1`;

    const detectDom = await w.webContents.executeJavaScript(
      `(async () => {
         const base = ${JSON.stringify(fakeBase)};
         const good = ${JSON.stringify(GOOD_KEY)};
         const out = {};
         await window.aemeath.saveProvider("localtest", {
           label: "local-test", baseUrl: base, apiMode: "chat", modes: ["chat"], logo: "T",
         });
         await window.aemeath.setConfig({ provider: "localtest", baseUrl: base, apiMode: "chat" });

         document.getElementById("settings-overlay")?.classList.remove("hidden");
         document.querySelector('[data-tab="model"]').click();
         await new Promise((r) => setTimeout(r, 300));
         if (window.__reloadProviders) await window.__reloadProviders();
         await new Promise((r) => setTimeout(r, 300));

         // Select the local provider card so the FORM points at the fake
         // server. Without this the detect button uses whatever base URL the
         // previous probe left behind — which is a real host, and would send
         // a real request.
         [...document.querySelectorAll("#prov-nav-list .prov-item")]
           .find((b) => b.dataset.provider === "localtest")?.click();
         await new Promise((r) => setTimeout(r, 400));

         const input = document.getElementById("cfg-apiKey");
         const detect = document.getElementById("btn-detect-models");
         const formBase = document.getElementById("cfg-baseUrl").value.trim();
         // Refuse to continue unless the form really targets the fake server:
         // a mis-set URL here means an outbound request to a real provider.
         if (formBase !== base) {
           return { aborted: true, formBase, expected: base };
         }

         // 1) Detection BEFORE any key is saved (the case that always worked).
         out.beforeSave = (await window.aemeath.listModels({
           provider: "localtest", baseUrl: base, apiMode: "chat", apiKey: good,
         })).ok;

         // 2) Save the key through the UI, exactly as a user would.
         input.focus();
         input.value = good;
         document.getElementById("cfg-key-save").click();
         await new Promise((r) => setTimeout(r, 800));
         out.maskedAfterSave = input.readOnly === true && input.value.indexOf(good.slice(0, 4)) === 0;

         // 3) Detection AFTER saving, driven by the real button. The field now
         //    holds a mask; it must not be sent as the key.
         detect.click();
         await new Promise((r) => setTimeout(r, 1500));
         out.afterSaveHint = document.getElementById("model-hint").textContent;
         const st = await window.aemeath.status();
         out.detected = st.detectedModels[st.modelScope] || [];
         out.rows = document.querySelectorAll("#model-list .model-row").length;
         return out;
       })()`,
    );

    /*
     * Reported: after pressing 保存 the key still reads as unsaved.
     *
     * There are two 保存 buttons. The one at the bottom of the dialog
     * deliberately omitted the key, so a key that was typed but not pushed
     * through the key-specific button was silently discarded — and the
     * re-resolve of cfg.apiKey then showed "还没保存 Key" again.
     */
    const saveBtnDom = await w.webContents.executeJavaScript(
      `(async () => {
         const base = ${JSON.stringify(fakeBase)};
         const good = ${JSON.stringify(GOOD_KEY)};
         const out = {};
         document.getElementById("settings-overlay")?.classList.remove("hidden");
         document.querySelector('[data-tab="model"]').click();
         await new Promise((r) => setTimeout(r, 300));
         if (window.__reloadProviders) await window.__reloadProviders();
         await new Promise((r) => setTimeout(r, 300));
         [...document.querySelectorAll("#prov-nav-list .prov-item")]
           .find((b) => b.dataset.provider === "localtest")?.click();
         await new Promise((r) => setTimeout(r, 300));

         const input = document.getElementById("cfg-apiKey");
         // Make sure we start from "no key for this pair".
         await window.aemeath.clearApiKey({ provider: "localtest", baseUrl: base });
         if (window.__syncKeyState) await window.__syncKeyState();
         await new Promise((r) => setTimeout(r, 300));
         out.before = await window.aemeath.keyState("localtest", base);
         // The field must be editable now (no stored key), as a user would see.
         out.fieldEditable = input.readOnly === false && input.value === "";

         // Type a key, then press the dialog's own 保存 (not the key one).
         input.focus();
         input.value = good;
         document.getElementById("settings-save").click();
         await new Promise((r) => setTimeout(r, 1200));

         out.after = await window.aemeath.keyState("localtest", base);
         // What a detection run would then use.
         const r = await window.aemeath.listModels({ provider: "localtest", baseUrl: base, apiMode: "chat" });
         out.detectOk = r.ok;
         out.detectModels = (r.models || []).map((m) => m.id);
         return out;
       })()`,
    );

    /*
     * Adding a provider must ask for a name and nothing else, then hand over to
     * the detail pane — and it must stay possible to get back to another
     * provider's settings afterwards.
     */
    const escapeDom = await w.webContents.executeJavaScript(
      `(async () => {
         const base = ${JSON.stringify(fakeBase)};
         const out = {};
         const card = (id) => [...document.querySelectorAll("#prov-nav-list .prov-item")]
           .find((b) => b.dataset.provider === id);
         const names = () => [...document.querySelectorAll("#prov-nav-list .prov-item-label")].map((n) => n.textContent);

         document.getElementById("settings-overlay")?.classList.remove("hidden");
         document.querySelector('[data-tab="model"]').click();
         await new Promise((r) => setTimeout(r, 300));

         const before = names().length;
         card("deepseek")?.click();
         await new Promise((r) => setTimeout(r, 200));

         // Add -> 新建自定义供应商
         document.getElementById("btn-add-provider").click();
         await new Promise((r) => setTimeout(r, 200));
         [...document.querySelectorAll(".tpl-card")].find((c) => c.dataset.newCustom)?.click();
         await new Promise((r) => setTimeout(r, 300));

         // The creation step is a name prompt, not a full endpoint form.
         const dlg = document.getElementById("confirm-overlay");
         out.dialogShown = !dlg.classList.contains("hidden");
         /*
          * "Not hidden" is not the same as "reachable". Overlays all shared
          * z-index 50 and stacked by DOM order, and settings is the last one —
          * so a confirm opened from inside settings rendered *behind* it. The
          * definitive check is what the browser would actually hit.
          */
         const r = dlg.getBoundingClientRect();
         const hit = document.elementFromPoint(r.left + r.width / 2, r.top + 20);
         out.confirmOnTop = dlg.contains(hit);
         out.confirmHitTag = hit ? hit.tagName + "#" + hit.id : null;
         out.confirmZ = getComputedStyle(dlg).zIndex;
         out.settingsZ = getComputedStyle(document.getElementById("settings-overlay")).zIndex;
         out.asksForName = !document.getElementById("confirm-input-wrap").classList.contains("hidden");
         out.noEndpointForm = !document.getElementById("pf-id");
         out.asksOnlyName = document.querySelectorAll("#confirm-input-wrap input").length === 1;

         document.getElementById("confirm-input").value = "probe-gateway";
         document.getElementById("confirm-ok").click();
         await new Promise((r) => setTimeout(r, 800));

         out.created = names().length === before + 1;
         out.selectedIsNew = (document.getElementById("cfg-provider").value || "").indexOf("probe-gateway") === 0;
         out.detailVisible = getComputedStyle(document.getElementById("prov-detail-fields")).display !== "none";
         out.hasKeyField = !!document.getElementById("cfg-apiKey");

         // A draft with no endpoint must not be quietly saved as the active one.
         document.getElementById("settings-save").click();
         await new Promise((r) => setTimeout(r, 300));
         out.blocksEmptyUrl = /Base URL/.test(document.getElementById("save-hint").textContent);

         card("openai")?.click();
         await new Promise((r) => setTimeout(r, 400));
         out.afterSwitch = {
           selected: document.getElementById("cfg-provider").value,
           detailName: document.getElementById("prov-detail-name").textContent,
         };

         out.logoFromUrl = await window.aemeath.providerLogo(base, "x");
         out.logoFromDeepseek = await window.aemeath.providerLogo("https://api.deepseek.com", "x");
         return out;
       })()`,
    );

    /*
     * The two reported symptoms:
     *   a) saving a key must not bounce the provider list back to the active
     *      provider ("跳到自定义")
     *   b) a provider with no key must show an EMPTY, directly typable field
     *      (no 更换 button required)
     */
    const jumpDom = await w.webContents.executeJavaScript(
      `(async () => {
         document.getElementById("settings-overlay")?.classList.remove("hidden");
         document.querySelector('[data-tab="model"]').click();
         await new Promise((r) => setTimeout(r, 300));
         const out = {};
         const input = document.getElementById("cfg-apiKey");
         const sel = () => document.getElementById("cfg-provider").value;
         const card = (id) => [...document.querySelectorAll("#prov-nav-list .prov-item")]
           .find((b) => b.dataset.provider === id);

         // (b) pick a provider that has NO stored key.
         card("openai")?.click();
         await new Promise((r) => setTimeout(r, 400));
         out.selected = sel();
         out.emptyValue = input.value;
         // Ground truth from the store, plus the scope the UI is looking at.
         out.openaiState = await window.aemeath.keyState("openai", document.getElementById("cfg-baseUrl").value.trim());
         out.localtestState = await window.aemeath.keyState("localtest", ${JSON.stringify(fakeBase)});
         out.formBaseUrl = document.getElementById("cfg-baseUrl").value;
         out.editable = !input.readOnly;
         out.replaceHidden = getComputedStyle(document.getElementById("cfg-key-replace")).display === "none";
         out.saveVisible = getComputedStyle(document.getElementById("cfg-key-save")).display !== "none";
         out.placeholder = input.placeholder;

         // (a) type a key and save it; the selection must not move.
         input.focus();
         input.value = ${JSON.stringify(UI_KEY_2)};
         document.getElementById("cfg-key-save").click();
         await new Promise((r) => setTimeout(r, 700));
         out.afterSaveSelected = sel();
         out.afterSaveMasked = getComputedStyle(input).display !== "none" && input.readOnly;
         out.afterSaveValue = input.value;
         // Switching to another provider with no key must show an empty
         // field. (Not "deepseek": the key-field probe above gave it one.)
         card("moonshot")?.click();
         await new Promise((r) => setTimeout(r, 400));
         out.otherEmpty = input.value;
         out.otherEditable = !input.readOnly;
         return out;
       })()`,
    );

    /*
     * Turn the key-field probe into hard assertions.
     *
     * These behaviours are pure renderer state, so the unit-test suite cannot
     * see them. If one regresses, the self-test fails instead of quietly
     * looking fine in a screenshot.
     */
    const keyFailures: string[] = [];
    const expect = (ok: boolean, message: string) => {
      if (!ok) keyFailures.push(message);
    };
    const expectJump = (j: typeof jumpDom) => {
      expect(j.selected === "openai", "选中 openai 后选择应停在 openai");
      expect(j.emptyValue === "", "没存过 Key 的供应商应显示空");
    /*
     * Regression: switching from a provider that HAS a key to one that does not
     * left the previous key sitting in the field in plaintext, still attributed
     * to the newly selected provider. The "don't wipe what the user is typing"
     * guard could not tell a paste from a leftover.
     */
    expect(j.openaiState?.hasKey === false, "openai 本身确实没有 Key");
    expect(j.localtestState?.hasKey === true, "localtest 确实有 Key（构成对照）");
    expect(
      !j.emptyValue || j.emptyValue.includes("•"),
      `切换供应商后不应残留上一个供应商的明文 Key，实际 ${JSON.stringify(j.emptyValue)}`,
    );
      expect(j.editable === true, "没存过 Key 时应可直接输入，不需要点「更换」");
      expect(j.replaceHidden === true, "没存过 Key 时不应出现「更换」");
      expect(j.saveVisible === true, "没存过 Key 时应显示「保存」");
      expect(j.afterSaveSelected === "openai", "保存 Key 后不应跳到别的供应商");
      expect(j.afterSaveMasked === true, "保存 Key 后应变为只读掩码");
      expect(j.otherEmpty === "", "切到另一个没 Key 的供应商应显示空");
      expect(j.otherEditable === true, "另一个没 Key 的供应商也应能直接输入");
    };
    expectJump(jumpDom);
    expect(hooksReady === true, "测试钩子应在 selftest 模式下装好");
    expect(endRunDom.permHidden === true, "任务结束后权限弹窗应收起");
    expect(endRunDom.toolCardsCleared === true, "任务结束后工具卡片表应清空");
    expect(endRunDom.ctxMeterPresent === true, "上下文仪表应存在");
    expect(detectDom.aborted !== true, `检测探针应指向本地假服务器，实际 ${(detectDom as any).formBase}`);
    expect(saveBtnDom.before.hasKey === false, "本地测试端点起始应无 Key");
    expect(saveBtnDom.fieldEditable === true, "无 Key 时输入框应可编辑且为空");
    expect(saveBtnDom.after.hasKey === true, "点底部「保存」也应把输入的 Key 存下来");
    expect(saveBtnDom.detectOk === true, "点底部「保存」后应能检测到模型");
    /*
     * The balance probe fans out to seven generic endpoints. Before caching,
     * every save in this run re-probed all of them — seven requests per save,
     * each carrying the API key.
     */
    const balanceHits = fakeHits.filter((h) => !h.includes("/models")).length;
    expect(balanceHits <= 7, `余额探测应被缓存住（整轮 ≤7 次），实际 ${balanceHits} 次`);

    expect(detectDom.beforeSave === true, "未保存 Key 时应能检测到模型");
    expect(detectDom.maskedAfterSave === true, "保存后 Key 应显示为掩码");
    expect(detectDom.afterSaveHint.includes("2"), `保存 Key 后应仍能检测到模型，实际提示：${detectDom.afterSaveHint}`);
    expect(
      (detectDom.detected || []).includes("local-model-a"),
      `检测结果应按当前 Key 的作用域缓存，实际 ${JSON.stringify(detectDom.detected)}`,
    );
    expect(escapeDom.dialogShown === true, "新建自定义供应商应弹出对话框");
    expect(
      escapeDom.confirmOnTop === true,
      `对话框必须能点得到，实际命中的是 ${escapeDom.confirmHitTag}（z: 对话框 ${escapeDom.confirmZ} / 设置 ${escapeDom.settingsZ}）`,
    );
    expect(escapeDom.asksForName === true, "对话框应只问名称");
    expect(escapeDom.asksOnlyName === true, "创建步骤不应有第二个输入框");
    expect(escapeDom.noEndpointForm === true, "创建步骤不应要求填 Base URL");
    expect(escapeDom.created === true, "创建后列表应多出这个供应商");
    expect(escapeDom.selectedIsNew === true, "创建后应选中它");
    expect(escapeDom.detailVisible === true, "创建后应直接落到详情页");
    expect(escapeDom.hasKeyField === true, "详情页应有 API Key 输入框");
    expect(escapeDom.blocksEmptyUrl === true, "草稿没填 Base URL 时保存应被拦下并说明");
    expect(escapeDom.afterSwitch.selected === "openai", "之后仍能切回别的供应商");
    expect(escapeDom.afterSwitch.detailName.includes("OpenAI"), "详情应显示新选中的供应商");
    expect(escapeDom.logoFromDeepseek === "\u{1F40B}", "已知域名应复用该厂商图标");
    expect(typeof escapeDom.logoFromUrl === "string" && escapeDom.logoFromUrl.length > 0, "自定义地址应能推导出图标");
    expect(/^sk-t•{8}wxyz$/.test(keyDom.after.value), `保存后应显示脱敏预览，实际 ${keyDom.after.value}`);
    expect(keyDom.preview === keyDom.after.value, "掩码应与保存后的输入框一致");
    expect(keyDom.after.readOnly === true, "脱敏状态应为只读");
    expect(keyDom.focused.value === keyDom.preview, "点击输入框不应清空脱敏预览");
    expect(keyDom.afterClick === keyDom.preview, "失焦后应仍是脱敏预览");
    expect(keyDom.replaceBtnVisible === true, "已保存 Key 时应显示「更换」");
    expect(keyDom.saveBtnHidden === true, "已保存 Key 时应隐藏「保存」");
    expect(keyDom.afterReplaceClick.value === "", "点「更换」应清空输入框");
    expect(keyDom.afterReplaceClick.readOnly === false, "点「更换」后应可编辑");
    expect(keyDom.afterEscape === keyDom.preview, "Esc 应还原脱敏预览");

    // Exercise the provider list + template picker end-to-end.
    const providerDom = await w.webContents.executeJavaScript(
      `(async () => {
         document.getElementById("settings-overlay")?.classList.remove("hidden");
         document.querySelector('[data-tab="model"]')?.click();
         await new Promise((r) => setTimeout(r, 300));
         const navItems = [...document.querySelectorAll("#prov-nav-list .prov-item")];
         const names = navItems.map((b) => b.querySelector(".prov-item-label")?.textContent);
         const groups = [...document.querySelectorAll("#prov-nav-list .prov-group-title")].map((g) => g.textContent);
         const hasDetail = !!document.getElementById("prov-detail-name")?.textContent;
         document.getElementById("btn-add-provider")?.click();
         await new Promise((r) => setTimeout(r, 200));
         const pickerOpen = !document.getElementById("tpl-overlay")?.classList.contains("hidden");
         const tplCards = [...document.querySelectorAll(".tpl-card")].map((c) => c.querySelector(".tpl-card-label")?.textContent);
         document.getElementById("tpl-cancel")?.click();
         document.getElementById("settings-overlay")?.classList.add("hidden");
         return { navItems: navItems.length, names, groups, hasDetail, pickerOpen, tplCards: tplCards.length, tplSample: tplCards.slice(0, 3) };
       })()`,
    );

    // Exercise the diagnostics panel end-to-end: open settings, click the
    // tab, and count the rows the renderer produced.
    const diagDom = await w.webContents.executeJavaScript(
      `(async () => {
         document.getElementById("settings-overlay")?.classList.remove("hidden");
         const tab = document.querySelector('[data-tab="diag"]');
         tab?.click();
         await new Promise((r) => setTimeout(r, 400));
         const rows = document.querySelectorAll("#health-list .health-row").length;
         const panelVisible = !document.querySelector('[data-panel="diag"]')?.classList.contains("hidden");
         document.getElementById("settings-overlay")?.classList.add("hidden");
         return { rows, panelVisible };
       })()`,
    );
    let reply = null;
    if (doRoundTrip && probe.status?.hasKey) {
      await w.webContents.executeJavaScript(
        `window.aemeath.onEvent((e) => { window.__last = e; }); true;`,
      );
      await w.webContents.executeJavaScript(`window.aemeath.send("请只回复四个字：桌面端已连通")`);
      // Wait for run_finished
      reply = await w.webContents.executeJavaScript(
        `new Promise((res) => { const t0 = Date.now(); const iv = setInterval(() => { if (window.__last && window.__last.type === "run_finished") { clearInterval(iv); res("finished"); } else if (Date.now() - t0 > 120000) { clearInterval(iv); res("timeout"); } }, 300); })`,
      );
    }
    clearTimeout(timeout);
    for (const srv of fakeServers) srv.close();
    if (process.argv.includes("--screenshot")) {
      try {
        // Leave the settings dialog on the provider tab so the screenshot
        // shows the UI under review rather than the chat view.
        await w.webContents.executeJavaScript(
          `(() => {
             document.getElementById("settings-overlay").classList.remove("hidden");
             document.querySelector('[data-tab="model"]').click();
             return true;
           })()`,
        );
        await new Promise((r) => setTimeout(r, 250));
        // AEMEATH_SHOT_FLOW=add opens the "name your provider" dialog, so the
        // exchange that is hardest to reason about can be eyeballed.
        if (process.env.AEMEATH_SHOT_FLOW === "add") {
          await w.webContents.executeJavaScript(
            `(() => {
               document.getElementById("btn-add-provider").click();
               [...document.querySelectorAll(".tpl-card")].find((c) => c.dataset.newCustom)?.click();
               return true;
             })()`,
          );
          await new Promise((r) => setTimeout(r, 500));
        }
        const img = await w.webContents.capturePage();
        const out = process.env.AEMEATH_SHOT || join(process.cwd(), "shot.png");
        writeFileSync(out, img.toPNG());
        process.stdout.write("SHOT:" + out + "\n");
      } catch (e) {
        process.stdout.write("SHOT:FAIL " + String(e) + "\n");
      }
    }
    process.stdout.write(
      "SELFTEST:" +
        JSON.stringify({
          ok: !!probe.hasApi && keyFailures.length === 0 && hooksReady === true,
          keyFailures,
          endRunDom,
          guardDom,
          keyDom,
          jumpDom,
          escapeDom,
          detectDom,
          saveBtnDom,
          fakeHits,
        balanceHits,
          providerDom,
          diagDom,
          health: probe.health
            ? {
                ok: probe.health.ok,
                failed: probe.health.failed,
                checks: probe.health.checks.map((c: any) => `${c.ok ? "ok" : "NO"}:${c.name}`),
              }
            : null,
          model: probe.status?.model,
          tools: probe.status?.tools?.length ?? 0,
          sessionId: probe.status?.sessionId,
          roundTrip: reply,
          bootMs: Date.now() - opts.startedAt,
        }) +
        "\n",
    );
    opts.closeMcp();
    opts.exit(0);
  } catch (err) {
    clearTimeout(timeout);
    process.stdout.write("SELFTEST:FAIL " + (err instanceof Error ? err.message : String(err)) + "\n");
    opts.exit(1);
  }
});
}
