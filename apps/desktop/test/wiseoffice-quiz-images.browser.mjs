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
const quiz = authoring.assessmentPptxScene({id:'quiz',stageId:'stage',type:'quiz',title:'Greetings',order:2,content:{type:'quiz',questions:[{id:'q',type:'single',question:'和朋友打招呼，可以用哪个词呢？',options:[{value:'A',label:'Hello',image:{src:'background'}},{value:'B',label:'Bye',image:{src:'background'}}],answer:['A']}]},actions:[]},'sha256:fixture',scene.canvas);
const { pptx } = await authoring.compileScenesToPptx([scene, quiz, {...scene, slideId:"interaction"}, {...quiz, slideId:"quiz-two"}], { master: background, background, [authoring.assessmentBackground.id]: authoring.assessmentBackground.bytes });
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
    const imageData='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVR4nGP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg==';
    const firstImage='.deckwise-ppt/classroom-assets/first.png', secondImage='.deckwise-ppt/classroom-assets/second.png';
    canonical.classroom.scenes[1].content.questions[0].options[1].image={src:firstImage,mimeType:'image/png'};
    canonical.classroom.scenes.push({...structuredClone(canonical.classroom.scenes[1]),id:'quiz-two',order:4,
      content:{...structuredClone(canonical.classroom.scenes[1].content),questions:[{id:'q-two',type:'single',question:'Second Quiz',options:[{value:'A',label:'One'},{value:'B',label:'Two',image:{src:secondImage,mimeType:'image/png'}}],answer:['A']}]}});
    const display=page=>({...structuredClone(canonical),resourceUrls:page===2?{[firstImage]:imageData}:page===4?{[secondImage]:imageData}:{}});
    const project = { teachingRevision: "revision", source: { sha256: "a".repeat(64) }, pages: [{ pageId: "page", locked: false, actions: [
      { id: "speech", type: "speech", text: "Greet your friend." },
      { id: "checkpoint", type: "interaction_checkpoint", checkpointId: "question", checkpointKind: "chapter_summary",
        chapterId: "chapter", chapterTitle: "Greetings", question: "How do you greet your friend?",
        response: { kind: "practice", options: [], answerIndices: [] }, referenceAnswer: { summary: "Say Hello", keyPoints: ["Hello"] }, context: { chapterSummary: "Greet", sourceSceneIds: [] } },
    ] }] };
    project.pages.push({pageId:"quiz",locked:false,actions:[]},{pageId:"interaction",locked:false,actions:[]},{pageId:"quiz-two",locked:false,actions:[]});
    window.deckwiseEditorHost = {
      onCommand(listener) { window.__commands.push(listener); return () => {}; },
      sendEvent(event) {
        const message = event.message; window.__events.push(message ?? event);
        if (message?.type !== "document:teaching-request") return;
        const { operation, args, context } = message.payload;
        let result;
        if (operation === "open") result = { viewId: "view", pageId: project.pages[context.page-1].pageId, pageNumber: context.page, project: structuredClone(project), hasAssessments:true, ...(context.page > 1 ? {assessment:display(context.page)} : {}) };
        else if(operation === 'classroom:open') result = structuredClone(canonical);
        else if(operation === 'classroom:write') { canonical = {...canonical,revision:String(Number(canonical.revision)+1),classroom:structuredClone(args.classroom)}; window.__classroomWrites.push(structuredClone(canonical)); result={...structuredClone(canonical),resourceUrls:{[firstImage]:imageData,[secondImage]:imageData}}; }
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
  await page.screenshot({path:'/tmp/deckwise-quiz-native-preview-20261105.png'});
  await page.evaluate(()=>window.__commands.forEach(listener=>listener({type:'document:configure-ui',id:'return-page',payload:{page:1}})));
  await page.evaluate(binding => window.__commands.forEach(listener => listener({ type: "document:teaching-enable", payload: { binding } })), binding);
  const native = page.frameLocator('iframe[name="frameEditor"]');
  const checkpoint = native.locator('.teaching-inspector[data-action-id="checkpoint"]');
  await native.getByText("MAIC 课堂互动", { exact: true }).first().click({ timeout: 30000 });
  await checkpoint.getByText(/右侧题目编辑/).waitFor();
  assert.equal(await checkpoint.locator("textarea,select,input").count(), 0);
  assert.equal(await native.getByText("课件原有提问", { exact: true }).count(), 0);
  assert.equal(await native.getByRole("combobox", { name: "题型", exact: true }).count(), 0);
  assert.equal(await native.locator('[data-action-id="checkpoint"]').count() > 0, true);
  assert.equal(await page.evaluate(() => window.__writes.length), 0, "Presentation changes must not rewrite saved actions");
  const panel = native.locator('.deckwise-teaching-sidebar');
  const headerButtons = () => panel.locator(':scope > header button').evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label')));
  const ordinaryHeader = await headerButtons();
  const assertSharedHeader = async () => {
    assert.deepEqual(await headerButtons(), ordinaryHeader, 'Assessment uses the ordinary teaching header and icon controls');
    assert.equal(await panel.locator(':scope > header strong').textContent(), '教学流程');
    assert.equal(await panel.locator('.maic-editor-toolbar').count(), 0, 'No second assessment toolbar');
    const fits = await panel.locator(':scope > header, :scope > .teaching-statusbar').evaluateAll(rows => rows.every(row => {
      const bounds = row.getBoundingClientRect();
      return [...row.children].every(child => child.getBoundingClientRect().right <= bounds.right + 1);
    }));
    assert(fits, 'Shared header fits within the native sidebar');
  };
  const select = async value => {
    await page.evaluate(value => window.__commands.forEach(listener => listener({type:'document:configure-ui',id:'select-'+value,payload:{page:value}})), value);
  };
  await page.evaluate(()=>{window.__quizImageFrame=document.querySelector('iframe[name="frameEditor"]').contentWindow;return true;});
  await select(2);
  const image = native.getByRole('img',{name:'选项 B 图片',exact:true});
  await image.waitFor();
  await image.evaluate(async node=>{await node.decode();});
  assert(await image.evaluate(node=>node.naturalWidth>0));
  await native.getByLabel('问题',{exact:true}).fill('Draft preserved while image addresses update');
  await select(4);
  await native.getByLabel('问题',{exact:true}).waitFor();
  await page.waitForFunction(()=>document.querySelector('iframe[name="frameEditor"]').contentDocument.querySelector('.maic-question textarea')?.value==='Second Quiz');
  await image.evaluate(async node=>{await node.decode();});
  assert(await image.evaluate(node=>node.naturalWidth>0),'second Quiz must receive its own page-scoped image URLs');
  assert.match(await image.getAttribute('src'),/^data:image\/png;base64,/);
  await select(2);
  await page.waitForFunction(()=>document.querySelector('iframe[name="frameEditor"]').contentDocument.querySelector('.maic-question textarea')?.value==='Draft preserved while image addresses update');
  await image.evaluate(async node=>{await node.decode();});
  assert(await image.evaluate(node=>node.naturalWidth>0));
  assert(await page.evaluate(()=>window.__quizImageFrame===document.querySelector('iframe[name="frameEditor"]').contentWindow),'navigation and image hydration retain the iframe');
  assert.deepEqual(await native.getByRole('alert').allTextContents(),[]);
  console.log('PASS: page-scoped Quiz thumbnail URLs hydrate on navigation without losing document or draft');
} finally {await browser.close();await new Promise(done=>server.close(done));}
