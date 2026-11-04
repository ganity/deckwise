import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const requireRuntime = createRequire(path.join(root, 'packages/courseware-runtime/package.json'));
const { build } = requireRuntime('esbuild');
const { chromium } = requireRuntime('@playwright/test');
const output = await mkdtemp(path.join(tmpdir(), 'maic-editor-browser-'));
const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5X0AAAAASUVORK5CYII=';
await build({ stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import {CoursewareClassroomEditor} from './src/components/workpanel/CoursewareClassroomEditor'; createRoot(document.getElementById('root')).render(React.createElement(CoursewareClassroomEditor,{sessionId:'fixture'}));`, resolveDir: path.join(root, 'apps/desktop'), loader: 'tsx' }, bundle: true, write: true, outfile: path.join(output, 'app.js'), format: 'esm', jsx: 'automatic' });
const server = http.createServer(async (req, res) => {
  try {
    if (req.url === '/') { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><html><head><link rel="stylesheet" href="app.css"></head><body><div id="root" style="height:900px"></div><script type="module" src="app.js"></script></body></html>'); return; }
    res.setHeader('content-type', req.url === '/app.css' ? 'text/css' : 'text/javascript'); res.end(await readFile(path.join(output, req.url.slice(1))));
  } catch { res.statusCode = 404; res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1100 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(({ image }) => {
    const now = Date.now();
    let view = { projectId: 'project', revision: '0', sourceRevision: 'source', classroom: { id: 'course', createdAt: new Date(now).toISOString(), stage: { id: 'course', name: 'Test', createdAt: now, updatedAt: now }, scenes: [
      { id: 'quiz', stageId: 'course', type: 'quiz', title: 'Image quiz', order: 1, content: { type: 'quiz', interactionMode: 'classroom_instant_feedback', questions: [{ id: 'q', type: 'single', question: 'Choose a greeting', options: [{value:'A',label:'Hello'}, {value:'B',label:'Bye'}], answer:['A'] }] }, actions: [] },
      { id: 'slide', stageId: 'course', type: 'slide', title: 'Interaction', order: 2, content: { type: 'slide', canvas: { id: 'slide', elements: [{ id:'slide_question', type:'text', content:'<p>Old question</p>' }] } }, actions: [{ id:'checkpoint', type:'interaction_checkpoint', checkpointId:'checkpoint', checkpointKind:'chapter_summary', chapterId:'chapter', chapterTitle:'Chapter', question:'Old question', referenceAnswer:{summary:'Old reference',keyPoints:[]}, context:{chapterSummary:'Context',sourceSceneIds:[]} }] },
    ] } };
    let failImage = true; window.__writes = []; window.__imageRevisions = []; window.__ttsCalls = [];
    window.piDesktop = { platform:'linux', invoke: async (channel, input) => {
      if (channel.endsWith('/tts/models')) { window.__ttsCalls.push('models'); return {ok:true,data:[{model:'fixture-model',voices:['fixture-voice'],providerDefaultVoice:false}]}; }
      if (channel.endsWith('/open')) return {ok:true,data:structuredClone(view)};
      if (input.expectedRevision !== view.revision || input.expectedSourceRevision !== view.sourceRevision) return {ok:false,error:{message:'CAS conflict'}};
      if (channel.includes('/tts/')) {
        const kind = channel.split('/').at(-1); window.__ttsCalls.push(kind);
        if (kind === 'quote') return {ok:true,data:{key:'tts',state:'quoted',quote:{quoteId:'quote',maxPoints:7,expiresAt:new Date(Date.now()+60000).toISOString()}}};
        if (kind === 'submit') { if(input.quoteId!=='quote') return {ok:false,error:{message:'quote required'}}; return {ok:true,data:{key:'tts',state:'processing'}}; }
        view.revision=String(Number(view.revision)+1); view.classroom.audioManifest=[{sceneId:'quiz',actionId:input.actionId,assetId:'audio',audioId:'audio',mimeType:'audio/wav',url:'asset.wav',originalUrl:'asset.wav'}];
        window.__currentView=structuredClone(view); return {ok:true,data:{key:'tts',state:'adopted',view:structuredClone(view)}};
      }
      if (channel.endsWith('/write')) { view = {...view, revision:String(Number(view.revision)+1), classroom:structuredClone(input.classroom)}; window.__writes.push(structuredClone(view)); }
      if (channel.endsWith('/image')) {
        window.__imageRevisions.push(input.expectedRevision);
        if (failImage) { failImage = false; return {ok:false,error:{message:'fixture image failure'}}; }
        const q = view.classroom.scenes.find(s=>s.id===input.sceneId).content.questions.find(q=>q.id===input.questionId);
        (input.optionValue ? q.options.find(o=>o.value===input.optionValue) : q).image = {src:image,assetId:'image',mimeType:'image/png'};
        view.revision=String(Number(view.revision)+1);
      }
      if (channel.endsWith('/reference')) { view.classroom.scenes.find(s=>s.id===input.sceneId).actions.find(a=>a.id===input.actionId).referenceAnswer.summary = 'Updated reference'; view.revision=String(Number(view.revision)+1); }
      window.__currentView = structuredClone(view); return {ok:true,data:structuredClone(view)};
    } };
  }, { image });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.getByLabel('问题', { exact:true }).fill('Updated greeting');
  await page.waitForFunction(() => window.__writes.some(v => v.classroom.scenes[0].content.questions[0].question === 'Updated greeting'));
  await page.getByLabel('题目图片', { exact:true }).setInputFiles({ name:'one.png', mimeType:'image/png', buffer:Buffer.from(image.split(',')[1], 'base64') });
  await page.getByRole('alert').filter({hasText:'fixture image failure'}).waitFor();
  await page.getByLabel('题目图片', { exact:true }).setInputFiles({ name:'one.png', mimeType:'image/png', buffer:Buffer.from(image.split(',')[1], 'base64') });
  await page.getByRole('img', { name:'题目图片', exact:true }).waitFor();
  const revisions = await page.evaluate(() => window.__imageRevisions);
  assert.equal(revisions.length, 2); assert.ok(Number(revisions[1]) > Number(revisions[0]));
  await page.getByRole('button', { name:'2. 互动 · Interaction', exact:true }).click();
  await page.getByLabel('问题', { exact:true }).fill('New <question>');
  await page.getByRole('button', { name:'保存课程', exact:true }).click();
  await page.waitForFunction(() => window.__currentView.classroom.scenes[1].actions[0].question === 'New <question>');
  const saved = await page.evaluate(() => window.__currentView);
  assert.equal(saved.classroom.scenes[1].content.canvas.elements[0].content, '<p>New &lt;question&gt;</p>');
  await page.getByRole('button', { name:'根据当前问题更新参考答案', exact:true }).click();
  await page.getByLabel('参考答案', { exact:true }).waitFor();
  await page.waitForFunction(() => document.querySelector('textarea') && window.__currentView.classroom.scenes[1].actions[0].referenceAnswer.summary === 'Updated reference');
  await page.getByRole('button', { name:'1. Quiz · Image quiz', exact:true }).click();
  await page.locator('.maic-question select').selectOption('multiple');
  await page.getByRole('checkbox', { name:'正确答案 A', exact:true }).check();
  await page.getByRole('checkbox', { name:'正确答案 B', exact:true }).check();
  await page.getByRole('button', { name:'保存课程', exact:true }).click();
  await page.waitForFunction(() => window.__currentView.classroom.scenes[0].content.questions[0].answer.length === 2);
  page.once('dialog', dialog => dialog.accept());
  await page.locator('.maic-question select').selectOption('judge');
  await page.getByRole('radio', { name:'正确答案 T', exact:true }).check();
  await page.getByRole('button', { name:'保存课程', exact:true }).click();
  await page.waitForFunction(() => window.__currentView.classroom.scenes[0].content.questions[0].type === 'judge');
  assert.deepEqual(await page.evaluate(() => window.__currentView.classroom.scenes[0].content.questions[0].options.map(option => option.value)), ['T','F']);
  page.once('dialog', dialog => dialog.accept());
  await page.locator('.maic-question select').selectOption('short_answer');
  await page.getByLabel('参考答案', {exact:true}).fill('  My exact reference  ');
  await page.getByRole('button', { name:'保存课程', exact:true }).click();
  await page.waitForFunction(() => window.__currentView.classroom.scenes[0].content.questions[0].answer[0] === '  My exact reference  ');
  assert.equal(await page.evaluate(() => window.__currentView.classroom.scenes[0].content.questions[0].hasAnswer), false);
  await page.getByText('讲解与语音', {exact:true}).click();
  await page.getByRole('button', {name:'添加讲解',exact:true}).click();
  await page.getByRole('button', {name:'读取语音模型',exact:true}).click();
  await page.getByRole('button', {name:'获取语音报价',exact:true}).click();
  await page.getByText('本次语音费用上限：7 积分。', {exact:false}).waitFor();
  assert.deepEqual(await page.evaluate(()=>window.__ttsCalls),['models','quote']);
  await page.getByRole('button', {name:'确认报价并生成语音',exact:true}).click();
  await page.getByRole('button', {name:'刷新并应用语音',exact:true}).click();
  await page.waitForFunction(()=>window.__currentView.classroom.audioManifest?.length===1);
  assert.deepEqual(await page.evaluate(()=>window.__ttsCalls),['models','quote','submit','refresh']);
  assert.deepEqual(errors, []);
  console.log('PASS real renderer: autosave, failed image retry, checkpoint canvas synchronization, reference regeneration, four question types, explicit TTS quote/submit/adopt');
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); await rm(output,{recursive:true,force:true}); }
