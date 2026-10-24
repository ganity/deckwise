import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

/** Isolated external Platform protocol fixture; Main/IPC/renderer remain real. */
export function onlineTeachingPlatform({ projectId, source }) {
  const prefix = `/courseware/team/projects/${projectId}`;
  const project = { schemaVersion: "deckwise-courseware/1", projectId, taskType: "plain", title: "Teaching fixture",
    source, teachingRevision: randomUUID(), pages: [
      { pageId: "logical-page-1", actions: [
        { id: "speech-1", type: "speech", text: "Original narration", pauseAfterMs: 300 },
        { id: "checkpoint-1", type: "checkpoint", label: "Preserve this opaque action" },
      ], locked: false, reviewState: "ready" },
      { pageId: "logical-page-2", actions: [{ id: "speech-2", type: "speech", text: "Second page narration" }], locked: false, reviewState: "ready" },
    ] };
  const events = [], receipts = new Map();
  let lease, pause, leaseEpoch = 0, dropNextWrite = false, dropNextResume = false, commits = 0;
  const version = () => structuredClone({ project, mappingRevision: "initial-logical-mapping" });
  const readBody = async request => {
    let raw = ""; for await (const bytes of request) raw += bytes;
    assert(raw.length <= 100_000); return JSON.parse(raw);
  };
  return {
    events, project,
    get commits() { return commits; },
    dropNextWrite() { dropNextWrite = true; },
    holdWrites() {
      assert(!pause || pause.state === "released");
      pause = { projectId, sessionEpoch: 5, pauseId: randomUUID(), state: "held", teaching: version() };
      lease = undefined; leaseEpoch++;
      events.push({ type: "fixture-held", pauseId: pause.pauseId });
      return structuredClone(pause);
    },
    dropNextResume() { dropNextResume = true; },
    async handle({ request, response, route, actor, send }) {
      if (!route.startsWith(prefix)) return false;
      if (route === `${prefix}/editing-session/5/write-pauses/current` && request.method === "GET") {
        const held = pause?.state === "held" ? structuredClone(pause) : null;
        events.push({ type: "pause-read", pauseId: held?.pauseId ?? null }); send(held); return true;
      }
      if (pause && route === `${prefix}/editing-session/5/write-pauses/${pause.pauseId}` && request.method === "DELETE") {
        assert.equal(actor.role, "OWNER"); pause.state = "released";
        events.push({ type: "resume", pauseId: pause.pauseId });
        if (dropNextResume) {
          dropNextResume = false; events.push({ type: "resume-response-lost", pauseId: pause.pauseId });
          response.writeHead(503, { "content-type": "text/plain" }); response.end("Isolated gateway lost the resume result");
        } else send(structuredClone(pause));
        return true;
      }
      if (route === `${prefix}/teaching` && request.method === "GET") {
        events.push({ type: "read", teachingRevision: project.teachingRevision }); send(version()); return true;
      }
      const match = route.match(/\/pages\/(logical-page-[12])\/lease$/u);
      if (match) {
        assert.notEqual(actor.role, "VIEWER");
        if (pause?.state === "held" && request.method !== "DELETE") { send(null, 46800); return true; }
        const body = await readBody(request), pageId = match[1];
        assert.equal(body.sessionEpoch, 5);
        if (request.method === "POST") {
          assert(!lease, "Fixture permits one page lease");
          lease = { projectId, pageId, sessionEpoch: 5, leaseEpoch: ++leaseEpoch, leaseToken: randomUUID(), expiresAtEpochMillis: Date.now() + 60_000 };
          events.push({ type: "acquire", pageId }); send(lease);
        } else {
          assert(lease && lease.pageId === pageId); assert.equal(body.leaseEpoch, lease.leaseEpoch); assert.equal(body.leaseToken, lease.leaseToken);
          if (request.method === "PUT") {
            lease.expiresAtEpochMillis = Date.now() + 60_000; events.push({ type: "renew", pageId }); send(lease);
          } else {
            assert.equal(request.method, "DELETE"); events.push({ type: "release", pageId }); lease = undefined; send(null);
          }
        }
        return true;
      }
      if (route !== `${prefix}/teaching/writes` || request.method !== "POST") return false;
      assert.notEqual(actor.role, "VIEWER");
      const body = await readBody(request), raw = JSON.stringify(body);
      events.push({ type: "write", body: structuredClone(body) });
      const existing = receipts.get(body.requestId);
      if (existing) { assert.equal(raw, existing.raw, "Replay must use identical request and actions"); send(existing.result); return true; }
      if (pause?.state === "held") { send(null, 46800); return true; }
      assert(lease); assert.equal(body.lease.leaseToken, lease.leaseToken); assert.equal(body.lease.leaseEpoch, lease.leaseEpoch);
      assert.equal(body.lease.sessionEpoch, lease.sessionEpoch); assert.equal(body.write.projectId, projectId);
      assert.equal(body.write.pageId, lease.pageId); assert.equal(body.write.expectedSourceRevision, source.revision);
      assert.equal(body.write.expectedTeachingRevision, project.teachingRevision);
      const page = project.pages.find(item => item.pageId === body.write.pageId); assert(page);
      assert.deepEqual(body.write.actions.filter(action => action.type !== "speech"), page.actions.filter(action => action.type !== "speech"));
      page.actions = structuredClone(body.write.actions); page.reviewState = "review";
      project.teachingRevision = randomUUID(); commits++;
      const result = version(); receipts.set(body.requestId, { raw, result });
      // A gateway can lose the successful upstream result after commit. A 503
      // avoids Chromium transparently retrying a disconnected pooled socket.
      if (dropNextWrite) { dropNextWrite = false; events.push({ type: "committed-response-lost", requestId: body.requestId });
        response.writeHead(503, { "content-type": "text/plain" }); response.end("Isolated gateway lost the committed result"); }
      else send(result);
      return true;
    },
  };
}

export async function verifyOnlineTeaching({ app, page, expect, invoke, step, teamPanel, opened, nativeFrame, teaching, projectId, output }) {
  const panel = page.locator(".courseware-online-teaching");
  const text = panel.locator("textarea").first();
  const button = name => panel.getByRole("button", { name, exact: true });
  const select = panel.getByRole("combobox", { name: "首次源稿页序" });
  const evidence = { realElectron: true, realMainAndIPC: true, platformHttpFixture: true, docsProtocolFixture: true,
    realSpringPlatform: false, realDocsEngine: false, sourceRevision: teaching.project.source.revision };
  await step("Actual team Join reads narration readonly and explicitly selects initial logical pages", async () => {
    await teamPanel(); await opened();
    await expect(panel).toBeVisible(); await expect(text).toHaveValue("Original narration"); await expect(text).toBeDisabled();
    await expect(select.locator("option")).toHaveCount(2);
    await expect(panel.getByText(/不会跟随 PPT 当前页/u)).toBeVisible();
    await select.selectOption("logical-page-2"); await expect(text).toHaveValue("Second page narration");
    await select.selectOption("logical-page-1"); await expect(text).toHaveValue("Original narration");
    assert(!teaching.events.some(event => event.type === "acquire" || event.type === "write"));
    await page.screenshot({ path: join(output, "01-readonly-logical-pages.png") });
  });
  await step("Actual controls acquire a page lease, edit text and pause, save through Main, then release", async () => {
    await button("编辑讲解词").click(); await expect(text).toBeEnabled();
    await text.fill("Narration saved from actual Electron controls"); await panel.locator('input[type="number"]').fill("700");
    await button("保存讲解词").click(); await expect(panel.getByText("讲解词已保存到团队项目。", { exact: true })).toBeVisible();
    assert.equal(teaching.commits, 1);
    assert.equal(teaching.project.pages[0].actions[0].text, "Narration saved from actual Electron controls");
    assert.equal(teaching.project.pages[0].actions[0].pauseAfterMs, 700);
    assert.deepEqual(teaching.project.pages[0].actions[1], { id: "checkpoint-1", type: "checkpoint", label: "Preserve this opaque action" });
    await button("释放编辑权").click(); await expect(text).toBeDisabled();
    assert.equal(teaching.events.filter(event => event.type === "release").length, 1);
    await page.screenshot({ path: join(output, "02-saved-released.png") });
  });
  await step("A committed but lost HTTP response freezes the draft and explicitly replays the identical pending save", async () => {
    await button("编辑讲解词").click(); await expect(text).toBeEnabled(); await text.fill("Exactly-once pending save narration");
    teaching.dropNextWrite(); await button("保存讲解词").click();
    await expect(button("继续保存／确认结果")).toBeEnabled({ timeout: 15_000 });
    await expect(text).toHaveValue("Exactly-once pending save narration"); await expect(text).toBeDisabled();
    await expect(select).toBeDisabled(); await expect(button("读取最新讲解词")).toBeDisabled(); await expect(button("释放编辑权")).toBeDisabled();
    assert.equal(teaching.commits, 2);
    await page.screenshot({ path: join(output, "03-pending-result-frozen.png") });
    await page.locator(".courseware-online-editor header button").last().click();
    const exit = page.locator(".courseware-online-editor > .courseware-online-teaching-discard");
    await expect(exit).toBeVisible(); await expect(exit.getByRole("button", { name: "丢弃草稿并继续", exact: true })).toHaveCount(0);
    await exit.getByRole("button", { name: "保留草稿", exact: true }).click();
    await button("继续保存／确认结果").click(); await expect(panel.getByText("讲解词已保存到团队项目。", { exact: true })).toBeVisible();
    const writes = teaching.events.filter(event => event.type === "write"); assert.equal(writes.length, 3);
    assert.deepEqual(writes[1].body, writes[2].body); assert.equal(teaching.commits, 2);
    evidence.pendingReplay = { requestId: writes[1].body.requestId, identicalRequest: true, httpAttempts: 2, additionalCommits: 1 };
    await button("释放编辑权").click(); await expect(text).toBeDisabled();
    await page.screenshot({ path: join(output, "04-pending-replayed.png") });
  });
  await step("Page switching and Back retain dirty drafts until explicit discard, while the native view stays attached", async () => {
    await button("编辑讲解词").click(); await expect(text).toBeEnabled(); await text.fill("Retain this unsaved draft");
    await select.selectOption("logical-page-2");
    const discard = panel.locator("div.courseware-online-teaching-discard");
    await expect(discard).toBeVisible(); await expect(text).toHaveValue("Retain this unsaved draft");
    await discard.getByRole("button", { name: "保留草稿", exact: true }).click();
    await expect(select).toHaveValue("logical-page-1");
    await page.locator(".courseware-online-editor header button").last().click();
    const exit = page.locator(".courseware-online-editor > .courseware-online-teaching-discard");
    await expect(exit).toBeVisible(); await expect(text).toHaveValue("Retain this unsaved draft");
    await exit.getByRole("button", { name: "保留草稿", exact: true }).click();
    await select.selectOption("logical-page-2"); await discard.getByRole("button", { name: "丢弃草稿并继续", exact: true }).click();
    await expect(text).toHaveValue("Second page narration"); await expect(text).toBeDisabled();
    assert.equal(teaching.commits, 2); assert.equal(teaching.events.filter(event => event.type === "release").length, 3);
    const state = await invoke("coursewareOnlineState"); assert.equal(state.status, "ready"); assert.equal(state.projectId, projectId);
    const rect = await page.locator(".courseware-online-editor .ppt-editor-surface").evaluate(element => {
      const { x, y, width, height } = element.getBoundingClientRect();
      return Object.fromEntries(Object.entries({ x, y, width, height }).map(([key, value]) => [key, Math.round(value)]));
    });
    await expect.poll(async () => {
      evidence.nativeVisibility = await app.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0];
        const children = window.contentView.children.filter(child => child.webContents?.getURL() === "deckwise-editor://host/online.html");
        return { attached: children.length, bounds: children[0]?.getBounds(), content: window.getContentBounds() };
      });
      return evidence.nativeVisibility.attached === 1 && Object.entries(rect).every(([key, value]) => evidence.nativeVisibility.bounds[key] === value);
    }, { timeout: 5000 }).toBe(true);
    assert(rect.width > 0 && rect.height > 0); evidence.nativeVisibility.rendererSlot = rect;
    const frame = await nativeFrame(); await expect(frame.getByText("Isolated Docs API fixture", { exact: true })).toBeVisible();
    await frame.page().screenshot({ path: join(output, "06-native-fixture-view.png") });
    await page.screenshot({ path: join(output, "05-explicit-discard-page-two.png") });
  });
  await step("Owner checks an existing teaching-only pause and explicitly recovers a lost resume response before editing again", async () => {
    const recovery = panel.locator('section[aria-label="恢复讲解词编辑"]');
    const check = recovery.getByRole("button", { name: "检查暂停状态", exact: true });
    const resume = recovery.getByRole("button", { name: "恢复讲解词编辑", exact: true });
    await expect(check).toBeEnabled();
    const held = teaching.holdWrites();
    await check.click();
    await expect(recovery).toContainText(`已暂停的教学版本：${held.teaching.project.teachingRevision}（会话 5）。`);
    await expect(recovery.getByText("仅讲解词编辑暂停，PPT 原生编辑仍可能继续。", { exact: true })).toBeVisible();
    await expect(button("编辑讲解词")).toBeDisabled(); await expect(text).toBeDisabled(); await expect(resume).toBeEnabled();
    assert.equal(teaching.events.filter(event => event.type === "resume").length, 0, "Checking a pause must not resume it");
    await page.screenshot({ path: join(output, "07-existing-teaching-pause.png") });
    teaching.dropNextResume(); await resume.click();
    await expect(recovery.getByText("尚未确认恢复结果；已保留同一暂停记录，请手动重试以核对。", { exact: true })).toBeVisible();
    await expect(resume).toBeEnabled(); await expect(button("编辑讲解词")).toBeDisabled();
    await page.screenshot({ path: join(output, "08-resume-result-uncertain.png") });
    await resume.click(); await expect(recovery.getByText("讲解词编辑未暂停。", { exact: true })).toBeVisible();
    const resumes = teaching.events.filter(event => event.type === "resume"); assert.equal(resumes.length, 2);
    assert.equal(resumes[0].pauseId, held.pauseId); assert.equal(resumes[1].pauseId, held.pauseId);
    await check.click(); await expect(recovery.getByText("讲解词编辑未暂停。", { exact: true })).toBeVisible();
    assert.equal(teaching.events.filter(event => event.type === "pause-read").at(-1).pauseId, null);
    await button("编辑讲解词").click(); await expect(text).toBeEnabled(); await expect(text).toHaveValue("Second page narration");
    await button("释放编辑权").click(); await expect(text).toBeDisabled();
    assert.equal(teaching.commits, 2, "Pause recovery must not create a teaching write");
    assert.equal((await invoke("coursewareOnlineState")).status, "ready", "Teaching pause does not stop the native editor");
    evidence.pauseRecovery = { pauseId: held.pauseId, teachingRevision: held.teaching.project.teachingRevision,
      samePauseRetried: true, deleteAttempts: 2, finalCurrentPause: null, nativePauseClaimed: false };
    await page.screenshot({ path: join(output, "09-teaching-pause-recovered.png") });
  });
  evidence.events = teaching.events; evidence.finalProject = structuredClone(teaching.project);
  return evidence;
}
