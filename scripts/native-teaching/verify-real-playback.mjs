import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join, extname, sep } from 'node:path';
import { createRequire } from 'node:module';
import { launchPlaybackBrowser } from '../../packages/courseware-runtime/scripts/playback-browser.mjs';

const [directory, evidence] = process.argv.slice(2);
assert(directory && evidence && resolve(directory) === directory && resolve(evidence) === evidence, 'Supply absolute build and new evidence directories');
await mkdir(evidence);
const runtime = resolve(import.meta.dirname, '../../packages/courseware-runtime');
const require = createRequire(join(runtime, 'package.json'));
const { build } = require('esbuild');
const bytes = await readFile(join(directory, 'package.json'));
const buildId = createHash('sha256').update(bytes).digest('hex');
const payload = JSON.parse(bytes);
await build({ stdin: { contents: `import {mountFixedBuild,englishPlayerLabels} from './player.mjs';
window.__audios=[]; const AudioClass=window.Audio;window.Audio=function(...args){const audio=new AudioClass(...args);window.__audios.push(audio);return audio;};
const bytes=new Uint8Array(await(await fetch('/package.json')).arrayBuffer());
window.unmount=await mountFixedBuild(document.querySelector('#player'),bytes,${JSON.stringify(buildId)},async asset=>new Uint8Array(await(await fetch('/'+asset.path)).arrayBuffer()),{labels:englishPlayerLabels,width:960});`,
  resolveDir: join(runtime, 'dist'), sourcefile: 'native-real-playback.mjs', loader: 'js' },
  bundle: true, format: 'esm', platform: 'browser', outfile: join(evidence, 'player.mjs'), define: { 'process.env.NODE_ENV': '"production"' } });
const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    if (pathname === '/') { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/player.css"><div id="player"></div><script type="module" src="/player.mjs"></script>'); return; }
    const root = pathname === '/player.mjs' ? evidence : pathname === '/player.css' ? join(runtime, 'dist') : directory;
    const path = resolve(root, '.' + pathname);
    assert(path.startsWith(root + sep));
    response.setHeader('Content-Type', { '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.mp3': 'audio/mpeg' }[extname(path)] ?? 'application/octet-stream');
    response.end(await readFile(path));
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  ({ browser } = await launchPlaybackBrowser());
  const page = await browser.newPage({ viewport: { width: 1120, height: 850 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => ['127.0.0.1'].includes(new URL(route.request().url()).hostname) || ['blob:', 'data:'].includes(new URL(route.request().url()).protocol) ? route.continue() : route.abort());
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.locator('[data-player-mode]').waitFor();
  const group = payload.pages[0].nativeTimeline.groups[0];
  const wrapper = page.locator(`[data-slide-render-element-id="${group.elementId}"]`);
  assert.equal(await wrapper.locator('[data-slide-render-element-id]').count(), group.children.length);
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await page.waitForFunction(() => window.__audios.some(audio => !audio.paused && audio.currentTime > .1), { timeout: 20000 });
  await page.locator('[data-fixed-effect="highlight"]').waitFor();
  await page.locator('[data-fixed-effect="spotlight"]').waitFor();
  const animatedGroups = await page.evaluate(() => document.getAnimations().filter(animation => animation.effect?.target?.dataset?.slideRenderElementId?.startsWith('native_group_')).length);
  assert(animatedGroups > 0, 'Native group animations did not execute');
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[data-player-mode]').dataset.playerMode === 'paused');
  const paused = await page.evaluate(() => window.__audios.filter(audio => audio.currentTime > 0).every(audio => audio.paused)); assert(paused);
  await page.getByRole('button', { name: 'Resume', exact: true }).click();
  await page.waitForFunction(() => window.__audios.some(audio => !audio.paused && audio.currentTime > .2));
  await page.screenshot({ path: join(evidence, 'native-group-attention-playback.png') });
  for (let index = 1; index < payload.pages.length; index++) {
    await page.getByRole('button', { name: 'Next page', exact: true }).click();
    try { await page.waitForFunction(pageId => document.querySelector('[data-player-mode]').dataset.pageId === pageId, payload.pages[index].pageId, { timeout: 10000 }); }
    catch (error) { await page.screenshot({ path: join(evidence, `navigation-${index + 1}-failure.png`) }); console.error('Navigation failed', index + 1, await page.locator('body').innerText(), errors); throw error; }
    if (payload.pages[index].actions.some(action => action.type === 'speech')) {
      try { await page.waitForFunction(() => window.__audios.some(audio => !audio.paused && audio.currentTime > .05), null, { timeout: 20000 }); }
      catch (error) { await page.screenshot({ path: join(evidence, `page-${index + 1}-failure.png`) }); console.error('Failed page', index + 1, await page.locator('body').innerText(), errors); throw error; }
    }
    const question = payload.pages[index].actions.find(action => action.type === 'interaction_checkpoint' && action.response);
    if (question) {
      await page.evaluate(() => { const audio = window.__audios.find(audio => !audio.paused && audio.duration > 0); if (audio) audio.currentTime = audio.duration - .03; });
      await page.waitForFunction(() => document.querySelector('[data-player-mode]').dataset.playerMode === 'waiting_interaction');
      await page.getByText(question.question, { exact: true }).last().waitFor();
      assert.equal(await page.getByRole('radio').count(), question.response.options.length);
    }
  }
  const finalCheckpoint = payload.pages.at(-1).actions.find(action => action.type === 'interaction_checkpoint');
  await page.getByText(finalCheckpoint.question, { exact: true }).last().waitFor();
  assert.deepEqual(errors, []);
  await page.screenshot({ path: join(evidence, 'native-assessment-playback.png') });
  await page.evaluate(() => window.unmount());
  assert(await page.evaluate(() => window.__audios.every(audio => audio.paused)), 'Unmount leaked playing audio');
  const report = { buildId, pages: payload.pages.length, adoptedAudio: payload.assets.filter(asset => asset.mimeType.startsWith('audio/')).length,
    nativeGroupWrappers: payload.pages.reduce((count, page) => count + (page.nativeTimeline?.groups?.length ?? 0), 0),
    actualAudioPlayback: true, nativeAnimations: true, groupHighlightAndSpotlight: true, pauseResume: true, allPagesNavigated: true, assessmentVisible: true, errors };
  await writeFile(join(evidence, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
  await page.close();
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
