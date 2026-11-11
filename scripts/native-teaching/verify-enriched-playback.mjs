import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join, extname, sep } from 'node:path';
import { createRequire } from 'node:module';
import { launchPlaybackBrowser } from '../../packages/courseware-runtime/scripts/playback-browser.mjs';

const [directory, evidence, teachingFile] = process.argv.slice(2);
assert(directory && evidence && teachingFile && resolve(directory) === directory && resolve(evidence) === evidence, 'Supply absolute build and new evidence directories');
await mkdir(evidence);
const runtime = resolve(import.meta.dirname, '../../packages/courseware-runtime');
const require = createRequire(join(runtime, 'package.json'));
const bytes = await readFile(join(directory, 'package.json'));
const buildId = createHash('sha256').update(bytes).digest('hex');
const payload = JSON.parse(bytes);
assert(payload.pages.length > 0, 'Expected an enriched lesson');
await require('esbuild').build({ stdin: { contents: `import {mountFixedBuild,englishPlayerLabels} from './player.mjs';
window.__audios=[]; const NativeAudio=window.Audio;window.Audio=function(...args){const audio=new NativeAudio(...args);window.__audios.push(audio);return audio;};
window.unmount=await mountFixedBuild(document.querySelector('#player'),new Uint8Array(await(await fetch('/package.json')).arrayBuffer()),${JSON.stringify(buildId)},async asset=>new Uint8Array(await(await fetch('/'+asset.path)).arrayBuffer()),{labels:englishPlayerLabels,width:960});`,
  resolveDir: join(runtime, 'dist'), sourcefile: 'enriched-playback.mjs', loader: 'js' },
  bundle: true, format: 'esm', platform: 'browser', outfile: join(evidence, 'player.mjs'), define: { 'process.env.NODE_ENV': '"production"' } });
const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    if (pathname === '/') { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/player.css"><div id="player"></div><script type="module" src="/player.mjs"></script>'); return; }
    const root = pathname === '/player.mjs' ? evidence : pathname === '/player.css' ? join(runtime, 'dist') : directory;
    const file = resolve(root, '.' + pathname); assert(file.startsWith(root + sep));
    response.setHeader('Content-Type', { '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.mp4': 'video/mp4', '.wav': 'audio/wav' }[extname(file)] ?? 'application/octet-stream');
    response.end(await readFile(file));
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  ({ browser } = await launchPlaybackBrowser());
  const page = await browser.newPage({ viewport: { width: 1120, height: 850 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' || ['blob:', 'data:'].includes(new URL(route.request().url()).protocol) ? route.continue() : route.abort());
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const teaching = JSON.parse(await readFile(teachingFile, 'utf8'));
  const enrichment = teaching.enrichment;
  assert(enrichment, 'Expected accepted source bindings');
  const packageData = JSON.parse(bytes);
  for (const source of enrichment.originalPages) {
    const expected = enrichment.script?.segments.filter(segment => segment.pageId === source.pageId).map(segment => segment.text);
    if (expected?.length && enrichment.script.policy === 'preserve') assert.deepEqual(
      packageData.pages.find(page => page.pageId === source.pageId)?.actions.filter(action => action.type === 'speech').map(action => action.text), expected);
  }
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await page.waitForFunction(() => window.__audios.some(audio => !audio.paused && audio.currentTime > .05));
  let answered = 0, teacherActivities = 0;
  for (const [index, item] of packageData.pages.entries()) {
    if (index) await page.getByRole('button', { name: 'Next page', exact: true }).click();
    await page.waitForFunction(pageId => document.querySelector('[data-player-mode]')?.dataset.pageId === pageId, item.pageId);
    const checkpoint = item.actions.find(action => action.type === 'interaction_checkpoint');
    if (!checkpoint) continue;
    if (checkpoint.response?.answerIndices?.length) {
      const options = page.getByRole(checkpoint.response.kind === 'multiple' ? 'checkbox' : 'radio');
      for (const answer of checkpoint.response.answerIndices) await options.nth(answer).check();
      await page.getByRole('button', { name: 'Check answer', exact: true }).click();
      await page.getByText('Correct', { exact: true }).waitFor(); answered++;
    } else {
      await page.getByRole('button', { name: 'Teacher continue', exact: true }).waitFor(); teacherActivities++;
    }
  }
  assert.deepEqual(errors, []); assert.equal(await page.getByRole('alert').count(), 0);
  await page.screenshot({ path: join(evidence, 'enriched-playback.png') });
  await page.evaluate(() => window.unmount());
  assert(await page.evaluate(() => window.__audios.every(audio => audio.paused)), 'Unmount leaked audio');
  const report = { buildId, pages: packageData.pages.length, preservedSourcePages: enrichment.originalPages.length,
    exactSourceWords: enrichment.script?.policy === 'preserve', speechClock: true, quizAnswersChecked: answered, teacherActivities, errors };
  await writeFile(join(evidence, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
  await page.close();
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
