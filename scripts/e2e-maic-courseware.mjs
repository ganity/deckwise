#!/usr/bin/env node
/** Actual Electron editor -> Main -> real Host persistence -> preview/export. Only account identity is a fixture. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { coursewareLaunch } from "./e2e/boot.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const out = process.env.DECKWISE_E2E_OUTPUT ? resolve(process.env.DECKWISE_E2E_OUTPUT) : await mkdtemp(join(tmpdir(), "maic-acceptance-"));
await mkdir(out, { recursive: true });
const directory = await mkdtemp(join(tmpdir(), "maic-electron-"));
const workspace = join(directory, "workspace"); await mkdir(workspace);
const require = createRequire(new URL("../packages/courseware-runtime/package.json", import.meta.url));
const { _electron, expect } = require("@playwright/test");
const JSZip = require("jszip");
const launch = coursewareLaunch();
const revision = path => execFileSync("git", ["rev-parse", "HEAD"], { cwd: path, encoding: "utf8" }).trim();
const report = { status: "RUNNING", checks: [], sourceRevision: revision(root), directory, realElectron: true, realMain: true, realHost: true,
  identityFixture: true, paidCalls: false, artifacts: [], excluded: ["paid provider generation", "production signing/publication", "native PPT edit/reorder (separate integration gate)"] };
const logs = [], pageErrors = [];
let app, page, playerPage, sessionId, savedExport;
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=", "base64");
function quizFixture(id) {
  return { id, createdAt: new Date().toISOString(), stage: { id, name: "Greetings", createdAt: 1, updatedAt: 1,
    canvas: { preset: "WIDE_16_9", viewportSize: 1000, viewportRatio: 0.5625 } }, scenes: [{ id: `${id}-quiz`, stageId: id, type: "quiz", title: "打招呼", order: 0,
      content: { type: "quiz", interactionMode: "classroom_instant_feedback", playbackConfig: { introSpeechMode: "page_enter_only", attemptPolicy: "until_correct", successSpeechText: "回答正确", failureSpeechText: "再试一次", cueUserOnEnter: true, cueUserOnRetry: false },
        questions: [{ id: `${id}-q`, type: "single", question: "可以用哪个词和朋友打招呼？", options: [{ value: "A", label: "Hello" }, { value: "B", label: "Bye" }], answer: ["A"], analysis: "Hello 用于见面问候。", hasAnswer: true, points: 1 }] }, actions: [] },
    { id: `${id}-assessment`, stageId: id, type: "quiz", title: "课堂测验", order: 1, content: { type: "quiz", interactionMode: "assessment_review", questions: [
      { id: `${id}-assessment-q`, type: "single", question: "选择正确答案", options: [{ value: "A", label: "选项一" }, { value: "B", label: "选项二" }], answer: ["A"], hasAnswer: true, points: 1 },
      { id: `${id}-assessment-q2`, type: "single", question: "判断问候语", options: [{ value: "A", label: "选项一" }, { value: "B", label: "选项二" }], answer: ["A"], hasAnswer: true, points: 1 },
      { id: `${id}-assessment-q3`, type: "single", question: "介绍自己", options: [{ value: "A", label: "选项一" }, { value: "B", label: "选项二" }], answer: ["A"], hasAnswer: true, points: 1 },
    ] }, actions: [] }], mediaManifest: [], audioManifest: [] };
}
const invoke = (name, ...args) => page.evaluate(async ({ name, args }) => {
  const response = await window.piDesktop.invoke(window.piDesktop.channels.invoke[name], ...args);
  if (!response.ok) throw new Error(JSON.stringify(response.error));
  return response.data;
}, { name, args });
const editor = () => page.getByRole("region", { name: "课程内容编辑器" });
const findCheckpoint = scene => scene.actions.find(action => action.type === "interaction_checkpoint");
const read = () => invoke("coursewareClassroomOpen", { sessionId });
const step = async (name, run) => { console.log("START", name); await run(); report.checks.push(name); console.log("PASS", name); };
async function start() {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/api.?key|secret|token|password|proxy/i.test(key)));
  app = await _electron.launch({ executablePath: launch.executablePath, cwd: launch.cwd,
    args: ["--no-sandbox", `--user-data-dir=${join(directory, "profile")}`, ...launch.args],
    env: { ...env, ELECTRON_RUN_AS_NODE: "", ELECTRON_RENDERER_URL: "", PI_DESKTOP_DATA_DIR: join(directory, "data"),
      DECKWISE_PLATFORM_BASE_URL: "http://127.0.0.1:9/fixture", PI_DESKTOP_START_MAXIMIZED: "0" }, timeout: 60_000 });
  for (const stream of [app.process().stdout, app.process().stderr]) stream.on("data", bytes => logs.push(String(bytes)));
  page = await app.firstWindow({ timeout: 60_000 });
  page.on("pageerror", error => pageErrors.push(error.stack));
  await page.waitForURL(/\/renderer\/index\.html(?:[?#]|$)/, { waitUntil: "load" });
  await page.waitForFunction(() => !!window.piDesktop);
  await app.evaluate(({ session }) => session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const url = new URL(details.url);
    callback({ cancel: /^https?:$/.test(url.protocol) && !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) });
  }));
  const channels = await page.evaluate(() => window.piDesktop.channels);
  await app.evaluate(({ ipcMain, BrowserWindow }, channels) => {
    const state = { status: "authenticated", profile: { userId: 1, userName: "MAIC acceptance", edition: "EDUCATION", role: "TEACHER", pcAllowed: true } };
    for (const name of ["authRestore", "authStartQr"]) { ipcMain.removeHandler(channels.invoke[name]); ipcMain.handle(channels.invoke[name], () => ({ ok: true, data: state })); }
    const window = BrowserWindow.getAllWindows()[0]; window.setBounds({ x: 0, y: 0, width: 1600, height: 1050 });
    const send = window.webContents.send.bind(window.webContents);
    window.webContents.send = (channel, ...args) => send(channel, ...(channel === channels.event.authChanged ? [state] : args));
    send(channels.event.authChanged, state);
  }, channels);
  await page.reload(); await page.waitForFunction(() => !!window.__PI_DESKTOP__);
  await invoke("projectSet", workspace);
}
async function stop() {
  if (!app) return;
  const child = app.process();
  if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise(resolve => child.once("exit", resolve));
    await app.evaluate(({ app }) => app.exit(0)); await exited;
  }
  app = null;
}
async function openEditor() {
  await page.evaluate(async id => {
    await window.__PI_DESKTOP__.selectSession(id);
    window.__PI_CAPTURE__ = true;
    await window.__PI_DESKTOP__.openNewWorkPanelTab();
    await window.__PI_DESKTOP__.setWorkPanelWidth(1100);
  }, sessionId);
  await page.locator('[data-work-panel-launcher-item="ppt-master"]').click();
  const entry = page.getByRole("button", { name: "Quiz / 互动编辑", exact: true });
  await expect.poll(async () => await editor().isVisible() || await entry.isVisible()).toBe(true);
  if (!await editor().isVisible()) await entry.click();
  await expect(editor()).toBeVisible();
  await expect(editor().getByRole("toolbar").getByRole("status")).toHaveText("已自动保存");
}
async function waitSaved(predicate) {
  await expect.poll(async () => {
    const current = await read(); return predicate(current.classroom);
  }, { timeout: 20_000 }).toBe(true);
  await expect(editor().getByRole("toolbar").getByRole("status")).toHaveText("已自动保存");
}
async function answerQuiz(player, answer) {
  const skip = player.getByRole("button", { name: "跳过失败的配音", exact: true });
  for (let attempt = 0; attempt <= 4; attempt++) {
    await expect.poll(async () => await answer.isEnabled() || await skip.isVisible(), { timeout: 30_000 }).toBe(true);
    if (await answer.isEnabled()) { await answer.click(); return; }
    assert(attempt < 4, "Quiz did not become answerable after bounded unavailable-speech recovery");
    report.offlineFeedback = "Unavailable system speech was explicitly skipped through the player control; no speech events were fabricated.";
    await skip.click();
  }
}
async function setCorrectAnswer(form, value) {
  const button = form.getByRole("button", { name: `正确答案 ${value}`, exact: true });
  if (await button.getAttribute("aria-pressed") !== "true") await button.click();
}
async function exportArchive(label) {
  const view = await read();
  const exported = await invoke("coursewareClassroomExport", { sessionId, projectId: view.projectId, expectedRevision: view.revision, expectedSourceRevision: view.sourceRevision });
  const path = join(out, `${label}.zip`); await writeFile(path, new Uint8Array(exported.bytes));
  const zip = await JSZip.loadAsync(exported.bytes);
  assert(zip.file("meta.json"), "MAIC meta.json missing");
  const meta = JSON.parse(await zip.file("meta.json").async("string"));
  assert.equal(meta.classroom.scenes[0].type, "quiz");
  for (const entry of meta.classroom.mediaManifest ?? []) {
    assert(entry.zipPath && zip.file(entry.zipPath), "Manifest asset missing in archive");
    assert.deepEqual(await zip.file(entry.zipPath).async("nodebuffer"), png);
  }
  assert(!JSON.stringify(meta).includes(directory), "Local absolute path leaked into MAIC output");
  report.artifacts.push(path);
  return { meta, path };
}
try {
  await step("Real Main/Host create an independent all-Quiz course", async () => {
    await start();
    sessionId = (await invoke("sessionCreate", { title: "MAIC Quiz acceptance", projectPath: workspace, mode: "agent" })).session.id;
    await page.evaluate(id => window.__PI_DESKTOP__.selectSession(id), sessionId);
    await invoke("coursewareTaskSet", { sessionId, taskType: "scene" });
    await invoke("coursewareClassroomCreate", { sessionId, classroom: quizFixture("acceptance") });
    await openEditor();
    assert((await read()).classroom.scenes.every(scene => scene.type === "quiz"));
    const selectedStyle = await editor().getByRole("button", { name: "正确答案 A", exact: true }).evaluate(button => {
      const style = getComputedStyle(button); return { color: style.color, background: style.backgroundColor };
    });
    assert.notEqual(selectedStyle.color, selectedStyle.background, "Selected answer letter must be visible");
  });
  await step("Question, stable options, correct answers and image uploads survive autosave", async () => {
    await editor().getByRole("textbox", { name: "问题", exact: true }).fill("当我们和小朋友打招呼的时候，可以用哪个词呢？");
    await waitSaved(c => c.scenes[0].content.questions[0].question.startsWith("当我们"));
    await editor().getByRole("button", { name: "添加选项", exact: true }).click();
    await waitSaved(c => c.scenes[0].content.questions[0].options.length === 3);
    const fields = editor().locator(".maic-option");
    await fields.nth(2).getByRole("textbox", { name: "选项文字", exact: true }).fill("Thanks");
    await waitSaved(c => c.scenes[0].content.questions[0].options[2].label === "Thanks");
    await fields.nth(1).getByRole("button", { name: "上移选项", exact: true }).click();
    await waitSaved(c => c.scenes[0].content.questions[0].options[0].value === "B");
    assert.deepEqual((await read()).classroom.scenes[0].content.questions[0].answer, ["A"]);
    for (const value of ["A", "B"]) {
      const field = editor().getByLabel(`选项 ${value} 图片`, { exact: true });
      await field.setInputFiles({ name: `${value}.png`, mimeType: "image/png", buffer: png });
      await waitSaved(c => !!c.scenes[0].content.questions[0].options.find(o => o.value === value).image);
    }
    await editor().getByLabel("题目图片", { exact: true }).setInputFiles({ name: "question.png", mimeType: "image/png", buffer: png });
    await waitSaved(c => !!c.scenes[0].content.questions[0].image);
    await exportArchive("all-quiz");
  });
  await step("Undo and redo restore Quiz text without losing image associations", async () => {
    const before = (await read()).classroom.scenes[0].content.questions[0].question;
    await editor().getByRole("textbox", { name: "问题", exact: true }).fill("临时问题");
    await waitSaved(c => c.scenes[0].content.questions[0].question === "临时问题");
    await editor().getByRole("button", { name: "撤销", exact: true }).click();
    await waitSaved(c => c.scenes[0].content.questions[0].question === before);
    await editor().getByRole("button", { name: "重做", exact: true }).click();
    await waitSaved(c => c.scenes[0].content.questions[0].question === "临时问题");
    await editor().getByRole("button", { name: "撤销", exact: true }).click();
    await waitSaved(c => c.scenes[0].content.questions[0].question === before);
    assert.equal((await read()).classroom.mediaManifest.length, 3);
  });
  await step("Shared Quiz player shows image options and supports retry then correct completion", async () => {
    const opened = app.waitForEvent("window");
    await editor().getByRole("button", { name: "播放整个课程", exact: true }).click();
    const player = await opened; playerPage = player; player.on("pageerror", error => pageErrors.push(error.stack));
    const quiz = player.locator('[data-scene-type="quiz"]'); await expect(quiz).toBeVisible();
    await expect(quiz.locator("img")).toHaveCount(3);
    await player.locator("header h1").hover();
    await expect(quiz.getByRole("button", { name: /A.*Hello/ })).toHaveCSS("background-color", "rgb(255, 255, 255)");
    report.instantPreviewStyle = await quiz.getByRole("button", { name: /A.*Hello/ }).evaluate(element => ({ background: getComputedStyle(element).backgroundColor, radius: getComputedStyle(element).borderRadius }));
    await player.getByRole("button", { name: "播放", exact: true }).click();
    await answerQuiz(player, quiz.getByRole("button", { name: /B.*Bye/ }));
    await expect(quiz.locator("button.border-red-300")).toHaveCount(1);
    await answerQuiz(player, quiz.getByRole("button", { name: /A.*Hello/ }));
    await expect(quiz.locator("button.border-emerald-300")).toHaveCount(1);
    const image = join(out, "quiz-image-options.png"); await player.screenshot({ path: image }); report.artifacts.push(image);
    await player.close(); playerPage = null;
  });
  await step("Interaction is a distinct editable slide checkpoint in a mixed course", async () => {
    const initial = (await read()).classroom;
    const assessment = initial.scenes.find(scene => scene.id === "acceptance-assessment");
    assert(assessment && initial.scenes.indexOf(assessment) === 1, "Assessment Quiz must follow the instant-feedback Quiz");
    await editor().getByRole("button", { name: `${initial.scenes.indexOf(assessment) + 1}. Quiz · ${assessment.title}`, exact: true }).click();
    await editor().getByRole("button", { name: "添加互动", exact: true }).click();
    const interactionIndex = () => read().then(view => view.classroom.scenes.findIndex(scene => scene.actions?.some(action => action.type === "interaction_checkpoint")));
    await waitSaved(c => c.scenes.some(scene => scene.actions?.some(action => action.type === "interaction_checkpoint")));
    const position = await interactionIndex();
    assert.equal(position, initial.scenes.indexOf(assessment) + 1, "Interaction checkpoint must follow the selected second Quiz");
    await editor().getByRole("textbox", { name: "问题", exact: true }).fill("请完整说出你的英文自我介绍。");
    await waitSaved(c => findCheckpoint(c.scenes[position]).question === "请完整说出你的英文自我介绍。");
    await editor().getByRole("textbox", { name: "参考答案", exact: true }).fill("Hello, my name is Pandy.");
    await waitSaved(c => findCheckpoint(c.scenes[position]).referenceAnswer.summary.includes("Pandy"));
    for (const [index, value] of ["问候语", "姓名"].entries()) {
      await editor().getByRole("button", { name: "添加关键点", exact: true }).click();
      await editor().getByRole("textbox", { name: `关键点 ${index + 1}`, exact: true }).fill(value);
      await waitSaved(c => findCheckpoint(c.scenes[position]).referenceAnswer.keyPoints[index] === value);
    }
    await editor().getByRole("textbox", { name: "约束性提示词", exact: true }).fill("引导学生自己说出姓名，不直接代答。");
    await waitSaved(c => findCheckpoint(c.scenes[position]).constraintPrompt.includes("不直接代答"));
    const image = join(out, "interaction-editor.png"); await editor().screenshot({ path: image }); report.artifacts.push(image);
    savedExport = await exportArchive("mixed");
    const scene = savedExport.meta.classroom.scenes.find(item => item.actions?.some(action => action.type === "interaction_checkpoint"));
    const checkpoint = scene.actions.find(action => action.type === "interaction_checkpoint");
    assert.equal(scene.content.type, "slide"); assert(checkpoint);
    assert(!("response" in checkpoint));
    assert(scene.content.canvas.elements.some(element => element.type === "text" && element.content.includes(checkpoint.question)));
  });
  await step("Assessment multiple, judge and short-answer guidance are authored through the real editor", async () => {
    const assessmentIndex = () => read().then(view => view.classroom.scenes.findIndex(scene => scene.id === "acceptance-assessment"));
    const position = await assessmentIndex();
    const assessment = (await read()).classroom.scenes[position];
    await editor().getByRole("button", { name: `${position + 1}. Quiz · ${assessment.title}`, exact: true }).click();
    assert.equal((await read()).classroom.scenes[position].content.interactionMode, "assessment_review");
    const forms = () => editor().locator("fieldset.maic-question");
    const questionType = index => forms().nth(index).getByRole("combobox").filter({ has: page.locator('option[value="judge"]') });
    report.assessmentEditor = await editor().evaluate(element => ({
      selected: element.querySelector('[aria-current="page"]')?.textContent,
      questionForms: element.querySelectorAll("fieldset.maic-question").length,
      selectLabels: [...element.querySelectorAll("label")].filter(label => label.querySelector("select")).map(label => label.textContent),
    }));
    assert.equal(report.assessmentEditor.questionForms, 3, "Existing multi-question assessment must remain editable");
    await questionType(0).selectOption("multiple");
    await waitSaved(c => c.scenes[position].content.questions[0].type === "multiple");
    for (const value of ["A", "B"]) {
      await setCorrectAnswer(forms().nth(0), value);
      await waitSaved(c => c.scenes[position].content.questions[0].answer.includes(value));
    }
    page.once("dialog", dialog => dialog.accept());
    await questionType(1).selectOption("judge");
    await waitSaved(c => c.scenes[position].content.questions[1].type === "judge");
    await setCorrectAnswer(forms().nth(1), "T");
    await waitSaved(c => c.scenes[position].content.questions[1].answer[0] === "T");
    page.once("dialog", dialog => dialog.accept());
    await questionType(2).selectOption("short_answer");
    await waitSaved(c => c.scenes[position].content.questions[2].type === "short_answer");
    await forms().nth(2).getByLabel("参考答案", { exact: true }).fill("Hello, my name is Pandy.");
    await waitSaved(c => c.scenes[position].content.questions[2].referenceAnswer?.includes("Pandy"));
    await forms().nth(2).getByLabel("关键点（每行一项）", { exact: true }).fill("问候语\n姓名");
    await waitSaved(c => c.scenes[position].content.questions[2].keyPoints?.length === 2);
    await forms().nth(2).getByLabel("评分提示", { exact: true }).fill("认可正确问候和自己的姓名。");
    await waitSaved(c => c.scenes[position].content.questions[2].commentPrompt?.includes("问候"));
    savedExport = await exportArchive("mixed");
  });
  await step("The actual assessment player reviews objective answers, marks short answers ungraded and resets on retry", async () => {
    const assessment = (await read()).classroom.scenes.find(scene => scene.id === "acceptance-assessment");
    const opened = app.waitForEvent("window");
    await editor().getByRole("button", { name: "播放整个课程", exact: true }).click();
    const player = await opened; playerPage = player; player.on("pageerror", error => pageErrors.push(error.stack));
    await expect(player.locator('[data-scene-type="quiz"]')).toBeVisible({ timeout: 30_000 });
    await player.getByRole("button", { name: "下一页", exact: true }).click();
    const card = type => player.locator(`[data-question-id="${assessment.content.questions.find(question => question.type === type).id}"]`);
    for (const value of ["A", "B"]) await answerQuiz(player, card("multiple").getByRole("button", { name: new RegExp(`^${value}\\s*`) }));
    await answerQuiz(player, card("judge").getByRole("button", { name: /^T\s*/ }));
    await card("short_answer").getByRole("textbox").fill("Hello, my name is Pandy.");
    await player.getByRole("button", { name: "提交答案", exact: true }).click();
    await expect(player.getByText("答题报告", { exact: true })).toBeVisible();
    await expect(card("multiple")).toHaveAttribute("data-grading-status", "correct");
    await expect(card("judge")).toHaveAttribute("data-grading-status", "correct");
    await expect(card("short_answer").getByRole("status")).toContainText("当前尚未评分");
    await expect(player.getByRole("status").filter({ hasText: "未计入当前得分" })).toContainText("1 道题");
    const image = join(out, "assessment-player-review.png"); await player.screenshot({ path: image }); report.artifacts.push(image);
    await player.getByRole("button", { name: "重新答题", exact: true }).click();
    await expect(player.getByText("答题报告", { exact: true })).toHaveCount(0);
    await expect(card("short_answer").getByRole("textbox")).toHaveValue("");
    await expect(player.locator('[data-question-id] button[aria-pressed="true"]')).toHaveCount(0);
    await player.close(); playerPage = null;
  });
  await step("The actual course player waits for Quiz completion and then pauses at the interaction", async () => {
    const assessmentIndex = (await read()).classroom.scenes.findIndex(scene => scene.id === "acceptance-assessment");
    const assessment = (await read()).classroom.scenes[assessmentIndex];
    await editor().getByRole("button", { name: `${assessmentIndex + 1}. Quiz · ${assessment.title}`, exact: true }).click();
    page.once("dialog", dialog => dialog.accept());
    await editor().getByRole("button", { name: "删除场景", exact: true }).click();
    await waitSaved(c => c.scenes.length === 2 && c.scenes.some(scene => scene.actions?.some(action => action.type === "interaction_checkpoint")));
    savedExport = await exportArchive("mixed-playback");
    const interaction = (await read()).classroom.scenes.find(scene => scene.actions?.some(action => action.type === "interaction_checkpoint"));
    const opened = app.waitForEvent("window");
    await editor().getByRole("button", { name: "播放整个课程", exact: true }).click();
    const player = await opened; playerPage = player; player.on("pageerror", error => pageErrors.push(error.stack));
    const quiz = player.locator('[data-scene-type="quiz"]');
    await expect(quiz).toBeVisible({ timeout: 30_000 });
    await expect(quiz.locator("img")).toHaveCount(3);
    await player.getByRole("button", { name: "播放", exact: true }).click();
    await answerQuiz(player, quiz.getByRole("button", { name: /A.*Hello/ }));
    await expect.poll(async () => await player.locator('[data-player-mode="waiting_interaction"]').count()
      ? "interaction" : await player.getByRole("button", { name: "跳过失败的配音", exact: true }).isVisible() ? "unavailable_voice" : "pending", { timeout: 30_000 }).not.toBe("pending");
    if (await player.getByRole("button", { name: "跳过失败的配音", exact: true }).isVisible()) {
      report.offlineFeedback = "Unavailable system speech voice was explicitly skipped through the player control; no speech events were fabricated.";
      await player.getByRole("button", { name: "跳过失败的配音", exact: true }).click();
    }
    await expect(player.locator('[data-player-mode="waiting_interaction"]')).toBeVisible();
    await expect(player.getByText(interaction.actions.find(action => action.type === "interaction_checkpoint").question, { exact: true }).first()).toBeVisible();
    const image = join(out, "interaction-player.png"); await player.screenshot({ path: image }); report.artifacts.push(image);
    await player.close();
  });
  await step("A fresh Electron and Host process reopens the exact saved mixed content", async () => {
    const before = (await read()).classroom;
    await stop(); await start(); await openEditor();
    assert.deepEqual((await read()).classroom, before);
    assert.deepEqual((await exportArchive("mixed-reopened")).meta.classroom, savedExport.meta.classroom);
  });
  await step("Blank MAIC display fields save and reopen through real Main and Host without relaxing identities", async () => {
    await editor().getByRole("textbox", { name: "问题", exact: true }).fill("");
    await waitSaved(c => c.scenes[0].content.questions[0].question === "");
    const current = (await read()).classroom;
    const position = current.scenes.findIndex(scene => scene.actions?.some(action => action.type === "interaction_checkpoint"));
    await editor().getByRole("button", { name: `${position + 1}. 互动 · ${current.scenes[position].title}`, exact: true }).click();
    await editor().locator("summary").filter({ hasText: "更多上下文设置" }).click();
    for (const field of ["问题", "参考答案", "章节标题", "章节摘要"]) {
      await editor().getByRole("textbox", { name: field, exact: true }).fill("");
      await expect(editor().getByRole("textbox", { name: field, exact: true })).toHaveValue("");
    }
    await waitSaved(c => {
      const action = c.scenes[position].actions.find(item => item.type === "interaction_checkpoint");
      return action.question === "" && action.referenceAnswer.summary === "" && action.chapterTitle === "" && action.context.chapterSummary === "";
    });
    const saved = (await read()).classroom;
    await stop(); await start(); await openEditor();
    assert.deepEqual((await read()).classroom, saved);
  });
  assert.deepEqual(pageErrors, []);
  assert(report.checks.length >= 10, "Acceptance did not execute every required journey");
  report.status = "PASS";
} catch (error) {
  report.status = "FAIL"; report.error = error.stack; process.exitCode = 1;
  console.error(error.stack ?? String(error));
  if (page && !page.isClosed()) await page.screenshot({ path: join(out, "failure.png") }).catch(() => {});
  if (page && !page.isClosed()) {
    await writeFile(join(out, "failure-dom.html"), await editor().innerHTML().catch(() => "Editor unavailable"));
    await writeFile(join(out, "failure-classroom.json"), JSON.stringify(await read().catch(error => ({ error: String(error) })), null, 2));
  }
  if (playerPage && !playerPage.isClosed()) {
    await playerPage.screenshot({ path: join(out, "failure-player.png") });
    await writeFile(join(out, "failure-player-dom.html"), await playerPage.locator("body").innerHTML());
    report.playerState = await playerPage.locator("[data-player-mode]").evaluateAll(elements => elements.map(element => ({ mode: element.getAttribute("data-player-mode"), pageId: element.getAttribute("data-page-id"), text: element.textContent })));
  }
} finally {
  await stop().catch(error => { report.cleanupError = String(error); process.exitCode = 1; report.status = "FAIL"; });
  report.pageErrors = pageErrors;
  await writeFile(join(out, "electron.log"), logs.join(""));
  await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2));
  if (report.status === "PASS") await rm(directory, { recursive: true, force: true });
  console.log(`${report.status} MAIC authoring acceptance: ${out}`);
}
