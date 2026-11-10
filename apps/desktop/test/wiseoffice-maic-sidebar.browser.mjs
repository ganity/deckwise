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
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.route("**/*", route => route.request().url().startsWith(origin) || /^(blob|data):/.test(route.request().url()) ? route.continue() : route.abort());
  await page.addInitScript(() => {
    window.__commands = []; window.__events = []; window.__writes = []; window.__classroomWrites = [];
    let canonical = {projectId:'project', revision:'0', sourceRevision:'source', classroom:{id:'course',createdAt:'2026-11-06',stage:{id:'stage',name:'Lesson',createdAt:1,updatedAt:1},scenes:[
      {id:'body',stageId:'stage',type:'slide',title:'Lesson',order:1,metadata:{nativeTeachingSyncPending:true},content:{type:'slide',canvas:{id:'body',elements:[]}},actions:[]},
      {id:'quiz',stageId:'stage',type:'quiz',title:'Greetings',order:2,content:{type:'quiz',questions:[{id:'q',type:'single',question:'Choose a greeting',options:[{value:'A',label:'Hello'},{value:'B',label:'Bye'}],answer:['A']}],interactionMode:'classroom_instant_feedback'},actions:[]},
      {id:'interaction',stageId:'stage',type:'slide',title:'Discuss',order:3,content:{type:'slide',canvas:{id:'interaction',elements:[{id:'interaction_question',type:'text',content:'<p>Introduce yourself</p>'}]}},actions:[{id:'cp',type:'interaction_checkpoint',checkpointId:'cp',checkpointKind:'chapter_summary',chapterId:'chapter',chapterTitle:'Discuss',question:'Introduce yourself',constraintPrompt:'',referenceAnswer:{summary:'My name is Pandy',keyPoints:['Name']},context:{chapterSummary:'Names',sourceSceneIds:[]}}]}
    ]}};
    for (const scene of canonical.classroom.scenes.slice(1)) {
      const id = scene.id + '-question-tts';
      const question = scene.type === 'quiz' ? scene.content.questions[0].question : scene.actions[0].question;
      scene.metadata = { assessmentSpeechIds: { [scene.type === 'quiz' ? scene.id : 'cp']: id } };
      scene.actions.unshift({ id, type: 'speech', text: question, audioId: id + '-audio' });
    }
    const project = { teachingRevision: "revision", source: { sha256: "a".repeat(64) }, pages: [{ pageId: "page", locked: false, actions: [
      { id: "speech", type: "speech", text: "Greet your friend." },
      { id: "checkpoint", type: "interaction_checkpoint", checkpointId: "question", checkpointKind: "chapter_summary",
        chapterId: "chapter", chapterTitle: "Greetings", question: "How do you greet your friend?",
        response: { kind: "practice", options: [], answerIndices: [] }, referenceAnswer: { summary: "Say Hello", keyPoints: ["Hello"] }, context: { chapterSummary: "Greet", sourceSceneIds: [] } },
    ] }] };
    project.pages.push({pageId:"quiz",locked:false,actions:[]},{pageId:"interaction",locked:false,actions:[]});
    const ttsTasks = new Map();
    window.__enableEmbedded = () => {
      canonical.revision = String(Number(canonical.revision)+1);
      project.pages[0].actions[0].audioAssetId = 'body-narration';
      const body = canonical.classroom.scenes[0];
      body.metadata = {nativeEmbeddedAssessments:true,assessmentSpeechIds:{checkpoint:'body-question-tts'}};
      body.actions = [{id:'body-question-tts',type:'speech',text:project.pages[0].actions[1].question,audioId:'body-audio'},structuredClone(project.pages[0].actions[1])];
      window.__embedded = true;
    };
    window.deckwiseEditorHost = {
      onCommand(listener) { window.__commands.push(listener); return () => {}; },
      sendEvent(event) {
        const message = event.message; window.__events.push(message ?? event);
        if (message?.type !== "document:teaching-request") return;
        const { operation, args, context } = message.payload;
        if (window.__insufficientTts && operation === 'tts:submit') {
          queueMicrotask(() => window.__commands.forEach(listener => listener({ type: 'document:teaching-response', id: message.id, payload: { error: 'COURSEWARE_MEDIA_INSUFFICIENT_POINTS' } })));
          return;
        }
        if (window.__failPreview && operation === 'classroom:audio:preview') {
          queueMicrotask(() => window.__commands.forEach(listener => listener({ type: 'document:teaching-response', id: message.id, payload: { error: 'Fixture audio unavailable' } })));
          return;
        }
        let result;
        if (operation === "open") result = { viewId: "view", pageId: project.pages[context.page-1].pageId, pageNumber: context.page, project: structuredClone(project), hasAssessments:true, ...(context.page > 1 ? {assessment:structuredClone(canonical)} : window.__embedded ? {embeddedAssessment:structuredClone(canonical)} : {}) };
        else if(operation === 'classroom:open') result = structuredClone(canonical);
        else if(operation === 'classroom:audio:preview' || operation === 'tts:preview') {
          const bytes = new Uint8Array(44 + 1600), wave = new DataView(bytes.buffer);
          const text = (offset, value) => [...value].forEach((char, i) => bytes[offset + i] = char.charCodeAt(0));
          text(0, 'RIFF'); wave.setUint32(4, bytes.length - 8, true); text(8, 'WAVE'); text(12, 'fmt ');
          wave.setUint32(16, 16, true); wave.setUint16(20, 1, true); wave.setUint16(22, 1, true);
          wave.setUint32(24, 8000, true); wave.setUint32(28, 16000, true); wave.setUint16(32, 2, true); wave.setUint16(34, 16, true);
          text(36, 'data'); wave.setUint32(40, 1600, true);
          result = { bytes, mimeType: 'audio/wav' };
        }
        else if(operation === 'classroom:write') {
          canonical = {...canonical,revision:String(Number(canonical.revision)+1),classroom:structuredClone(args.classroom)};
          for(const scene of canonical.classroom.scenes) for(const [key,id] of Object.entries(scene.metadata?.assessmentSpeechIds??{})){
            const speech=scene.actions.find(action=>action.id===id);
            const text=scene.content.type==='quiz'?scene.content.questions.map(q=>[q.question,...(q.options??[]).map(o=>o.value+'. '+o.label)].join('\n')).join('\n\n'):scene.actions.find(a=>a.id===key).question;
            if(speech.text!==text){speech.text=text;delete speech.audioId;delete speech.audioUrl;canonical.classroom.audioManifest=canonical.classroom.audioManifest?.filter(entry=>entry.sceneId!==scene.id||entry.actionId!==id);}
          }
          window.__classroomWrites.push(structuredClone(canonical)); result=structuredClone(canonical);
        }
        else if(operation === 'classroom:tts:models') result = [{model:'fixture-model',voices:['fixture-voice'],providerDefaultVoice:false}];
        else if(operation === 'classroom:tts:quote') result = {key:'canonical-tts',state:'quoted',quote:{quoteId:'canonical-quote',maxPoints:7,expiresAt:new Date(Date.now()+60000).toISOString()}};
        else if(operation === 'classroom:tts:submit') { if(args.quoteId!=='canonical-quote'||args.regenerate!==true)throw Error('Explicit regeneration quote required');result={key:'canonical-tts',state:'running'}; }
        else if(operation === 'classroom:tts:refresh') {
          const speech=canonical.classroom.scenes.find(scene=>scene.id===args.sceneId).actions.find(a=>a.id===args.actionId);
          speech.audioId='generated-'+args.sceneId;
          canonical.classroom.audioManifest=[...(canonical.classroom.audioManifest??[]).filter(entry=>entry.sceneId!==args.sceneId||entry.actionId!==args.actionId),{sceneId:args.sceneId,actionId:args.actionId,audioId:speech.audioId}];
          canonical.revision=String(Number(canonical.revision)+1);
          result={key:'canonical-tts',state:'adopted',view:structuredClone(canonical)};
        }
        else if(operation === 'classroom:play' || operation === 'classroom:preview-course') result={ok:true};
        else if (operation === "draft:get" || operation === "draft:set") result = { draft: null };
        else if (operation === 'tts:models') result = [{model:'fixture-model',voices:['fixture-voice'],providerDefaultVoice:false}];
        else if (operation === 'tts:list') result = [...ttsTasks.values()];
        else if (operation === 'tts:prepare') {
          result = {...args,intentId:'intent-'+ttsTasks.size,phase:'prepared',current:true,task:null};
          ttsTasks.set(result.intentId,result);
        }
        else if (operation === 'tts:quote') result = {quoteId:'native-quote',maxPoints:7};
        else if (operation === 'tts:submit') {
          if(args.quoteId!=='native-quote') throw Error('Quote required');
          result = {...ttsTasks.get(args.intentId),phase:'submitted',task:{state:'running'}};
          ttsTasks.set(args.intentId,result);
        }
        else if (operation === 'tts:status') {
          result = {...ttsTasks.get(args.intentId),task:{state:'ready'}}; ttsTasks.set(args.intentId,result);
        }
        else if (operation === 'tts:archive') result = {};
        else if (operation === 'tts:adopt') {
          const task = ttsTasks.get(args.intentId), action = project.pages[0].actions.find(a=>a.id===task.actionId);
          action.audioAssetId = 'generated-'+task.intentId; action.durationMs = 100;
          project.teachingRevision = 'adopted-'+task.intentId;
          result = {viewId:'view',pageId:'page',pageNumber:1,project:structuredClone(project),...(window.__embedded?{embeddedAssessment:structuredClone(canonical)}:{})};
        }
        else if (operation === "media:list") result = [];
        else if (operation === "write") { window.__writes.push(structuredClone(args)); project.pages[0].actions = args.actions; result = { viewId: "view", pageId: "page", pageNumber: 1, project: structuredClone(project) }; }
        else throw Error("Unexpected native operation " + operation);
        const respond = () => queueMicrotask(() => window.__commands.forEach(listener => listener({ type: "document:teaching-response", id: message.id, payload: { result } })));
        if (operation === 'classroom:open' && window.__holdPreview) window.__releasePreview = respond;
        else if (operation === 'classroom:audio:preview' && window.__holdPreviewAudio) window.__releasePreviewAudio = respond;
        else respond();
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
  await native.locator('[data-teaching-inspector]').getByRole('button',{name:'生成语音',exact:true}).waitFor({timeout:30000});
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
  let selection = 0;
  const select = async value => {
    const id = `selection-${++selection}`;
    await page.evaluate(({ value, id, binding }) => {
      window.__commands.forEach(listener => listener({type:'document:configure-ui',id,payload:{page:value}}));
      window.__commands.forEach(listener => listener({type:'document:get-context',id:`${id}-context`,payload:binding}));
    }, { value, id, binding });
    await page.waitForFunction(({ value, id }) => window.__events.some(event => event.id === `${id}-context` && event.payload?.page === value),
      { value, id });
  };
  await select(2);
  await native.getByLabel('题型',{exact:true}).waitFor();
  await assertSharedHeader();
  assert.equal(await native.locator('.deckwise-teaching-sidebar .maic-editor').count(),1);
  assert.equal(await native.getByRole('button',{name:'预览题目',exact:true}).count(),0);
  assert.equal(await native.getByRole('button',{name:/编辑当前页题目|编辑当前题目/}).count(),0);
  assert.equal(await native.getByRole('button',{name:'保存课程',exact:true}).count(),0);
  assert.equal(await native.getByRole('button',{name:'添加题目',exact:true}).count(),0);
  assert.equal(await native.getByRole('button',{name:'删除题目',exact:true}).count(),0);
  assert.equal(await native.getByText(/原生教学流程中的音乐/).count(),0);
  await native.getByRole('button',{name:'画布预览',exact:true}).click();
  const quizPlayback = native.locator('[data-teaching-quiz]');
  await quizPlayback.waitFor();
  assert(await page.evaluate(() => window.__events.some(event => event.payload?.operation === 'classroom:audio:preview' && event.payload.args.sceneId === 'quiz')),
    'Native Quiz must load its managed question audio before showing the answer card');
  await quizPlayback.getByRole('button').filter({hasText:'Bye'}).click();
  await quizPlayback.getByRole('status').filter({hasText:'再试一次'}).waitFor();
  assert.equal(await quizPlayback.getByRole('button',{name:'教师继续',exact:true}).count(), 0);
  await quizPlayback.getByRole('button').filter({hasText:'Hello'}).click();
  await quizPlayback.getByRole('status').filter({hasText:'回答正确'}).waitFor();
  await quizPlayback.getByRole('button',{name:'教师继续',exact:true}).click();
  await quizPlayback.waitFor({state:'detached'});
  await native.getByLabel('问题',{exact:true}).fill('Updated native Quiz question');
  await panel.getByRole('button',{name:'撤销',exact:true}).waitFor({ state:'visible' });
  await assert.equal(await panel.getByRole('button',{name:'撤销',exact:true}).isDisabled(), false);
  await select(3);
  await select(2);
  await native.getByLabel('问题',{exact:true}).waitFor();
  assert.equal(await native.getByLabel('问题',{exact:true}).inputValue(), 'Updated native Quiz question');
  assert.equal(await panel.getByRole('button',{name:'撤销',exact:true}).isDisabled(), false,
    'Native page selection must preserve the canonical editor undo history');
  await panel.getByRole('button',{name:'撤销',exact:true}).click();
  assert.equal(await native.getByLabel('问题',{exact:true}).inputValue(), 'Choose a greeting');
  await panel.getByRole('button',{name:'重做',exact:true}).click();
  assert.equal(await native.getByLabel('问题',{exact:true}).inputValue(), 'Updated native Quiz question');
  await native.locator('.maic-question').getByRole('button',{name:'生成语音',exact:true}).click();
  await native.locator('.maic-question').getByRole('button',{name:'重新生成语音',exact:true}).waitFor();
  assert.equal(await native.locator('.maic-speech-tools').getByRole('button',{name:/报价|确认费用|刷新并应用/}).count(),0);
  assert.equal(await page.evaluate(()=>window.__events.filter(e=>e.payload?.operation==='classroom:tts:submit').length),1);
  await native.getByLabel('选项文字',{exact:true}).first().fill('Hi there');
  await panel.getByRole('button',{name:'保存本页教学',exact:true}).click();
  await page.waitForFunction(() => window.__classroomWrites.some(v=>v.classroom.scenes[1].content.questions[0].question==='Updated native Quiz question' && v.classroom.scenes[1].content.questions[0].options[0].label==='Hi there'));
  await panel.getByRole('button',{name:'刷新',exact:true}).click();
  await panel.locator('[data-status]').filter({hasText:'已自动保存'}).waitFor();
  assert.equal(await native.getByLabel('问题',{exact:true}).inputValue(), 'Updated native Quiz question');
  await page.screenshot({path:'/tmp/deckwise-native-quiz-shared-header.png'});
  assert.equal(await page.evaluate(() => window.__events.some(e => e.type === 'document:teaching-request' &&
    ['classroom:play', 'classroom:preview-course'].includes(e.payload.operation))), false,
    'Quiz preview must remain in the WiseOffice player');
  await select(3);
  await native.getByLabel('约束性提示词', {exact:true}).waitFor();
  await assertSharedHeader();
  await native.getByLabel('问题',{exact:true}).fill('What is your name?');
  await native.getByLabel('约束性提示词',{exact:true}).fill('Answer in one sentence');
  await page.waitForFunction(()=>window.__classroomWrites.some(v=>v.classroom.scenes[2].actions.some(a=>a.type==='interaction_checkpoint' && a.question==='What is your name?' && a.constraintPrompt==='Answer in one sentence')));
  await native.locator('.maic-question').getByRole('button',{name:'生成语音',exact:true}).click();
  await native.locator('.maic-question').getByRole('button',{name:'重新生成语音',exact:true}).waitFor();
  await page.evaluate(()=>{window.__holdPreview=true;window.__holdPreviewAudio=true;});
  await panel.locator('[data-preview-command="show"]').click();
  await page.waitForFunction(()=>typeof window.__releasePreview==='function');
  assert.match(await panel.locator('[data-status]').textContent(), /正在.*(放映|准备|读取)/,
    'The first click must visibly report preparation while the saved classroom is loading');
  assert.equal(await panel.locator('[data-preview-command="show"]').isDisabled(),true,
    'An in-flight start must disable duplicate starts immediately');
  assert.equal(await panel.getAttribute('aria-busy'),'true');
  assert(await panel.locator('[data-preview-loading]').isVisible());
  await page.screenshot({path:'/tmp/deckwise-native-preview-preparing-20261107.png'});
  await page.evaluate(()=>{window.__holdPreview=false;window.__releasePreview();delete window.__releasePreview;});
  await page.waitForFunction(()=>typeof window.__releasePreviewAudio==='function');
  assert.match(await panel.locator('[data-status]').textContent(), /正在准备语音和媒体/);
  assert.equal(await panel.locator('[data-preview-command="show"]').isDisabled(),true);
  await page.evaluate(()=>{window.__holdPreviewAudio=false;window.__releasePreviewAudio();delete window.__releasePreviewAudio;});
  const interactionPlayback = native.locator('[data-teaching-question]');
  await interactionPlayback.waitFor({timeout:12000});
  assert.equal(await panel.getAttribute('aria-busy'),'false');
  assert.equal(await panel.locator('[data-preview-loading]').isVisible(),false);
  assert(await interactionPlayback.textContent().then(text => text?.includes('What is your name?')),
    'WiseOffice interaction playback must use the canonical MAIC checkpoint when native actions are empty');
  assert.deepEqual(await page.evaluate(() => window.__classroomWrites.at(-1).classroom.scenes[2].actions.find(action => action.checkpointKind === 'chapter_summary').context.sourceSceneIds), [],
    'An empty canonical source list must play without inventing a current-page source');
  await interactionPlayback.getByRole('button',{name:'教师继续',exact:true}).click();
  await interactionPlayback.waitFor({state:'detached'});
  await page.keyboard.press('Escape');
  await page.evaluate(()=>{window.__failPreview=true;});
  await panel.locator('[data-preview-command="show"]').click();
  await panel.locator('[data-status][role="alert"]').filter({hasText:'Fixture audio unavailable'}).waitFor();
  assert.equal(await panel.getAttribute('aria-busy'),'false');
  assert.equal(await panel.locator('[data-preview-command="show"]').isDisabled(),false);
  await page.evaluate(()=>{window.__failPreview=false;});
  for (let attempt=0; attempt<3; attempt++) {
    await panel.locator('[data-preview-command="show"]').click();
    await interactionPlayback.waitFor({timeout:12000});
    await interactionPlayback.getByRole('button',{name:'教师继续',exact:true}).click();
    await interactionPlayback.waitFor({state:'detached'});
    await page.keyboard.press('Escape');
  }
  assert(await page.evaluate(() => window.__events.some(event => event.payload?.operation === 'classroom:audio:preview' && event.payload.args.sceneId === 'interaction')),
    'Native checkpoint must read its question before waiting for the learner');
  assert.equal(await native.locator('.deckwise-teaching-sidebar .teaching-inspector').count(),0);
  await page.screenshot({path:'/tmp/deckwise-native-interaction-editor.png'});
  await select(2);
  await native.getByLabel('题型',{exact:true}).waitFor();
  await assertSharedHeader();
  assert.equal(await native.getByLabel('问题',{exact:true}).inputValue(),'Updated native Quiz question');
  await native.getByLabel('问题',{exact:true}).fill('Draft survives navigation');
  await select(1);
  await native.getByRole('button',{name:'放映整课教学',exact:true}).waitFor();
  await page.waitForFunction(()=>window.__classroomWrites.some(v=>v.classroom.scenes[1].content.questions[0].question==='Draft survives navigation'));
  await native.getByRole('button',{name:'放映整课教学',exact:true}).click();
  await page.waitForTimeout(500);
  assert.equal(await page.evaluate(() => window.__events.some(e => e.type === 'document:teaching-request' &&
    ['classroom:play', 'classroom:preview-course'].includes(e.payload.operation))), false,
    'WiseOffice lesson playback must not open the standalone MAIC player');
  assert.equal(await page.evaluate(() => window.__writes.length), 0, 'Assessment header must never write native teaching actions');
  await select(2);
  await native.getByLabel('题型',{exact:true}).waitFor();
  await page.evaluate(()=>window.__enableEmbedded());
  await select(1);
  await native.getByLabel('问题',{exact:true}).waitFor({timeout:10000}).catch(async error=>{
    throw new Error(`${error.message}\n${await panel.innerText()}`);
  });
  assert(await native.locator('[data-action-id="speech"]').count() > 0, 'Embedded question tools retain the native body narration');
  await native.getByRole('button',{name:'画布预览',exact:true}).click();
  await native.locator('[data-teaching-question]').waitFor({timeout:10000}).catch(async error=>{
    throw new Error(`${error.message}\n${await panel.innerText()}`);
  });
  assert(await page.evaluate(()=>window.__events.some(event=>event.payload?.operation==='classroom:audio:preview'&&event.payload.args.sceneId==='body')),
    'Embedded questions use canonical question audio within the ordinary native timeline');
  await native.locator('[data-teaching-question]').getByRole('button',{name:'教师继续',exact:true}).click();
  await native.locator('.teaching-flow article[data-action-id="speech"]').click();
  const narration = native.locator('[data-teaching-inspector][data-action-id="speech"]');
  assert(await narration.getByRole('button',{name:'重新生成语音',exact:true}).isVisible());
  const ttsStyles = await panel.locator('.maic-speech-status > button, [data-tts-generate]').evaluateAll(nodes => nodes.map(node => {
    const style = getComputedStyle(node);
    return Object.fromEntries(['padding','border','borderRadius','backgroundColor','color','fontFamily','fontSize','lineHeight'].map(key=>[key,style[key]]));
  }));
  assert(ttsStyles.length >= 2);
  assert.deepEqual(ttsStyles[0],ttsStyles.at(-1),'Question and narration use the same TTS button style');
  await narration.getByLabel('第 1 段讲解',{exact:true}).fill('Updated narration for TTS.');
  await narration.getByRole('button',{name:'重新生成语音',exact:true}).click();
  await narration.getByText(/语音已就绪/).waitFor({timeout:10000});
  assert.equal(await narration.getByRole('button',{name:/报价|确认生成/}).count(),0);
  assert.equal(await page.evaluate(()=>window.__writes.at(-1).actions[0].text),'Updated narration for TTS.');
  assert.equal(await page.evaluate(()=>window.__writes.at(-1).actions[0].audioAssetId),undefined);
  await panel.locator('[data-status]').filter({hasText:'语音已就绪'}).waitFor();
  assert(await narration.getByRole('button',{name:'试听语音',exact:true}).isVisible());
  assert.equal(await page.evaluate(()=>window.__events.filter(e=>e.payload?.operation==='tts:submit').length),1);
  assert.equal(await page.evaluate(()=>window.__events.filter(e=>e.payload?.operation==='tts:adopt').length),1);
  await page.evaluate(()=>{window.__insufficientTts=true;});
  await narration.getByRole('button',{name:'重新生成语音',exact:true}).click();
  await panel.locator('[data-status]').filter({hasText:'积分不足，请充值后重试。'}).waitFor();
  assert.equal(await page.evaluate(()=>window.__events.filter(e=>e.payload?.operation==='tts:adopt').length),1);
  assert(await narration.getByRole('button',{name:'试听语音',exact:true}).isVisible(),'Insufficient points keeps the existing narration');
  await page.screenshot({path:'/tmp/deckwise-native-inline-tts.png'});
  assert.deepEqual(errors,[]);
  console.log('PASS: real native iframe edits Quiz and checkpoints in teaching flow, autosaves across navigation, and keeps playback in WiseOffice');

} finally { await browser.close(); await new Promise(done => server.close(done)); }
