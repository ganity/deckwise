import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { launchPlaybackBrowser } from './playback-browser.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = process.argv[2];
assert(output && path.isAbsolute(output), 'Supply a new absolute evidence directory');
await mkdir(output);
const temporary = await mkdtemp(path.join(os.tmpdir(), 'deckwise-native-media-'));
const report = { scope: 'Production FixedCoursewarePlayer/FixedMediaElement source, local decodable media, actual native events; no converter, Office, provider or packaged-app claim', results: [] };
let browser, server;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
try {
  for (const [name, args] of [
    ['narration.wav', ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=6', '-c:a', 'pcm_s16le']],
    ['page.wav', ['-f', 'lavfi', '-i', 'sine=frequency=220:duration=16', '-c:a', 'pcm_s16le']],
    ['page.mp4', ['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=15:duration=16', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=16', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', '-shortest']],
  ]) execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args, path.join(temporary, name)], { timeout: 20000 });
  report.fixtures = {};
  for (const name of ['narration.wav', 'page.wav', 'page.mp4']) {
    const bytes = await readFile(path.join(temporary, name));
    report.fixtures[name] = { sha256: sha(bytes), byteLength: bytes.length };
  }
  report.sources = {};
  for (const file of ['components/courseware/FixedCoursewarePlayer.tsx', 'components/courseware/FixedMediaElement.tsx', 'components/courseware/FixedSlide.tsx', 'lib/utils/media-ducking.ts'])
    report.sources[file] = sha(await readFile(path.join(root, 'src/player', file)));
  server = await createServer({ configFile: false, root, publicDir: path.join(root, 'assets'),
    cacheDir: path.join(temporary, 'vite-cache'), define: { 'process.env': '{}' }, esbuild: { jsx: 'automatic' },
    server: { host: '127.0.0.1', port: 0, fs: { allow: [root] } }, logLevel: 'error',
    plugins: [{ name: 'native-media-fixture', load(id) { if (id === path.join(root, 'tests/main.tsx')) return entry; }, configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const name = req.url?.split('?')[0]?.slice('/native-fixtures/'.length);
        if (!req.url?.startsWith('/native-fixtures/') || !['narration.wav', 'page.wav', 'page.mp4'].includes(name)) return next();
        res.setHeader('Content-Type', name.endsWith('.mp4') ? 'video/mp4' : 'audio/wav');
        res.end(await readFile(path.join(temporary, name)));
      });
    } }],
  });
  await server.listen();
  const base = `http://127.0.0.1:${server.httpServer.address().port}`;
  const launched = await launchPlaybackBrowser(process.argv.find(arg => arg.startsWith('--electron='))?.slice(11));
  browser = launched.browser; report.runtime = launched.runtime;
  const entry = `import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { FixedCoursewarePlayer, englishPlayerLabels } from '/src/player.ts';
    import '/src/player.css';
    const urls = {};
    for (const name of ['narration.wav', 'page.wav', 'page.mp4']) urls[name] = URL.createObjectURL(await (await fetch('/native-fixtures/' + name)).blob());
    const canvas = id => ({ id, viewportSize: 960, viewportRatio: 0.5625,
      theme: { backgroundColor: '#ffffff', themeColors: ['#123456'], fontColor: '#111111', fontName: 'Noto Sans SC Variable' },
      background: { type: 'solid', color: '#ffffff' }, elements: [
        { id: id + '-video', type: 'video', src: urls['page.mp4'], autoplay: false, left: 40, top: 40, width: 640, height: 360, rotate: 0 },
        { id: id + '-audio', type: 'audio', src: urls['page.wav'], autoplay: false, fixedRatio: false, color: '#111111', loop: false, left: 40, top: 430, width: 640, height: 54, rotate: 0 },
      ] });
    const scenes = ['page-1', 'page-2'].map((id, order) => ({ id, stageId: 'native-media', type: 'slide', title: 'Native media ' + (order + 1), order,
      content: { type: 'slide', canvas: canvas(id) }, actions: [
        { id: id + '-speech', type: 'speech', text: 'Local narration fixture.', audioId: 'narration', audioUrl: urls['narration.wav'] },
        { id: id + '-wait', type: 'interaction_checkpoint', checkpointId: id + '-wait', checkpointKind: 'teacher_continue' },
      ] }));
    const build = { buildId: 'native-media-lifecycle-fixture', scenes, speechVisualCues: new Map(), dispose() {} };
    const root = createRoot(document.getElementById('root'));
    window.__unmount = () => { root.unmount(); Object.values(urls).forEach(URL.revokeObjectURL); };
    const controls = document.createElement('div');
    const start = document.createElement('button'); start.textContent = 'Start native media';
    start.onclick = () => document.querySelectorAll('[data-media-element] audio, [data-media-element] video').forEach(media => { void media.play().catch(() => {}); });
    controls.append(start); document.body.append(controls);
    root.render(React.createElement(FixedCoursewarePlayer, { build, labels: englishPlayerLabels, width: 960 }));
    if (location.search.includes('autostart')) {
      const timer = setInterval(() => { const play = [...document.querySelectorAll('button')].find(button => button.textContent === 'Play');
        if (play) { clearInterval(timer); play.click(); } }, 20);
    }`;
  async function test(name, run, query = '') {
    const page = await browser.newPage({ viewport: { width: 1180, height: 920 } });
    const errors = [], blocked = [];
    page.setDefaultTimeout(12000);
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.hostname === '127.0.0.1' || ['blob:', 'data:'].includes(url.protocol)) return route.continue();
      blocked.push(url.origin); return route.abort();
    });
    await page.addInitScript(() => {
      window.__media = []; window.__nativeEvents = []; window.__playResults = [];
      const attach = media => {
        if (window.__media.includes(media)) return;
        const id = window.__media.length; window.__media.push(media);
        for (const type of ['loadedmetadata', 'playing', 'timeupdate', 'seeked', 'volumechange', 'pause', 'ended', 'error', 'emptied'])
          media.addEventListener(type, event => window.__nativeEvents.push({ id, tag: media.tagName, type, trusted: event.isTrusted,
            time: media.currentTime, volume: media.volume, paused: media.paused }));
      };
      const NativeAudio = window.Audio;
      window.Audio = function (...args) { const media = new NativeAudio(...args); attach(media); return media; };
      new MutationObserver(() => document.querySelectorAll('video,audio').forEach(attach)).observe(document, { childList: true, subtree: true });
      const play = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function () {
        attach(this); const id = window.__media.indexOf(this);
        return play.call(this).then(value => { window.__playResults.push({ id, status: 'resolved' }); return value; }, error => {
          window.__playResults.push({ id, status: 'rejected', name: error.name, message: error.message }); throw error;
        });
      };
    });
    try {
      await page.goto(base + '/tests/index.html' + query);
      // Automation evaluation can grant activation; let the genuine policy rejection settle first.
      if (query) await page.waitForTimeout(1500);
      await page.locator('[data-player-mode]').waitFor();
      await page.waitForFunction(() => document.querySelectorAll('[data-media-element] audio, [data-media-element] video').length === 2);
      const detail = await run(page);
      assert.deepEqual(errors, []); assert.deepEqual(blocked, []);
      const native = await page.evaluate(() => window.__nativeEvents);
      assert(native.some(event => event.type === 'timeupdate' && event.trusted), 'Actual native decoding/time progression is required');
      assert(native.every(event => event.trusted), 'No synthetic media events may prove this gate');
      await page.screenshot({ path: path.join(output, `${name}.png`) });
      report.results.push({ name, status: 'PASS', ...detail, native, playResults: await page.evaluate(() => window.__playResults) });
      console.log('PASS', name);
    } catch (error) {
      report.results.push({ name, status: 'FAIL', error: String(error), errors, blocked,
        body: await page.locator('body').innerText(), native: await page.evaluate(() => window.__nativeEvents),
        media: await page.evaluate(() => window.__media.map(media => ({ tag: media.tagName, paused: media.paused, volume: media.volume, time: media.currentTime, src: media.getAttribute('src') }))),
        playResults: await page.evaluate(() => window.__playResults) });
      await page.screenshot({ path: path.join(output, `${name}-failure.png`) });
      throw error;
    } finally { await page.close(); }
  }
  const start = async page => {
    await page.getByRole('button', { name: 'Play', exact: true }).click();
    await page.waitForFunction(() => window.__media.some(media => !media.isConnected && !media.paused && media.currentTime > .1));
    await page.getByRole('button', { name: 'Start native media', exact: true }).click();
    await page.waitForFunction(() => [...document.querySelectorAll('[data-media-element] audio, [data-media-element] video')].every(media => !media.paused && media.currentTime > .1));
  };
  const nativeState = page => page.evaluate(() => [...document.querySelectorAll('[data-media-element] audio, [data-media-element] video')].map(media => ({ tag: media.tagName, time: media.currentTime, volume: media.volume, paused: media.paused })));
  const released = async (page, count) => {
    await page.waitForFunction(count => window.__old.length === count && window.__old.every(media => media.paused && !media.hasAttribute('src')), count);
    return page.evaluate(() => window.__old.map(media => ({ tag: media.tagName, paused: media.paused, src: media.getAttribute('src') })));
  };
  await test('concurrent-native-media-duck-pause-resume-restore', async page => {
    await start(page);
    await page.waitForFunction(() => [...document.querySelectorAll('[data-media-element] audio, [data-media-element] video')].every(media => Math.abs(media.volume - .2) < .001));
    await page.evaluate(() => { document.querySelector('video').volume = .65; document.querySelector('[data-media-element] audio').volume = .4; });
    await page.waitForFunction(() => Math.abs(document.querySelector('video').volume - .13) < .001 && Math.abs(document.querySelector('[data-media-element] audio').volume - .08) < .001);
    await page.getByRole('button', { name: 'Pause', exact: true }).click();
    await page.waitForFunction(() => [...document.querySelectorAll('video,audio')].every(media => media.paused));
    const paused = await nativeState(page);
    assert.deepEqual(paused.map(media => media.volume), [.65, .4]);
    await page.waitForTimeout(200);
    assert.deepEqual((await nativeState(page)).map(media => media.time), paused.map(media => media.time));
    await page.getByRole('button', { name: 'Resume', exact: true }).click();
    await page.waitForFunction(() => [...document.querySelectorAll('video,audio')].every(media => !media.paused));
    await page.evaluate(() => document.querySelector('[data-media-element] audio').pause());
    await page.getByRole('button', { name: 'Pause', exact: true }).click();
    await page.getByRole('button', { name: 'Resume', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('video').paused && document.querySelector('[data-media-element] audio').paused);
    await page.evaluate(() => { const narration = window.__media.findLast(media => !media.isConnected && media.hasAttribute('src')); narration.currentTime = narration.duration - .15; });
    await page.getByRole('button', { name: 'Teacher continue', exact: true }).waitFor();
    await page.waitForFunction(() => document.querySelector('video').volume === .65 && document.querySelector('[data-media-element] audio').volume === .4);
    const frames = await page.locator('video').evaluate(media => media.getVideoPlaybackQuality().totalVideoFrames);
    assert(frames > 0);
    return { duckGain: .2, decodedVideoFrames: frames, pauseStable: true, resumedOnlyPreviouslyPlayingMedia: true, userVolumeRestoredAfterNativeNarrationEnd: true };
  });
  await test('cross-page-replay-stops-old-native-media', async page => {
    await start(page);
    await page.evaluate(() => { window.__old = window.__media.filter(media => media.hasAttribute('src')); });
    await page.getByRole('button', { name: 'Next page', exact: true }).click();
    const stopped = await released(page, 3);
    await page.waitForFunction(() => document.querySelector('[data-page-id]')?.dataset.pageId === 'page-2');
    assert((await nativeState(page)).every(media => media.paused && media.time === 0));
    await page.getByRole('button', { name: 'Start native media', exact: true }).click();
    await page.waitForFunction(() => [...document.querySelectorAll('video,audio')].every(media => !media.paused));
    await page.evaluate(() => { window.__old = window.__media.filter(media => media.hasAttribute('src')); });
    await page.getByRole('button', { name: 'Replay page', exact: true }).click();
    await released(page, 3);
    return { oldPageReleased: stopped, replayReleasedAllPriorMedia: true, newNativeMediaRequiresExplicitPlay: true };
  });
  await test('close-disposes-native-media-and-narration', async page => {
    await start(page);
    await page.evaluate(() => { window.__old = window.__media.filter(media => media.hasAttribute('src')); window.__unmount(); });
    const stopped = await released(page, 3);
    assert.equal(await page.locator('[data-player-mode]').count(), 0);
    return { unmountReleasedAllSources: stopped };
  });
  await test('native-autoplay-refusal-explicit-retry', async page => {
    await page.getByRole('alert').waitFor();
    assert.match(await page.getByRole('alert').innerText(), /autoplay|Audio unavailable/i);
    assert(await page.evaluate(() => window.__playResults.some(result => result.status === 'rejected' && result.name === 'NotAllowedError')));
    assert.equal(await page.locator('[data-player-mode]').getAttribute('data-player-mode'), 'paused');
    assert((await nativeState(page)).every(media => media.paused && media.time === 0));
    await page.getByRole('button', { name: 'Retry page', exact: true }).click();
    await page.waitForFunction(() => window.__media.some(media => !media.isConnected && !media.paused && media.currentTime > .1));
    assert.equal(await page.getByRole('alert').count(), 0);
    await page.waitForFunction(() => window.__nativeEvents.some(event => event.type === 'timeupdate' && event.time > 0));
    return { genuineBrowserNotAllowedError: true, nativeMediaNotAutostarted: true, explicitUserRetryRecovered: true };
  }, '?autostart');
} catch (error) { report.error = String(error); process.exitCode = 1; }
finally {
  try { await browser?.close(); } finally {
    await server?.close(); await rm(temporary, { recursive: true, force: true });
    await writeFile(path.join(output, 'result.json'), JSON.stringify(report, null, 2));
  }
}
assert.equal(report.results.length, 4, 'All four bounded groups must execute');
assert(report.results.every(result => result.status === 'PASS'));
console.log(`PASS ${report.results.length} actual native-media lifecycle groups`);
