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
const bytes = await readFile(join(directory, 'package.json'));
const buildId = createHash('sha256').update(bytes).digest('hex');
const payload = JSON.parse(bytes);
assert.equal(payload.pages.length, 3, 'Use the generated body/Quiz/practice fixture');
await require('esbuild').build({ stdin: { contents: `import {mountFixedBuild,englishPlayerLabels} from './player.mjs';
window.__audios=[]; const NativeAudio=window.Audio;window.Audio=function(...args){const audio=new NativeAudio(...args);window.__audios.push(audio);return audio;};
window.unmount=await mountFixedBuild(document.querySelector('#player'),new Uint8Array(await(await fetch('/package.json')).arrayBuffer()),${JSON.stringify(buildId)},async asset=>new Uint8Array(await(await fetch('/'+asset.path)).arrayBuffer()),{labels:englishPlayerLabels,width:960});`,
  resolveDir: join(runtime, 'dist'), sourcefile: 'generated-playback.mjs', loader: 'js' },
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
  await page.addInitScript(() => {
    window.__animated = false;
    const sample = () => { window.__animated ||= [...document.querySelectorAll('[data-slide-render-element-id]')].some(node => Number(node.style.scale) > 1.01); requestAnimationFrame(sample); };
    requestAnimationFrame(sample);
  });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' || ['blob:', 'data:'].includes(new URL(route.request().url()).protocol) ? route.continue() : route.abort());
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await page.waitForFunction(() => window.__audios.some(a => !a.paused && a.currentTime > .05));
  await page.waitForFunction(() => window.__animated);
  await page.locator('[data-fixed-effect="highlight"]').waitFor();
  await page.locator('[data-fixed-effect="spotlight"]').waitFor();
  await page.waitForFunction(() => window.__audios.some(a => !a.paused && a.currentTime > .05 && window.__audios.indexOf(a) >= 1));
  const video = page.locator('video'); await video.waitFor();
  await video.evaluate(v => v.play());
  await page.waitForFunction(() => (document.querySelector('video')?.currentTime ?? 0) > .05);
  await page.getByRole('button', { name: 'Next page', exact: true }).click();
  await page.getByRole('radio').nth(1).check();
  await page.getByRole('button', { name: 'Check answer', exact: true }).click();
  await page.getByText('Correct', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Next page', exact: true }).click();
  await page.getByText('Greet your friend.', { exact: true }).last().waitFor();
  assert.deepEqual(errors, []); assert.equal(await page.getByRole('alert').count(), 0);
  await page.screenshot({ path: join(evidence, 'generated-complete-playback.png') });
  await page.evaluate(() => window.unmount());
  assert(await page.evaluate(() => window.__audios.every(a => a.paused)), 'Unmount leaked audio');
  const report = { buildId, pages: 3, speechAudio: true, musicAudio: true, videoPlayback: true, animation: true, highlight: true, spotlight: true, quizCorrectAnswer: true, practice: true, errors };
  await writeFile(join(evidence, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
  await page.close();
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
