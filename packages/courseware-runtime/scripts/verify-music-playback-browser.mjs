import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import JSZip from 'jszip';
import { createServer } from 'vite';
import { adaptCanonicalSnapshot, buildFixedCourseware } from '../dist/node.mjs';
import { createHash } from 'node:crypto';
import { launchPlaybackBrowser } from './playback-browser.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = process.argv[2];
assert(output && path.isAbsolute(output), 'Supply an absolute evidence directory');
await mkdir(output, { recursive: true });
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const temporary = await mkdtemp(path.join(os.tmpdir(), 'deckwise-music-playback-'));
const oldBuildDirectory = process.env.D_BUILD_DIRECTORY;
const report = { scope: 'Current compiled fixed player, verified local MP3 bytes, real native browser audio; no provider or real-account authorization', results: [] };
let server, browser;
try {
  const fixture = path.join(root, 'tests/fixtures/fixed-courseware');
  const raw = JSON.parse(await readFile(path.join(fixture, 'canonical-desktop.json'), 'utf8'));
  const source = await JSZip.loadAsync(await readFile(path.join(fixture, 'lesson-r8.pptx')));
  for (const entry of Object.values(source.files)) if (/^ppt\/slides\/slide\d+\.xml$/.test(entry.name))
    source.file(entry.name, (await entry.async('string')).replace(/<p:timing\b[\s\S]*?<\/p:timing>/g, ''));
  const sourceBytes = await source.generateAsync({ type: 'nodebuffer' });
  raw.files.sourcePath = path.join(temporary, 'static.pptx');
  await writeFile(raw.files.sourcePath, sourceBytes);
  raw.project.source.sha256 = raw.snapshot.source.sha256 = raw.files.mapping.sourceSha256 = sha(sourceBytes);
  const workerDirectory = path.join(root, '../../apps/desktop/resources/pptx-worker');
  raw.files.converter.manifestSha256 = sha(await readFile(path.join(workerDirectory, 'manifest.json')));
  const musicPath = path.join(root, 'tests/fixtures/music-clip/tone.mp3');
  const musicBytes = await readFile(musicPath), musicSha = sha(musicBytes);
  assert.equal(musicSha, 'b2904fd3c8dbec640904b6545daef5760fcdcd490ae92b0e4cdcb0d4d6ca1084');
  const voice = { ...raw.files.assets[1], path: path.join(fixture, 'page-2.wav') };
  const music = { id: `music-${musicSha}`, path: musicPath, sha256: musicSha, mimeType: 'audio/mpeg' };
  const wait = id => ({ id, type: 'interaction_checkpoint', checkpointId: id, checkpointKind: 'teacher_continue' });
  raw.project.pages[0].actions = [{ id: 'music-only', type: 'audio_clip', audioAssetId: music.id }, wait('music-only-wait')];
  raw.project.pages[1].actions = [{ id: 'mixed-speech', type: 'speech', text: 'Fixed narration before music.', audioAssetId: voice.id },
    { id: 'mixed-music', type: 'audio_clip', audioAssetId: music.id }, wait('mixed-wait')];
  raw.project.pages[2].actions = [];
  raw.files.assets = [voice, music]; raw.snapshot.assetIds = [voice.id, music.id];
  const built = await buildFixedCourseware(adaptCanonicalSnapshot(raw.project, raw.snapshot, raw.files), {
    workerDirectory, outputDirectory: path.join(temporary, 'builds'),
  });
  const packageBytes = await readFile(path.join(built.directory, 'package.json'));
  assert.equal(sha(packageBytes), built.buildId);
  report.fixture = { buildId: built.buildId, sourceSha256: sha(sourceBytes), musicSha256: musicSha,
    musicByteLength: musicBytes.length, workerManifestSha256: raw.files.converter.manifestSha256,
    playerSha256: sha(await readFile(path.join(root, 'dist/player.mjs'))), fixtureOrigin: 'Local authored 8-second sine MP3, not provider output' };
  await writeFile(path.join(output, 'package.json'), packageBytes);
  await writeFile(path.join(output, 'report-build.json'), JSON.stringify(built.report, null, 2));
  await cp(built.directory, path.join(output, 'fixed-build'), { recursive: true });
  process.env.D_BUILD_DIRECTORY = built.directory;
  server = await createServer({ configFile: path.join(root, 'scripts/playback-vite.config.mts'),
    server: { host: '127.0.0.1', port: 0, strictPort: false }, clearScreen: false, logLevel: 'error' });
  await server.listen();
  const address = server.httpServer.address();
  assert(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  const launched = await launchPlaybackBrowser(process.argv.find(arg => arg.startsWith('--electron='))?.slice(11));
  browser = launched.browser; report.runtime = launched.runtime;
  const entry = `import { mountFixedBuild, englishPlayerLabels } from '/dist/player.mjs';
    window.__events = []; window.__assetReads = [];
    try {
      const { buildId } = await fetch('/fixture.json').then(r => r.json());
      const bytes = new Uint8Array(await (await fetch('/build/package.json')).arrayBuffer());
      window.__unmount = await mountFixedBuild(document.getElementById('root'), bytes, buildId, async asset => {
        window.__assetReads.push({ id: asset.id, sha256: asset.sha256, mimeType: asset.mimeType });
        return new Uint8Array(await (await fetch('/build/' + asset.path)).arrayBuffer());
      }, { labels: englishPlayerLabels, width: 960,
        onSpeechStart: text => window.__events.push({ type: 'speech-start', text }),
        onSpeechEnd: () => window.__events.push({ type: 'speech-end' }),
        onSpeechProgress: value => { if (value) window.__events.push({ type: 'speech-progress', actionId: value.actionId }); },
        onInteractionStart: value => window.__events.push({ type: 'wait', id: value.checkpointId }) });
    } catch (error) { document.getElementById('root').textContent = error.message; throw error; }`;
  async function test(name, run) {
    const page = await browser.newPage({ viewport: { width: 1180, height: 900 } });
    const errors = [], blocked = [];
    page.setDefaultTimeout(10000);
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.hostname === '127.0.0.1' || ['blob:', 'data:'].includes(url.protocol)) return route.continue();
      blocked.push(url.origin); return route.abort();
    });
    await page.route('**/tests/main.tsx', route => route.fulfill({ contentType: 'application/javascript', body: entry }));
    await page.addInitScript(() => {
      window.__audios = []; window.__ttsCalls = 0; window.__native = [];
      const OriginalAudio = window.Audio;
      window.Audio = function (...args) {
        const audio = new OriginalAudio(...args); const id = window.__audios.length;
        window.__audios.push(audio);
        for (const type of ['playing', 'timeupdate', 'seeked', 'pause', 'ended', 'error'])
          audio.addEventListener(type, () => window.__native.push({ id, type, time: audio.currentTime, duration: audio.duration, paused: audio.paused }));
        return audio;
      };
      const speak = window.speechSynthesis?.speak.bind(window.speechSynthesis);
      if (speak) window.speechSynthesis.speak = utterance => { window.__ttsCalls++; speak(utterance); };
    });
    try {
      await page.goto(base + '/tests/index.html');
      await page.locator('[data-player-mode]').waitFor();
      await page.addStyleTag({ url: base + '/dist/player.css?direct' });
      await page.waitForFunction(() => document.querySelector('[data-courseware-fonts-ready]')?.dataset.coursewareFontsReady === 'true');
      // All resolver reads have completed; disable even loopback retrieval before playback.
      await page.context().setOffline(true);
      const detail = await run(page);
      assert.deepEqual(errors, []); assert.deepEqual(blocked, []);
      assert.equal(await page.evaluate(() => window.__ttsCalls), 0);
      await page.screenshot({ path: path.join(output, name + '.png') });
      await rm(path.join(output, name + '-failure.png'), { force: true });
      report.results.push({ name, status: 'PASS', ...detail, native: await page.evaluate(() => window.__native),
        events: await page.evaluate(() => window.__events), assetReads: await page.evaluate(() => window.__assetReads) });
    } catch (error) {
      report.results.push({ name, status: 'FAIL', error: String(error), errors, blocked, body: await page.locator('body').innerText(), native: await page.evaluate(() => window.__native), audio: await page.evaluate(() => window.__audios.map(audio => ({ paused: audio.paused, src: audio.getAttribute('src'), time: audio.currentTime }))) });
      await page.screenshot({ path: path.join(output, name + '-failure.png') });
      throw error;
    } finally { await page.context().setOffline(false); await page.close(); }
  }
  const active = page => page.waitForFunction(() => window.__audios.some(audio => !audio.paused && audio.currentTime > .1));
  const seekEnd = page => page.evaluate(() => { const audio = window.__audios.at(-1); audio.currentTime = audio.duration - .15; });
  await test('music-only-native-pause-seek-end', async page => {
    await page.getByRole('button', { name: 'Play', exact: true }).click(); await active(page);
    await page.getByRole('slider', { name: 'Seek audio clip', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Pause', exact: true }).click();
    const paused = await page.evaluate(() => ({ time: window.__audios.at(-1).currentTime, paused: window.__audios.at(-1).paused }));
    assert.equal(paused.paused, true);
    await page.waitForTimeout(200);
    assert.equal(await page.evaluate(() => window.__audios.at(-1).currentTime), paused.time);
    await page.getByRole('slider', { name: 'Seek audio clip', exact: true }).fill('3000');
    await page.waitForFunction(() => Math.abs(window.__audios.at(-1).currentTime - 3) < .1);
    await page.getByRole('button', { name: 'Resume', exact: true }).click(); await active(page);
    await seekEnd(page);
    await page.getByRole('button', { name: 'Teacher continue', exact: true }).waitFor();
    assert.equal((await page.evaluate(() => window.__events)).filter(event => event.type.startsWith('speech')).length, 0);
    assert(await page.evaluate(() => window.__native.some(event => event.type === 'ended') && window.__native.some(event => event.type === 'timeupdate')));
    return { offlinePlayback: true, pauseStable: true, seekMs: 3000, nativeEndedReachedTeacherWait: true, noNarrationCallbacks: true };
  });
  await test('mixed-narration-music-navigation-unmount', async page => {
    await page.getByRole('button', { name: 'Play', exact: true }).click(); await active(page);
    await page.getByRole('button', { name: 'Next page', exact: true }).click();
    await page.getByRole('slider', { name: 'Seek narration', exact: true }).waitFor(); await active(page);
    const stoppedMusic = await page.evaluate(() => ({ paused: window.__audios[0].paused, src: window.__audios[0].getAttribute('src') }));
    assert.deepEqual(stoppedMusic, { paused: true, src: null });
    await seekEnd(page);
    await page.getByRole('slider', { name: 'Seek audio clip', exact: true }).waitFor(); await active(page);
    const before = await page.evaluate(() => window.__events.filter(event => event.type.startsWith('speech')));
    assert.equal(before.filter(event => event.type === 'speech-start').length, 1);
    assert.equal(before.filter(event => event.type === 'speech-end').length, 1);
    await seekEnd(page);
    await page.getByRole('button', { name: 'Teacher continue', exact: true }).waitFor();
    assert.deepEqual(await page.evaluate(() => window.__events.filter(event => event.type.startsWith('speech'))), before);
    assert(await page.evaluate(() => window.__native.filter(event => event.type === 'ended').length >= 2));
    await page.getByRole('button', { name: 'Replay page', exact: true }).click(); await active(page);
    await page.evaluate(() => window.__unmount());
    await page.waitForFunction(() => window.__audios.every(audio => audio.paused) && !window.__audios.at(-1).getAttribute('src'));
    return { oldMusicStoppedOnNavigation: stoppedMusic, narrationBeforeMusic: true, musicDoesNotEmitSpeechEvents: true, unmountStopsAllAudio: true };
  });
} catch (error) { report.error = String(error); throw error; }
finally {
  try { await browser?.close(); } finally {
    await server?.close();
    if (oldBuildDirectory === undefined) delete process.env.D_BUILD_DIRECTORY; else process.env.D_BUILD_DIRECTORY = oldBuildDirectory;
    await rm(temporary, { recursive: true, force: true });
    await writeFile(path.join(output, 'result.json'), JSON.stringify(report, null, 2));
  }
}
assert.equal(report.results.length, 2);
assert(report.results.every(result => result.status === 'PASS'));
console.log(`PASS ${report.results.length} native music playback groups`);
