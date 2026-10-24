/** Real React panel clicks; only the preload IPC boundary is a stand-in. */
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { IPC } from "../packages/shared/dist/index.js";
import { testTtsTasks } from "./e2e/tts-tasks.mjs";
import { testTeachingFollow } from "./e2e/teaching-follow.mjs";
import { testShareRecovery } from "./e2e/share-recovery.mjs";

assert(process.env.DECKWISE_E2E_OUTPUT, "Missing DECKWISE_E2E_OUTPUT");
const out = resolve(process.env.DECKWISE_E2E_OUTPUT); await mkdir(out);
const ttsTasks = process.argv.includes("--tts-tasks");
const teachingFollow = process.argv.includes("--follow-page");
const shareRecovery = process.argv.includes("--share-recovery");
const desktop = createRequire(new URL("../apps/desktop/package.json", import.meta.url));
const { createServer } = desktop("vite");
const { chromium, expect } = createRequire(new URL("../packages/courseware-runtime/package.json", import.meta.url))("@playwright/test");
const fixture = JSON.parse(await readFile(new URL("../packages/shared/src/courseware-contract.fixtures/accepted.json", import.meta.url), "utf8"));
const project = structuredClone(fixture.project);
for (const page of project.pages) { page.actions = []; page.reviewState = "ready"; }
const snapshot = { snapshotId: "frozen-1", projectId: project.projectId, source: project.source,
  teachingRevision: project.teachingRevision, mappingRevision: "mapping-1", assetIds: [] };
const report = { status: "RUNNING", checks: [], realReact: true, ipcStandIn: true, paidCalls: false };
const errors = []; let browser, server;
try {
  server = await createServer({ root: new URL("../apps/desktop", import.meta.url).pathname, configFile: false,
    server: { host: "127.0.0.1", port: 0 }, esbuild: { jsx: "automatic" },
    plugins: [{ name: "courseware-panel-test", resolveId(id) { if (id === "/__courseware-panel.jsx") return id; },
      load(id) { if (id === "/__courseware-panel.jsx") return `
        import { createElement } from 'react';
        import { createRoot } from 'react-dom/client';
        import i18n from 'i18next';
        import { I18nextProvider } from 'react-i18next';
        import { catalogs } from '@pi-desktop/i18n';
        import { CoursewarePlaybackPanel } from '/src/components/workpanel/CoursewarePlaybackPanel.tsx';
        import { CoursewareTeachingPanel } from '/src/components/workpanel/CoursewareTeachingPanel.tsx';
        await i18n.init({ lng:'en', resources:{ en:{translation:catalogs.en}, 'zh-CN':{translation:catalogs['zh-CN']} } });
        const root = createRoot(document.getElementById('root')); let generation = 0;
        window.renderView = async (view, enabled = true, language = 'en', remount = true) => {
          await i18n.changeLanguage(language);
          if (remount) generation++;
          root.render(createElement(I18nextProvider, {i18n}, createElement(${ttsTasks || teachingFollow ? "CoursewareTeachingPanel" : "CoursewarePlaybackPanel"},
            {key:generation, view, enabled, sessionId:'chat-1', onActiveChange(active) { window.active = active; }})));
        };
      `; }, configureServer(instance) { instance.middlewares.use((req, res, next) => {
        if (req.url !== "/__courseware-panel") return next();
        res.setHeader("content-type", "text/html"); res.end('<div id="root"></div><script type="module" src="/__courseware-panel.jsx"></script>');
      }); } }] });
  await server.listen();
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  const page = await browser.newPage(); page.on("pageerror", (error) => errors.push(error.stack));
  await page.addInitScript(({ channels, snapshot }) => {
    window.calls = []; window.rejectCapture = false; window.rejectBuild = false; window.deferCapture = false;
    window.piDesktop = { async invoke(channel, payload) {
      window.calls.push({ channel, payload });
      if (channel === channels.coursewareFixedShareStatus) return { ok: true, data: { intent: null } };
      if (channel === channels.coursewareTeamProjects) return { ok: true, data: [] };
      if (channel === channels.coursewareFixedCancel || channel === channels.coursewareFixedPlay) return { ok: true, data: { ok: true } };
      if (channel === channels.pptEditorSnapshotCapture) {
        if (window.deferCapture) await new Promise((resolve) => { window.releaseCapture = resolve; });
        if (window.rejectCapture) return { ok: false, error: { code: "COURSEWARE_AUDIO_REQUIRED", message: "COURSEWARE_AUDIO_REQUIRED: stale audio" } };
        return { ok: true, data: snapshot };
      }
      if (channel === channels.coursewareFixedBuild) {
        if (window.rejectBuild) return { ok: false, error: { code: "CONTENT_ERROR",
          message: "CONTENT_ERROR: PPTX_NATIVE_MATH_UNVERIFIED: PPTX 第 9 页包含尚未验证还原的原生 Office 公式" } };
        return { ok: true, data: { status: "review", reviewId: "review-1", snapshot,
          diagnostics: [{ code: "REVIEW_FIXTURE", severity: "warning", message: "Review this conversion" }] } };
      }
      if (channel === channels.coursewareFixedApprove) return { ok: true, data: { status: "ready", previewId: "preview-1", snapshot,
        buildRef: { buildId: "build-1", packageSha256: "hash", snapshotId: snapshot.snapshotId }, report: {} } };
      throw new Error(`Unexpected IPC: ${channel}`);
    } };
  }, { channels: IPC.invoke, snapshot });
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__courseware-panel`);
  await page.waitForFunction(() => !!window.renderView);
  if (shareRecovery) {
    await testShareRecovery({ page, expect, project, snapshot, IPC, report });
    report.status = "PASS_REACT_SHARE_RECOVERY";
  } else if (teachingFollow) {
    await testTeachingFollow({ page, expect, project, IPC, report });
    report.status = "PASS_REACT_TEACHING_FOLLOW";
  } else if (ttsTasks) {
    await testTtsTasks({ page, expect, project, IPC, report });
    report.status = "PASS_REACT_TTS_TASKS";
  } else {
  const view = (actions = [[], []]) => ({ viewId: "view-1", pageId: project.pages[0].pageId,
    project: { ...project, pages: project.pages.map((entry, index) => ({ ...entry, actions: actions[index] ?? [] })) } });
  const render = async (data, enabled = true, language = "en") => {
    await page.evaluate(async ({ data, enabled, language }) => { await window.renderView(data, enabled, language); }, { data, enabled, language });
    await expect(page.locator(".courseware-playback")).toBeVisible();
    await page.evaluate(() => { window.calls = []; });
  };
  const build = () => page.getByRole("button", { name: /^(Build preview|构建预览)$/ });
  const step = async (name, run) => { await run(); report.checks.push(name); console.log("PASS", name); };
  await step("No-speech confirmed preview stays enabled; dirty and unconfirmed views stay disabled", async () => {
    await render(view()); await expect(build()).toBeEnabled();
    await render(view(), false); await expect(build()).toBeDisabled();
    const pending = view(); pending.project.pages[1].reviewState = "review";
    await render(pending); await expect(build()).toBeDisabled();
  });
  const speech = { id: "speech-1", type: "speech", text: "Good!", audioAssetId: `tts-${"a".repeat(64)}` };
  await step("Missing, malformed and another page's absent audio disable narrated preview", async () => {
    for (const asset of [undefined, "forged", "tts-ABC"]) {
      await render(view([[{ ...speech, audioAssetId: asset }]]));
      await expect(build()).toBeDisabled(); await expect(page.getByRole("status")).toContainText("matching adopted audio");
    }
    await render(view([[speech], [{ ...speech, id: "speech-2", audioAssetId: undefined }]]), true, "zh-CN");
    await expect(build()).toBeDisabled(); await expect(page.getByRole("status")).toContainText("匹配的已采用配音");
    assert.deepEqual(await page.evaluate(() => window.calls), []);
  });
  await step("Adopted audio enables capture, exact warning approval, play and close through real React handlers", async () => {
    await render(view([[speech]])); await expect(build()).toBeEnabled(); await build().click();
    const proceed = page.getByRole("button", { name: "Continue building", exact: true });
    await expect(proceed).toBeDisabled(); await page.getByRole("checkbox").check(); await proceed.click();
    await page.getByRole("button", { name: "Play preview", exact: true }).click();
    const calls = await page.evaluate(() => window.calls);
    assert.deepEqual(calls.filter(({ channel }) => ![IPC.invoke.coursewareFixedCancel,
      IPC.invoke.coursewareFixedShareStatus, IPC.invoke.coursewareTeamProjects].includes(channel)), [
      { channel: IPC.invoke.pptEditorSnapshotCapture, payload: { viewId: "view-1", expectedTeachingRevision: project.teachingRevision } },
      { channel: IPC.invoke.coursewareFixedBuild, payload: { sessionId: "chat-1", projectId: snapshot.projectId, snapshotId: snapshot.snapshotId } },
      { channel: IPC.invoke.coursewareFixedApprove, payload: { reviewId: "review-1", codes: ["REVIEW_FIXTURE"] } },
      { channel: IPC.invoke.coursewareFixedPlay, payload: { previewId: "preview-1", locale: "en" } },
    ]);
    await page.getByRole("button", { name: "Close preview / cancel", exact: true }).click(); await expect(build()).toBeEnabled();
    assert.equal(await page.evaluate(() => window.active), false);
  });
  await step("Host capture rejection is visible and cannot continue into a build", async () => {
    await render(view([[speech]])); await page.evaluate(() => { window.rejectCapture = true; }); await build().click();
    await expect(page.getByRole("alert")).toContainText("COURSEWARE_AUDIO_REQUIRED"); await expect(build()).toBeEnabled();
    assert(!(await page.evaluate(() => window.calls)).some(({ channel }) => channel === IPC.invoke.coursewareFixedBuild));
    await page.evaluate(() => { window.rejectCapture = false; });
  });
  await step("Blocking conversion identifies the affected page in the visible panel", async () => {
    await render(view()); await page.evaluate(() => { window.rejectBuild = true; }); await build().click();
    await expect(page.getByRole("alert")).toContainText("PPTX 第 9 页包含尚未验证还原的原生 Office 公式");
    await expect(build()).toBeEnabled();
    await page.evaluate(() => { window.rejectBuild = false; });
  });
  await step("Closing during snapshot capture prevents a late narrated build", async () => {
    await render(view([[speech]])); await page.evaluate(() => { window.deferCapture = true; }); await build().click();
    await page.waitForFunction(() => !!window.releaseCapture);
    await page.getByRole("button", { name: "Close preview / cancel", exact: true }).click();
    await page.evaluate(async () => { window.releaseCapture(); await new Promise(requestAnimationFrame); });
    await expect(build()).toBeEnabled();
    assert(!(await page.evaluate(() => window.calls)).some(({ channel }) => channel === IPC.invoke.coursewareFixedBuild));
  });
  report.status = "PASS_REACT_PLAYBACK_PANEL";
  }
  assert.deepEqual(errors, []);
  await page.screenshot({ path: `${out}/panel.png` });
} catch (error) { report.status = "FAIL"; report.error = error.stack; process.exitCode = 1;
} finally {
  await browser?.close(); await server?.close();
  await writeFile(`${out}/report.json`, JSON.stringify({ ...report, errors }, null, 2));
}
