/** Real renderer components with isolated Host/media/native-editor IPC fixtures; no provider calls. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(new URL("../packages/courseware-runtime/package.json", import.meta.url));
const { build } = require("esbuild"), { chromium, expect } = require("@playwright/test");
const output = process.env.DECKWISE_E2E_OUTPUT ? resolve(process.env.DECKWISE_E2E_OUTPUT) : await mkdtemp(join(tmpdir(), "courseware-workspace-"));
await mkdir(output, { recursive: true });
const fixture = `
import { create } from "zustand";
export const calls = [];
let stage = 0;
const plan = { title: "Unit 1 · Greetings：认识小动物朋友，学说问候语", visualBible: {artDirection:"温暖明亮的儿童绘本风格，柔和的色彩与清晰的画面层次。",characters:"Pandy 是戴绿色围巾的小熊猫，与小动物朋友一起探索课堂。",setting:"阳光透过窗户洒进幼儿园教室，木地板上摆着彩色坐垫。"}, sha256: "a".repeat(64), approvedSha256: null,
  pages: Array.from({length: 6}, (_, i) => ({pageId: "page-"+i, title: ["Hello, Pandy!", "Good morning", "Say hello", "Meet my friends", "Let's play", "Goodbye!"][i], visibleText: ["Hello!"], visualIntent: "温暖的教室里，小熊猫 Pandy 站在窗边向大家挥手。画面中央保留清晰的英文问候语，周围的小动物朋友自然地围坐在彩色坐垫上。", narration: "小朋友们，早上好！这是我们的新朋友 Pandy。让我们一起挥挥手，大声说：Hello, Pandy! 现在请和身旁的小伙伴互相问好。"})) };
const row = (i, kind) => ({intentId: i+kind, planSha256: plan.sha256, pageId: "page-"+i, current: true,
  selected: stage >= 2, target: kind === "layer" ? {kind, name: "Pandy"} : {kind}, phase: "submitted",
  asset: {sha256: kind+"b".repeat(50), byteLength: 100, width: 640, height: 400}, task: null });
const rows = () => Array.from({length: stage < 2 ? 1 : stage === 2 ? 3 : 6}, (_,i) => row(i,"visualMaster"))
  .concat(Array.from({length: stage < 3 ? 0 : stage === 3 ? 4 : 6}, (_,i) => [row(i,"cleanPlate"),row(i,"layer")]).flat());
const preview = id => ({image: rows().find(row => row.intentId === id), dataUrl: "data:image/svg+xml,"+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400"><rect width="640" height="400" fill="#e8f1dd"/><circle cx="320" cy="200" r="90" fill="#fff"/><circle cx="270" cy="120" r="28" fill="#263f35"/><circle cx="370" cy="120" r="28" fill="#263f35"/><circle cx="290" cy="190" r="19" fill="#263f35"/><circle cx="350" cy="190" r="19" fill="#263f35"/><text x="320" y="345" text-anchor="middle" font-size="32" fill="#263f35">Hello, Pandy!</text></svg>')});
export const useAppStore = create(set => ({activeSessionId: "chat", runningSessions: {}, messages: [], sessions: [{id:"chat",projectPath:"/fixture",title:plan.title}], workPanelTabs:[{id:"ppt",kind:"ppt"}],
  sendPrompt: async text => { calls.push(["prompt",text]); setStage(stage === 0 ? 1 : stage === 1 ? 2 : stage); return true; },
  replaceWorkPanelTab: (_id,tab) => set({workPanelTabs:[tab]}), openWorkPanelTab: tab => calls.push(["tab",tab]), closeWorkPanelTab() {}, showToast: text => calls.push(["toast",text])
}));
export function setStage(next) { stage=next; plan.approvedSha256 = stage ? plan.sha256 : null; useAppStore.setState(state => ({messages:[...state.messages,{role:"assistant",content:"fixture"}],runningSessions:{chat:stage>=2&&stage<=5}})); }
export const api = {
  onAuthChanged: () => () => {},
  coursewareWorkflowGet: async () => ({task:{taskType:"scene",imported:false,generated:stage>=5,...(stage>=5?{sourcePath:"/fixture/lesson.pptx"}:{})},plan:stage>=5?null:structuredClone(plan),...(stage===4?{compilation:{state:"running",planSha256:plan.sha256}}:{})}),
  coursewareScenePlanApprove: async () => { plan.approvedSha256=plan.sha256; return {plan:structuredClone(plan)}; },
  coursewareSceneImageList: async () => rows(), coursewareSceneImageStatus: async (_session,id) => rows().find(row=>row.intentId===id),
  coursewareSceneImagePreview: async (_session,id) => preview(id), coursewareSceneImageArchive: async (_session,id) => preview(id),
  coursewareSceneImageAdopt: async (_session,id) => {calls.push(["adopt",id]); return rows().map(row=>({...row,selected:true}));},
  pptEditorOpen: async path => {calls.push(["open",path]);return {status:"ready",path,canSave:true,nativeTeaching:true,teachingProgress:{total:6,audio:3,ready:2}};},
  onPptEditorState: () => () => {}, pptEditorSetVisible: async visible => calls.push(["visible",visible]), pptEditorSetBounds: async () => {}, pptEditorClose: async () => calls.push(["close"])
};
window.fixture={setStage,calls};
`;
const stubs = ["CoursewareSourceVisuals", "CoursewareChatNarration", "CoursewareChatPptxCandidates", "CoursewareImportDialog", "PptxInspectionPanel", "CoursewareTeachingPanel"];
await build({ stdin: { contents: `import React from "react"; import {createRoot} from "react-dom/client"; import i18n from "i18next"; import {initReactI18next} from "react-i18next";
import "workspace-fixture"; import {zhCN} from "${root}packages/i18n/src/locales/zh-CN/index.ts";
import {CoursewareChatWorkflow} from "./src/components/courseware/CoursewareChatWorkflow";
await i18n.use(initReactI18next).init({lng:"zh-CN",resources:{"zh-CN":{translation:zhCN}},interpolation:{escapeValue:false}});
createRoot(document.getElementById("root")).render(<CoursewareChatWorkflow/>);`, loader: "tsx", resolveDir: join(root, "apps/desktop") },
  outfile: join(output, "app.js"), bundle: true, format: "esm", platform: "browser", jsx: "automatic", define: { "process.env.NODE_ENV": '"test"' },
  plugins: [{name:"isolated-ipc",setup(build) {
    build.onResolve({filter:/workspace-fixture$|\/lib\/api$|\/stores\/app-store$/}, () => ({path:"fixture",namespace:"fixture"}));
    build.onLoad({filter:/.*/,namespace:"fixture"}, () => ({contents:fixture,loader:"js",resolveDir:join(root,"apps/desktop")}));
    build.onResolve({filter:new RegExp("/("+stubs.join("|")+")$")}, args => ({path:args.path.split("/").at(-1),namespace:"stub"}));
    build.onLoad({filter:/.*/,namespace:"stub"}, args => ({contents:'export function '+args.path+'(){return null;}',loader:"js"}));
  }}] });
const styles = await Promise.all(["courseware-chat-workflow.css","work-panel.css"].map(name => readFile(join(root,"apps/desktop/src/styles",name),"utf8")));
await writeFile(join(output,"index.html"), `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>
:root{--ds-bg-primary:#fff;--ds-bg-secondary:#f5f6f3;--ds-bg-elevated-opaque:#fff;--ds-bg-active:#e4eee8;--ds-bg-hover:#eee;--ds-text-primary:#263f35;--ds-text-secondary:#43584f;--ds-text-muted:#65766e;--ds-text-faint:#8d9993;--ds-border-subtle:#e3e8e3;--ds-border-default:#d8dfd8;--ds-accent:#38785d;--ds-error:#a13232;--text-2xs:11px;--text-xs:12px;--text-sm:14px;--text-lg:20px;--radius-sm:6px;--radius-2xs:3px;}*{box-sizing:border-box}body{margin:0;font:14px Arial,sans-serif}#root{height:100vh;width:100%}${styles.join("\n")}</style><div id="root"></div><script type="module" src="/app.js"></script></html>`);
const server = createServer(async (request,response) => {
  const js = request.url === "/app.js"; response.setHeader("content-type",js?"text/javascript":"text/html"); response.end(await readFile(join(output,js?"app.js":"index.html")));
});
await new Promise(resolve => server.listen(0,"127.0.0.1",resolve));
const browser = await chromium.launch({executablePath:process.env.CHROME_BIN || "/usr/bin/google-chrome",headless:true,args:["--no-sandbox"]});
const page = await browser.newPage({viewport:{width:1100,height:760}}), errors=[];
page.on("pageerror",error=>errors.push(String(error)));
const setStage = async stage => {await page.evaluate(stage=>window.fixture.setStage(stage),stage);};
try {
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const approval = page.getByRole("button",{name:"确认规划并生成封面",exact:true});
  await expect(approval).toBeInViewport();
  await expect(page.locator(".courseware-plan-pages details[open]")).toHaveCount(1);
  await page.locator(".courseware-plan-guide > summary").click();
  await expect(page.getByText("温暖明亮的儿童绘本风格，柔和的色彩与清晰的画面层次。",{exact:true})).toBeVisible();
  await page.locator(".courseware-plan-guide > summary").click();
  await page.screenshot({path:join(output,"plan-review.png")});
  await page.setViewportSize({width:420,height:700});
  await expect(approval).toBeInViewport();
  await page.locator(".courseware-plan-pages li:last-child summary").click();
  await expect(page.locator(".courseware-plan-pages li:last-child details")).toHaveAttribute("open", "");
  await expect(approval).toBeInViewport();
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.screenshot({path:join(output,"plan-review-narrow.png")});
  await page.setViewportSize({width:1100,height:760});
  await approval.click();
  await expect(page.getByRole("button",{name:"采用此风格，生成剩余页面",exact:true})).toBeVisible();
  await page.getByRole("button",{name:"采用此风格，生成剩余页面",exact:true}).click();
  await expect(page.locator('[data-courseware-phase="images"]')).toBeVisible();
  await expect(page.locator(".ppt-editor-tab")).toHaveCount(0);
  await setStage(3); await expect(page.locator('[data-courseware-phase="layers"]')).toBeVisible({timeout:10000});
  await expect(page.getByText("图片 6/6 页 · 素材齐备 4/6 页",{exact:true})).toBeVisible();
  await page.screenshot({path:join(output,"images-before-ppt.png")});
  await page.locator('[data-scene-page="page-2"]').click();
  await setStage(4); await expect(page.locator('[data-courseware-phase="converting"]')).toBeVisible();
  await expect(page.locator('[data-scene-page="page-2"]')).toHaveAttribute("aria-current","page");
  await expect(page.locator(".ppt-editor-tab")).toHaveCount(0);
  await page.setViewportSize({width:520,height:700});
  await expect(page.locator('[data-courseware-phase="converting"]')).toBeVisible();
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.screenshot({path:join(output,"conversion-narrow.png")});
  await setStage(5); await expect(page.locator(".ppt-editor-tab")).toBeVisible();
  await expect.poll(()=>page.evaluate(()=>window.fixture.calls.filter(call=>call[0]==="open").length)).toBe(1);
  await expect(page.getByText("音频 3/6 页 · 教学审核 2/6 页",{exact:true})).toBeVisible();
  await expect(page.locator(".courseware-teaching")).toHaveCount(0);
  await page.getByRole("button",{name:"刷新状态",exact:true}).click();
  await setStage(6); await expect(page.getByRole("button",{name:"发布到教学平台",exact:true})).toBeEnabled();
  assert.equal(await page.evaluate(()=>window.fixture.calls.filter(call=>call[0]==="open").length),1);
  assert.equal(await page.evaluate(()=>window.fixture.calls.filter(call=>call[0]==="close").length),0);
  assert.deepEqual(errors,[]);
  await writeFile(join(output,"report.json"),JSON.stringify({status:"PASS",scope:"Real renderer components; fixture IPC and media; native Office engine and paid providers not exercised",checks:["plan disclosure and pinned approval at 420px","plan approval","cover adoption","images-only preview","layers 4/6","compiler state","selected page retained","narrow layout","PPT opens during active turn","refresh does not reopen editor"],errors},null,2));
  console.log("PASS courseware workspace renderer:",output);
} finally {await browser.close();await new Promise(resolve=>server.close(resolve));}
