/** Actual React/DOM regression for repeated teaching reloads; no Host, Office or supplier calls. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const desktop = join(root, "apps/desktop");
const requireBuild = createRequire(join(root, "packages/agent-runtime/package.json"));
const { build } = requireBuild("esbuild");
assert(process.env.DECKWISE_E2E_OFFICE_ROOT, "Supply the existing Playwright installation via DECKWISE_E2E_OFFICE_ROOT");
const { chromium } = createRequire(join(process.env.DECKWISE_E2E_OFFICE_ROOT, "package.json"))("@playwright/test");
const temporary = await mkdtemp(join(tmpdir(), "teaching-refresh-"));
const stubs = new Map([
  ["react-i18next", 'export const useTranslation=()=>({t:key=>key});'],
  ["../../stores/app-store", 'export const useAppStore=select=>select({sendPrompt:async()=>true});'],
  ["@pi-desktop/shared", 'export const replaceNarrationText=(action,text)=>({...action,text});'],
  ["../../lib/api", `let sequence=0;
    const project={schemaVersion:'deckwise-courseware/1',projectId:'course',taskType:'plain',source:{revision:'source',sha256:'a'.repeat(64)},teachingRevision:'T1',pages:[{pageId:'page',actions:[],locked:false,reviewState:'review'}]};
    const view=()=>({viewId:'view-'+(++sequence),pageId:'page',pageNumber:1,project,chatChanges:[{changeGroupId:'group',receiptSha256:'b'.repeat(64),acknowledged:0,uncertain:0,pending:0,plan:{pageId:'page',pageNumber:1,items:[{label:'Missing narration',toolName:'ppt_propose_page_narration',status:'not-recorded'}]}}]});
    export const api={pptEditorTeachingOpen:async()=>view(),pptEditorTeachingDraftGet:async()=>({draft:null}),pptEditorGetContext:async()=>({page:1,readOnly:false})};`],
]);
const childNames = ["CoursewareNarrationReview", "CoursewareSourceReview", "CoursewarePptxCandidateReview", "CoursewarePlaybackPanel", "CoursewareTtsTasks", "CoursewareImageAssets", "CoursewareSourceVisuals", "CoursewareTeachingEffects", "CoursewareAssetLocks"];
for (const name of childNames) stubs.set("./" + name, `export function ${name}(){return React.createElement('span',{'data-child':'${name}'},'${name}')}`);
await build({ stdin: { contents: `import React from 'react';import{createRoot}from'react-dom/client';import{CoursewareTeachingPanel}from'./src/components/workpanel/CoursewareTeachingPanel';createRoot(document.getElementById('root')).render(React.createElement(CoursewareTeachingPanel,{sessionId:'chat',enabled:true}));`, resolveDir: desktop, sourcefile: "refresh-entry.tsx" },
  bundle: true, format: "iife", platform: "browser", jsx: "automatic", outfile: join(temporary, "bundle.js"),
  plugins: [{ name: "teaching-boundary-fixtures", setup(build) {
    build.onResolve({ filter: /.*/ }, args => stubs.has(args.path) ? { path: args.path, namespace: "fixture" } : undefined);
    build.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({ contents: "import React from 'react';" + stubs.get(args.path), resolveDir: desktop, loader: "tsx" }));
  } }], define: { "process.env.NODE_ENV": '"development"' } });
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE_PATH, args: ["--no-sandbox"] });
const errors = [];
try {
  const page = await browser.newPage();
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  await page.setContent('<div id="root"></div>');
  await page.addScriptTag({ content: await readFile(join(temporary, "bundle.js"), "utf8") });
  const load = page.getByRole("button", { name: "panel.pptEditor.teachingCurrent", exact: true });
  for (let n = 0; n < 4; n++) {
    await load.click(); await load.waitFor({ state: "visible" });
    await page.waitForFunction(() => !document.querySelector('.courseware-teaching button').disabled);
    assert.equal(await page.locator(".courseware-chat-changes").count(), 1, `Reload ${n+1} must retain one Chat history`);
    assert.equal(await page.locator('[data-child="CoursewareAssetLocks"]').count(), 1, `Reload ${n+1} must retain one asset-lock panel`);
  }
  assert(!errors.some(error => /same key|duplicate key/i.test(error)), errors.join("\n"));
  console.log("PASS: four actual React/DOM teaching reloads retain one Chat history and one asset-lock panel, with no duplicate-key warning.");
} finally {
  if (errors.length) console.log(JSON.stringify({ consoleErrors: errors }, null, 2));
  await browser.close(); await rm(temporary, { recursive: true, force: true });
}
