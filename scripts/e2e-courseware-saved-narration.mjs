/** Run under Electron: actual Main/Host/parser/offline rasterization, deterministic model, no editor window. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as shared from "../packages/shared/dist/index.js";
import * as runtime from "../packages/agent-runtime/dist/index.js";
const [source, worker, out] = process.argv.slice(1).filter(arg => !arg.startsWith("--")).slice(1);
assert(source && worker && out && process.env.PI_DESKTOP_HOST_BIN, "source, worker, output and PI_DESKTOP_HOST_BIN are required");
await mkdir(out, { recursive: true });
const temporary = await mkdtemp(join(tmpdir(), "deckwise-saved-narration-"));
const workspace = join(temporary, "workspace"), data = join(temporary, "data");
const imported = join(workspace, ".deckwise-ppt/imports/lesson.pptx");
await mkdir(join(workspace, ".deckwise-ppt/imports"), { recursive: true });
await mkdir(join(data, "plugins/market"), { recursive: true });
await writeFile(join(data, "plugins/market/catalog.json"), JSON.stringify({ schemaVersion: 2, providerId: "official", plugins: [] }));
await copyFile(source, imported);
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const originalHash = hash(await readFile(imported));
const require = createRequire(new URL("../apps/desktop/package.json", import.meta.url));
assert(process.versions.electron, "Run this script with Electron for real native image decoding");
const ts = require("typescript"), loaded = new Map();
function load(name) {
 if (loaded.has(name)) return loaded.get(name);
 const source = require("node:fs").readFileSync(new URL(`../apps/desktop/electron/main/${name}.ts`, import.meta.url), "utf8");
 const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
 const exports = {};
 new Function("require", "exports", code)(id => id === "@pi-desktop/shared" ? shared : id === "@pi-desktop/agent-runtime" ? runtime : id.startsWith("./") ? load(id.slice(2)) : require(id), exports);
 loaded.set(name,exports);return exports;
}
const { CoursewareSavedNarration } = load("courseware-saved-narration");
let child, host, sessionId, seq = 0, modelCalls = 0, generation = 1, failPage;
const calls = [], logs = [], report = { paidCalls: false, checks: [], temporary,
 hostSha256: hash(await readFile(process.env.PI_DESKTOP_HOST_BIN)), workerSha256: hash(await readFile(worker)),
 sourceSha256: originalHash, rasterPreviewPages: [], embeddedImagePages: [] };
async function start() {
 child = spawn(process.env.PI_DESKTOP_HOST_BIN, [], { stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env.PATH, LANG: "C.UTF-8", PI_DESKTOP_DATA_DIR: data, PI_DESKTOP_PLUGIN_MARKET_URL: "http://127.0.0.1:9/catalog.json", DECKWISE_PPTX_NODE: process.env.DECKWISE_E2E_NODE || "/usr/bin/node", DECKWISE_PPTX_WORKER: worker } });
 child.stderr.on("data", bytes => logs.push(String(bytes)));
 const pending = new Map();
 createInterface({input:child.stdout}).on("line", line => {
  const result=JSON.parse(line), entry=pending.get(result.id);if(!entry)return;pending.delete(result.id);clearTimeout(entry.timer);
  if(result.error) entry.reject(new Error(JSON.stringify(result.error)));else entry.resolve(result.result);
 });
 host={call(method,params={}){calls.push(method);return new Promise((resolve,reject)=>{const id=++seq;const timer=setTimeout(()=>{pending.delete(id);reject(new Error(`RPC timeout: ${method}`));},120000);pending.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({jsonrpc:"2.0",id,method,params})+"\n");});}};
 await host.call("app.handshake",{protocolVersion:shared.PROTOCOL_VERSION});
}
async function stop(){if(!child)return;const current=child;child=undefined;current.stdin.end();await new Promise(resolve=>current.once("exit",resolve));}
const coordinator=new CoursewareSavedNarration(()=>host,()=>sessionId,async input=>{
 modelCalls++;
 assert(input.includeSessionContext===false);
 const data=JSON.parse(input.messages[0].content);
 if(data.outline) {
  assert(data.outline.every(p=>!p.unavailable));
  report.plannedPages=data.outline.map(p=>p.pageNumber);
  return {text:JSON.stringify({goal:"认识影子",pages:data.outline.map(p=>({pageNumber:p.pageNumber,purpose:"观察与解释",bridge:"联系前后页",focus:"页面证据"}))})};
 }
 assert(data.pageText.trim() || data.evidence?.visualSummary.trim());
 assert(data.coursePlan?.page.purpose && data.coursePlan.pageCount===report.pageCount);
 if(data.coursePlan.previous) assert.equal(data.coursePlan.previous.pageNumber,data.coursePlan.page.pageNumber-1);
 if(data.coursePlan.next) assert.equal(data.coursePlan.next.pageNumber,data.coursePlan.page.pageNumber+1);
 if(data.coursePlan.page.pageNumber===failPage) throw new Error("Fixture page generation failed");
 const target=data.evidence?.objects[0];
 return {text:JSON.stringify({blocks:[{type:"speech",text:`第${generation}次讲解。同学们，我们一起来看看这一页，说说你发现了什么。`,...(target?{attention:{type:target.kind==="image"?"spotlight":"highlight",objectIds:[target.objectId]}}:{})}]})};
}, undefined, async input => {
 modelCalls++; assert(input.images.length>0);
 assert(input.images.every(image=>image.bytes.length>0));
 const data=JSON.parse(input.data); assert(data.pageNumber>0);
 (input.images.some(image=>image.assetIds.some(id=>id.endsWith("-preview"))) ? report.rasterPreviewPages : report.embeddedImagePages).push(data.pageNumber);
 return {text:"本页有可见的文字或图片，应依据画面内容讲解，不推测无法辨认的细节。"};
});
try {
 await start();
 sessionId=(await host.call("session.create",{mode:"agent",providerId:"fixture-provider",modelId:"fixture-model",projectPath:workspace})).session.id;
 await host.call("courseware.task.set",{sessionId,taskType:"import",educationContext:{schoolStage:"primary",grade:"1",subject:"chinese"}});
 await host.call("courseware.task.attachImport",{sessionId,path:imported});
 const outline=await coordinator.execute(sessionId,"courseware_narration_context",{},()=>true);
 assert(outline.pageCount>1);report.pageCount=outline.pageCount;report.checks.push("Read real saved PPTX without Office");
 const started=Date.now();
 const batch=await coordinator.execute(sessionId,"courseware_narration_propose",{sourceSha256:outline.sourceSha256,pageNumbers:outline.pages.map(p=>p.pageNumber),instruction:"为一年级学生连续生成整份课件的课堂讲解。"},()=>true);
 assert.equal(batch.savedPages.length+batch.failures.length,outline.pageCount);assert.equal(batch.savedPages.length,outline.pageCount);assert.equal(batch.failures.length,0);
 assert.deepEqual(report.plannedPages,outline.pages.map(p=>p.pageNumber));
 assert.equal(report.rasterPreviewPages.length+report.embeddedImagePages.length,outline.pageCount);
 report.rasterPreviewPages.sort((a,b)=>a-b);report.embeddedImagePages.sort((a,b)=>a-b);
 report.generationMs=Date.now()-started;report.generatedPages=batch.savedPages.map(c=>c.pageNumber);report.failures=batch.failures;
 assert.equal(batch.saved,true); assert.equal(batch.applied,true);
 const getProject=async()=> (await host.call("courseware.project.get",{sessionId,projectId:outline.projectId})).project;
 const initial=await getProject();
 assert(initial.pages.every(p=>p.actions.some(a=>a.type==="speech")));
 assert(initial.pages.some(p=>p.actions.some(a=>a.attention)));
 assert(!calls.some(method=>method.includes("narrationCandidate")));
 report.checks.push("All requested pages saved directly into authoritative teaching without candidate RPCs");
 await stop();await start();
 assert.deepEqual(await getProject(),initial);
 report.checks.push("Every page of formal teaching survives Host restart");
 generation=2;
 const regenerated=await coordinator.execute(sessionId,"courseware_narration_propose",{sourceSha256:outline.sourceSha256,pageNumbers:[1],instruction:"重新生成第一页并直接保存。"},()=>true);
 assert.equal(regenerated.saved,true);
 const replaced=await getProject();
 assert.notDeepEqual(replaced.pages[0].actions,initial.pages[0].actions);
 assert.deepEqual(replaced.pages.slice(1),initial.pages.slice(1));
 report.checks.push("Regeneration replaces only the requested page without adoption");
 generation=3;failPage=2;
 const partial=await coordinator.execute(sessionId,"courseware_narration_propose",{sourceSha256:outline.sourceSha256,pageNumbers:[1,2],instruction:"重新生成这两页并直接保存。"},()=>true);
 assert.equal(partial.saved,false);assert.equal(partial.applied,true);
 assert.deepEqual(partial.savedPages.map(p=>p.pageNumber),[1]);assert.deepEqual(partial.failures.map(p=>p.pageNumber),[2]);
 const partiallySaved=await getProject();
 assert.notDeepEqual(partiallySaved.pages[0].actions,replaced.pages[0].actions);
 assert.deepEqual(partiallySaved.pages.slice(1),replaced.pages.slice(1));
 report.checks.push("Page failure preserves both completed saves and previous teaching on failed pages");
 failPage=undefined;
 const draftScope={sessionId,projectId:outline.projectId,pageId:partiallySaved.pages[0].pageId};
 const {draft}=await host.call("courseware.teachingDraft.set",{...draftScope,expectedRevision:null,draft:{baseline:partiallySaved,actions:partiallySaved.pages[0].actions,instruction:"Keep my manual draft"}});
 const blocked=await coordinator.execute(sessionId,"courseware_narration_propose",{sourceSha256:outline.sourceSha256,pageNumbers:[1],instruction:"Do not overwrite a manual draft"},()=>true);
 assert.equal(blocked.saved,false);assert.equal(blocked.savedPages.length,0);assert.match(blocked.failures[0].error,/draft/i);
 assert.deepEqual(await getProject(),partiallySaved);
 await host.call("courseware.teachingDraft.set",{...draftScope,expectedRevision:draft.revision,draft:null});
 report.checks.push("Stored target-page draft blocks direct replacement");
 await stop();await start();
 assert.deepEqual(await getProject(),partiallySaved);
 report.checks.push("Regenerated and partially completed saves survive a second restart");
 assert.equal(hash(await readFile(imported)),originalHash);report.editorSelectionRpcCount=calls.filter(method=>/editor|selection/i.test(method)).length;assert.equal(report.editorSelectionRpcCount,0);
 report.checks.push("Original PPTX bytes unchanged; no editor or selection RPC");
 report.status="PASS";report.modelCalls=modelCalls;
 console.log(JSON.stringify(report,null,2));
} catch(error){report.status="FAIL";report.error=String(error);console.error(error);process.exitCode=1;}
finally{await stop();await writeFile(join(out,"result.json"),JSON.stringify(report,null,2));await writeFile(join(out,"host.log"),logs.join(""));require("electron").app.exit(process.exitCode || 0);}
