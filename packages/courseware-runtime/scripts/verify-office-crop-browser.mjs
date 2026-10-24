import assert from 'node:assert/strict';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { launchPlaybackBrowser } from './playback-browser.mjs';

const output = process.argv[2];
assert(output && path.isAbsolute(output), 'Supply a new absolute evidence directory');
await mkdir(output);
const electron = process.argv.find(arg => arg.startsWith('--electron='))?.slice(11);
const fixture = JSON.parse(await readFile(new URL('../tests/fixtures/office-image-crop-b20/SOURCE.json', import.meta.url)));
const html = (await readFile(new URL('../tests/index.html', import.meta.url), 'utf8'))
  .replace('/tests/main.tsx', '/crop-probe.mjs')
  .replace('</head>', '<link rel="stylesheet" href="/dist/player.css"></head>');
const { browser, runtime } = await launchPlaybackBrowser(electron);
const report = { runtime, results: [] };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
try {
  for (const [name, expected] of Object.entries(fixture.variants)) {
    const directory = new URL(`../${expected.fixedBuild.outputDirectory}/${expected.fixedBuild.buildId}/`, import.meta.url);
    const bytes = await readFile(new URL('package.json', directory));
    assert.equal(sha(bytes), expected.fixedBuild.buildId);
    const payload = JSON.parse(bytes);
    assert.equal(payload.report.sourceSha256, fixture.files[`${name}.pptx`].sha256);
    assert.equal(payload.report.visualFidelity, 'NOT_VERIFIED');
    const files = new Map([['package.json', { body: bytes, contentType: 'application/json' }]]);
    for (const asset of payload.assets) {
      const body = await readFile(new URL(asset.path, directory));
      assert.equal(sha(body), asset.sha256);
      files.set(asset.path, { body, contentType: asset.mimeType });
    }
    for (const width of [960, 480]) {
      const page = await browser.newPage({ viewport: { width: 1180, height: 920 } });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.addInitScript(() => {
        window.__csp = []; window.__ttsCalls = 0; window.__audios = []; window.__pages = [];
        document.addEventListener('securitypolicyviolation', e => window.__csp.push(e.effectiveDirective));
        const NativeAudio = window.Audio;
        window.Audio = function (...args) { const audio = new NativeAudio(...args); window.__audios.push(audio); return audio; };
        speechSynthesis.speak = () => { window.__ttsCalls++; throw new Error('Unexpected browser TTS'); };
      });
      await page.route('**/*', route => {
        const url = new URL(route.request().url());
        if (url.hostname !== '127.0.0.1' && !['data:', 'blob:'].includes(url.protocol)) {
          errors.push(`External request: ${url.origin}`); return route.abort();
        }
        if (url.pathname === '/tests/crop.html') return route.fulfill({ body: html, contentType: 'text/html' });
        if (url.pathname === '/crop-probe.mjs') return route.fulfill({ contentType: 'text/javascript', body: `
          import { mountFixedBuild, englishPlayerLabels } from '/dist/player.mjs';
          const bytes = new Uint8Array(await (await fetch('/crop-build/package.json')).arrayBuffer());
          window.__dispose = await mountFixedBuild(document.querySelector('#root'), bytes, '${expected.fixedBuild.buildId}',
            async asset => new Uint8Array(await (await fetch('/crop-build/' + asset.path)).arrayBuffer()),
            { labels: englishPlayerLabels, width: ${width}, onPageChange: id => window.__pages.push(id) });
        ` });
        if (url.pathname.startsWith('/crop-build/')) {
          const file = files.get(url.pathname.slice('/crop-build/'.length));
          return file ? route.fulfill(file) : route.abort();
        }
        return route.continue();
      });
      try {
        await page.goto('http://127.0.0.1:4259/tests/crop.html');
        await page.locator('[data-player-mode]').waitFor();
        await page.getByRole('button', { name: 'Next page', exact: true }).click();
        await page.waitForFunction(() => window.__audios.some(a => !a.paused && a.currentTime > 0.15));
        await page.getByRole('button', { name: 'Pause', exact: true }).click();
        const pausedTime = await page.evaluate(() => window.__audios.at(-1).currentTime);
        await page.locator('[data-courseware-fonts-ready="true"]').waitFor();
        const crop = page.locator(`[data-slide-render-element-id="${expected.imageElementId}"] .image-content`);
        await crop.locator('img').evaluate(async image => { await image.decode(); });
        const geometry = await crop.locator('img').evaluate(image => {
          const box = image.parentElement.getBoundingClientRect();
          return { width: box.width, height: box.height, naturalWidth: image.naturalWidth,
            naturalHeight: image.naturalHeight, left: image.style.left, top: image.style.top,
            imageWidth: image.style.width, imageHeight: image.style.height };
        });
        assert.ok(Math.abs(geometry.width - width * 0.5625) < 0.1);
        assert.ok(Math.abs(geometry.height - width * 0.234375) < 0.1);
        assert.equal(geometry.naturalWidth, 100); assert.equal(geometry.naturalHeight, 100);
        const screenshot = await crop.screenshot({ path: path.join(output, `${name}-${width}-crop.png`) });
        const pixels = await page.evaluate(async data => {
          const image = new Image(); image.src = 'data:image/png;base64,' + data; await image.decode();
          const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
          const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
          return [0.05, 0.5, 0.95].map(x => [...context.getImageData(Math.floor(image.width * x), Math.floor(image.height / 2), 1, 1).data].slice(0, 3));
        }, screenshot.toString('base64'));
        assert.deepEqual(pixels, [[240, 80, 30], [250, 200, 40], [40, 110, 220]]);
        // A crop-box screenshot alone hides overflow outside that box.
        const viewport = await page.locator('.slide-viewport').screenshot({ path: path.join(output, `${name}-${width}-viewport.png`) });
        const outsidePixels = await page.evaluate(async data => {
          const image = new Image(); image.src = 'data:image/png;base64,' + data; await image.decode();
          const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
          const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
          return [[80, 390], [700, 390], [400, 540]].map(([x, y]) =>
            [...context.getImageData(Math.round(image.width * x / 1000), Math.round(image.height * y / 625), 1, 1).data].slice(0, 3));
        }, viewport.toString('base64'));
        assert.deepEqual(outsidePixels, [[255, 0, 0], [255, 0, 0], [255, 0, 0]]);
        await page.screenshot({ path: path.join(output, `${name}-${width}-page.png`) });
        // Screenshot decoding spans browser frames while the real narration remains paused.
        assert.equal(await page.evaluate(() => window.__audios.at(-1).currentTime), pausedTime);
        assert.equal(await page.evaluate(() => window.__audios.at(-1).paused), true);
        await page.getByRole('button', { name: 'Resume', exact: true }).click();
        await page.waitForFunction(time => window.__audios.at(-1).currentTime > time + 0.15, pausedTime);
        await page.evaluate(() => { const audio = window.__audios.at(-1); audio.currentTime = audio.duration - 0.15; });
        await page.getByRole('button', { name: 'Teacher continue', exact: true }).waitFor();
        assert.equal(await page.evaluate(() => window.__audios.at(-1).paused), true);
        await page.getByRole('button', { name: 'Teacher continue', exact: true }).click();
        await page.getByText('Playback complete', { exact: true }).waitFor();
        await page.getByRole('button', { name: 'Next page', exact: true }).click();
        await page.locator('[data-player-mode][data-page-id="fixture-B20-page-3"]').waitFor();
        await page.getByRole('button', { name: 'Previous page', exact: true }).click();
        await page.waitForFunction(() => window.__audios.some(a => !a.paused && a.currentTime > 0.1));
        await page.getByRole('button', { name: 'Previous page', exact: true }).click();
        await page.locator('[data-player-mode][data-page-id="fixture-B20-page-1"]').waitFor();
        assert.equal(await page.evaluate(() => window.__audios.some(a => !a.paused)), false);
        await page.getByRole('button', { name: 'Next page', exact: true }).click();
        await page.waitForFunction(() => window.__audios.some(a => !a.paused && a.currentTime > 0.1));
        assert.deepEqual(await page.evaluate(() => window.__pages), [
          'fixture-B20-page-2', 'fixture-B20-page-3', 'fixture-B20-page-2', 'fixture-B20-page-1', 'fixture-B20-page-2',
        ]);
        await page.evaluate(() => window.__dispose());
        assert.equal(await page.locator('[data-player-mode]').count(), 0);
        assert.equal(await page.evaluate(() => window.__audios.some(a => !a.paused)), false);
        assert.deepEqual(errors, []);
        assert.deepEqual(await page.evaluate(() => window.__csp), []);
        assert.equal(await page.evaluate(() => window.__ttsCalls), 0);
        report.results.push({ name, width, status: 'PASS', buildId: expected.fixedBuild.buildId,
          pixels, outsidePixels, geometry, emptyFirstAndFinalPageNavigation: true,
          actualNarrationAndWait: true, immutableHostSnapshotVerified: false });
        console.log('PASS', name, width);
      } catch (error) {
        await page.screenshot({ path: path.join(output, `${name}-${width}-failure.png`) });
        report.results.push({ name, width, status: 'FAIL', error: String(error), errors });
        throw error;
      } finally { await page.close(); }
    }
  }
} finally {
  await browser.close();
  await writeFile(path.join(output, 'results.json'), JSON.stringify(report, null, 2) + '\n');
}
assert.equal(report.results.length, 6);
