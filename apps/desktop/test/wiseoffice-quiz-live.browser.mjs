import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import * as authoring from "@pi-desktop/courseware-runtime/authoring";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const requireRuntime = createRequire(resolve(root, "packages/courseware-runtime/package.json"));
const { chromium } = requireRuntime("@playwright/test");
const bundle = resolve(process.argv[2] ?? resolve(root, "apps/desktop/resources/wiseoffice"));
const scene = authoring.editablePptxSceneSchema.parse({ version: 1, slideId: "fixture", sourceHash: `sha256:${"a".repeat(64)}`,
  canvas: { width: 1280, height: 800 }, visualMasterAssetId: "master", cleanPlateAssetId: "background", elements: [
    { id: "title", type: "native_text", bboxPx: [80, 80, 900, 150], zIndex: 1, content: "MAIC interaction",
      style: { fontFace: "Arial", fontSizePt: 32, color: "#111827", align: "left", lineHeight: 1.2 } },
  ] });
const sharp = requireRuntime("sharp");
const background = await sharp({ create: { width: 1280, height: 800, channels: 4, background: "white" } }).png().toBuffer();
const quiz = authoring.assessmentPptxScene({id:'quiz',stageId:'stage',type:'quiz',title:'Greetings',order:2,content:{type:'quiz',questions:[{id:'q',type:'single',question:'和朋友打招呼，可以用哪个词呢？',options:[{value:'A',label:'Hello'},{value:'B',label:'Bye'}],answer:['A']}]},actions:[]},'sha256:fixture',scene.canvas);
const { pptx } = await authoring.compileScenesToPptx([scene, quiz, {...scene, slideId:"interaction"}], { master: background, background, [authoring.assessmentBackground.id]: authoring.assessmentBackground.bytes });
const server = createServer(async (request, response) => {
  try {
    const file = resolve(bundle, "." + new URL(request.url, "http://localhost").pathname);
    if (!file.startsWith(bundle + sep) || !(await stat(file)).isFile()) { response.writeHead(404).end(); return; }
    response.setHeader("Cross-Origin-Opener-Policy", "same-origin"); response.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
    response.setHeader("Content-Type", file.endsWith(".wasm.br") ? "application/wasm" :
      ({ ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".wasm": "application/wasm" }[extname(file)] ?? "application/octet-stream"));
    if (file.endsWith(".wasm.br")) response.setHeader("Content-Encoding", "br");
    response.end(await readFile(file));
  } catch { response.writeHead(404).end(); }
});
await new Promise(done => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.route("**/*", route => route.request().url().startsWith(origin) || /^(blob|data):/.test(route.request().url()) ? route.continue() : route.abort());
  await page.addInitScript(() => {
    window.__commands = []; window.__events = []; window.__writes = []; window.__classroomWrites = [];
    let canonical = {projectId:'project', revision:'0', sourceRevision:'source', classroom:{id:'course',createdAt:'2026-11-06',stage:{id:'stage',name:'Lesson',createdAt:1,updatedAt:1},scenes:[
      {id:'body',stageId:'stage',type:'slide',title:'Lesson',order:1,metadata:{nativeTeachingSyncPending:true},content:{type:'slide',canvas:{id:'body',elements:[]}},actions:[]},
      {id:'quiz',stageId:'stage',type:'quiz',title:'Greetings',order:2,content:{type:'quiz',questions:[{id:'q',type:'single',question:'Choose a greeting',options:[{value:'A',label:'Hello'},{value:'B',label:'Bye'}],answer:['A']}],interactionMode:'classroom_instant_feedback'},actions:[]},
      {id:'interaction',stageId:'stage',type:'slide',title:'Discuss',order:3,content:{type:'slide',canvas:{id:'interaction',elements:[{id:'interaction_question',type:'text',content:'<p>Introduce yourself</p>'}]}},actions:[{id:'cp',type:'interaction_checkpoint',checkpointId:'cp',checkpointKind:'chapter_summary',chapterId:'chapter',chapterTitle:'Discuss',question:'Introduce yourself',constraintPrompt:'',referenceAnswer:{summary:'My name is Pandy',keyPoints:['Name']},context:{chapterSummary:'Names',sourceSceneIds:[]}}]}
    ]}};
    const project = { teachingRevision: "revision", source: { sha256: "a".repeat(64) }, pages: [{ pageId: "page", locked: false, actions: [
      { id: "speech", type: "speech", text: "Greet your friend." },
      { id: "checkpoint", type: "interaction_checkpoint", checkpointId: "question", checkpointKind: "chapter_summary",
        chapterId: "chapter", chapterTitle: "Greetings", question: "How do you greet your friend?",
        response: { kind: "practice", options: [], answerIndices: [] }, referenceAnswer: { summary: "Say Hello", keyPoints: ["Hello"] }, context: { chapterSummary: "Greet", sourceSceneIds: [] } },
    ] }] };
    project.pages.push({pageId:"quiz",locked:false,actions:[]},{pageId:"interaction",locked:false,actions:[]});
    window.deckwiseEditorHost = {
      onCommand(listener) { window.__commands.push(listener); return () => {}; },
      sendEvent(event) {
        const message = event.message; window.__events.push(message ?? event);
        if (message?.type !== "document:teaching-request") return;
        const { operation, args, context } = message.payload;
        let result;
        if (operation === "open") result = { viewId: "view", pageId: project.pages[context.page-1].pageId, pageNumber: context.page, project: structuredClone(project), hasAssessments:true, ...(context.page > 1 ? {assessment:structuredClone(canonical)} : {}) };
        else if(operation === 'classroom:open') result = structuredClone(canonical);
        else if(operation === 'classroom:write') { canonical = {...canonical,revision:String(Number(canonical.revision)+1),classroom:structuredClone(args.classroom)}; window.__classroomWrites.push(structuredClone(canonical)); result=structuredClone(canonical); }
        else if(operation === 'classroom:play' || operation === 'classroom:preview-course') result={ok:true};
        else if (operation === "draft:get" || operation === "draft:set") result = { draft: null };
        else if (operation === "tts:list" || operation === "tts:models" || operation === "media:list") result = [];
        else if (operation === "write") { window.__writes.push(args); project.pages[0].actions = args.actions; result = { viewId: "view", pageId: "page", pageNumber: 1, project: structuredClone(project) }; }
        else throw Error("Unexpected native operation " + operation);
        queueMicrotask(() => window.__commands.forEach(listener => listener({ type: "document:teaching-response", id: message.id, payload: { result } })));
      },
    };
  });
  await page.goto(origin + "/module.html?deckwise=1");
  await page.waitForFunction(() => window.__events.some(event => event.type === "document:ready"));
  const binding = { projectId: "project", documentId: "document", sessionId: "session" };
  await page.evaluate(({ bytes, binding }) => window.__commands.forEach(listener => listener({ type: "document:open-buffer", id: "open", payload: {
    fileName: "fixture.pptx", buffer: Uint8Array.from(atob(bytes), c => c.charCodeAt(0)).buffer, editorBinding: binding,
  } })), { bytes: Buffer.from(pptx).toString("base64"), binding });
  await page.waitForFunction(() => document.querySelector('iframe[name="frameEditor"]')?.contentWindow?.Asc?.editor?.isDocumentLoadComplete, { timeout: 60000 });
  await page.evaluate(binding => {
    window.__commands.forEach(listener => listener({type:'document:configure-ui',id:'select-page',payload:{page:2}}));
    window.__commands.forEach(listener => listener({type:'document:get-context',id:'selected-page',payload:binding}));
  }, binding);
  await page.waitForFunction(()=>window.__events.some(e=>e.id==='selected-page' && e.payload?.page===2));
  const updated = {id:'quiz',stageId:'stage',type:'quiz',title:'Greetings',order:2,
    content:{type:'quiz',questions:[{id:'q',type:'single',question:'Updated question before image upload',options:[
      {value:'A',label:'Hello'},{value:'B',label:'Updated option',image:{src:'uploaded'}}],answer:['A']}]},actions:[]};
  const image = await sharp({create:{width:80,height:40,channels:4,background:'#ff0033'}}).png().toBuffer();
  const {projected: next, assets} = await authoring.prepareAssessmentPage(updated,'sha256:fixture',scene.canvas,async()=>image);
  const beforeDocument = await page.evaluate(() => {
    const win=document.querySelector('iframe[name="frameEditor"]').contentWindow;
    window.__originalDocument=win.Asc.editor.WordControl.m_oLogicDocument;
    window.__originalFrame=win; return true;
  });
  const send = (type,id,payload) => page.evaluate(({type,id,payload})=>window.__commands.forEach(listener=>listener({type,id,payload})),{type,id,payload});
  const context=await page.evaluate(()=>window.__events.find(e=>e.id==='selected-page').payload);
  await page.evaluate(({binding,context,previous,next,assets})=>window.__commands.forEach(listener=>listener({
    type:'document:apply-quiz-page',id:'live-upload',payload:{binding,page:2,editGeneration:context.editGeneration,previous,next,
      assets:Object.fromEntries(Object.entries(assets).map(([key,value])=>[key,Uint8Array.from(value)]))}
  })),{binding,context,previous:quiz,next,assets:Object.fromEntries(Object.entries(assets).map(([key,value])=>[key,[...value]]))});
  await page.waitForFunction(()=>window.__events.some(e=>e.id==='live-upload'),{timeout:15000});
  const response=await page.evaluate(()=>window.__events.find(e=>e.id==='live-upload'));
  assert.equal(response.type,'document:command-result',JSON.stringify(response));
  assert.equal(response.payload.applied,true);
  const inspect=()=>page.evaluate(()=>{
    const win=document.querySelector('iframe[name="frameEditor"]').contentWindow, api=win.Asc.editor,logic=api.WordControl.m_oLogicDocument;
    return {same:window.__originalFrame===win&&window.__originalDocument===logic,page:api.getCurrentPage(),
      shapes:logic.Slides[1].cSld.spTree.map(s=>({name:s.getObjectName(),image:s.blipFill?.RasterImageId,text:s.getDocContent?.()?.GetText?.({})}))};
  });
  let current=await inspect();assert.equal(current.same,true);assert.equal(current.page,1);
  assert(current.shapes.some(s=>s.name==='quiz_q0_option1_image'&&s.image));
  assert(current.shapes.some(s=>s.text?.includes('Updated question before image upload')));
  await page.evaluate(()=>document.querySelector('iframe[name="frameEditor"]').contentWindow.Asc.editor.Undo());
  current=await inspect();assert(!current.shapes.some(s=>s.name==='quiz_q0_option1_image'),'one native undo removes uploaded image');
  await page.evaluate(()=>document.querySelector('iframe[name="frameEditor"]').contentWindow.Asc.editor.Redo());
  current=await inspect();assert(current.shapes.some(s=>s.name==='quiz_q0_option1_image'),'redo restores image');
  await page.screenshot({path:'/tmp/deckwise-quiz-live-upload.png'});
  const replaceImage=await sharp({create:{width:40,height:80,channels:4,background:'#0033ff'}}).png().toBuffer();
  const replacement=await authoring.prepareAssessmentPage(updated,'sha256:fixture',scene.canvas,async()=>replaceImage);
  await send('document:get-context','replacement-context',binding);
  await page.waitForFunction(()=>window.__events.some(e=>e.id==='replacement-context'));
  const replacementContext=await page.evaluate(()=>window.__events.find(e=>e.id==='replacement-context').payload);
  const apply=async(id,editGeneration,assets)=>page.evaluate(({id,editGeneration,binding,previous,next,assets})=>window.__commands.forEach(listener=>listener({
    type:'document:apply-quiz-page',id,payload:{binding,page:2,editGeneration,previous,next,
      assets:Object.fromEntries(Object.entries(assets).map(([key,value])=>[key,Uint8Array.from(value)]))}
  })),{id,editGeneration,binding,previous:next,next:replacement.projected,assets:Object.fromEntries(Object.entries(assets).map(([key,value])=>[key,[...value]]))});
  const unchanged=await inspect();
  await apply('stale-upload',-1,replacement.assets);
  await page.waitForFunction(()=>window.__events.some(e=>e.id==='stale-upload'));
  assert.equal(await page.evaluate(()=>window.__events.find(e=>e.id==='stale-upload').type),'document:error');
  assert.deepEqual(await inspect(),unchanged,'stale upload cannot touch the page');
  await apply('invalid-upload',replacementContext.editGeneration,Object.fromEntries(Object.keys(replacement.assets).map(key=>[key,new Uint8Array([1,2,3])])));
  await page.waitForFunction(()=>window.__events.some(e=>e.id==='invalid-upload'));
  assert.equal(await page.evaluate(()=>window.__events.find(e=>e.id==='invalid-upload').type),'document:error');
  assert.deepEqual(await inspect(),unchanged,'invalid image cannot partially update the page');
  await apply('replace-upload',replacementContext.editGeneration,replacement.assets);
  await page.waitForFunction(()=>window.__events.some(e=>e.id==='replace-upload'));
  assert.equal(await page.evaluate(()=>window.__events.find(e=>e.id==='replace-upload').type),'document:command-result');
  const replaced=await inspect();
  assert.equal(replaced.same,true);assert.equal(replaced.shapes.filter(s=>s.name==='quiz_q0_option1_image').length,1);
  assert.notEqual(replaced.shapes.find(s=>s.name==='quiz_q0_option1_image').image,unchanged.shapes.find(s=>s.name==='quiz_q0_option1_image').image);
  await send('document:save','live-save',{targetExt:'PPTX',requireHostCommit:true});
  await page.waitForFunction(()=>window.__events.some(e=>e.id==='live-save'&&['saved','document:error'].includes(e.type)),null,{timeout:60000});
  const exported=await page.evaluate(async()=>{const e=window.__events.find(e=>e.id==='live-save'&&['saved','document:error'].includes(e.type));return {type:e.type,payload:e.payload,bytes:e.bytes?[...new Uint8Array(e.bytes)]:[]};});
  assert.equal(exported.type,'saved',JSON.stringify(exported.payload));
  assert(exported.bytes.length>0,'native document exports without reopen');
  const zip=await requireRuntime('jszip').loadAsync(Uint8Array.from(exported.bytes));
  const xml=await zip.file('ppt/slides/slide2.xml').async('string');
  assert(xml.includes('Updated question before image upload'));assert(xml.includes('quiz_q0_option1_image'));
  await send('document:commit-save','live-save',{success:true});
  assert.equal((await inspect()).same,true);
  console.log('PASS: native Quiz image insertion, draft text, undo/redo and PPT export preserve the document');
} catch(error) {console.error(error); throw error;} finally { await browser.close(); await new Promise(done=>server.close(done)); }
