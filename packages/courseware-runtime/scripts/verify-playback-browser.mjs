import assert from "node:assert/strict";
import path from "node:path";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { launchPlaybackBrowser } from './playback-browser.mjs';

const output = process.argv[2];
const animations = process.argv.includes("--animations");
const only = process.argv.find(arg => arg.startsWith("--only="))?.slice(7);
const effects = animations || process.argv.includes("--effects");
assert.ok(
  output && path.isAbsolute(output),
  "Supply a new absolute evidence directory",
);
await mkdir(output);
const electron = process.argv.find(arg => arg.startsWith('--electron='))?.slice('--electron='.length);
const { browser, runtime } = await launchPlaybackBrowser(electron);
const report = {
  runtime,
  browser: browser.version(),
  scope:
    "Real Chromium/HTMLMediaElement decoding; loopback fixed build, no classroom editor or providers",
  results: [],
};
const base = "http://127.0.0.1:4259/tests/";
async function newPage() {
  const page = await browser.newPage({
    viewport: { width: 1180, height: 920 },
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    return url.hostname === "127.0.0.1" ||
      ["data:", "blob:"].includes(url.protocol)
      ? route.continue()
      : route.abort();
  });
  await page.addInitScript(() => {
    window.__cspViolations = [];
    document.addEventListener('securitypolicyviolation', event => {
      window.__cspViolations.push({ directive: event.effectiveDirective, blockedURI: event.blockedURI });
    });
    const NativeAudio = window.Audio;
    window.__audios = [];
    window.Audio = function (...args) {
      const audio = new NativeAudio(...args);
      window.__audios.push(audio);
      return audio;
    };
  });
  return { page, errors };
}
async function test(name, run) {
  if (only && only !== name) return;
  const { page, errors } = await newPage();
  try {
    const detail = await run(page);
    assert.deepEqual(errors, []);
    assert.deepEqual(await page.evaluate(() => window.__cspViolations), []);
    await page.screenshot({ path: path.join(output, `${name}.png`) });
    report.results.push({ name, status: "PASS", ...detail });
    console.log("PASS", name);
  } catch (error) {
    await page.screenshot({ path: path.join(output, `${name}-failure.png`) });
    report.results.push({
      name,
      status: "FAIL",
      error: String(error),
      errors,
      dom: await page.locator("body").innerText(),
      video: await page.locator('video').count() ? await page
        .locator("video")
        .evaluate((v) => ({
          paused: v.paused,
          time: v.currentTime,
          readyState: v.readyState,
          controls: v.controls,
        }))
        .catch(() => null) : null,
    });
    console.log("FAIL", name, String(error));
  } finally {
    await page.close();
  }
}
async function loaded(page) {
  await page.goto(base + "index.html");
  await page.locator("[data-player-mode]").waitFor();
  await page.waitForFunction(
    () =>
      document.querySelector("[data-courseware-fonts-ready]")?.dataset
        .coursewareFontsReady === "true",
  );
}
const mediaState = (page) =>
  page.evaluate(() =>
    window.__audios.map((a) => ({
      paused: a.paused,
      time: a.currentTime,
      duration: a.duration,
      src: a.src,
      readyState: a.readyState,
    })),
  );
const running = (page) =>
  page.waitForFunction(() =>
    window.__audios.some((a) => !a.paused && a.currentTime > 0.1),
  );
const finishNarration = (page) =>
  page.evaluate(() => {
    const a = window.__audios.at(-1);
    a.currentTime = a.duration - 0.15;
  });
try {
  if (process.argv.includes('--bound-native')) await test('fixed-bound-native-timeline', async page => {
    await loaded(page);
    const target = id => page.locator(`[data-slide-render-element-id="${id}"]`);
    const opacity = id => target(id).evaluate(element => Number(getComputedStyle(element).opacity));
    const first = 'pptx_text_1', second = 'pptx_shape_2';
    const wait = () => page.getByRole('button', { name: 'Teacher continue', exact: true });
    const pause = () => page.getByRole('button', { name: 'Pause', exact: true }).click();
    const resume = () => page.getByRole('button', { name: 'Resume', exact: true }).click();
    assert.equal(await opacity(first), 0);
    assert.equal(await opacity(second), 0);
    await page.getByRole('button', { name: 'Play', exact: true }).click();
    await running(page);
    assert.equal(await opacity(first), 0);
    assert.equal(await opacity(second), 0);
    assert.equal(await wait().count(), 0);
    await finishNarration(page);
    await page.waitForFunction(() => document.querySelector('[data-slide-render-element-id="pptx_text_1"]')
      ?.getAnimations().some(animation => animation.playState === 'running'));
    await pause();
    const fadeTime = await target(first).evaluate(element => element.getAnimations()[0].currentTime);
    await page.waitForTimeout(250);
    assert.equal(await target(first).evaluate(element => element.getAnimations()[0].currentTime), fadeTime);
    assert.equal(await opacity(second), 0);
    await resume();
    await page.waitForFunction(() => window.__audios.length >= 2 && !window.__audios.at(-1).paused);
    await pause();
    await page.getByRole('slider', { name: 'Seek narration' }).fill('1000');
    const highlight = page.locator('[data-fixed-effect="highlight"]');
    await highlight.waitFor();
    assert.equal(await highlight.getAttribute('data-target-ids'), first);
    assert.equal(await opacity(first), 1);
    assert.equal(await opacity(second), 0);
    await resume(); await finishNarration(page);
    await wait().waitFor();
    await page.waitForTimeout(600);
    assert.equal(await opacity(second), 0);
    assert.equal(await page.locator('[data-fixed-effect]').count(), 0);
    await wait().click();
    await page.waitForFunction(() => document.querySelector('[data-slide-render-element-id="pptx_shape_2"]')
      ?.getAnimations().some(animation => animation.playState === 'running'));
    await pause();
    const secondTime = await target(second).evaluate(element => element.getAnimations()[0].currentTime);
    await page.waitForTimeout(250);
    assert.equal(await target(second).evaluate(element => element.getAnimations()[0].currentTime), secondTime);
    await resume();
    await page.waitForFunction(() => window.__audios.length >= 3 && !window.__audios.at(-1).paused);
    await pause();
    await page.getByRole('slider', { name: 'Seek narration' }).fill('1000');
    await page.locator('[data-fixed-effect="spotlight"]').waitFor();
    assert.equal(await opacity(second), 1);
    await resume(); await finishNarration(page); await wait().waitFor();
    await page.getByRole('button', { name: 'Replay page', exact: true }).click();
    await running(page);
    assert.equal(await opacity(first), 0);
    assert.equal(await opacity(second), 0);
    assert.equal(await page.locator('[data-fixed-effect]').count(), 0);
    const previousAudioCount = (await mediaState(page)).length;
    await page.getByRole('button', { name: 'Next page', exact: true }).click();
    assert.equal((await mediaState(page)).slice(0, previousAudioCount).some(audio => !audio.paused), false);
    return { verified: ['intro-before-native', 'two-ordered-native-steps', 'pause-resume',
      'highlight-after-first', 'teacher-gate', 'spotlight-after-second', 'replay-reset', 'navigation-cleanup'] };
  });
  if (process.argv.includes('--native-attention')) await test('fixed-native-attention', async page => {
    await loaded(page);
    const target = page.locator('[data-slide-render-element-id="pptx_text_1"]');
    const opacity = () => target.evaluate(element => Number(getComputedStyle(element).opacity));
    assert.equal(await opacity(), 0);
    await page.getByRole('button', { name: 'Play', exact: true }).click();
    const next = page.getByRole('button', { name: 'Next native animation 1/1', exact: true });
    await next.waitFor();
    await page.waitForTimeout(600);
    assert.equal((await mediaState(page)).some(audio => !audio.paused), false);
    assert.equal(await page.locator('[data-fixed-effect]').count(), 0);
    await next.click();
    await page.waitForFunction(() => document.querySelector('[data-slide-render-element-id="pptx_text_1"]')
      ?.getAnimations().some(animation => animation.playState === 'running'));
    await page.getByRole('button', { name: 'Pause', exact: true }).click();
    const fadeTime = await target.evaluate(element => element.getAnimations()[0].currentTime);
    await page.waitForTimeout(250);
    assert.equal(await target.evaluate(element => element.getAnimations()[0].currentTime), fadeTime);
    assert.equal((await mediaState(page)).some(audio => !audio.paused), false);
    await page.getByRole('button', { name: 'Resume', exact: true }).click();
    await running(page);
    await page.getByRole('button', { name: 'Pause', exact: true }).click();
    const seek = async time => {
      await page.getByRole('slider', { name: 'Seek narration' }).fill(String(time));
    };
    await seek(1000);
    const highlight = page.locator('[data-fixed-effect="highlight"]');
    await highlight.waitFor();
    assert.equal(await opacity(), 1);
    assert.equal(await highlight.getAttribute('data-target-ids'), 'pptx_text_1');
    const box = await highlight.boundingBox();
    await page.waitForTimeout(250);
    assert.deepEqual(await highlight.boundingBox(), box);
    await seek(2800);
    await page.locator('[data-fixed-effect="spotlight"]').waitFor();
    assert.equal(await opacity(), 1);
    assert.equal(await page.locator('[data-fixed-effect="highlight"]').count(), 0);
    await page.screenshot({ path: path.join(output, 'native-entrance-then-spotlight.png') });
    await seek(1000);
    await highlight.waitFor();
    await page.getByRole('button', { name: 'Resume', exact: true }).click();
    await running(page);
    await finishNarration(page);
    await page.getByRole('button', { name: 'Teacher continue', exact: true }).waitFor();
    assert.equal(await page.locator('[data-fixed-effect]').count(), 0);
    await page.getByRole('button', { name: 'Replay page', exact: true }).click();
    await next.waitFor();
    assert.equal(await opacity(), 0);
    assert.equal(await page.locator('[data-fixed-effect]').count(), 0);
    await page.getByRole('button', { name: 'Next page', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[data-player-mode]')?.getAttribute('data-page-id') === 'fixture-page-2');
    assert.equal(await page.locator('[data-fixed-effect]').count(), 0);
    return { savedNativeClickGate: true, fadePauseResume: true, attentionOnRevealedTarget: true,
      pausedSeekAndReplay: true, navigationCleanup: true };
  });
  if (electron) await test('electron-renderer-isolation', async (page) => {
    await loaded(page);
    const access = await page.evaluate(() => ({
      require: typeof window.require, nodeVersion: typeof window.process?.versions?.node,
      nodeLoader: typeof window.process?.getBuiltinModule, cwd: typeof window.process?.cwd,
      processShimKeys: Object.keys(window.process ?? {}),
      fontsLoaded: document.fonts.check('16px "Noto Sans SC"'),
      policy: document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content,
    }));
    assert.equal(access.require, 'undefined');
    assert.equal(access.nodeVersion, 'undefined');
    assert.equal(access.nodeLoader, 'undefined');
    assert.equal(access.cwd, 'undefined');
    // Vite supplies only its browser process.env shim, not the Node process.
    assert.deepEqual(access.processShimKeys, ['env']);
    assert.equal(access.fontsLoaded, true);
    assert.match(access.policy, /media-src 'self' data: blob:/);
    return { ...access, sandbox: true, contextIsolation: true, webSecurity: true };
  });
  async function teamFixture(page, corrupt = false) {
    const fixture = JSON.parse(await readFile(new URL('../tests/fixtures/team-fixed-files-c2b/fixed-playback.json', import.meta.url), 'utf8')).data;
    const source = JSON.parse(await readFile(new URL('../tests/fixtures/team-fixed-files-c2b/SOURCE.json', import.meta.url), 'utf8'));
    const requested = [];
    await page.route('**/team-fixed-selection.json', route => route.fulfill({ json: fixture }));
    await page.route('**/team-fixed-files/**', async route => {
      const name = new URL(route.request().url()).pathname.slice('/team-fixed-files/'.length);
      const entry = fixture.fixedBuild.files.find(item => item.file.path === name);
      assert.ok(entry, name);
      requested.push(name);
      const bytes = await readFile(path.join(source.buildDirectory, name));
      if (corrupt && name === 'package.json') bytes[0] ^= 1;
      return route.fulfill({ contentType: entry.file.mimeType, body: bytes });
    });
    return { requested, buildId: fixture.pointer.buildId, snapshotId: fixture.pointer.snapshotId };
  }
  await test('team-fixed-files-native-playback', async page => {
    const fixture = await teamFixture(page);
    await page.goto(base + 'index.html?team-fixed');
    await page.locator('[data-player-mode]').waitFor();
    assert.equal(new Set(fixture.requested).size, 9);
    await page.getByRole('button', { name: 'Play', exact: true }).click();
    await running(page);
    await page.getByRole('button', { name: 'Pause', exact: true }).click();
    const paused = (await mediaState(page))[0];
    await page.waitForTimeout(220);
    assert.equal((await mediaState(page))[0].time, paused.time);
    await page.getByRole('button', { name: 'Resume', exact: true }).click();
    await running(page);
    await finishNarration(page);
    await page.getByRole('button', { name: 'Teacher continue', exact: true }).waitFor();
    assert.ok((await mediaState(page)).every(audio => audio.paused));
    await page.getByRole('button', { name: 'Teacher continue', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[data-page-id]')?.dataset.pageId === 'fixture-page-2');
    return { ...fixture, offlineC2bProjection: true, nativeAudioPauseResume: true, teacherCheckpoint: true };
  });
  await test('team-fixed-files-corrupt-package', async page => {
    const fixture = await teamFixture(page, true);
    await page.goto(base + 'index.html?team-fixed');
    assert.equal(await page.getByRole('alert').innerText(), 'TEAM_FILE_HASH_MISMATCH');
    assert.deepEqual(fixture.requested, ['manifest.json', 'package.json']);
    assert.equal(await page.locator('[data-player-mode]').count(), 0);
    assert.deepEqual(await mediaState(page), []);
    return { requested: fixture.requested, rejectedBeforeAssetsOrPlayback: true };
  });
  await test('team-fixed-files-final-digest-cancel', async page => {
    await teamFixture(page);
    await loaded(page);
    const detail = await page.evaluate(async () => {
      const { loadTeamFixedBuild } = await import('/dist/player.mjs');
      const { pointer, fixedBuild } = await fetch('/team-fixed-selection.json').then(r => r.json());
      const expected = { buildId: pointer.buildId, snapshotId: pointer.snapshotId, packageSha256: pointer.packageSha256 };
      const controller = new AbortController(), reason = new Error('Team selection changed');
      const digest = crypto.subtle.digest.bind(crypto.subtle);
      const create = URL.createObjectURL.bind(URL);
      let reads = 0, digests = 0, created = 0, rejected = false;
      crypto.subtle.digest = async (...args) => {
        const result = await digest(...args);
        if (++digests === fixedBuild.files.length) controller.abort(reason);
        return result;
      };
      URL.createObjectURL = blob => { created++; return create(blob); };
      try {
        await loadTeamFixedBuild(fixedBuild, expected, async (path, signal) => {
          reads++;
          return new Uint8Array(await (await fetch('/team-fixed-files/' + path, { signal })).arrayBuffer());
        }, controller.signal);
      } catch (error) { rejected = error === reason; }
      finally { crypto.subtle.digest = digest; URL.createObjectURL = create; }
      return { reads, digests, created, rejected };
    });
    assert.deepEqual(detail, { reads: 9, digests: 9, created: 0, rejected: true });
    return detail;
  });
  await test("desktop-mount-cancel-after-load", async (page) => {
    await loaded(page);
    const detail = await page.evaluate(async () => {
      const {mountFixedBuild, englishPlayerLabels} = await import('/dist/player.mjs');
      const {buildId} = await fetch('/fixture.json').then(r => r.json());
      const bytes = new Uint8Array(await (await fetch('/build/package.json')).arrayBuffer());
      const assetCount = JSON.parse(new TextDecoder().decode(bytes)).assets.length;
      const controller = new AbortController();
      const reason = new Error('Snapshot changed after loading');
      const nativeCreate = URL.createObjectURL.bind(URL);
      const nativeRevoke = URL.revokeObjectURL.bind(URL);
      const created = [], revoked = [];
      URL.createObjectURL = blob => {
        const url = nativeCreate(blob);
        created.push(url);
        // The loader finishes synchronously; abort before the awaiting mount resumes.
        if (created.length === assetCount) queueMicrotask(() => controller.abort(reason));
        return url;
      };
      URL.revokeObjectURL = url => { revoked.push(url); nativeRevoke(url); };
      const container = document.createElement('div'); document.body.append(container);
      let mounted = false, sameReason = false, unmount;
      try {
        unmount = await mountFixedBuild(container, bytes, buildId,
          async asset => new Uint8Array(await (await fetch('/build/' + asset.path)).arrayBuffer()),
          {labels: englishPlayerLabels}, controller.signal);
        mounted = true;
      } catch (error) {
        sameReason = error === reason;
      } finally {
        unmount?.();
        URL.createObjectURL = nativeCreate;
        URL.revokeObjectURL = nativeRevoke;
      }
      return {mounted, sameReason, created: created.length, revoked: revoked.length,
        allReleased: created.every(url => revoked.filter(item => item === url).length === 1),
        emptyContainer: container.childElementCount === 0};
    });
    assert.equal(detail.mounted, false);
    assert.equal(detail.sameReason, true);
    assert.ok(detail.created > 0);
    assert.equal(detail.revoked, detail.created);
    assert.equal(detail.allReleased, true);
    assert.equal(detail.emptyContainer, true);
    return detail;
  });
  await test("desktop-mount-dispose", async (page) => {
    await loaded(page);
    await page.evaluate(async () => {
      const {mountFixedBuild, englishPlayerLabels} = await import('/dist/player.mjs');
      const {buildId} = await fetch('/fixture.json').then(r => r.json());
      const bytes = new Uint8Array(await (await fetch('/build/package.json')).arrayBuffer());
      const container = document.createElement('div'); container.id = 'desktop-mount-probe'; document.body.append(container);
      window.__unmountDesktop = await mountFixedBuild(container, bytes, buildId,
        async asset => new Uint8Array(await (await fetch('/build/' + asset.path)).arrayBuffer()),
        {labels: englishPlayerLabels, width: 720});
    });
    const mounted = page.locator('#desktop-mount-probe');
    await mounted.getByRole('button', {name: 'Play', exact: true}).click();
    await running(page);
    await page.evaluate(() => window.__unmountDesktop());
    assert.equal(await mounted.locator('button').count(), 0);
    const audio = await mediaState(page);
    assert.ok(audio.every(item => item.paused));
    return {mountedCompiledEntry: true, unmountedControls: true, stoppedAudio: true};
  });
  await test("desktop-owned-package-and-asset-bytes", async (page) => {
    await loaded(page);
    const detail = await page.evaluate(async () => {
      const {mountFixedBuild, englishPlayerLabels} = await import('/dist/player.mjs');
      const {buildId} = await fetch('/fixture.json').then(r => r.json());
      const bytes = new Uint8Array(await (await fetch('/build/package.json')).arrayBuffer());
      const payload = JSON.parse(new TextDecoder().decode(bytes));
      const digest = crypto.subtle.digest.bind(crypto.subtle);
      const create = URL.createObjectURL.bind(URL);
      const resolved = [], blobs = [];
      let calls = 0;
      crypto.subtle.digest = async (...args) => {
        const result = await digest(...args);
        if (++calls === 1) bytes.fill(0);
        else resolved.at(-1).fill(0);
        return result;
      };
      URL.createObjectURL = blob => { blobs.push(blob); return create(blob); };
      const container = document.createElement('div');
      container.id = 'desktop-owned-probe'; document.body.append(container);
      try {
        window.__unmountOwned = await mountFixedBuild(container, bytes, buildId,
          async asset => {
            const value = new Uint8Array(await (await fetch('/build/' + asset.path)).arrayBuffer());
            resolved.push(value); return value;
          }, {labels: englishPlayerLabels, width: 720});
      } finally {
        crypto.subtle.digest = digest;
        URL.createObjectURL = create;
      }
      const playedHashes = [];
      for (const blob of blobs) {
        playedHashes.push([...new Uint8Array(await digest('SHA-256', await blob.arrayBuffer()))]
          .map(b => b.toString(16).padStart(2, '0')).join(''));
      }
      return {packageChanged: bytes.every(b => b === 0),
        assetsChanged: resolved.every(value => value.every(b => b === 0)),
        digests: calls, assetCount: payload.assets.length, playedHashes,
        expectedHashes: payload.assets.map(asset => asset.sha256)};
    });
    assert.equal(detail.packageChanged, true);
    assert.equal(detail.assetsChanged, true);
    assert.ok(detail.assetCount > 0);
    assert.equal(detail.digests, detail.assetCount + 1);
    assert.deepEqual(detail.playedHashes, detail.expectedHashes);
    const mounted = page.locator('#desktop-owned-probe');
    await mounted.getByRole('button', {name: 'Play', exact: true}).click();
    await running(page);
    await finishNarration(page);
    await mounted.getByRole('button', {name: 'Teacher continue', exact: true}).waitFor();
    await page.evaluate(() => window.__unmountOwned());
    assert.equal(await mounted.locator('button').count(), 0);
    assert.ok((await mediaState(page)).every(a => a.paused));
    return {...detail, actualCompiledMount: true, actualNarrationAndWait: true};
  });
  await test("desktop-c-http-image-and-fixed-audio", async (page) => {
    const fixture = new URL('../tests/fixtures/media-task-c1-http/', import.meta.url);
    const task = JSON.parse(await readFile(new URL('task-ready.json', fixture), 'utf8'));
    const image = await readFile(new URL('asset.png', fixture));
    assert.equal(createHash('sha256').update(image).digest('hex'), task.assetRef.sha256);
    assert.equal(image.length, task.assetRef.byteLength);
    const requests = [];
    await page.route(`**${task.assetRef.downloadPath}`, route => {
      requests.push({method: route.request().method(), path: new URL(route.request().url()).pathname});
      return route.fulfill({contentType: task.assetRef.mime, body: image});
    });
    await loaded(page);
    const detail = await page.evaluate(async task => {
      const {mountFixedBuild, createMediaTaskAssetResolver, englishPlayerLabels} = await import('/dist/player.mjs');
      // Offline composition fixture: original fixed package plus C's actual response/payload.
      const payload = await fetch('/build/package.json').then(r => r.json());
      const ref = task.assetRef;
      payload.assets.push({id: ref.assetId, sha256: ref.sha256,
        mimeType: ref.mime, path: `assets/${ref.sha256}.png`});
      payload.pages[0].slide.elements.push({id: 'c-http-image', type: 'image',
        left: 700, top: 250, width: 100, height: 100, rotate: 0,
        src: ref.assetId, fixedRatio: true});
      payload.pages[0].objects.push({objectId: 'c-http-logical-image', importElementId: 'c-http-image'});
      const bytes = new TextEncoder().encode(JSON.stringify(payload));
      const buildId = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
        .map(b => b.toString(16).padStart(2, '0')).join('');
      const downloads = [];
      const resolver = createMediaTaskAssetResolver([task], async (taskId, signal) => {
        downloads.push(taskId);
        const response = await fetch(`/courseware/media/tasks/${taskId}/asset`, {signal});
        if (!response.ok) throw new Error(`Asset request failed (${response.status})`);
        return new Uint8Array(await response.arrayBuffer());
      });
      const container = document.createElement('div');
      container.id = 'desktop-c-http-probe'; document.body.append(container);
      window.__unmountCHttp = await mountFixedBuild(container, bytes, buildId,
        (asset, signal) => asset.id === ref.assetId ? resolver(asset, signal)
          : fetch('/build/' + asset.path, {signal}).then(async r => new Uint8Array(await r.arrayBuffer())),
        {labels: englishPlayerLabels, width: 720});
      return {buildId, taskId: task.taskId, imageSha256: ref.sha256, downloads};
    }, task);
    const mounted = page.locator('#desktop-c-http-probe');
    await mounted.locator('[data-slide-render-element-id="c-http-image"] img').evaluate(async img => {
      await img.decode();
      if (img.naturalWidth !== 1 || img.naturalHeight !== 1 || !img.src.startsWith('blob:'))
        throw new Error('C archived image did not decode from a verified Blob');
    });
    assert.deepEqual(detail.downloads, [task.taskId]);
    assert.deepEqual(requests, [{method: 'GET', path: task.assetRef.downloadPath}]);
    await mounted.getByRole('button', {name: 'Play', exact: true}).click();
    await running(page);
    await mounted.getByRole('button', {name: 'Pause', exact: true}).click();
    assert.ok((await mediaState(page)).every(a => a.paused));
    await mounted.getByRole('button', {name: 'Resume', exact: true}).click();
    await running(page);
    await finishNarration(page);
    await mounted.getByRole('button', {name: 'Teacher continue', exact: true}).waitFor();
    await page.evaluate(() => window.__unmountCHttp());
    assert.equal(await mounted.locator('button').count(), 0);
    assert.ok((await mediaState(page)).every(a => a.paused));
    assert.equal(requests.length, 1, 'Playback must not request or generate another asset');
    return {...detail, requests, actualImageDecoded: true, actualNarrationAndWait: true,
      offlineInteropOnly: true, liveDesktopAuthorizationVerified: false};
  });
  await test("desktop-page-state-events", async (page) => {
    await loaded(page);
    const pageIds = await page.evaluate(async () => {
      const {mountFixedBuild, englishPlayerLabels} = await import('/dist/player.mjs');
      const {buildId} = await fetch('/fixture.json').then(r => r.json());
      const bytes = new Uint8Array(await (await fetch('/build/package.json')).arrayBuffer());
      const container = document.createElement('div');
      container.id = 'desktop-events-probe'; document.body.append(container);
      window.__stateEvents = []; window.__pageEvents = [];
      window.__unmountEvents = await mountFixedBuild(container, bytes, buildId,
        async asset => new Uint8Array(await (await fetch('/build/' + asset.path)).arrayBuffer()),
        {labels: englishPlayerLabels, width: 720,
          onState: (mode, snapshot) => window.__stateEvents.push({mode, ...snapshot}),
          onPageChange: id => window.__pageEvents.push(id)});
      return JSON.parse(new TextDecoder().decode(bytes)).pages.map(p => p.pageId);
    });
    const mounted = page.locator('#desktop-events-probe');
    await mounted.getByRole('button', {name: 'Next page', exact: true}).click();
    await running(page);
    await mounted.getByRole('button', {name: 'Pause', exact: true}).click();
    const paused = await page.evaluate(() => window.__stateEvents.at(-1));
    assert.equal(paused.mode, 'paused');
    assert.equal(paused.sceneIndex, 1);
    assert.equal(paused.sceneId, pageIds[1]);
    await mounted.getByRole('button', {name: 'Previous page', exact: true}).click();
    await running(page);
    await finishNarration(page);
    await mounted.getByRole('button', {name: 'Teacher continue', exact: true}).waitFor();
    const waiting = await page.evaluate(() => window.__stateEvents.at(-1));
    assert.equal(waiting.mode, 'waiting_interaction');
    assert.equal(waiting.sceneIndex, 0);
    assert.equal(waiting.sceneId, pageIds[0]);
    await mounted.getByRole('button', {name: 'Teacher continue', exact: true}).click();
    await page.waitForFunction(id => document.querySelector('#desktop-events-probe [data-player-mode]')?.dataset.pageId === id, pageIds[1]);
    await running(page);
    await mounted.getByRole('button', {name: 'Pause', exact: true}).click();
    const advanced = await page.evaluate(() => window.__stateEvents.at(-1));
    assert.equal(advanced.sceneIndex, 1);
    assert.equal(advanced.sceneId, pageIds[1]);
    await mounted.getByRole('button', {name: 'Next page', exact: true}).click();
    await running(page);
    await finishNarration(page);
    await mounted.getByText('Playback complete', {exact: true}).waitFor();
    const completed = await page.evaluate(() => window.__stateEvents.at(-1));
    assert.equal(completed.mode, 'idle');
    assert.equal(completed.sceneIndex, 3);
    assert.equal(completed.sceneId, undefined);
    await mounted.getByRole('button', {name: 'Replay page', exact: true}).click();
    await running(page);
    await mounted.getByRole('button', {name: 'Pause', exact: true}).click();
    const replayed = await page.evaluate(() => window.__stateEvents.at(-1));
    assert.equal(replayed.sceneIndex, 2);
    assert.equal(replayed.sceneId, pageIds[2]);
    const pages = await page.evaluate(() => window.__pageEvents);
    assert.deepEqual(pages, [pageIds[1], pageIds[0], pageIds[1], pageIds[2], pageIds[2]]);
    await page.evaluate(() => window.__unmountEvents());
    assert.ok((await mediaState(page)).every(a => a.paused));
    return {paused, waiting, advanced, completed, replayed, pages,
      actualCompiledMount: true, actualNarrationAndWait: true};
  });
  await test("desktop-role-events-same-clock", async (page) => {
    await loaded(page);
    await page.evaluate(async () => {
      const { mountFixedBuild, englishPlayerLabels } = await import('/dist/player.mjs');
      const { buildId } = await fetch('/fixture.json').then(r => r.json());
      const bytes = new Uint8Array(await (await fetch('/build/package.json')).arrayBuffer());
      window.__rolePackage = JSON.parse(new TextDecoder().decode(bytes));
      const container = document.createElement('div'); container.id = 'role-events-probe';
      const role = document.createElement('output'); role.id = 'role-presentation';
      document.body.append(role, container);
      window.__roleEvents = [];
      const record = (type, value) => window.__roleEvents.push({ type, value });
      window.__unmountRole = await mountFixedBuild(container, bytes, buildId,
        async asset => new Uint8Array(await (await fetch('/build/' + asset.path)).arrayBuffer()),
        { labels: englishPlayerLabels,
          onState: mode => { role.dataset.mode = mode; record('mode', mode); },
          onSpeechStart: text => { role.textContent = text; record('start', text); },
          onSpeechEnd: () => record('end'),
          onSpeechProgress: position => {
            role.dataset.time = String(position?.timeMs ?? '');
            record('progress', position ? { ...position } : null);
            if (position) position.timeMs = -123;
          },
          onInteractionStart: checkpoint => {
            record('wait', structuredClone(checkpoint));
            checkpoint.question = 'Observer mutation';
            checkpoint.context?.sourceSceneIds.push('observer-only');
          },
          onInteractionComplete: checkpointId => record('continue', checkpointId),
        });
    });
    const mounted = page.locator('#role-events-probe');
    await mounted.getByRole('button', { name: 'Play', exact: true }).click();
    await running(page);
    await page.waitForFunction(() => window.__roleEvents.some(e => e.type === 'start'), null, { timeout: 5000 });
    const expected = await page.evaluate(() => window.__rolePackage.pages[0]);
    assert.equal(await page.locator('#role-presentation').textContent(), expected.actions.find(a => a.type === 'speech').text);
    await page.waitForFunction(() => Number(document.querySelector('#role-presentation').dataset.time) > 100);
    const sample = await page.evaluate(() => ({
      reported: Number(document.querySelector('#role-presentation').dataset.time),
      native: window.__audios.at(-1).currentTime * 1000,
    }));
    assert.ok(Math.abs(sample.native - sample.reported) < 250, JSON.stringify(sample));
    await mounted.getByRole('button', { name: 'Pause', exact: true }).click();
    const paused = await page.evaluate(() => ({
      time: document.querySelector('#role-presentation').dataset.time,
      starts: window.__roleEvents.filter(e => e.type === 'start').length,
      at: performance.now(),
    }));
    await page.waitForFunction(at => performance.now() - at > 350, paused.at);
    assert.equal(await page.locator('#role-presentation').getAttribute('data-time'), paused.time);
    assert.equal(await page.locator('#role-presentation').getAttribute('data-mode'), 'paused');
    await mounted.getByRole('slider', { name: 'Seek narration' }).fill('1400');
    await page.waitForFunction(() => Math.abs(Number(document.querySelector('#role-presentation').dataset.time) - 1400) < 20);
    assert.equal(await mounted.getByRole('slider', { name: 'Seek narration' }).inputValue(), '1400');
    await mounted.getByRole('button', { name: 'Resume', exact: true }).click();
    await running(page);
    assert.equal(await page.evaluate(() => window.__roleEvents.filter(e => e.type === 'start').length), paused.starts);
    await finishNarration(page);
    await mounted.getByRole('button', { name: 'Teacher continue', exact: true }).waitFor();
    const waiting = await page.evaluate(() => ({
      events: window.__roleEvents, mode: document.querySelector('#role-presentation').dataset.mode,
      time: document.querySelector('#role-presentation').dataset.time,
    }));
    assert.equal(waiting.mode, 'waiting_interaction');
    assert.equal(waiting.time, '');
    assert.equal(waiting.events.filter(e => e.type === 'end').length, 1);
    const checkpoint = expected.actions.find(a => a.type === 'interaction_checkpoint');
    await mounted.getByText(checkpoint.question, { exact: true }).waitFor();
    assert.equal(waiting.events.find(e => e.type === 'wait').value.checkpointId, checkpoint.checkpointId);
    await mounted.getByRole('button', { name: 'Teacher continue', exact: true }).click();
    await page.waitForFunction(() => window.__roleEvents.some(e => e.type === 'continue'));
    assert.equal(await page.evaluate(() => window.__roleEvents.find(e => e.type === 'continue').value), checkpoint.checkpointId);
    await running(page);
    await mounted.getByRole('button', { name: 'Replay page', exact: true }).click();
    await running(page);
    await mounted.getByRole('button', { name: 'Previous page', exact: true }).click();
    await running(page);
    await mounted.getByRole('button', { name: 'Pause', exact: true }).click();
    const replay = await page.evaluate(() => window.__roleEvents.filter(e => e.type === 'start').map(e => e.value));
    assert.deepEqual(replay, [expected.actions[0].text,
      ...Array(2).fill(await page.evaluate(() => window.__rolePackage.pages[1].actions[0].text)), expected.actions[0].text]);
    await mounted.getByRole('button', { name: 'Resume', exact: true }).click();
    await running(page);
    await finishNarration(page);
    await mounted.getByRole('button', { name: 'Teacher continue', exact: true }).waitFor();
    await mounted.getByRole('button', { name: 'Next page', exact: true }).click();
    await running(page);
    assert.equal(await page.evaluate(() => window.__roleEvents.filter(e => e.type === 'continue').length), 1);
    await page.evaluate(() => window.__unmountRole());
    const disposed = await page.evaluate(() => ({
      mode: document.querySelector('#role-presentation').dataset.mode,
      time: document.querySelector('#role-presentation').dataset.time,
      events: window.__roleEvents.length, at: performance.now(),
    }));
    assert.equal(disposed.mode, 'idle');
    assert.equal(disposed.time, '');
    await page.waitForFunction(at => performance.now() - at > 250, disposed.at);
    assert.equal(await page.evaluate(() => window.__roleEvents.length), disposed.events);
    assert.ok((await mediaState(page)).every(audio => audio.paused));
    return { sample, paused, checkpointId: checkpoint.checkpointId, replay, disposed,
      actualCompiledMount: true, sameNativeClock: true, newClockOrTTS: false };
  });
  await test("desktop-a8-two-speeches-and-fixed-pause", async (page) => {
    const fixture = JSON.parse(await readFile(new URL('../tests/fixtures/a8-narration/SOURCE.json', import.meta.url), 'utf8'));
    const directory = new URL(`../${fixture.fixedBuild.outputDirectory}/${fixture.fixedBuild.buildId}/`, import.meta.url);
    const bytes = await readFile(new URL('package.json', directory));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), fixture.fixedBuild.buildId);
    const payload = JSON.parse(bytes);
    const original = JSON.parse(await readFile(new URL('../tests/fixtures/a8-narration/source-pause-project.json', import.meta.url), 'utf8'));
    assert.deepEqual(payload.pages[0].actions.slice(0, 2).map(({ audioAssetId, ...speech }) => speech), original.pages[0].actions);
    const files = new Map([['package.json', { body: bytes, contentType: 'application/json' }]]);
    for (const asset of payload.assets)
      files.set(asset.path, { body: await readFile(new URL(asset.path, directory)), contentType: asset.mimeType });
    await page.route('**/a8-build/**', route => {
      const file = files.get(new URL(route.request().url()).pathname.slice('/a8-build/'.length));
      return file ? route.fulfill(file) : route.abort();
    });
    await loaded(page);
    await page.evaluate(async buildId => {
      const { mountFixedBuild, englishPlayerLabels } = await import('/dist/player.mjs');
      const bytes = new Uint8Array(await (await fetch('/a8-build/package.json')).arrayBuffer());
      const container = document.createElement('div');
      container.id = 'a8-narration-probe'; document.body.append(container);
      window.__a8Events = []; window.__a8States = [];
      const Audio = window.Audio;
      window.Audio = function (...args) {
        const audio = new Audio(...args);
        for (const type of ['playing', 'ended']) audio.addEventListener(type, () => {
          window.__a8Events.push({ type, index: window.__audios.indexOf(audio), at: performance.now() });
        });
        return audio;
      };
      window.__unmountA8 = await mountFixedBuild(container, bytes, buildId,
        async asset => new Uint8Array(await (await fetch('/a8-build/' + asset.path)).arrayBuffer()),
        { labels: englishPlayerLabels, width: 720,
          onState: (mode, snapshot) => window.__a8States.push({ mode, ...snapshot }) });
    }, fixture.fixedBuild.buildId);
    const mounted = page.locator('#a8-narration-probe');
    await mounted.getByRole('button', { name: 'Play', exact: true }).click();
    await running(page);
    await finishNarration(page);
    await page.waitForFunction(() => window.__a8Events.some(e => e.type === 'ended' && e.index === 0));
    await mounted.getByRole('button', { name: 'Pause', exact: true }).click();
    const pausedAt = await page.evaluate(() => performance.now());
    await page.waitForFunction(at => performance.now() - at >= 4300, pausedAt);
    assert.equal((await mediaState(page)).length, 1);
    assert.equal(await mounted.locator('[data-player-mode]').getAttribute('data-player-mode'), 'paused');
    assert.equal(await mounted.getByRole('button', { name: 'Teacher continue', exact: true }).count(), 0);
    await mounted.getByRole('button', { name: 'Resume', exact: true }).click();
    const resumedAt = await page.evaluate(() => performance.now());
    await page.waitForFunction(() => window.__a8Events.some(e => e.type === 'playing' && e.index === 1));
    const detail = await page.evaluate(({ pausedAt, resumedAt }) => ({
      actualNativeEnded: window.__audios[0].ended,
      pausedForMs: resumedAt - pausedAt,
      effectiveElapsedMs: window.__a8Events.find(e => e.type === 'playing' && e.index === 1).at
        - window.__a8Events.find(e => e.type === 'ended' && e.index === 0).at - (resumedAt - pausedAt),
      events: window.__a8Events,
    }), { pausedAt, resumedAt });
    assert.ok(detail.actualNativeEnded && detail.pausedForMs >= 4300);
    assert.ok(detail.effectiveElapsedMs >= 3800 && detail.effectiveElapsedMs < 6500, JSON.stringify(detail));
    assert.equal(await mounted.locator('[data-player-mode]').getAttribute('data-page-id'), original.pages[0].pageId);
    assert.equal(await mounted.getByRole('button', { name: 'Teacher continue', exact: true }).count(), 0);
    await finishNarration(page);
    await mounted.getByRole('button', { name: 'Teacher continue', exact: true }).waitFor();
    const waiting = await page.evaluate(() => window.__a8States.at(-1));
    assert.equal(waiting.mode, 'waiting_interaction');
    assert.equal(waiting.sceneId, original.pages[0].pageId);
    assert.equal((await mediaState(page)).length, 2);
    await mounted.getByRole('button', { name: 'Teacher continue', exact: true }).click();
    await mounted.getByText('Playback complete', { exact: true }).waitFor();
    await page.evaluate(() => window.__unmountA8());
    assert.ok((await mediaState(page)).every(audio => audio.paused));
    return { buildId: fixture.fixedBuild.buildId, speechIds: original.pages[0].actions.map(a => a.id),
      pauseAfterMs: 4000, waiting, ...detail, actualCompiledMount: true, actualNarrationAndWait: true,
      immutableHostSnapshotVerified: false, matchingNarrationAudioVerified: false };
  });
  const b15 = JSON.parse(await readFile(new URL('../tests/fixtures/office-text-format-b15/SOURCE.json', import.meta.url), 'utf8'));
  for (const [name, expected] of Object.entries(b15.variants)) {
    await test(`desktop-b15-text-format-${name}`, async page => {
      const directory = new URL(`../${expected.fixedBuild.outputDirectory}/${expected.fixedBuild.buildId}/`, import.meta.url);
      const bytes = await readFile(new URL('package.json', directory));
      assert.equal(createHash('sha256').update(bytes).digest('hex'), expected.fixedBuild.buildId);
      const payload = JSON.parse(bytes);
      assert.equal(payload.report.sourceSha256, b15.files[`${name}.pptx`].sha256);
      const files = new Map([['package.json', { body: bytes, contentType: 'application/json' }]]);
      for (const asset of payload.assets)
        files.set(asset.path, { body: await readFile(new URL(asset.path, directory)), contentType: asset.mimeType });
      await page.route('**/b15-build/**', route => {
        const file = files.get(new URL(route.request().url()).pathname.slice('/b15-build/'.length));
        return file ? route.fulfill(file) : route.abort();
      });
      await loaded(page);
      await page.evaluate(async buildId => {
        const { mountFixedBuild, englishPlayerLabels } = await import('/dist/player.mjs');
        const bytes = new Uint8Array(await (await fetch('/b15-build/package.json')).arrayBuffer());
        const container = document.createElement('div');
        container.id = 'b15-format-probe'; document.body.append(container);
        window.__unmountB15 = await mountFixedBuild(container, bytes, buildId,
          async asset => new Uint8Array(await (await fetch('/b15-build/' + asset.path)).arrayBuffer()),
          { labels: englishPlayerLabels, width: 720 });
      }, expected.fixedBuild.buildId);
      const mounted = page.locator('#b15-format-probe');
      await mounted.getByRole('button', { name: 'Next page', exact: true }).click();
      await running(page);
      await mounted.getByRole('button', { name: 'Pause', exact: true }).click();
      await mounted.locator('[data-courseware-fonts-ready="true"]').waitFor();
      const glyphs = await mounted.locator('[data-slide-render-element-id="pptx_shape_1"] .pptx-imported-static-text').evaluate(element => {
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        const result = [];
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const style = getComputedStyle(node.parentElement);
          for (let i = 0; i < node.length; i++) {
            const range = document.createRange(); range.setStart(node, i); range.setEnd(node, i + 1);
            const box = range.getBoundingClientRect();
            result.push({ text: node.data[i].replace(/\u00a0/g, ' '), color: style.color,
              fontSize: parseFloat(style.fontSize), fontFamily: style.fontFamily,
              width: box.width, height: box.height, left: box.left, top: box.top });
          }
        }
        return result;
      });
      assert.equal(glyphs.map(g => g.text).join(''), expected.text);
      const rgb = hex => `rgb(${[0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16)).join(', ')})`;
      assert.deepEqual(glyphs.map(g => g.color), expected.colors.map(rgb));
      glyphs.forEach((glyph, i) => {
        // This 12.8-inch source is normalized to a 1000-unit slide, not CSS point units.
        assert.ok(Math.abs(glyph.fontSize - expected.fontSizesPt[i] * 1000 / (12.8 * 72)) < 0.002,
          JSON.stringify({ name, glyph, expectedPt: expected.fontSizesPt[i] }));
        assert.ok(glyph.width > 0 && glyph.height > 0 && Number.isFinite(glyph.left));
      });
      assert.equal(await mounted.locator('[data-player-mode]').getAttribute('data-page-id'), 'fixture-B15-page-2');
      assert.equal((await mediaState(page)).length, 1);
      await page.screenshot({ path: path.join(output, `b15-${name}-paused.png`) });
      await mounted.getByRole('button', { name: 'Resume', exact: true }).click();
      await running(page);
      await finishNarration(page);
      await mounted.getByRole('button', { name: 'Teacher continue', exact: true }).waitFor();
      assert.equal((await mediaState(page))[0].paused, true);
      await mounted.getByRole('button', { name: 'Teacher continue', exact: true }).click();
      await mounted.getByText('Playback complete', { exact: true }).waitFor();
      await page.evaluate(() => window.__unmountB15());
      assert.ok((await mediaState(page)).every(audio => audio.paused));
      return { buildId: expected.fixedBuild.buildId, sourceSha256: payload.report.sourceSha256,
        glyphs, actualCompiledMount: true, actualNarrationAndWait: true,
        immutableHostSnapshotVerified: false, matchingNarrationAudioVerified: false };
    });
  }
  for (const type of ["video", "audio"]) {
    await test(`fixed-media-effect-replay-${type}`, async (page) => {
      const payload = await (await page.request.get("http://127.0.0.1:4259/build/package.json")).json();
      const element = payload.pages[2].slide.elements.find(e => e.type === "video");
      if (type === "audio") {
        Object.assign(element, { type, src: "voice-3", trimStartMs: 1000, trimEndMs: 3000, loop: false });
        delete element.poster;
      }
      const bytes = Buffer.from(JSON.stringify(payload));
      const buildId = createHash("sha256").update(bytes).digest("hex");
      await page.route("**/build/package.json", route => route.fulfill({ body: bytes, contentType: "application/json" }));
      await page.route("**/fixture.json", route => route.fulfill({ json: { buildId } }));
      await page.goto(base + "index.html?strict=1");
      await page.locator('[data-courseware-fonts-ready="true"]').waitFor();
      await page.getByRole("button", { name: "Next page", exact: true }).click();
      await page.getByRole("button", { name: "Next page", exact: true }).click();
      const media = page.locator(type);
      await media.waitFor();
      // StrictMode replays setup/cleanup on this same native element.
      await page.waitForFunction(() => document.querySelector('[data-courseware-fonts-ready="true"]'));
      const source = await media.getAttribute("src");
      assert.match(source ?? "", /^blob:/, "Effect replay must restore the verified source");
      await page.waitForFunction(type => document.querySelector(type)?.readyState >= 2, type);
      await media.evaluate(async media => { window.__replayedMedia = media; await media.play(); });
      await page.waitForFunction(type => { const m = document.querySelector(type); return !m.paused && m.currentTime > 1.15; }, type);
      if (type === "video") assert.ok(await media.evaluate(m => m.getVideoPlaybackQuality().totalVideoFrames > 0));
      const playing = await media.evaluate(m => ({ time: m.currentTime, duration: m.duration, src: m.src }));
      await page.getByRole("button", { name: "Pause", exact: true }).click();
      const paused = await media.evaluate(m => ({ time: m.currentTime, paused: m.paused }));
      await page.waitForTimeout(350);
      assert.equal(paused.paused, true);
      assert.ok(Math.abs(await media.evaluate(m => m.currentTime) - paused.time) < 0.02);
      await page.getByRole("button", { name: "Resume", exact: true }).click();
      await page.waitForFunction(({ type, time }) => document.querySelector(type).currentTime > time + 0.1, { type, time: paused.time });
      if (type === "audio") {
        await page.waitForFunction(() => window.__replayedMedia.paused && Math.abs(window.__replayedMedia.currentTime - (window.__replayedMedia.duration - 3)) < 0.02);
      }
      await page.getByRole("button", { name: "Previous page", exact: true }).click();
      await page.waitForFunction(type => !document.querySelector(type), type);
      const disposed = await page.evaluate(() => ({ paused: window.__replayedMedia.paused, src: window.__replayedMedia.getAttribute("src") }));
      assert.deepEqual(disposed, { paused: true, src: null });
      assert.equal(await page.getByRole("alert").count(), 0);
      return { buildId, type, playing, paused, disposed, actualCompiledPlayer: true, strictMode: true, immutableHostSnapshotVerified: false };
    });
  }
  await test("fixed-trim-native-clock", async (page) => {
    const response = await page.request.get("http://127.0.0.1:4259/build/package.json");
    const payload = await response.json();
    const element = payload.pages[2].slide.elements.find(e => e.type === "video");
    Object.assign(element, { type: "audio", src: "voice-3", loop: false,
      trimStartMs: 1000, trimEndMs: 3000 });
    delete element.poster;
    const bytes = Buffer.from(JSON.stringify(payload));
    const buildId = createHash("sha256").update(bytes).digest("hex");
    await page.route("**/build/package.json", route => route.fulfill({ body: bytes, contentType: "application/json" }));
    await page.route("**/fixture.json", route => route.fulfill({ json: { buildId } }));
    await loaded(page);
    await page.getByRole("button", { name: "Next page", exact: true }).click();
    await page.getByRole("button", { name: "Next page", exact: true }).click();
    const audio = page.locator("audio");
    await audio.waitFor();
    await page.waitForFunction(() => document.querySelector("audio")?.readyState >= 2);
    const before = await audio.evaluate(async media => {
      window.__trimEnded = 0;
      media.addEventListener("ended", () => window.__trimEnded++);
      media.playbackRate = 0;
      await media.play();
      return { time: media.currentTime, end: media.duration - 3 };
    });
    await page.waitForTimeout((before.end - before.time) * 1000 + 500);
    const stopped = await audio.evaluate(media => ({ time: media.currentTime,
      paused: media.paused, ended: window.__trimEnded }));
    assert.equal(stopped.paused, false);
    assert.equal(stopped.ended, 0);
    assert.ok(Math.abs(stopped.time - before.time) < 0.02);
    await audio.evaluate(media => { media.playbackRate = 1; });
    await page.waitForFunction(() => window.__trimEnded === 1);
    const completed = await audio.evaluate(media => ({ time: media.currentTime,
      paused: media.paused, ended: window.__trimEnded }));
    assert.equal(completed.paused, true);
    assert.ok(Math.abs(completed.time - before.end) < 0.02);
    assert.equal(await page.getByRole("alert").count(), 0);
    return { buildId, before, stopped, completed, actualCompiledPlayer: true,
      actualNativeWav: true, immutableHostSnapshotVerified: false };
  });
  await test("fixed-trim-native-loop", async (page) => {
    const response = await page.request.get("http://127.0.0.1:4259/build/package.json");
    const payload = await response.json();
    const element = payload.pages[2].slide.elements.find(e => e.type === "video");
    Object.assign(element, { type: "audio", src: "voice-3", loop: true,
      trimStartMs: 5200, trimEndMs: 0 });
    delete element.poster;
    const bytes = Buffer.from(JSON.stringify(payload));
    const buildId = createHash("sha256").update(bytes).digest("hex");
    await page.route("**/build/package.json", route => route.fulfill({ body: bytes, contentType: "application/json" }));
    await page.route("**/fixture.json", route => route.fulfill({ json: { buildId } }));
    await loaded(page);
    await page.getByRole("button", { name: "Next page", exact: true }).click();
    await page.getByRole("button", { name: "Next page", exact: true }).click();
    const audio = page.locator("audio");
    await page.waitForFunction(() => {
      const media = document.querySelector("audio");
      return media?.readyState >= 2 && !media.seeking;
    });
    await audio.evaluate(async media => {
      window.__audios.at(-1).playbackRate = 0;
      window.__loopMedia = media;
      window.__loopWraps = [];
      window.__loopEnded = 0;
      media.addEventListener("seeked", () => window.__loopWraps.push(media.currentTime));
      media.addEventListener("ended", () => window.__loopEnded++);
      await media.play();
      // A busy renderer must not let native EOF permanently stop a loop.
      const until = performance.now() + 800;
      while (performance.now() < until) {}
    });
    await page.waitForTimeout(1600);
    const looping = await audio.evaluate(media => ({ time: media.currentTime,
      duration: media.duration, loop: media.loop, paused: media.paused,
      wraps: window.__loopWraps.slice(), ended: window.__loopEnded }));
    assert.equal(looping.paused, false, JSON.stringify(looping));
    assert.equal(looping.loop, true);
    assert.ok(looping.wraps.length >= 2, JSON.stringify(looping));
    assert.ok(looping.wraps.every(time => time >= 5.2 && time < 5.3));
    assert.equal(looping.ended, 0);
    await page.getByRole("button", { name: "Pause", exact: true }).click();
    const paused = await audio.evaluate(media => ({ time: media.currentTime, paused: media.paused }));
    await page.waitForTimeout(600);
    assert.equal(paused.paused, true);
    assert.ok(Math.abs(await audio.evaluate(media => media.currentTime) - paused.time) < 0.02);
    await page.getByRole("button", { name: "Resume", exact: true }).click();
    await page.waitForFunction(count => !window.__loopMedia.paused && window.__loopWraps.length > count, looping.wraps.length);
    await page.getByRole("button", { name: "Previous page", exact: true }).click();
    await page.waitForFunction(() => !document.querySelector("audio"));
    const disposed = await page.evaluate(() => ({ paused: window.__loopMedia.paused,
      src: window.__loopMedia.getAttribute("src"), ended: window.__loopEnded }));
    assert.equal(disposed.paused, true);
    assert.equal(disposed.src, null);
    assert.equal(disposed.ended, 0);
    assert.equal(await page.getByRole("alert").count(), 0);
    return { buildId, looping, paused, disposed, actualCompiledPlayer: true,
      actualNativeWav: true, immutableHostSnapshotVerified: false };
  });
  await test("desktop-html-boundary-and-labels", async (page) => {
    await page.goto(base + "index.html?zh=1");
    await page.getByRole('button', {name: '播放', exact: true}).waitFor();
    assert.equal(await page.getByRole('button', {name: 'Play', exact: true}).count(), 0);
    const detail = await page.evaluate(async () => {
      const {sanitizeSlideHtml} = await import('/src/player/lib/sanitize-slide-html.ts');
      const html = sanitizeSlideHtml('<p style="font-size:24px;color:red;background-image:url(https://invalid.test/x)">safe <a href="javascript:alert(1)">text</a><img src=x onerror="alert(1)"><script>alert(1)</script></p>');
      const div = document.createElement('div'); div.innerHTML = html;
      return { html, script: !!div.querySelector('script,img'), href: div.querySelector('a')?.getAttribute('href'), style: div.querySelector('p')?.getAttribute('style') };
    });
    assert.equal(detail.script, false); assert.equal(detail.href, null);
    assert.match(detail.style, /font-size: 24px/); assert.doesNotMatch(detail.style, /url/);
    return detail;
  });
  await test("stale-resume-after-navigation", async (page) => {
    await loaded(page);
    await page.getByRole("button", { name: "Play", exact: true }).click();
    await running(page);
    await page.getByRole("button", { name: "Pause", exact: true }).click();
    await page.evaluate(() => {
      const audio = window.__audios[0];
      const nativePlay = audio.play.bind(audio);
      // Delay delivery of a real decoder rejection until the next page is playing.
      const gate = new Promise((resolve) => { window.__releaseResume = resolve; });
      audio.play = () => {
        audio.src = URL.createObjectURL(new Blob(["invalid WAV"], { type: "audio/wav" }));
        window.__invalidResumeUrl = audio.src;
        return nativePlay().catch(async (error) => {
          window.__nativeResumeError = error.name;
          await gate;
          throw error;
        });
      };
    });
    await page.getByRole("button", { name: "Resume", exact: true }).click();
    await page.waitForFunction(() => window.__nativeResumeError === "NotSupportedError");
    await page.getByRole("button", { name: "Next page", exact: true }).click();
    await page.waitForFunction(() => window.__audios.length === 2 && window.__audios[1].currentTime > 0.1);
    await page.evaluate(() => window.__releaseResume());
    await page.waitForTimeout(300);
    assert.equal(await page.locator("[data-player-mode]").getAttribute("data-player-mode"), "playing");
    assert.equal(await page.getByRole("alert").count(), 0);
    const result = await mediaState(page);
    assert.equal(result[1].paused, false);
    await page.evaluate(() => URL.revokeObjectURL(window.__invalidResumeUrl));
    return { nativeDecoderRejection: "NotSupportedError", lateRejectionIgnored: true, audio: result };
  });
  for (const destination of ["Previous page", "Replay page"]) {
    await test(`fixed-media-stale-resume-${destination === "Previous page" ? "navigation" : "replay"}`, async (page) => {
      await loaded(page);
      await page.getByRole("button", { name: "Next page", exact: true }).click();
      await page.getByRole("button", { name: "Next page", exact: true }).click();
      const video = page.locator("video");
      await video.waitFor();
      await video.evaluate(async media => { await media.play(); });
      await page.waitForFunction(() => document.querySelector("video").getVideoPlaybackQuality().totalVideoFrames > 0);
      await page.getByRole("button", { name: "Pause", exact: true }).click();
      await page.evaluate(() => {
        const video = document.querySelector("video");
        const nativePlay = video.play.bind(video);
        const gate = new Promise(resolve => { window.__releaseMediaResume = resolve; });
        video.play = () => {
          video.src = URL.createObjectURL(new Blob(["invalid MP4"], { type: "video/mp4" }));
          window.__invalidMediaResumeUrl = video.src;
          return nativePlay().catch(async error => {
            window.__nativeMediaResumeError = error.name;
            await gate;
            throw error;
          });
        };
      });
      await page.getByRole("button", { name: "Resume", exact: true }).click();
      await page.waitForFunction(() => window.__nativeMediaResumeError === "NotSupportedError");
      // The current element's native error must still pause and report a failure.
      await page.getByRole("alert").waitFor();
      assert.equal(await page.locator("[data-player-mode]").getAttribute("data-player-mode"), "paused");
      await page.getByRole("button", { name: destination, exact: true }).click();
      await running(page);
      const before = (await mediaState(page)).at(-1);
      await page.evaluate(() => window.__releaseMediaResume());
      await page.waitForTimeout(300);
      const after = (await mediaState(page)).at(-1);
      assert.equal(await page.locator("[data-player-mode]").getAttribute("data-player-mode"), "playing");
      assert.equal(await page.getByRole("alert").count(), 0);
      assert.equal(after.paused, false);
      assert.ok(after.time > before.time);
      await page.evaluate(() => URL.revokeObjectURL(window.__invalidMediaResumeUrl));
      return { destination, nativeDecoderRejection: "NotSupportedError", currentFailureReported: true,
        lateRejectionIgnored: true, actualVideoFrames: true, before, after };
    });
  }
  await test("narration-wait-navigation", async (page) => {
    await loaded(page);
    await page.getByRole("button", { name: "Play", exact: true }).click();
    await running(page);
    await page.getByRole("button", { name: "Pause", exact: true }).click();
    const paused = await mediaState(page);
    await page.waitForTimeout(250);
    const frozen = await mediaState(page);
    assert.ok(
      paused[0].paused && Math.abs(paused[0].time - frozen[0].time) < 0.03,
    );
    await page.getByRole("button", { name: "Resume", exact: true }).click();
    await page.waitForFunction(
      (t) => window.__audios[0].currentTime > t + 0.1,
      paused[0].time,
    );
    await finishNarration(page);
    await page
      .getByRole("button", { name: "Teacher continue", exact: true })
      .waitFor();
    assert.equal(
      await page.locator("[data-player-mode]").getAttribute("data-page-id"),
      "fixture-page-1",
    );
    await page.waitForTimeout(300);
    assert.equal(
      (await mediaState(page)).length,
      1,
      "Teacher wait must not auto-advance",
    );
    await page
      .getByRole("button", { name: "Teacher continue", exact: true })
      .click();
    await page.waitForFunction(
      () =>
        document.querySelector("[data-page-id]")?.dataset.pageId ===
        "fixture-page-2",
    );
    await page.waitForFunction(
      () =>
        window.__audios.length === 2 && window.__audios[1].currentTime > 0.1,
    );
    await page
      .getByRole("button", { name: "Replay page", exact: true })
      .click();
    await page.waitForFunction(
      () =>
        window.__audios.length === 3 && window.__audios[2].currentTime > 0.1,
    );
    assert.equal((await mediaState(page))[1].paused, true);
    await page.getByRole("button", { name: "Next page", exact: true }).click();
    await page.waitForFunction(
      () =>
        document.querySelector("[data-page-id]")?.dataset.pageId ===
        "fixture-page-3",
    );
    assert.equal((await mediaState(page))[2].paused, true);
    await page
      .getByRole("button", { name: "Previous page", exact: true })
      .click();
    await page.waitForFunction(
      () =>
        document.querySelector("[data-page-id]")?.dataset.pageId ===
        "fixture-page-2",
    );
    return { paused, frozen, finalAudio: await mediaState(page) };
  });
  await test("fixed-silence-pause", async (page) => {
    await loaded(page);
    await page.getByRole("button", { name: "Next page", exact: true }).click();
    await running(page);
    await finishNarration(page);
    await page.waitForTimeout(350);
    await page.getByRole("button", { name: "Pause", exact: true }).click();
    await page.waitForTimeout(1400);
    assert.equal(
      await page.locator("[data-player-mode]").getAttribute("data-page-id"),
      "fixture-page-2",
    );
    await page.getByRole("button", { name: "Resume", exact: true }).click();
    await page.waitForFunction(
      () =>
        document.querySelector("[data-page-id]")?.dataset.pageId ===
        "fixture-page-3",
    );
    return { fixedWaitMs: 1200, pausedForMs: 1400 };
  });
  await test("fixed-maximum-silence-pause", async (page) => {
    const payload = await fetch("http://127.0.0.1:4259/build/package.json").then(r => r.json());
    const speech = payload.pages[0].actions.find(a => a.type === "speech");
    assert.ok(speech);
    speech.pauseAfterMs = 30_000;
    const bytes = Buffer.from(JSON.stringify(payload));
    const buildId = createHash("sha256").update(bytes).digest("hex");
    await page.route("**/fixture.json", route => route.fulfill({ json: { buildId } }));
    await page.route("**/build/package.json", route => route.fulfill({ contentType: "application/json", body: bytes }));
    await loaded(page);
    await page.getByRole("button", { name: "Play", exact: true }).click();
    await running(page);
    await page.evaluate(() => {
      window.__audios.at(-1).addEventListener("ended", () => { window.__endedAt = performance.now(); }, { once: true });
    });
    await finishNarration(page);
    await page.waitForFunction(() => Number.isFinite(window.__endedAt));
    await page.waitForTimeout(3300);
    assert.equal(await page.getByRole("button", { name: "Teacher continue", exact: true }).count(), 0);
    await page.getByRole("button", { name: "Pause", exact: true }).click();
    const pausedAt = await page.evaluate(() => performance.now());
    await page.waitForTimeout(1400);
    assert.equal(await page.locator("[data-player-mode]").getAttribute("data-player-mode"), "paused");
    assert.equal(await page.getByRole("button", { name: "Teacher continue", exact: true }).count(), 0);
    await page.getByRole("button", { name: "Resume", exact: true }).click();
    const resumedAt = await page.evaluate(() => performance.now());
    await page.getByRole("button", { name: "Teacher continue", exact: true }).waitFor({ timeout: 35_000 });
    const detail = await page.evaluate(({ pausedAt, resumedAt }) => ({
      actualNativeEnded: window.__audios[0].ended,
      audioCount: window.__audios.length,
      pausedForMs: resumedAt - pausedAt,
      effectiveElapsedMs: performance.now() - window.__endedAt - (resumedAt - pausedAt),
    }), { pausedAt, resumedAt });
    assert.equal(detail.actualNativeEnded, true);
    assert.equal(detail.audioCount, 1);
    assert.ok(detail.effectiveElapsedMs >= 29_500 && detail.effectiveElapsedMs < 35_000, JSON.stringify(detail));
    return { derivedBuildId: buildId, pauseAfterMs: 30_000, actualNarrationAndWait: true, ...detail };
  });
  await test("autoplay-retry", async (page) => {
    await page.goto(base + "index.html?autostart=1");
    // Let the native play() reject before automation evaluation can grant transient activation.
    await page.waitForTimeout(2000);
    await page.getByRole("alert").waitFor();
    assert.equal(
      await page.locator("[data-player-mode]").getAttribute("data-player-mode"),
      "paused",
    );
    assert.match(
      await page.getByRole("alert").innerText(),
      /autoplay|Audio unavailable/i,
    );
    assert.equal((await mediaState(page))[0].paused, true);
    await page.getByRole("button", { name: "Resume", exact: true }).click();
    await running(page);
    return { recoveredWithUserGesture: true, audio: await mediaState(page) };
  });
  await test("asset-failure", async (page) => {
    await page.route("**/build/assets/*.wav", (route) =>
      route.fulfill({ status: 200, body: "corrupt fixed audio" }),
    );
    await page.goto(base + "index.html");
    await page.getByRole("alert").waitFor();
    assert.match(
      await page.getByRole("alert").innerText(),
      /ASSET_HASH_MISMATCH/,
    );
    assert.equal((await mediaState(page)).length, 0);
    return { rejectedBeforePlayback: true };
  });
  for (const kind of ["missing-page", "duplicate-checkpoint"]) {
    await test(`invalid-wait-${kind}`, async (page) => {
      const original = await fetch(
        "http://127.0.0.1:4259/build/package.json",
      ).then((r) => r.json());
      const wait = original.pages
        .flatMap((p) => p.actions)
        .find((a) => a.type === "interaction_checkpoint");
      assert.ok(wait, "Fixture requires a structured teacher wait");
      if (kind === "missing-page")
        wait.context.sourceSceneIds = ["absent-page"];
      else
        original.pages[1].actions.push({
          ...structuredClone(wait),
          id: "duplicate-wait-action",
        });
      const bytes = Buffer.from(JSON.stringify(original));
      const buildId = createHash("sha256").update(bytes).digest("hex");
      let assetRequests = 0;
      page.on("request", (request) => {
        if (new URL(request.url()).pathname.startsWith("/build/assets/"))
          assetRequests++;
      });
      await page.route("**/fixture.json", (route) =>
        route.fulfill({ json: { buildId } }),
      );
      await page.route("**/build/package.json", (route) =>
        route.fulfill({ contentType: "application/json", body: bytes }),
      );
      await page.goto(base + "index.html");
      await page.getByRole("alert").waitFor();
      const code =
        kind === "missing-page"
          ? "WAIT_BINDING_MISMATCH"
          : "DUPLICATE_CHECKPOINT_ID";
      assert.equal(await page.getByRole("alert").innerText(), code);
      assert.equal(assetRequests, 0);
      assert.equal((await mediaState(page)).length, 0);
      return {
        derivedBuildId: buildId,
        code,
        assetRequests,
        rejectedBeforePlayback: true,
      };
    });
  }
  await test("asset-digest-cancellation", async (page) => {
    await loaded(page);
    const detail = await page.evaluate(async () => {
      const { loadFixedBuild } =
        await import("/src/player/lib/courseware/load-fixed-build.ts");
      const { buildId } = await fetch("/fixture.json").then((r) => r.json());
      const bytes = new Uint8Array(
        await (await fetch("/build/package.json")).arrayBuffer(),
      );
      const assetCount = JSON.parse(new TextDecoder().decode(bytes)).assets
        .length;
      const controller = new AbortController();
      const nativeDigest = crypto.subtle.digest.bind(crypto.subtle);
      const nativeCreate = URL.createObjectURL.bind(URL);
      const nativeRevoke = URL.revokeObjectURL.bind(URL);
      const created = [];
      const revoked = [];
      let digestCount = 0;
      let error = "";
      let resolved = false;
      crypto.subtle.digest = async (...args) => {
        const result = await nativeDigest(...args);
        if (++digestCount === assetCount + 1)
          controller.abort(new Error("Selection replaced during final digest"));
        return result;
      };
      URL.createObjectURL = (blob) => {
        const url = nativeCreate(blob);
        created.push(url);
        return url;
      };
      URL.revokeObjectURL = (url) => {
        revoked.push(url);
        nativeRevoke(url);
      };
      try {
        const result = await loadFixedBuild(
          bytes,
          buildId,
          async (asset, signal) => {
            const response = await fetch(`/build/${asset.path}`, { signal });
            if (!response.ok) throw new Error("Asset request failed");
            return new Uint8Array(await response.arrayBuffer());
          },
          controller.signal,
        );
        resolved = true;
        result.dispose();
      } catch (failure) {
        error = failure.message;
      } finally {
        crypto.subtle.digest = nativeDigest;
        URL.createObjectURL = nativeCreate;
        URL.revokeObjectURL = nativeRevoke;
      }
      return { assetCount, digestCount, created, revoked, error, resolved };
    });
    assert.equal(detail.resolved, false);
    assert.equal(detail.error, "Selection replaced during final digest");
    assert.equal(detail.digestCount, detail.assetCount + 1);
    assert.equal(detail.created.length, detail.assetCount - 1);
    assert.deepEqual(detail.revoked, detail.created);
    assert.equal((await mediaState(page)).length, 0);
    return { ...detail, nativeHashingAndAssetBytes: true };
  });
  for (const denied of [false, true]) {
    await test(
      denied ? "media-task-access-denied" : "media-task-fixed-audio",
      async (page) => {
        const payload = await fetch(
          "http://127.0.0.1:4259/build/package.json",
        ).then((r) => r.json());
        const sample = JSON.parse(
          await readFile(
            new URL(
              "../src/player/tests/fixtures/fixed-playback/media-tasks/task-ready.json",
              import.meta.url,
            ),
            "utf8",
          ),
        );
        const assets = payload.assets.filter(
          (asset) => !asset.id.startsWith("import-asset:"),
        );
        const tasks = await Promise.all(
          assets.map(async (asset, index) => {
            const bytes = Buffer.from(
              await (
                await fetch(`http://127.0.0.1:4259/build/${asset.path}`)
              ).arrayBuffer(),
            );
            const taskId = `local-archived-audio-${index}`;
            return {
              task: {
                ...sample,
                taskId,
                assetRef: {
                  assetId: asset.id,
                  sha256: asset.sha256,
                  mime: asset.mimeType,
                  byteLength: bytes.length,
                  downloadPath: `/courseware/media/tasks/${taskId}/asset`,
                },
              },
              bytes,
            };
          }),
        );
        const requests = [];
        await page.route("**/media-tasks.json", (route) =>
          route.fulfill({ json: tasks.map(({ task }) => task) }),
        );
        await page.route("**/courseware/media/**", async (route) => {
          const request = route.request();
          const pathname = new URL(request.url()).pathname;
          requests.push({ method: request.method(), path: pathname });
          assert.equal(
            request.method(),
            "GET",
            "Playback must not submit or cancel a media task",
          );
          const entry = tasks.find(
            ({ task }) => task.assetRef.downloadPath === pathname,
          );
          assert.ok(entry, "Only pinned task asset retrieval is allowed");
          return denied
            ? route.fulfill({ status: 403, body: "Forbidden" })
            : route.fulfill({
                contentType: entry.task.assetRef.mime,
                body: entry.bytes,
              });
        });
        await page.goto(base + "index.html?media-tasks=1");
        if (denied) {
          await page.getByRole("alert").waitFor();
          assert.equal(
            await page.getByRole("alert").innerText(),
            "Asset request failed (403)",
          );
          assert.equal(requests.length, 1);
          assert.equal((await mediaState(page)).length, 0);
        } else {
          await page.locator("[data-player-mode]").waitFor();
          assert.equal(requests.length, tasks.length);
          await page.getByRole("button", { name: "Play", exact: true }).click();
          await running(page);
          await page
            .getByRole("button", { name: "Pause", exact: true })
            .click();
          assert.equal((await mediaState(page)).at(-1).paused, true);
          await page
            .getByRole("button", { name: "Resume", exact: true })
            .click();
          await running(page);
          await finishNarration(page);
          await page
            .getByRole("button", { name: "Teacher continue", exact: true })
            .waitFor();
          await page
            .getByRole("button", { name: "Teacher continue", exact: true })
            .click();
          await page.waitForFunction(
            () =>
              document.querySelector("[data-player-mode]").dataset.pageId ===
              "fixture-page-2",
          );
          assert.equal(
            requests.length,
            tasks.length,
            "Playback must not retrieve or generate new media",
          );
        }
        return {
          requests,
          readyAssets: tasks.length,
          denied,
          simulatedCResponseWithRealArchivedAudio: true,
          noProviderOrAuthorizationAcceptanceClaim: true,
        };
      },
    );
  }
  await test("decoder-failure", async (page) => {
    const original = await fetch(
      "http://127.0.0.1:4259/build/package.json",
    ).then((r) => r.json());
    const broken = Buffer.from("This is not a decodable WAV file");
    const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
    const voice = original.assets.find((a) => a.id === "voice-1");
    voice.sha256 = hash(broken);
    voice.path = `assets/${voice.sha256}.wav`;
    const bytes = Buffer.from(JSON.stringify(original));
    await page.route("**/fixture.json", (route) =>
      route.fulfill({ json: { buildId: hash(bytes) } }),
    );
    await page.route("**/build/package.json", (route) =>
      route.fulfill({ contentType: "application/json", body: bytes }),
    );
    await page.route(`**/build/${voice.path}`, (route) =>
      route.fulfill({ contentType: "audio/wav", body: broken }),
    );
    await loaded(page);
    await page.getByRole("button", { name: "Play", exact: true }).click();
    await page.getByRole("alert").waitFor();
    assert.equal(
      await page.locator("[data-player-mode]").getAttribute("data-player-mode"),
      "paused",
    );
    assert.equal(
      await page.locator("[data-player-mode]").getAttribute("data-page-id"),
      "fixture-page-1",
    );
    await page.waitForTimeout(600);
    assert.equal(
      await page.locator("[data-player-mode]").getAttribute("data-page-id"),
      "fixture-page-1",
    );
    return {
      actualDecoderError: true,
      stayedOnPage: true,
      error: await page.getByRole("alert").innerText(),
    };
  });
  if (effects) {
    const seek = async (page, timeMs) => {
      const duration = await page.evaluate(
        () => window.__audios.at(-1).duration * 1000,
      );
      const slider = page.getByRole("slider", { name: "Seek narration" });
      const box = await slider.boundingBox();
      const currentMs = Number(await slider.inputValue());
      const x = value => box.x + 8 + ((box.width - 16) * value) / duration;
      // A nearby track click can hit the thumb without moving it; drag the actual thumb.
      await page.mouse.move(x(currentMs), box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(x(timeMs), box.y + box.height / 2, { steps: 4 });
      await page.mouse.up();
      // Wait for the native seek and React's paused progress render before sampling effects.
      await page.waitForFunction(timeMs => {
        const audio = window.__audios.at(-1);
        const slider = document.querySelector('input[aria-label="Seek narration"]');
        return Math.abs(audio.currentTime * 1000 - timeMs) < 75 &&
          Math.abs(Number(slider.value) - timeMs) < 75;
      }, timeMs);
    };
    await test("effects-paused-seek-replay", async (page) => {
      await loaded(page);
      await page.getByRole("button", { name: "Play", exact: true }).click();
      await page.locator('[data-fixed-effect="highlight"]').waitFor();
      await page.getByRole("button", { name: "Pause", exact: true }).click();
      const position = (await mediaState(page))[0].time;
      const highlight = page.locator('[data-fixed-effect="highlight"]');
      const shape = page
        .locator('[data-slide-render-element-id="pptx_shape_2"] > div')
        .first();
      const highlightBox = await highlight.boundingBox();
      const shapeBox = await shape.boundingBox();
      assert.ok(Math.abs(highlightBox.x - (shapeBox.x - 2.88)) < 1);
      assert.ok(Math.abs(highlightBox.width - (shapeBox.width + 5.76)) < 1);
      await page.waitForTimeout(250);
      assert.ok(Math.abs((await mediaState(page))[0].time - position) < 0.03);
      await seek(page, 3000);
      await page.locator('[data-fixed-effect="spotlight"]').waitFor();
      assert.equal(await highlight.count(), 0);
      assert.equal((await mediaState(page))[0].paused, true);
      const spotlight = await page
        .locator('[data-fixed-effect="spotlight"]')
        .getAttribute("data-target-ids");
      assert.equal(spotlight, "pptx_shape_2,pptx_text_3");
      await page.screenshot({
        path: path.join(output, "paused-spotlight.png"),
      });
      await seek(page, 100);
      await page.waitForFunction(
        () => !document.querySelector("[data-fixed-effect]"),
      );
      await seek(page, 1000);
      await highlight.waitFor();
      await page.getByRole("button", { name: "Resume", exact: true }).click();
      await page.locator('[data-fixed-effect="spotlight"]').waitFor();
      await page
        .getByRole("button", { name: "Replay page", exact: true })
        .click();
      await page.waitForFunction(
        () =>
          window.__audios.length === 2 && window.__audios[1].currentTime < 0.5,
      );
      assert.equal(await page.locator("[data-fixed-effect]").count(), 0);
      await highlight.waitFor();
      await finishNarration(page);
      await page
        .getByRole("button", { name: "Teacher continue", exact: true })
        .waitFor();
      assert.equal(await page.locator("[data-fixed-effect]").count(), 0);
      assert.equal(
        await page.getByRole("slider", { name: "Seek narration" }).count(),
        0,
      );
      await page
        .getByRole("button", { name: "Next page", exact: true })
        .click();
      assert.equal(await page.locator("[data-fixed-effect]").count(), 0);
      return {
        nativePausedSeek: true,
        reverseSeek: true,
        replayReconciled: true,
        spotlight,
        highlightBox,
        shapeBox,
        finalAudio: await mediaState(page),
      };
    });
    await test("narration-media-ducking", async (page) => {
      await loaded(page);
      await page
        .getByRole("button", { name: "Next page", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Next page", exact: true })
        .click();
      const video = page.locator("video");
      await page.waitForFunction(
        () =>
          document.querySelector("video")?.readyState >= 2 &&
          document.querySelector("video")?.volume === 0.2,
      );
      const box = await video.boundingBox();
      await video.click({ position: { x: box.width / 2, y: box.height / 2 } });
      await page.waitForFunction(() => !document.querySelector("video").paused);
      await video.evaluate((v) => {
        v.volume = 0.65;
        v.muted = true;
      });
      await page.waitForFunction(
        () => Math.abs(document.querySelector("video").volume - 0.13) < 0.001,
      );
      assert.equal(await video.evaluate((v) => v.muted), true);
      await video.evaluate((v) => {
        v.muted = false;
      });
      await page.getByRole("button", { name: "Pause", exact: true }).click();
      await page.waitForFunction(
        () =>
          document.querySelector("video").paused &&
          document.querySelector("video").volume === 0.65,
      );
      await video.evaluate((v) => {
        v.volume = 0.4;
      });
      await page.getByRole("button", { name: "Resume", exact: true }).click();
      await page.waitForFunction(
        () =>
          !document.querySelector("video").paused &&
          Math.abs(document.querySelector("video").volume - 0.08) < 0.001,
      );
      await finishNarration(page);
      await page.getByText("Playback complete", { exact: true }).waitFor();
      await page.waitForFunction(
        () => document.querySelector("video").volume === 0.4,
      );
      const final = await video.evaluate((v) => ({
        volume: v.volume,
        paused: v.paused,
        frames: v.getVideoPlaybackQuality().totalVideoFrames,
      }));
      assert.ok(final.frames > 0);
      await video.evaluate((v) => {
        window.__priorVideo = v;
      });
      await page
        .getByRole("button", { name: "Replay page", exact: true })
        .click();
      assert.equal(
        await page.evaluate(
          () =>
            window.__priorVideo.paused &&
            !window.__priorVideo.hasAttribute("src"),
        ),
        true,
      );
      return {
        duckGain: 0.2,
        userVolumeRestored: final.volume,
        nativeMutePreserved: true,
        oldMediaReleased: true,
        final,
      };
    });
    if (animations) {
      const target = (page, id) =>
        page.locator(`[data-slide-render-element-id="${id}"]`);
      const style = (locator) =>
        locator.evaluate((e) => ({
          opacity: Number(getComputedStyle(e).opacity),
          scale: Number(getComputedStyle(e).scale),
          visibility: getComputedStyle(e).visibility,
          ariaHidden: e.getAttribute("aria-hidden"),
        }));
      await test("fixed-object-animation-seek", async (page) => {
        await loaded(page);
        const title = target(page, "pptx_text_1");
        const caption = target(page, "pptx_text_3");
        const square = target(page, "pptx_shape_2");
        assert.equal((await style(title)).visibility, "hidden");
        const squareStart = await square.locator(":scope > div").boundingBox();
        await page.getByRole("button", { name: "Play", exact: true }).click();
        await running(page);
        await page.getByRole("button", { name: "Pause", exact: true }).click();
        await seek(page, 1400);
        const fadeIn = await style(title);
        assert.ok(fadeIn.opacity > 0.35 && fadeIn.opacity < 0.65);
        await page.waitForTimeout(500);
        assert.deepEqual(
          await style(title),
          fadeIn,
          "Paused effects must not advance on wall time",
        );
        await seek(page, 3000);
        const pulse = await style(square);
        assert.ok(Math.abs(pulse.scale - 1.1) < 0.002);
        const squarePulse = await square.locator(":scope > div").boundingBox();
        assert.ok(
          Math.abs(squarePulse.width / squareStart.width - 1.1) < 0.003,
        );
        const mask = await page
          .locator('[data-fixed-effect="spotlight"] path')
          .getAttribute("d");
        assert.ok(
          mask.includes("M "),
          "Spotlight geometry must remain present on the scaled object",
        );
        const holes = [
          ...mask.matchAll(
            /M ([\d.e+-]+) ([\d.e+-]+) H ([\d.e+-]+) V ([\d.e+-]+) H ([\d.e+-]+) Z/g,
          ),
        ];
        const holeWidth = (Number(holes[1][3]) - Number(holes[1][1])) * 9.6;
        assert.ok(
          Math.abs(holeWidth - squarePulse.width - 7.68) < 1,
          "Spotlight hole must follow the scaled object bounds",
        );
        await page.screenshot({
          path: path.join(output, "paused-player-pulse.png"),
        });
        await seek(page, 4400);
        const fadeOut = await style(caption);
        assert.ok(fadeOut.opacity > 0.35 && fadeOut.opacity < 0.65);
        await seek(page, 5000);
        assert.equal((await style(caption)).visibility, "hidden");
        await seek(page, 1400);
        assert.equal((await style(caption)).visibility, "visible");
        assert.equal((await style(square)).scale, 1);
        assert.ok((await style(title)).opacity < 0.65);
        await page.getByRole("button", { name: "Resume", exact: true }).click();
        await page.waitForFunction(
          () =>
            Number(
              getComputedStyle(
                document.querySelector(
                  '[data-slide-render-element-id="pptx_text_1"]',
                ),
              ).opacity,
            ) === 1,
        );
        await finishNarration(page);
        await page
          .getByRole("button", { name: "Teacher continue", exact: true })
          .waitFor();
        assert.equal((await style(title)).opacity, 1);
        assert.equal((await style(caption)).visibility, "hidden");
        await caption.evaluate((e) => {
          window.__oldCaption = e;
        });
        await page
          .getByRole("button", { name: "Replay page", exact: true })
          .click();
        await page.waitForFunction(
          () =>
            window.__audios.length === 2 &&
            window.__audios[1].currentTime < 0.5,
        );
        assert.equal((await style(title)).visibility, "hidden");
        assert.equal((await style(caption)).visibility, "visible");
        assert.equal(
          await page.evaluate(() => window.__oldCaption.isConnected),
          false,
        );
        await page
          .getByRole("button", { name: "Next page", exact: true })
          .click();
        assert.equal((await style(target(page, "pptx_text_1"))).opacity, 1);
        return {
          fadeIn,
          fadeOut,
          pulse,
          squareStart,
          squarePulse,
          reverseSeek: true,
          waitStateRetained: true,
          replayAndNavigationReset: true,
        };
      });
      await test("object-animation-speech-boundaries", async (page) => {
        const payload = await fetch(
          "http://127.0.0.1:4259/build/package.json",
        ).then((r) => r.json());
        const speech = payload.pages[0].actions[0];
        const entrance = speech.visualCues.find(
          (c) =>
            c.effect.type === "element_animation" &&
            c.effect.effect === "fadeIn",
        );
        speech.visualCues = speech.visualCues.filter((c) => c !== entrance);
        payload.pages[0].actions.push({
          id: "narration-after-wait",
          type: "speech",
          text: "Second fixed narration",
          audioAssetId: speech.audioAssetId,
          visualCues: [{ ...entrance, atMs: 200, endMs: 1000 }],
        });
        for (const id of ['repeat-pulse-1', 'repeat-pulse-2']) payload.pages[0].actions.push({
          id, type: 'speech', text: 'Emphasize this same teaching object again.', audioAssetId: speech.audioAssetId,
          visualCues: [{ ...entrance, id: `${id}-cue`, atMs: 0, endMs: 1000,
            effect: { ...entrance.effect, effect: 'pulse' } }],
        });
        const bytes = Buffer.from(JSON.stringify(payload));
        const derivedBuildId = createHash("sha256").update(bytes).digest("hex");
        await page.route("**/fixture.json", (route) =>
          route.fulfill({ json: { buildId: derivedBuildId } }),
        );
        await page.route("**/build/package.json", (route) =>
          route.fulfill({ contentType: "application/json", body: bytes }),
        );
        await loaded(page);
        const title = target(page, "pptx_text_1");
        const caption = target(page, "pptx_text_3");
        await page.getByRole("button", { name: "Play", exact: true }).click();
        await running(page);
        assert.equal((await style(title)).visibility, "hidden");
        await finishNarration(page);
        await page
          .getByRole("button", { name: "Teacher continue", exact: true })
          .waitFor();
        assert.equal((await style(title)).visibility, "hidden");
        assert.equal((await style(caption)).visibility, "hidden");
        await page
          .getByRole("button", { name: "Teacher continue", exact: true })
          .click();
        await page.waitForFunction(
          () =>
            window.__audios.length === 2 &&
            window.__audios[1].currentTime > 0.1,
        );
        await page.getByRole("button", { name: "Pause", exact: true }).click();
        await seek(page, 600);
        const secondSpeech = await style(title);
        assert.ok(secondSpeech.opacity > 0.35 && secondSpeech.opacity < 0.65);
        assert.equal(
          (await style(caption)).visibility,
          "hidden",
          "Earlier exit must persist through the next narration",
        );
        await page.getByRole("button", { name: "Resume", exact: true }).click();
        await finishNarration(page);
        const repeatedPulses = [];
        for (const audioCount of [3, 4]) {
          await page.waitForFunction(count => window.__audios.length === count && window.__audios.at(-1).currentTime > 0.05, audioCount);
          await page.getByRole('button', { name: 'Pause', exact: true }).click();
          await seek(page, 500);
          const pulse = await style(title);
          assert.ok(pulse.scale > 1.09 && pulse.scale < 1.11, 'Each later speech must pulse the same visible object');
          assert.equal(pulse.visibility, 'visible');
          repeatedPulses.push(pulse);
          await page.getByRole('button', { name: 'Resume', exact: true }).click();
          await finishNarration(page);
        }
        await page.waitForFunction(
          () =>
            document.querySelector("[data-page-id]")?.dataset.pageId ===
            "fixture-page-2",
        );
        return {
          derivedBuildId,
          sameArchivedAudio: true,
          futureEntranceHeld: true,
          earlierExitRetained: true,
          secondSpeech,
          repeatedPulses,
        };
      });
    }
  }
  for (const legacy of [false]) {
    await test(
      legacy ? "legacy-video-click" : "fixed-video-click",
      async (page) => {
        if (legacy) await page.goto(base + "legacy.html");
        else {
          await loaded(page);
          await page
            .getByRole("button", { name: "Next page", exact: true })
            .click();
          await page
            .getByRole("button", { name: "Next page", exact: true })
            .click();
        }
        const video = page.locator("video");
        await video.waitFor();
        await page.waitForFunction(
          () => document.querySelector("video")?.readyState >= 2,
        );
        const box = await video.boundingBox();
        console.log("MEDIA ready", legacy, box);
        await video.click({
          position: { x: box.width / 2, y: box.height / 2 },
        });
        await page.waitForFunction(() => {
          const v = document.querySelector("video");
          return (
            !v.paused &&
            v.currentTime > 0.15 &&
            v.getVideoPlaybackQuality().totalVideoFrames > 0
          );
        });
        console.log("MEDIA center play", legacy);
        const centerPlay = await video.evaluate((v) => ({
          paused: v.paused,
          time: v.currentTime,
          frames: v.getVideoPlaybackQuality().totalVideoFrames,
        }));
        await page.waitForTimeout(350);
        await video.click({
          position: { x: box.width / 2, y: box.height / 2 },
        });
        assert.equal(await video.evaluate((v) => v.paused), true);
        console.log("MEDIA center pause", legacy);
        // Chromium native controls are in a closed UA shadow tree; click its visible play control.
        await video.hover();
        await video.click({ position: { x: 24, y: box.height - 46 } });
        await page.waitForFunction(
          () => !document.querySelector("video").paused,
        );
        await page.waitForTimeout(600);
        await video.click({ position: { x: 24, y: box.height - 46 } });
        assert.equal(await video.evaluate((v) => v.paused), true);
        console.log("MEDIA controls checked", legacy);
        if (legacy) {
          await page
            .getByRole("button", { name: "Action play", exact: true })
            .click();
          await page.waitForFunction(
            () => !document.querySelector("video").paused,
          );
          assert.equal(await video.evaluate((v) => v.controls), false);
          await page
            .getByRole("button", { name: "Action pause", exact: true })
            .click();
          await page.waitForFunction(
            () => document.querySelector("video").paused,
          );
          await page
            .getByRole("button", { name: "Action resume", exact: true })
            .click();
          await page.waitForFunction(
            () => !document.querySelector("video").paused,
          );
          await page
            .getByRole("button", { name: "Action stop", exact: true })
            .click();
          await page.waitForFunction(
            () => document.querySelector("video").paused,
          );
          await page
            .getByRole("button", { name: "Thumbnail", exact: true })
            .click();
          assert.equal(await video.evaluate((v) => v.controls), false);
          assert.equal(await video.evaluate((v) => v.paused), true);
          await page
            .getByRole("button", { name: "Edit mode", exact: true })
            .click();
          assert.equal(await video.evaluate((v) => v.controls), false);
          assert.equal(await video.evaluate((v) => v.paused), true);
          const editBox = await video.boundingBox();
          await video.click({ position: { x: 80, y: 80 } });
          await page.waitForFunction(
            () =>
              document.querySelector("[data-selection-count]")?.dataset
                .selectionCount === "1",
          );
          await page
            .getByRole("button", { name: "播放视频", exact: true })
            .click();
          await page.waitForFunction(
            () => !document.querySelector("video").paused,
          );
          assert.equal(
            await page
              .locator("[data-selection-count]")
              .getAttribute("data-selection-count"),
            "1",
          );
          await page
            .getByRole("button", { name: "暂停视频", exact: true })
            .click();
          await page
            .getByRole("button", { name: "Lock selection", exact: true })
            .click();
          await video.click({ position: { x: editBox.width - 80, y: 80 } });
          assert.equal(
            await page
              .locator("[data-selection-count]")
              .getAttribute("data-selection-count"),
            "1",
          );
        } else {
          await page.waitForTimeout(600);
          await video.hover();
          await video.click({ position: { x: 24, y: box.height - 46 } });
          await page.waitForFunction(
            () => !document.querySelector("video").paused,
          );
          await page
            .getByRole("button", { name: "Pause", exact: true })
            .click();
          assert.equal(await video.evaluate((v) => v.paused), true);
          await page
            .getByRole("button", { name: "Resume", exact: true })
            .click();
          await page.waitForFunction(
            () => !document.querySelector("video").paused,
          );
          await page
            .getByRole("button", { name: "Previous page", exact: true })
            .click();
          await page.waitForFunction(() => !document.querySelector("video"));
        }
        return { centerPlay, nativeControlsPlayPause: true, legacy };
      },
    );
  }
} catch (error) {
  report.error = String(error);
  throw error;
} finally {
  try {
    await browser.close();
  } catch (error) {
    report.closeError = String(error);
    if (!report.error) throw error;
  } finally {
    await writeFile(
      path.join(output, "result.json"),
      JSON.stringify(report, null, 2),
    );
  }
}
assert.equal(report.results.length, only ? 1 : (animations ? 37 : effects ? 35 : 33) + (electron ? 1 : 0));
assert.ok(
  report.results.every((r) => r.status === "PASS"),
  JSON.stringify(report.results, null, 2),
);
console.log(
  `PASS: ${report.results.length} Desktop fixed playback checks`,
);
