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
      pptEditorVisualClear:async()=>{f.calls.push(['visual-clear']);return{ok:true}},
      pptEditorVisualPrepare:async session=>{f.calls.push(['visual-prepare',session]);if(f.visualHold)await new Promise(resolve=>{f.releaseVisual=resolve});return{reviewId:'visual',pageNumber:1,
        original:{preview:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aR1cAAAAASUVORK5CYII='},
        nativeTextless:{preview:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aR1cAAAAASUVORK5CYII='}}},
      pptEditorVisualApprove:async id=>{f.calls.push(['visual-approve',id]);if(f.rejectVisual)throw Error('Saved page changed');return{approved:true}},
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
    import{en}from'../../packages/i18n/src/locales/en/index';
    import{CoursewareChatPptxCandidates}from'./src/components/courseware/CoursewareChatPptxCandidates';
    import{CoursewareSourceVisuals}from'./src/components/workpanel/CoursewareSourceVisuals';
    import{useAppStore}from'../../stores/app-store';
    i18next.init({lng:'zh-CN',resources:{'zh-CN':{translation:zhCN},en:{translation:en}},interpolation:{escapeValue:false}});
    let generation=0,showVisuals=false;const root=createRoot(document.getElementById('root'));
    function App(){const session=useAppStore(s=>s.activeSessionId),running=useAppStore(s=>s.runningSessions);
      return <I18nextProvider i18n={i18next}><section className='courseware-chat-workflow'>{showVisuals?<CoursewareSourceVisuals
        key={session+generation} sessionId={session} enabled disabled={!!running[session]} onActiveChange={()=>{}}/>:<CoursewareChatPptxCandidates
        key={session+generation} sessionId={session} disabled={!!running[session]}/>}</section></I18nextProvider>}
    window.reset=(kind='page-fade',effects=false)=>{showVisuals=false;generation++;Object.assign(window.fixture,{calls:[],draft:false,loss:false,hold:false,status:'needs-review',effects,kind});
      const toolName={'page-fade':'ppt_propose_page_fade','page-pptx':'ppt_propose_page_redo','page-style-batch':'ppt_propose_page_style_batch'}[kind];
      useAppStore.setState({activeSessionId:'chat',runningSessions:{},messages:[{role:'tool',toolName,toolStatus:'success',
        toolResult:{details:{kind,candidateId:'candidate',reviewState:'needs-review',applied:false,saved:false,outputSha256:'a'.repeat(64),baseline:{sessionId:'native-mount'}}}}]});root.render(<App/>)};
    window.resetVisuals=()=>{generation++;showVisuals=true;Object.assign(window.fixture,{calls:[],draft:false,visualHold:false,rejectVisual:false,releaseVisual:null});
      useAppStore.setState({activeSessionId:'chat',runningSessions:{},messages:[]});root.render(<App/>)};
    window.language=lng=>i18next.changeLanguage(lng);window.setChatState=useAppStore.setState;window.reset();`,
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
  await step("Chat page visuals require explicit approval and survive an Agent turn without regeneration", async () => {
    await page.evaluate(() => window.resetVisuals());
    const visuals = page.locator('.courseware-source-visuals');
    await visuals.getByRole('button', { name: '准备当前页底图', exact: true }).click();
    await expect(visuals.locator('img')).toHaveCount(2);
    const approval = visuals.getByRole('button', { name: '确认使用此背景', exact: true });
    await expect(approval).toBeDisabled(); await expect(visuals.getByRole('checkbox')).not.toBeChecked();
    await visuals.getByRole('checkbox').check(); await approval.click();
    await expect(visuals.getByRole('status')).toContainText('已审核');
    const calls = await page.evaluate(() => window.fixture.calls);
    assert.deepEqual(calls, [['visual-clear'], ['visual-clear'], ['visual-prepare', 'chat'], ['visual-approve', 'visual']]);
    await page.evaluate(() => window.setChatState({runningSessions:{chat:true}}));
    await expect(visuals.getByRole('button', { name: '准备当前页底图', exact: true })).toBeDisabled();
    await expect(visuals.getByRole('button', { name: '放弃本次底图', exact: true })).toBeDisabled();
    await page.evaluate(() => window.setChatState({runningSessions:{}}));
    await expect(visuals.getByRole('status')).toContainText('已审核');
    assert.deepEqual(await page.evaluate(() => window.fixture.calls), calls);
    if (output) await page.screenshot({path:join(output,'chat-source-visuals.png')});
  });
  await step("Stored narration drafts block Chat visual preparation and navigation revokes the review", async () => {
    await page.evaluate(() => {window.resetVisuals();window.fixture.draft=true});
    const visuals = page.locator('.courseware-source-visuals');
    await visuals.getByRole('button', {name:'准备当前页底图',exact:true}).click();
    await expect(visuals.getByRole('alert')).toContainText('草稿');
    assert(!(await page.evaluate(() => window.fixture.calls)).some(call => call[0] === 'visual-prepare'));
    await page.evaluate(() => window.setChatState({activeSessionId:'other'}));
    await expect(visuals.getByRole('alert')).toHaveCount(0);
    await expect(visuals.locator('img')).toHaveCount(0);
  });
  await step("Visual consent and approval work in English as well as Chinese", async () => {
    await page.evaluate(async () => { await window.language('en'); window.resetVisuals(); });
    const visuals = page.locator('.courseware-source-visuals');
    await visuals.getByRole('button', {name:'Prepare current page visuals',exact:true}).click();
    await expect(visuals.getByAltText('Original saved page')).toBeVisible();
    const approval = visuals.getByRole('button', {name:'Approve this background',exact:true});
    await expect(approval).toBeDisabled(); await visuals.getByRole('checkbox').check(); await approval.click();
    await expect(visuals.getByRole('status')).toContainText('Background reviewed');
    await page.evaluate(() => window.language('zh-CN'));
    await expect(visuals.getByRole('status')).toContainText('已审核');
  });
  await step("Late visual replies and stale approvals cannot leave a usable preview", async () => {
    await page.evaluate(() => { window.resetVisuals(); window.fixture.visualHold=true; });
    const visuals = page.locator('.courseware-source-visuals');
    await visuals.getByRole('button', {name:'准备当前页底图',exact:true}).click();
    await page.waitForFunction(() => typeof window.fixture.releaseVisual === 'function');
    await page.evaluate(() => window.setChatState({activeSessionId:'other'}));
    await page.evaluate(() => window.fixture.releaseVisual());
    await expect(visuals.locator('img')).toHaveCount(0);
    await page.evaluate(() => { window.resetVisuals(); window.fixture.rejectVisual=true; });
    await visuals.getByRole('button', {name:'准备当前页底图',exact:true}).click();
    await visuals.getByRole('checkbox').check();
    await visuals.getByRole('button', {name:'确认使用此背景',exact:true}).click();
    await expect(visuals.getByRole('alert')).toContainText('Saved page changed');
    await expect(visuals.locator('img')).toHaveCount(0);
  });
  assert.deepEqual(errors, []); report.status = "PASS";
} catch (error) { report.status = "FAIL"; report.error = String(error); throw error; }
finally {
  if (output) await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  await browser?.close(); await rm(temporary, { recursive: true, force: true });
}
