/** Actual React/DOM and review components; IPC is a local fixture, with no provider calls. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const desktop = join(root, "apps/desktop");
const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");
const { chromium, expect } = createRequire(join(root, "packages/courseware-runtime/package.json"))("@playwright/test");
const output = process.env.DECKWISE_E2E_OUTPUT && resolve(process.env.DECKWISE_E2E_OUTPUT);
if (output) await mkdir(output, { recursive: false });
const temporary = await mkdtemp(join(tmpdir(), "chat-pptx-review-"));
const report = { status: "RUNNING", checks: [], actualReact: true, actualReviewComponent: true, ipcFixture: true, paidCalls: false };
const stubs = new Map([
  ["../../stores/app-store", `import React from 'react';
    let state={activeSessionId:'chat',runningSessions:{},messages:[]};const listeners=new Set();
    export function useAppStore(select){return select(React.useSyncExternalStore(fn=>{listeners.add(fn);return()=>listeners.delete(fn)},()=>state))}
    useAppStore.getState=()=>state;
    useAppStore.setState=patch=>{state={...state,...patch};for(const listener of listeners)listener()};`],
  ["../../lib/api", `
    const f=window.fixture={calls:[],draft:false,loss:false,hold:false,status:'needs-review',effects:false};
    export const api={
      pptEditorTeachingOpen:async()=>({viewId:'teaching'}),
      pptEditorTeachingDraftGet:async()=>({draft:f.draft?{}:null}),
      pptEditorStyleClear:async()=>({ok:true}),
      pptEditorPptxCandidateReview:async(sessionId,candidateId)=>{
        f.calls.push(['review',sessionId,candidateId]);if(f.hold)await new Promise(resolve=>{f.release=resolve});
        if(f.status!=='needs-review')throw Error('Invalid or outdated PPTX candidate');
        return {reviewId:'review',candidateId,kind:f.kind,outputSha256:'b'.repeat(64),targetPages:[{pageId:'page',pageNumber:1},...(f.kind==='page-style-batch'?[{pageId:'peer',pageNumber:2}]:[])],lineageVerified:true,stale:false,
          ...(f.effects?{effectTargets:[{pageId:'page',pageIndex:0,objectId:'shape',kind:'shape',index:1}],
            effectPages:[{objects:[{index:1,kind:'text'},{index:2,kind:'shape'}]}],
            effectCues:[{pageNumber:1,effect:'highlight',atMs:0,endMs:900}]}:{})};
      },
      pptEditorPptxCandidatePreview:async id=>{f.calls.push(['preview',id]);return{ok:true}},
      pptEditorPptxCandidateReject:async id=>{f.calls.push(['reject',id]);f.status='rejected';return{ok:true}},
      pptEditorPptxCandidateAdopt:async(id,bindings)=>{f.calls.push(['adopt',id,bindings]);f.status='adopted';if(f.loss)throw Error('Lost adoption response');return{ok:true}},
    };`],
]);
let browser;
try {
  await build({ stdin: { contents: `
    import React from 'react';import{createRoot}from'react-dom/client';
    import i18next from 'i18next';import{I18nextProvider}from'react-i18next';
    import{zhCN}from'../../packages/i18n/src/locales/zh-CN/index';
    import{CoursewareChatPptxCandidates}from'./src/components/courseware/CoursewareChatPptxCandidates';
    import{useAppStore}from'../../stores/app-store';
    i18next.init({lng:'zh-CN',resources:{'zh-CN':{translation:zhCN}},interpolation:{escapeValue:false}});
    let generation=0;const root=createRoot(document.getElementById('root'));
    function App(){const session=useAppStore(s=>s.activeSessionId),running=useAppStore(s=>s.runningSessions);
      return <I18nextProvider i18n={i18next}><section className='courseware-chat-workflow'><CoursewareChatPptxCandidates
        key={session+generation} sessionId={session} disabled={!!running[session]}/></section></I18nextProvider>}
    window.reset=(kind='page-fade',effects=false)=>{generation++;Object.assign(window.fixture,{calls:[],draft:false,loss:false,hold:false,status:'needs-review',effects,kind});
      const toolName={'page-fade':'ppt_propose_page_fade','page-pptx':'ppt_propose_page_redo','page-style-batch':'ppt_propose_page_style_batch'}[kind];
      useAppStore.setState({activeSessionId:'chat',runningSessions:{},messages:[{role:'tool',toolName,toolStatus:'success',
        toolResult:{details:{kind,candidateId:'candidate',reviewState:'needs-review',applied:false,saved:false,outputSha256:'a'.repeat(64),baseline:{sessionId:'native-mount'}}}}]});root.render(<App/>)};
    window.setChatState=useAppStore.setState;window.reset();`,
    resolveDir: desktop, sourcefile: "chat-pptx-review-entry.tsx", loader: "tsx" },
    bundle: true, format: "iife", platform: "browser", jsx: "automatic", outfile: join(temporary, "bundle.js"),
    plugins: [{ name: "ipc-store-fixtures", setup(build) {
      build.onResolve({ filter: /.*/ }, args => stubs.has(args.path) ? { path: args.path, namespace: "fixture" } : undefined);
      build.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({ contents: stubs.get(args.path), resolveDir: desktop, loader: "tsx" }));
    } }], define: { "process.env.NODE_ENV": '"development"' } });
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE_PATH, args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1080, height: 760 } });
  const errors = [];
  page.on("pageerror", error => errors.push(String(error)));
  await page.setContent('<main id="root"></main>');
  await page.addStyleTag({ content: await readFile(join(desktop, "src/styles/courseware-chat-workflow.css"), "utf8") });
  await page.addScriptTag({ content: await readFile(join(temporary, "bundle.js"), "utf8") });
  const step = async (name, run) => { await run(); report.checks.push(name); console.log("PASS", name); };
  const entrance = () => page.getByRole("button", { name: /审阅候选稿/ });
  const review = () => page.locator(".courseware-source-review");
  const adopt = () => page.getByRole("button", { name: "采纳并重新打开", exact: true });
  const reset = async (kind = "page-fade", effects = false) => {
    await page.evaluate(({ kind, effects }) => window.reset(kind, effects), { kind, effects }); await expect(entrance()).toBeEnabled();
  };
  await step("All three candidate kinds open the real review in Chat without an ID form", async () => {
    for (const kind of ["page-fade", "page-pptx", "page-style-batch"]) {
      await reset(kind); await entrance().click(); await expect(review()).toBeVisible();
      assert.equal(await page.locator('input:not([type="checkbox"])').count(), 0);
      await expect(adopt()).toBeDisabled();
      await page.getByRole("button", { name: "打开只读预览", exact: true }).click();
      await expect(page.getByRole("button", { name: "打开只读预览", exact: true })).toBeEnabled();
      assert.deepEqual(await page.evaluate(() => window.fixture.calls.at(-1)), ["preview", "review"]);
      await page.getByRole("button", { name: "拒绝候选", exact: true }).click();
      await expect(review()).toHaveCount(0); assert.equal(await entrance().count(), 0);
    }
  });
  await step("Adoption requires an unchecked confirmation and forwards explicit attention-object bindings", async () => {
    await reset("page-style-batch", true); await entrance().click(); await expect(review()).toBeVisible();
    await expect(adopt()).toBeDisabled();
    await review().locator("select").selectOption("2");
    await review().getByRole("checkbox").nth(1).check(); await expect(adopt()).toBeDisabled();
    await review().getByRole("checkbox").nth(0).check(); await expect(adopt()).toBeEnabled();
    if (output) await page.screenshot({ path: join(output, "chat-pptx-review.png") });
    await adopt().click(); await expect(review()).toHaveCount(0);
    assert.deepEqual(await page.evaluate(() => window.fixture.calls.at(-1)), ["adopt", "review", [{ pageIndex: 0, objectId: "shape", targetIndex: 2 }]]);
    assert.equal(await entrance().count(), 0);
  });
  await step("A current-page narration draft blocks both opening and adoption", async () => {
    await reset(); await page.evaluate(() => { window.fixture.draft = true; }); await entrance().click();
    await expect(page.getByRole("alert")).toContainText("草稿"); assert.equal(await review().count(), 0);
    assert.equal((await page.evaluate(() => window.fixture.calls)).length, 0);
    await page.evaluate(() => { window.fixture.draft = false; }); await entrance().click(); await expect(review()).toBeVisible();
    await review().getByRole("checkbox").check(); await page.evaluate(() => { window.fixture.draft = true; }); await adopt().click();
    await expect(page.getByRole("alert")).toContainText("草稿");
    assert(!(await page.evaluate(() => window.fixture.calls)).some(call => call[0] === "adopt"));
  });
  await step("Lost adoption responses reread persisted status without a duplicate write", async () => {
    await reset(); await entrance().click(); await expect(review()).toBeVisible();
    await review().getByRole("checkbox").check(); await page.evaluate(() => { window.fixture.loss = true; }); await adopt().click();
    await expect(page.getByRole("alert")).toContainText("Lost adoption response"); await expect(review()).toHaveCount(0);
    await entrance().click(); await expect(page.getByRole("alert")).toContainText("outdated");
    assert.equal((await page.evaluate(() => window.fixture.calls)).filter(call => call[0] === "adopt").length, 1);
  });
  await step("Running Chat turns disable review; navigation discards late reads", async () => {
    await reset(); await page.evaluate(() => window.setChatState({ runningSessions: { chat: true } })); await expect(entrance()).toBeDisabled();
    await page.evaluate(() => { window.setChatState({ runningSessions: {} }); window.fixture.hold = true; });
    await entrance().click(); await page.waitForFunction(() => typeof window.fixture.release === "function");
    await page.evaluate(() => { window.setChatState({ activeSessionId: "other", messages: [] }); });
    await expect(entrance()).toHaveCount(0); await page.evaluate(() => window.fixture.release());
    await expect(review()).toHaveCount(0);
  });
  assert.deepEqual(errors, []); report.status = "PASS";
} catch (error) { report.status = "FAIL"; report.error = String(error); throw error; }
finally {
  if (output) await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  await browser?.close(); await rm(temporary, { recursive: true, force: true });
}
