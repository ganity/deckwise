/** Actual Electron/WiseOffice/Host plain and import effects; only HTTP auth/audio are loopback fixtures. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { coursewareLaunch } from "./e2e/boot.mjs";
import { testAdoptedPlayback } from "./e2e/tts-playback.mjs";

for (const key of ["DECKWISE_E2E_OUTPUT", "DECKWISE_EDITOR_URL",
  ...(process.env.DECKWISE_E2E_PACKAGE_ROOT ? [] : ["PI_DESKTOP_HOST_BIN", "DECKWISE_PPTX_WORKER"])])
  assert(process.env[key], `Missing ${key}`);
assert(["127.0.0.1", "localhost"].includes(new URL(process.env.DECKWISE_EDITOR_URL).hostname));
const out = resolve(process.env.DECKWISE_E2E_OUTPUT);
await mkdir(dirname(out), { recursive: true }); await mkdir(out);
const directory = await mkdtemp(join(tmpdir(), "deckwise-ordinary-effects-"));
const workspace = join(directory, "workspace"); await mkdir(workspace);
const source = resolve(process.env.DECKWISE_E2E_EFFECT_SOURCE ?? "packages/courseware-runtime/tests/fixtures/fixed-courseware/lesson-r8.pptx");
const audio = await readFile(resolve("packages/courseware-runtime/tests/fixtures/fixed-courseware/page-1.wav"));
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const originalHash = hash(await readFile(source));
const reassociate = process.env.DECKWISE_E2E_REASSOCIATE === "1";
const officeUndo = process.env.DECKWISE_E2E_OFFICE_UNDO === "1";
const sourceChanges = process.env.DECKWISE_E2E_SOURCE_CHANGE === "1";
assert(!officeUndo || reassociate, "Office undo requires saved-source reassociation");
assert(!sourceChanges || reassociate, "Source-change recovery requires saved-source reassociation");
assert(!sourceChanges || !officeUndo, "Restart recovery and native Undo require independent sessions; Office undo history does not survive process exit");
const reassociationTaskType = process.env.DECKWISE_E2E_REASSOCIATE_TASK_TYPE ?? "plain";
assert(["plain", "import"].includes(reassociationTaskType), "Reassociation accepts only plain or import tasks");
const launch = coursewareLaunch();
const { _electron, expect } = createRequire(new URL("../packages/courseware-runtime/package.json", import.meta.url))("@playwright/test");
const token = `header.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.signature`;
const report = { status: "RUNNING", checks: [], directory, paidCalls: false, modelCalls: false,
  packaged: launch.packaged, reassociate, officeUndo, sourceChanges, identityFixture: true, audioFixture: "existing local page-1.wav, not generated speech", sourcePath: source, sourceSha256: originalHash };
const logs = [], requests = [], tasks = new Map();
let app, page, sdk, sessionId, file, taskType, expectedSpeech, submitted = 0;
const requestHash = request => hash("courseware-media-v1" + [request.kind, request.model, request.input, request.voice ?? null]
  .map(value => `:${value === null ? -1 : value.length}:${value ?? ""}`).join(""));
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://127.0.0.1");
    requests.push({ method: req.method, path: url.pathname });
    const send = data => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ code: 200, data })); };
    if (url.pathname === "/auth/desktop/wx/qrcode") return send({ ticket: "ordinary-effects", entryUrl: "https://fixture.test/qr" });
    if (["/auth/desktop/refresh", "/auth/refresh", "/auth/wx/poll/ordinary-effects"].includes(url.pathname))
      return send({ status: "SUCCESS", accessToken: token, refreshToken: "ordinary-effects-refresh" });
    if (url.pathname === "/auth/me") return send({ edition: "EDUCATION", pcAllowed: true, role: "ADMIN", tenantId: 8, userId: 7 });
    if (url.pathname === "/auth/logout") return send({});
    assert.equal(req.headers.authorization, `Bearer ${token}`);
    if (url.pathname === "/courseware/team/projects" && req.method === "GET") return send([]);
    if (url.pathname === "/courseware/media/models") return send([{ model: "fixture-speech", voices: ["classroom"], providerDefaultVoice: false }]);
    if (url.pathname === "/courseware/media/models/fixture-speech/quote") {
      const expiry = Math.floor(Date.now() / 1000) + 300;
      return send({ version: "courseware-media-quote-v1", kind: "tts", model: "fixture-speech", priceVersion: "fixture-v1",
        maxPoints: 1, maxChars: 2500, expiresAt: new Date(expiry * 1000).toISOString(), quoteToken: `${expiry}.${"a".repeat(43)}` });
    }
    if (url.pathname === "/courseware/media/tasks/confirmed" && req.method === "POST") {
      let raw = ""; for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw), request = body.request, key = req.headers["idempotency-key"];
      assert.equal(request.kind, "tts"); assert.equal(request.model, "fixture-speech"); assert.equal(request.voice, "classroom");
      assert.equal(request.input, expectedSpeech);
      assert.equal(body.confirmation.maxPoints, 1); assert(!tasks.has(key)); assert(++submitted <= 6);
      const taskId = `ordinary-speech-${submitted}`;
      const task = { version: "courseware-media-v1", kind: "tts", taskId, idempotencyKey: key, requestHash: requestHash(request),
        model: request.model, state: "ready", feeState: "settled", reservedPoints: 1, actualPoints: 1, errorCode: null,
        receiptId: `courseware-media:${taskId}`, assetRef: { assetId: `asset-${taskId}`, sha256: hash(audio), mime: "audio/wav",
          byteLength: audio.length, durationMs: 5955, downloadPath: `/courseware/media/tasks/${taskId}/asset` } };
      tasks.set(key, task); return send(task);
    }
    if (url.pathname === "/courseware/media/tasks/by-idempotency") { const task = tasks.get(url.searchParams.get("key")); assert(task); return send(task); }
    const match = /^\/courseware\/media\/tasks\/(ordinary-speech-[1-6])(\/asset)?$/u.exec(url.pathname);
    if (match) {
      const task = [...tasks.values()].find(entry => entry.taskId === match[1]); assert(task);
      if (match[2]) { res.setHeader("content-type", "audio/wav"); return res.end(audio); } return send(task);
    }
    throw new Error(`Unexpected fixture request ${req.method} ${url.pathname}`);
  } catch (error) { logs.push(`FIXTUREERROR ${error.stack}`); res.statusCode = 500; res.end("Fixture error"); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const invoke = (name, ...args) => page.evaluate(async ({ name, args }) => {
  const result = await window.piDesktop.invoke(window.piDesktop.channels.invoke[name], ...args);
  if (!result.ok) throw new Error(JSON.stringify(result.error)); return result.data;
}, { name, args });
const teaching = () => page.locator(".courseware-teaching");
const button = name => teaching().getByRole("button", { name, exact: true });
const load = () => button("读取当前页讲解");
async function ready() { await expect(load()).toBeEnabled({ timeout: 120_000 }); assert.deepEqual(await teaching().getByRole("alert").allTextContents(), []); }
async function readTeaching() { const view = await invoke("pptEditorTeachingOpen", { sessionId }); await load().click(); await ready(); return view; }
async function save() { await expect(button("保存讲解")).toBeEnabled(); await button("保存讲解").click(); await expect(button("保存讲解")).toBeDisabled(); await ready(); }
async function confirm() { if (await button("确认本页教学内容").isEnabled()) await button("确认本页教学内容").click(); await ready(); }
async function stop() {
  if (!app) return;
  const child = app.process();
  if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise(resolve => child.once("exit", resolve)); await app.evaluate(({ app }) => app.exit(0)); await exited;
  }
  app = null;
}
async function start(reopen = false, recoveringDraft = false) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/api.?key|secret|token|password|proxy/i.test(key)));
  app = await _electron.launch({ executablePath: launch.executablePath, cwd: launch.cwd,
    args: ["--no-sandbox", `--user-data-dir=${join(directory, "profile")}`, ...launch.args],
    env: { ...env, ELECTRON_RUN_AS_NODE: "", ELECTRON_RENDERER_URL: "", PI_DESKTOP_DATA_DIR: join(directory, "data"),
      DECKWISE_PLATFORM_BASE_URL: `http://127.0.0.1:${server.address().port}`, PI_DESKTOP_START_MAXIMIZED: "0" }, timeout: 60_000 });
  for (const stream of [app.process().stdout, app.process().stderr]) stream.on("data", bytes => logs.push(String(bytes)));
  page = await app.firstWindow({ timeout: 60_000 }); page.on("pageerror", error => logs.push(`PAGEERROR ${error.stack}`));
  report.runtime = await app.evaluate(({ app }) => ({ packaged: app.isPackaged, appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath, executablePath: process.execPath }));
  assert.equal(report.runtime.packaged, launch.packaged);
  if (launch.packaged) {
    assert.equal(report.runtime.appPath, join(launch.cwd, "resources/app.asar"));
    assert.equal(report.runtime.executablePath, launch.executablePath);
    assert.equal(report.runtime.resourcesPath, join(launch.cwd, "resources"));
  }
  await page.waitForFunction(() => !!window.piDesktop);
  await app.evaluate(({ session, BrowserWindow }) => {
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
      const url = new URL(details.url); callback({ cancel: /^https?:$/.test(url.protocol) && !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) });
    }); BrowserWindow.getAllWindows()[0].setBounds({ x: 0, y: 0, width: 1500, height: 1050 });
  });
  await page.waitForFunction(() => !!window.__PI_DESKTOP__ && !document.querySelector(".auth-shell"), null, { timeout: 60_000 });
  assert.equal((await invoke("authRestore")).status, "authenticated");
  await invoke("projectSet", workspace);
  if (!reopen) sessionId = (await invoke("sessionCreate", { title: `${taskType} effects verification`, projectPath: workspace })).session.id;
  if (!reopen && taskType === "import") {
    await page.reload(); await page.waitForFunction(() => !!window.__PI_DESKTOP__);
  }
  await page.evaluate(async id => { window.__PI_CAPTURE__ = true; await window.__PI_DESKTOP__.selectSession(id); }, sessionId);
  if (!reopen && taskType === "import") {
    await page.evaluate(() => window.__PI_DESKTOP__.openNewWorkPanelTab());
    await page.locator('[data-work-panel-launcher-item="ppt-master"]').click();
    await page.getByRole("button", { name: "已有 PPT 导入", exact: true }).click();
    await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, file);
    await page.getByRole("button", { name: "选择 PPTX 并导入", exact: true }).click();
    await expect.poll(async () => (await invoke("coursewareTaskGet", { sessionId })).task?.importPath, { timeout: 30_000 }).toMatch(/\.deckwise-ppt\/imports\//u);
    file = (await invoke("coursewareTaskGet", { sessionId })).task.importPath;
  } else {
    if (!reopen) await invoke("coursewareTaskSet", { sessionId, taskType: "plain", educationContext: {} });
    await page.evaluate(async path => window.__PI_DESKTOP__.openWorkPanelArtifact("file", path), file);
  }
  sdk = undefined;
  await expect.poll(async () => {
    const editor = app.context().pages().find(target => target.url().startsWith("deckwise-editor:")); if (!editor) return false;
    for (const frame of editor.frames()) if (await frame.evaluate(() => !!window.Asc?.editor?.isDocumentLoadComplete).catch(() => false)) { sdk = frame; return true; }
    return false;
  }, { timeout: 120_000 }).toBe(true);
  await sdk.evaluate(() => window.Asc.editor.goToPage(0));
  await expect(load()).toBeEnabled({ timeout: 120_000 }); await load().click();
  if (recoveringDraft) await expect(button("保存讲解")).toBeEnabled({ timeout: 120_000 });
  else await ready();
}
async function adoptFixtureAudio() {
  let view = await readTeaching();
  if (!view.project.pages.find(entry => entry.pageId === view.pageId).actions.some(action => action.type === "speech")) {
    await button("添加讲解段").click();
    await teaching().locator("textarea").last().fill("Find the current text and shape."); await save();
    view = await readTeaching();
  }
  expectedSpeech = view.project.pages.find(entry => entry.pageId === view.pageId).actions.find(action => action.type === "speech").text;
  const tts = teaching().locator(".courseware-tts-tasks");
  await tts.getByRole("button", { name: "读取可用模型与音色", exact: true }).click();
  const select = tts.locator("select");
  await select.nth(0).selectOption(await select.nth(0).locator("option").nth(1).getAttribute("value"));
  await select.nth(1).selectOption("fixture-speech"); await select.nth(2).selectOption("classroom");
  await tts.getByRole("button", { name: "查看报价（不扣费）", exact: true }).click();
  const submit = tts.getByRole("button", { name: "确认费用并生成配音", exact: true }); await expect(submit).toBeDisabled();
  await tts.getByRole("checkbox", { name: /确认按此费用上限/u }).check(); await submit.click();
  const task = tts.locator("article").filter({ hasText: "fixture-speech" });
  await expect(task).toContainText("音频可获取");
  await task.getByRole("button", { name: "获取并校验音频", exact: true }).click(); await expect(task).toContainText("音频已校验并保存");
  await task.getByRole("checkbox", { name: /将这份音频应用/u }).check(); await task.getByRole("button", { name: "采用配音", exact: true }).click();
  await ready(); await confirm();
}
async function pageNumber(number) {
  await sdk.evaluate(number => window.Asc.editor.goToPage(number - 1), number);
  await expect(teaching().getByText(`第 ${number} 页讲解`, { exact: true })).toBeVisible({ timeout: 30_000 }); await ready();
}
async function prepareAllAudio() {
  const count = (await readTeaching()).project.pages.length;
  for (let number = 1; number <= count; number++) { await pageNumber(number); await adoptFixtureAudio(); }
  await pageNumber(1);
}
async function authorEffects() {
  const baseline = await readTeaching(); assert.equal(baseline.project.taskType, taskType);
  const objects = baseline.teachingObjects.filter(object => object.effectTargetEligible && ["text", "shape"].includes(object.savedKind));
  const text = objects.find(object => object.savedKind === "text"), shape = objects.find(object => object.savedKind === "shape");
  assert(text && shape, "Use actual Host-bound text and shape objects");
  const panel = page.getByRole("region", { name: "高亮与聚光", exact: true });
  for (const cue of [{ kind: "highlight", start: "0", end: "800" }, { kind: "spotlight", start: "800", end: "1900" }]) {
    await panel.getByRole("combobox", { name: "效果", exact: true }).selectOption(cue.kind);
    for (const object of [text, shape]) await panel.getByRole("checkbox", { name: `${object.savedKind === "text" ? "文本" : "形状"} · 对象 ${object.savedIndex}`, exact: true }).check();
    await panel.getByRole("spinbutton", { name: "本段开始时间（毫秒）", exact: true }).fill(cue.start);
    await panel.getByRole("spinbutton", { name: "本段结束时间（毫秒）", exact: true }).fill(cue.end);
    const add = panel.getByRole("button", { name: "添加提示", exact: true }); await expect(add).toBeDisabled();
    await panel.getByRole("checkbox", { name: "我已核对已保存页面中的这些对象，并审核本讲解段的时间区间。", exact: true }).check();
    await add.click(); await save(); await confirm();
  }
  const current = await readTeaching(), beforeSpeech = baseline.project.pages[0].actions.find(action => action.type === "speech" && action.audioAssetId);
  const speech = current.project.pages[0].actions.find(action => action.id === beforeSpeech.id);
  assert.equal(speech.text, beforeSpeech.text); assert.equal(speech.audioAssetId, beforeSpeech.audioAssetId);
  assert.deepEqual(speech.visualCues.map(cue => [cue.atMs, cue.endMs, cue.effect.type]), [[0, 800, "highlight"], [800, 1900, "spotlight"]]);
  assert.deepEqual(speech.visualCues[0].effect.elementIds, [text.objectId, shape.objectId]);
  assert.equal(speech.visualCues[1].effect.elementId, text.objectId); assert.deepEqual(speech.visualCues[1].effect.elementIds, [shape.objectId]);
  assert.deepEqual(current.project.pages.slice(1), baseline.project.pages.slice(1));
  await panel.scrollIntoViewIfNeeded(); await panel.screenshot({ path: join(out, `${taskType}-authored.png`) });
  report[taskType] = { file, sessionId, targets: [text, shape], project: current.project, audioSha256: hash(audio) };
  return current.project;
}
async function reassociateAfterNativeSave(project, undo = false) {
  const inventory = () => sdk.evaluate(() => window.Asc.editor.WordControl.m_oLogicDocument.Slides.map(slide =>
    slide.cSld.spTree.map(shape => ({ text: shape.getDocContent?.()?.GetText({}) ?? "", type: shape.getObjectType(),
      geometry: Object.fromEntries(["offX", "offY", "extX", "extY", "rot", "flipH", "flipV"].map(key => [key, shape.spPr?.xfrm?.[key]])) }))));
  const before = await inventory();
  assert(before[0][2].text.trim(), "Fixture's third object is a real non-target text box");
  if (undo) {
    await sdk.evaluate(() => { window.Asc.editor.Undo(); });
    await expect.poll(inventory).toEqual(report[taskType].nativeBefore);
  } else {
    await sdk.evaluate(() => {
      const api = window.Asc.editor, doc = api.WordControl.m_oLogicDocument, shape = doc.Slides[0].cSld.spTree[2];
      shape.Set_CurrentElement(); shape.getDocContent().SelectAll(); doc.Document_UpdateSelectionState();
    });
    const context = await invoke("pptEditorGetContext");
    assert(context.selectedText.trim());
    const position = { xMm: Math.round((before[0][2].geometry.offX + 1) * 1000) / 1000,
      yMm: Math.round(before[0][2].geometry.offY * 1000) / 1000 };
    report[taskType].nativeSelection = { selectedText: context.selectedText, page: context.page,
      selectionCharacters: context.selectionCharacters, before, requestedPosition: position };
    assert(context.capabilities.some(capability => capability.name === "set_slide_text_box_position"));
    const edited = await invoke("pptEditorExecute", { projectId: context.projectId, documentId: context.documentId,
      sessionId: context.sessionId, editGeneration: context.editGeneration, requestId: "effect-reassociation-edit",
      tool: "set_slide_text_box_position", input: position });
    assert.equal(edited.status, "verified");
    const after = await inventory();
    const expected = structuredClone(before); Object.assign(expected[0][2].geometry, { offX: position.xMm, offY: position.yMm });
    assert.deepEqual(after, expected);
    assert.equal(hash(await readFile(file)), originalHash, "Native edits remain unsaved until explicit Save");
  }
  const previousHash = hash(await readFile(file));
  await page.locator(".ppt-editor-toolbar").getByRole("button", { name: "保存到原文件", exact: true }).click();
  const reviewStart = button("审核已保存的 PPTX 变更"); await expect(reviewStart).toBeEnabled({ timeout: 240_000 });
  const savedSha256 = hash(await readFile(file)); assert.notEqual(savedSha256, previousHash);
  await assert.rejects(invoke("pptEditorTeachingOpen", { sessionId }), /COURSEWARE_CONFLICT.*reconcile/u);
  await reviewStart.click();
  const review = page.locator(".courseware-source-review"), choices = review.locator("select");
  await expect(choices).toHaveCount(project.pages.length + 2, { timeout: 120_000 });
  const adopt = review.getByRole("button", { name: "采用这些关联", exact: true });
  for (let index = 0; index < project.pages.length; index++) {
    await expect(choices.nth(index)).toHaveValue(""); await choices.nth(index).selectOption(String(index));
  }
  const effects = review.getByRole("region", { name: "重新关联高亮与聚光对象", exact: true });
  const objectChoices = effects.locator("select");
  for (const choice of await objectChoices.all()) await expect(choice).toHaveValue("");
  // The fixture is visually reviewed: first text and second shape are unchanged; positions grant no identity.
  await expect(objectChoices.nth(0).locator('option[value="1"]')).toHaveText("新第 1 页使用 · 文本 · 对象 1");
  await expect(objectChoices.nth(1).locator('option[value="2"]')).toHaveText("新第 1 页使用 · 形状 · 对象 2");
  await objectChoices.nth(0).selectOption("1"); await objectChoices.nth(1).selectOption("1");
  await expect(adopt).toBeDisabled(); await expect(effects.getByRole("checkbox")).toBeDisabled();
  await objectChoices.nth(1).selectOption("2");
  await expect(adopt).toBeDisabled();
  await effects.getByRole("checkbox", { name: "我已逐项核对对象关联，并审核保留的讲解段提示时间。", exact: true }).check();
  await expect(adopt).toBeDisabled();
  await review.getByRole("checkbox", { name: "我已核对每一页的关联，并确认采用此版本。", exact: true }).check();
  await review.screenshot({ path: join(out, `${taskType}-${undo ? "undo-" : ""}explicit-reassociation.png`) });
  await adopt.click(); await expect(review).toHaveCount(0, { timeout: 120_000 }); await ready();
  let current = await readTeaching();
  assert.equal(current.project.source.sha256, savedSha256);
  assert.deepEqual(current.project.pages.map(page => page.pageId), project.pages.map(page => page.pageId));
  assert(current.project.pages.every(page => page.reviewState === "review"));
  const previousTargets = report[taskType].targets;
  const targets = previousTargets.map(old => current.teachingObjects.find(object => object.savedIndex === old.savedIndex && object.savedKind === old.savedKind));
  assert(targets.every(object => object?.effectTargetEligible));
  assert(targets.every((object, index) => object.objectId !== previousTargets[index].objectId));
  const expectedActions = structuredClone(project.pages[0].actions);
  const ids = targets.map(object => object.objectId);
  expectedActions.find(action => action.visualCues).visualCues[0].effect.elementIds = ids;
  const spotlight = expectedActions.find(action => action.visualCues).visualCues[1].effect;
  spotlight.elementId = ids[0]; spotlight.elementIds = [ids[1]];
  assert.deepEqual(current.project.pages[0].actions, expectedActions);
  assert.deepEqual(current.project.pages.slice(1).map(page => page.actions), project.pages.slice(1).map(page => page.actions));
  if (sourceChanges) {
    assert.equal(current.sourceChange.phase, "teaching-review");
    assert.equal(current.sourceChange.baselineSource, project.source.sha256);
    assert.equal(current.sourceChange.targetSource, savedSha256);
    assert.deepEqual(current.sourceChange.pendingPageIds, current.project.pages.map(page => page.pageId));
    await expect(teaching()).toContainText("页面已保存；以下页面的讲解和效果仍需复核确认");
    if (!undo) current = await recoverFailedTeaching(current);
  }
  if (undo) {
    const snapshotView = await invoke("pptEditorTeachingOpen", { sessionId });
    await assert.rejects(invoke("pptEditorSnapshotCapture", { viewId: snapshotView.viewId,
      expectedTeachingRevision: snapshotView.project.teachingRevision }), /COURSEWARE_REVIEW_REQUIRED/u);
    assert.notEqual(current.project.teachingRevision, project.teachingRevision);
    report[taskType].undoBeforeConfirmation = current.project;
    await load().click(); await ready();
  }
  for (let number = 1; number <= project.pages.length; number++) { await pageNumber(number); await confirm(); }
  await pageNumber(1); current = await readTeaching();
  if (sourceChanges) {
    assert.equal(current.sourceChange.phase, "complete");
    assert.deepEqual(current.sourceChange.pendingPageIds, []);
    await expect(teaching()).toContainText("页面修改与教学内容已完成复核。");
    report[taskType][undo ? "undoSourceChange" : "sourceChange"] = current.sourceChange;
  }
  if (!undo) {
    report[taskType].beforeReassociation = project;
    Object.assign(report[taskType], { nativeBefore: before, nativeAfter: await inventory() });
  } else report[taskType].undoNativeAfter = await inventory();
  Object.assign(report[taskType], { previousTargets, targets, project: current.project, savedSha256 });
  await copyFile(file, join(out, `${taskType}-${undo ? "undo-" : ""}reassociated.pptx`));
  return current.project;
}
async function recoverFailedTeaching(view) {
  const sql = async statement => promisify(execFile)("python3", ["-c",
    "import sqlite3,sys; db=sqlite3.connect(sys.argv[1]); db.executescript(sys.argv[2]); db.commit(); db.close()",
    join(directory, "data/pi.sqlite"), statement]);
  const sourceHash = hash(await readFile(file));
  await step(`${taskType}: saved native page survives failed teaching write, full restart and explicit retry`, async () => {
    await sql("CREATE TRIGGER w03_teaching_failure BEFORE UPDATE ON kv WHEN NEW.ns='coursewareProjects.v1' BEGIN SELECT RAISE(ABORT,'fixture teaching failure'); END;");
    await teaching().getByRole("spinbutton", { name: "段后停顿（毫秒）", exact: true }).fill("1800");
    await expect(button("保存讲解")).toBeEnabled(); await button("保存讲解").click();
    await expect(teaching().getByRole("alert")).toContainText("fixture teaching failure");
    const failed = await invoke("pptEditorTeachingOpen", { sessionId });
    assert.deepEqual(failed.project, view.project);
    assert.deepEqual(failed.sourceChange, view.sourceChange);
    await assert.rejects(invoke("pptEditorSnapshotCapture", { viewId: failed.viewId,
      expectedTeachingRevision: failed.project.teachingRevision }), /COURSEWARE_REVIEW_REQUIRED/u);
    assert.equal(hash(await readFile(file)), sourceHash);
    await stop(); await sql("DROP TRIGGER w03_teaching_failure;"); await start(true, true);
    await expect(teaching().getByRole("spinbutton", { name: "段后停顿（毫秒）", exact: true })).toHaveValue("1800");
    await expect(teaching()).toContainText("已恢复本页草稿");
    await expect(teaching()).toContainText(view.sourceChange.changeGroupId.slice(0, 8));
    await save();
    const retried = await readTeaching();
    const expected = structuredClone(view.project.pages[0].actions);
    expected.find(action => action.type === "speech").pauseAfterMs = 1800;
    assert.deepEqual(retried.project.pages[0].actions, expected);
    assert.deepEqual(retried.project.pages.slice(1), view.project.pages.slice(1));
    assert.equal(retried.sourceChange.changeGroupId, view.sourceChange.changeGroupId);
    assert.equal(retried.sourceChange.phase, "teaching-review");
    assert.equal(hash(await readFile(file)), sourceHash);
    report[taskType].partialTeachingFailure = { before: view, failed, retried, sourceSha256: sourceHash };
    view = retried;
  });
  return view;
}
async function verifyPlayerEffects(player, project) {
  await expect(player.locator('[data-player-mode]')).toBeVisible();
  const pkg = await player.evaluate(async () => JSON.parse(new TextDecoder().decode((await window.deckwiseFixedPlayer.readPackage()).bytes)));
  const actionIds = project.pages.flatMap(entry => entry.actions.map(action => action.id));
  const repeatIds = new Set(actionIds).size !== actionIds.length;
  const expectedActions = project.pages.map(entry => entry.actions.map(action => ({ ...action,
    id: repeatIds ? `fixed-${hash(JSON.stringify([entry.pageId, action.id]))}` : action.id })));
  assert.deepEqual(pkg.pages.map(entry => entry.actions), expectedActions);
  const mapping = pkg.pages[0].objects;
  const ids = report[taskType].targets.map(target => mapping.find(entry => entry.objectId === target.objectId)?.importElementId);
  assert(ids.every(Boolean));
  assert.deepEqual(ids.map(id => pkg.pages[0].slide.elements.find(element => element.id === id)?.type), ["text", "shape"]);
  assert.equal(typeof await player.evaluate(() => window.piDesktop), "undefined");
  const highlights = player.locator('[data-fixed-effect="highlight"]'), spotlight = player.locator('[data-fixed-effect="spotlight"]');
  const currentAudio = () => player.evaluate(() => {
    const audio = window.__ordinaryAudios.at(-1); return { time: audio.currentTime * 1000, paused: audio.paused };
  });
  const record = async name => {
    const sample = { name, ...(await currentAudio()), highlights: await highlights.evaluateAll(nodes => nodes.map(node => node.dataset.targetIds)),
      spotlights: await spotlight.evaluateAll(nodes => nodes.map(node => node.dataset.targetIds)), pageId: await player.locator('[data-player-mode]').getAttribute("data-page-id") };
    (report[taskType].effectSamples ??= []).push(sample); return sample;
  };
  await expect(highlights).toHaveCount(2, { timeout: 10_000 });
  await player.getByRole("button", { name: "暂停", exact: true }).click();
  await expect(player.getByRole("button", { name: "继续", exact: true })).toBeVisible();
  const first = await record("initial-highlight-paused");
  assert(first.paused && first.time < 800); assert.deepEqual(first.highlights.sort(), [...ids].sort()); assert.equal(first.pageId, project.pages[0].pageId);
  await player.screenshot({ path: join(out, `${taskType}-player-highlight.png`) });
  await player.waitForTimeout(180); const paused = await currentAudio(); assert.equal(paused.time, first.time);
  const slider = player.getByRole("slider", { name: "调整旁白进度", exact: true });
  await slider.press("Home");
  for (let index = 0; index < 100; index++) await slider.press("ArrowRight");
  await expect(spotlight).toHaveCount(1); await expect(highlights).toHaveCount(0);
  const sought = await record("paused-keyboard-seek-1000ms"); assert.equal(sought.time, 1000); assert.equal(sought.spotlights[0], ids.join(","));
  await player.screenshot({ path: join(out, `${taskType}-player-spotlight.png`) });
  await slider.press("Home"); for (let index = 0; index < 4; index++) await slider.press("PageUp");
  await expect(spotlight).toHaveCount(0); await expect(highlights).toHaveCount(0);
  assert((await record("paused-seek-after-both-intervals")).time >= 1900);
  await player.getByRole("button", { name: "重播本页", exact: true }).click();
  await expect(highlights).toHaveCount(2); const replayed = await record("replay-first-page");
  assert(replayed.time < 800 && !replayed.paused); assert.equal(replayed.pageId, project.pages[0].pageId);
  await expect(spotlight).toHaveCount(1, { timeout: 10_000 });
  const natural = await record("native-clock-spotlight"); assert(natural.time >= 800 && natural.time < 1900); assert.equal(natural.spotlights[0], ids.join(","));
  await expect(spotlight).toHaveCount(0, { timeout: 10_000 });
  assert((await record("native-clock-cleared")).time >= 1900);
  await expect(player.locator("header")).toContainText("2 / 3", { timeout: 15_000 });
  await expect(highlights).toHaveCount(0); await expect(spotlight).toHaveCount(0);
  assert.equal(await player.locator('[data-player-mode]').getAttribute("data-page-id"), project.pages[1].pageId);
  report[taskType].frozenPackage = pkg; report[taskType].renderTargetIds = ids;
}
async function playback(project) {
  await app.context().addInitScript(() => {
    window.__ordinaryAudios = []; window.__ordinaryAudioErrors = [];
    const original = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function (...args) {
      if (!window.__ordinaryAudios.includes(this)) {
        window.__ordinaryAudios.push(this);
        this.addEventListener("error", () => window.__ordinaryAudioErrors.push({ code: this.error?.code,
          message: this.error?.message, src: this.getAttribute("src"), currentSrc: this.currentSrc,
          timeMs: this.currentTime * 1000, paused: this.paused }));
      }
      return original.apply(this, args);
    };
  });
  const taskOut = join(out, taskType); await mkdir(taskOut);
  // Keep the existing helper's uninterrupted native-audio assertion independent of replay.
  await testAdoptedPlayback({ app, page, expect, project, out: taskOut, step, report: report[taskType] });
  const view = await readTeaching(); assert.deepEqual(view.project, project);
  const preview = teaching().locator(".courseware-playback");
  await preview.getByRole("button", { name: "构建预览", exact: true }).click();
  const approve = preview.getByRole("button", { name: "确认并继续构建", exact: true });
  const play = preview.getByRole("button", { name: "播放预览", exact: true });
  await expect.poll(async () => {
    assert.deepEqual(await preview.getByRole("alert").allTextContents(), []);
    return await approve.isVisible() || await play.isVisible();
  }, { timeout: 120_000 }).toBe(true);
  if (await approve.isVisible()) { for (const checkbox of await preview.getByRole("checkbox").all()) await checkbox.check(); await approve.click(); }
  await expect(play).toBeEnabled({ timeout: 120_000 });
  const opened = app.waitForEvent("window"); await play.click(); const player = await opened;
  try {
    const observed = verifyPlayerEffects(player, project);
    await player.getByRole("button", { name: "播放", exact: true }).click();
    await observed;
    await expect(player.getByRole("status")).toContainText("播放完成", { timeout: 60_000 });
    assert.equal(await player.locator('[data-player-mode]').getAttribute("data-player-mode"), "idle");
    report[taskType].manualAudioErrors = await player.evaluate(() => window.__ordinaryAudioErrors);
    for (const error of report[taskType].manualAudioErrors) {
      assert.equal(error.src, "", "Only detached audio explicitly cleared by replay may report an error");
      assert.equal(error.code, 4); assert.match(error.message, /Empty src attribute/u);
    }
    assert.equal(await player.locator("#error").textContent(), "");
    await player.screenshot({ path: join(out, `${taskType}-manual-player-complete.png`) });
  } finally { await player.close(); }
  await preview.getByRole("button", { name: /Close preview|关闭预览/u }).click();
  assert.equal(hash(await readFile(join(directory, "data/courseware-assets", `${hash(audio)}.bin`))), hash(audio));
  assert.equal(hash(await readFile(file)), report[taskType].savedSha256 ?? originalHash);
}
async function step(name, action) { console.log("START", name); await action(); report.checks.push(name); console.log("PASS", name); }
try {
  for (const kind of reassociate ? [reassociationTaskType] : ["plain", "import"]) {
    taskType = kind; file = join(workspace, `${kind}.pptx`); await copyFile(source, file);
    await step(`${kind}: real Office opens saved source and adopts local WAV on all pages through visible controls`, async () => { await start(); await prepareAllAudio(); });
    let project;
    await step(`${kind}: select current text/shape, author highlight and spotlight, save and confirm`, async () => { project = await authorEffects(); assert.equal(hash(await readFile(file)), originalHash); });
    const submissionsBefore = submitted;
    if (reassociate) await step(`${kind}: native edit and save require explicit page and every effect target association, preserve audio and cues`, async () => {
      project = await reassociateAfterNativeSave(project); assert.equal(submitted, submissionsBefore);
    });
    if (officeUndo) {
      await step(`${kind}: later teaching edit preserves existing audio and advances its own revision`, async () => {
        await pageNumber(2);
        const previous = await readTeaching();
        await teaching().getByRole("spinbutton", { name: "段后停顿（毫秒）", exact: true }).fill("1700");
        await save(); await confirm();
        const later = await readTeaching();
        assert.notEqual(later.project.teachingRevision, previous.project.teachingRevision);
        const expected = structuredClone(project.pages[1].actions);
        expected.find(action => action.type === "speech").pauseAfterMs = 1700;
        assert.deepEqual(later.project.pages[1].actions, expected);
        project = later.project; report[kind].laterTeaching = project;
        await pageNumber(1);
      });
      await step(`${kind}: actual Office undo and explicit saved-source review retain later teaching and block unreviewed builds`, async () => {
        project = await reassociateAfterNativeSave(project, true);
        assert.deepEqual(report[kind].undoNativeAfter, report[kind].nativeBefore);
        assert.deepEqual(project.pages[1].actions, report[kind].laterTeaching.pages[1].actions);
        assert.equal(submitted, submissionsBefore);
      });
    }
    await step(`${kind}: complete Desktop process restart restores exact effects, audio and peers`, async () => {
      await stop(); await start(true); const reopened = await readTeaching(); assert.deepEqual(reopened.project, project);
      assert.equal(hash(await readFile(file)), report[kind].savedSha256 ?? originalHash); assert.equal(submitted, submissionsBefore);
      await expect(page.getByRole("region", { name: "高亮与聚光", exact: true }).getByRole("button", { name: "编辑提示", exact: true })).toHaveCount(2);
      await page.screenshot({ path: join(out, `${kind}-restarted.png`) }); report[kind].completeDesktopRestart = true;
    });
    await step(`${kind}: real fixed player targets, pause, seek, replay and native audio completion`, async () => { await playback(project); assert.equal(submitted, submissionsBefore); });
    await stop();
  }
  assert.equal(submitted, reassociate ? 3 : 6); assert(!logs.some(line => /FIXTUREERROR|PAGEERROR/u.test(line)), logs.filter(line => /FIXTUREERROR|PAGEERROR/u.test(line)).join("\n"));
  report.status = sourceChanges ? "PASS_SAVED_SOURCE_CHANGE_TEACHING_FAILURE_RESTART_PLAYER" : officeUndo ? "PASS_NATIVE_OFFICE_UNDO_REVIEW_RESTART_PLAYER" : reassociate ? `PASS_${reassociationTaskType.toUpperCase()}_SOURCE_EFFECT_REASSOCIATION_REAL_DESKTOP_PLAYER` : "PASS_PLAIN_IMPORT_EFFECTS_REAL_DESKTOP_PLAYER";
} catch (error) {
  report.status = "FAIL"; report.error = error.stack; process.exitCode = 1;
  await page?.screenshot({ path: join(out, "failure.png") }).catch(() => {});
} finally {
  await stop(); await new Promise(resolve => server.close(resolve));
  await writeFile(join(out, "report.json"), JSON.stringify({ ...report, fixtureSubmissions: submitted, requests }, null, 2));
  await writeFile(join(out, "desktop.log"), logs.join(""));
}
