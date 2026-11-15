import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
const require = createRequire(new URL("../../../packages/agent-runtime/package.json", import.meta.url));
const { build } = require("esbuild");
const { chromium } = createRequire(new URL("../../../packages/courseware-runtime/package.json", import.meta.url))("@playwright/test");
let browser, server, address;
before(async () => {
  const children = ["CoursewareSourceReview", "CoursewarePptxCandidateReview", "CoursewarePlaybackPanel", "CoursewareTtsTasks", "CoursewareImageAssets", "CoursewareTeachingEffects", "CoursewareAssetLocks", "CoursewareChatChanges", "CoursewareTeachingHistory"];
  const mocks = {
    "react-i18next": `export const useTranslation=()=>({t:key=>key});`,
    "../../lib/api": `export const api={};`,
    "../../stores/app-store": `export const useAppStore=selector=>selector({});`,
    ...Object.fromEntries(children.map(name => [`./${name}`, `import {useState} from 'react';export function ${name}(){const [value,setValue]=useState('');return <label>${name}<input aria-label="${name}" value={value} onChange={e=>setValue(e.target.value)}/></label>}`])),
  };
  const result = await build({ stdin: { contents: `import {createRoot} from 'react-dom/client';import {CoursewareTeachingPanel} from './src/components/workpanel/CoursewareTeachingPanel';createRoot(document.getElementById('root')).render(<CoursewareTeachingPanel sessionId="chat" enabled={false}/>);`, resolveDir: new URL("..", import.meta.url).pathname, loader: "tsx" }, bundle: true, write: false, format: "iife", jsx: "automatic", plugins: [{ name: "fixture", setup(build) {
    build.onResolve({ filter: /.*/ }, args => Object.hasOwn(mocks,args.path) ? { path:args.path, namespace:"fixture" } : undefined);
    build.onLoad({ filter: /.*/, namespace:"fixture" }, args => ({contents:mocks[args.path],loader:"tsx",resolveDir:new URL("..",import.meta.url).pathname}));
  } }] });
  const script = result.outputFiles[0].text;
  const css = await readFile(new URL("../src/styles/work-panel.css", import.meta.url),"utf8");
  server=createServer((req,res)=>{res.setHeader("Content-Type",req.url==="/app.js"?"text/javascript":"text/html");res.end(req.url==="/app.js"?script:`<style>body{margin:0;--ds-border-subtle:#ddd;--ds-bg-primary:white;--ds-text-primary:#222;--ds-text-secondary:#666}.courseware-teaching{width:300px;height:600px}${css}</style><div id="root"></div><script src="/app.js"></script>`);});
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));address=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({headless:true});
});
after(async()=>{await browser?.close();await new Promise(resolve=>server?.close(resolve));});
test("sidebar opens on narration and keeps review forms and assets in separate tabs",async t=>{
 const page=await browser.newPage();t.after(()=>page.close());await page.goto(address);
 assert.equal(await page.getByRole("tab").count(),5);
 await page.getByRole("tab",{name:"panel.pptEditor.tab_narration",exact:true}).waitFor();
 assert.equal(await page.getByRole("tab",{selected:true}).textContent(),"panel.pptEditor.tab_narration");
 assert.equal(await page.getByRole("button",{name:"panel.pptEditor.sourceReviewStart",exact:true}).isVisible(),false);
 assert.equal(await page.getByLabel("CoursewareImageAssets",{exact:true}).isVisible(),false);
 await page.getByRole("tab",{name:"panel.pptEditor.tab_review",exact:true}).click();
 assert.equal(await page.getByRole("button",{name:"panel.pptEditor.sourceReviewStart",exact:true}).isVisible(),true);
 assert.equal(await page.getByText("panel.pptEditor.teachingScope",{exact:true}).isVisible(),false);
});
test("switching tabs retains local input and supports arrow key navigation",async t=>{
 const page=await browser.newPage();t.after(()=>page.close());await page.goto(address);
 await page.getByRole("tab",{name:"panel.pptEditor.tab_assets",exact:true}).click();
 await page.getByLabel("CoursewareImageAssets",{exact:true}).fill("preserved local input");
 await page.getByRole("tab",{name:"panel.pptEditor.tab_narration",exact:true}).click();
 await page.getByRole("tab",{name:"panel.pptEditor.tab_assets",exact:true}).click();
 assert.equal(await page.getByLabel("CoursewareImageAssets",{exact:true}).inputValue(),"preserved local input");
 await page.getByRole("tab",{selected:true}).press("ArrowRight");
 assert.equal(await page.getByRole("tab",{selected:true}).textContent(),"panel.pptEditor.tab_review");
 await page.getByRole("tab",{selected:true}).press("Home");
 assert.equal(await page.getByRole("tab",{selected:true}).textContent(),"panel.pptEditor.tab_narration");
});
