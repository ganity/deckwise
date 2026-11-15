import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { IPC } from "../packages/shared/dist/index.js";

assert(process.env.DECKWISE_E2E_OUTPUT);
const output = resolve(process.env.DECKWISE_E2E_OUTPUT); await mkdir(output);
const desktop = createRequire(new URL("../apps/desktop/package.json", import.meta.url));
const { createServer } = desktop("vite");
const { chromium, expect } = createRequire(new URL("../packages/courseware-runtime/package.json", import.meta.url))("@playwright/test");
const picture = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";
const review = { reviewId: "style-one", candidateId: "candidate-one", pageId: "one", pageNumber: 1, outputSha256: "a".repeat(64),
  instruction: "Use a blue style without changing target facts", pages: [
    { pageId: "one", pageNumber: 1, locked: false }, { pageId: "two", pageNumber: 2, locked: true }, { pageId: "three", pageNumber: 3, locked: false },
  ], preview: { width: 1600, height: 1000, preview: picture } };
const checks = [], errors = []; let server, browser;
try {
  server = await createServer({ root: new URL("../apps/desktop", import.meta.url).pathname, configFile: false, esbuild: { jsx: "automatic" },
    server: { host: "127.0.0.1", port: 0 }, plugins: [{ name: "style-review-test", resolveId(id) { if (id === "/__style.jsx") return id; },
      load(id) { if (id === "/__style.jsx") return `
        import {createElement} from 'react'; import {createRoot} from 'react-dom/client';
        import i18n from 'i18next'; import {I18nextProvider} from 'react-i18next'; import {catalogs} from '@pi-desktop/i18n';
        import {CoursewarePptxCandidateReview} from '/src/components/workpanel/CoursewarePptxCandidateReview.tsx';
        import '/src/styles/work-panel.css';
        await i18n.init({lng:'en',resources:{en:{translation:catalogs.en},'zh-CN':{translation:catalogs['zh-CN']}}});
        const root=createRoot(document.getElementById('root'));
        window.render=async(sessionId='chat-one',disabled=false,language='en')=>{
          await i18n.changeLanguage(language);root.render(createElement(I18nextProvider,{i18n},createElement(CoursewarePptxCandidateReview,{
            sessionId,disabled,review:{reviewId:'candidate-review',candidateId:'candidate-one',kind:'page-pptx',lineageVerified:true,stale:false,targetPageIds:['one'],targetPages:[{pageId:'one',pageNumber:1}]},
            preview(){},adopt(){},reject(){},close(){}
          })));
        }; window.unmount=()=>root.render(null);
      `; }, configureServer(instance) { instance.middlewares.use((req, res, next) => {
        if (req.url !== "/__style") return next();
        res.setHeader("content-type", "text/html");
        res.end('<style>body{font:14px sans-serif;background:#fafafa;color:#222}#root{width:320px;margin:20px;--ds-border-subtle:#ddd;--ds-text-primary:#222;--ds-bg-primary:#fff;--ds-bg-secondary:#eee}</style><div id="root" class="courseware-teaching"></div><script type="module" src="/__style.jsx"></script>');
      }); } }] });
  await server.listen(); browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1100, height: 1000 } }); page.on("pageerror", error => errors.push(String(error)));
  await page.addInitScript(({ channels, review }) => {
    window.calls = []; window.defer = ""; window.rejectApproval = false;
    window.piDesktop = { async invoke(channel, payload) {
      window.calls.push({ channel, payload });
      if (channel === channels.pptEditorStyleClear) return { ok: true, data: { ok: true } };
      if (channel === window.defer) await new Promise(resolve => { window.release = resolve; });
      if (channel === channels.pptEditorStylePrepare) return { ok: true, data: review };
      if (channel === channels.pptEditorStyleApprove) return window.rejectApproval ?
        { ok: false, error: { code: "CONFLICT", message: "Representative changed" } } : { ok: true, data: { confirmed: true, pageIds: ["one", "three"] } };
      throw new Error("Unexpected IPC " + channel);
    } };
  }, { channels: IPC.invoke, review });
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__style`); await page.waitForFunction(() => !!window.render);
  await page.evaluate(() => window.render());
  const section = () => page.getByRole("region", { name: /Use this page as a style reference|将此页用作风格参考/ });
  const prepare = () => section().getByRole("button", { name: /Review style and page range|审核风格与应用范围/ });
  const approve = () => section().getByRole("button", { name: /Confirm style and pages|确认风格与页面/ });
  const clear = () => section().getByRole("button", { name: /Clear style confirmation|清除风格确认/ });
  const confirm = () => section().getByRole("checkbox", { name: /I reviewed this representative|我已检查代表页/ });
  const choices = () => section().getByRole("group").getByRole("checkbox");
  await prepare().click(); await expect(section().getByRole("img")).toBeVisible();
  await expect(choices().nth(0)).toBeChecked(); await expect(choices().nth(0)).toBeDisabled(); await expect(choices().nth(1)).toBeDisabled();
  await expect(confirm()).toBeDisabled(); await expect(approve()).toBeDisabled();
  assert.equal(await page.evaluate(ch => window.calls.filter(c => c.channel === ch).length, IPC.invoke.pptEditorStyleApprove), 0);
  checks.push("render alone grants no scope; representative included and locked peers disabled");
  await choices().nth(2).check(); await confirm().check();
  await page.evaluate(ch => { window.defer = ch; }, IPC.invoke.pptEditorStyleApprove);
  await approve().click(); await page.waitForFunction(() => !!window.release);
  await expect(page.getByRole("button", { name: "Open read-only preview" })).toBeDisabled();
  await page.evaluate(() => window.release()); await expect(section().getByRole("status")).toContainText("Confirmed pages: 1, 3");
  const approvals = await page.evaluate(ch => window.calls.filter(c => c.channel === ch), IPC.invoke.pptEditorStyleApprove);
  assert.deepEqual(approvals[0].payload, { reviewId: "style-one", pageIds: ["one", "three"] });
  await page.screenshot({ path: `${output}/style-en.png` });
  checks.push("parent busy handling preserves pending approval; explicit exact page IDs reach IPC");
  const count = await page.evaluate(ch => window.calls.filter(c => c.channel === ch).length, IPC.invoke.pptEditorStyleClear);
  await page.evaluate(() => window.unmount()); await expect(page.getByRole("img")).toHaveCount(0);
  assert.equal(await page.evaluate(ch => window.calls.filter(c => c.channel === ch).length, IPC.invoke.pptEditorStyleClear), count);
  checks.push("closing reviewed candidate retains confirmed Main scope for the owning Chat");
  await page.evaluate(() => { window.defer = ""; return window.render("chat-two", false, "zh-CN"); });
  await prepare().click(); await choices().nth(2).check(); await confirm().check(); await approve().click();
  await expect(section().getByRole("status")).toContainText("已确认页面：1, 3"); await page.screenshot({ path: `${output}/style-zh.png` });
  checks.push("new Chat starts fresh; Chinese review and scope confirmation are functional");
  await clear().click(); await page.evaluate(ch => { window.defer = ch; }, IPC.invoke.pptEditorStylePrepare);
  await prepare().click(); await page.waitForFunction(() => !!window.release); await clear().click(); await page.evaluate(() => window.release());
  await expect(section().getByRole("img")).toHaveCount(0);
  checks.push("cleared late preview cannot restore a cancelled review");
  await page.evaluate(() => { window.defer = ""; window.rejectApproval = true; });
  await prepare().click(); await choices().nth(2).check(); await confirm().check(); await approve().click();
  await expect(section().getByRole("alert")).toContainText("Representative changed"); await expect(section().getByRole("status")).toHaveCount(0);
  checks.push("stale approval failure cannot show confirmed scope");
  assert.deepEqual(errors, []);
  await writeFile(`${output}/report.json`, JSON.stringify({ status: "PASS", checks, realReact: true, preloadIpcStandIn: true,
    realMain: false, paidCalls: false, errors }, null, 2));
  console.log(`PASS ${checks.length} actual React style-review groups`);
} finally { await browser?.close(); await server?.close(); }
