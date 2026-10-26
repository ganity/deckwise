import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

export async function verifyDeletedNarrationRecovery({ page, sdk, invoke, sessionId,
  file, out, report, step, start, stop, goToPage, loadPage, load, save, database }) {
  const require = createRequire(join(process.env.DECKWISE_E2E_OFFICE_ROOT, "package.json"));
  const { expect } = require("@playwright/test");
  const sha = async () => createHash("sha256").update(await readFile(file)).digest("hex");
  const current = async () => (await invoke("pptEditorTeachingOpen", { sessionId }));
  const run = promisify(execFile);
  const persisted = async () => {
    const { stdout } = await run("python3", ["-c",
      "import sqlite3,json,sys; db=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True); print(json.dumps([json.loads(row[0]) for row in db.execute(\"SELECT value_json FROM kv WHERE ns='coursewareProjects.v1'\")]))", database]);
    const projects = JSON.parse(stdout); assert.equal(projects.length, 1); return projects[0];
  };
  const history = () => page().locator(".courseware-teaching-history");
  const speech = () => page().locator(".courseware-teaching").getByRole("textbox", { name: "讲解段 1", exact: true });
  const record = async (name, value) => writeFile(join(out, name), JSON.stringify(value, null, 2));
  let before, associated, recovered, savedHash;
  const original = "Recovered lesson: a circle is round. Good!";
  const edited = "Teacher revised the recovered explanation: trace the round edge. Good!";

  await step("Save teacher narration before native duplication and deletion", async () => {
    await expect(speech()).toBeVisible();
    await speech().fill(original); await save().click(); await expect(load()).toBeEnabled();
    before = await persisted();
    assert.equal(before.pages.length, 3);
    assert.equal(before.pages[0].actions.find(action => action.type === "speech").text, original);
    await record("before-deletion.json", before);
  });
  await step("Delete the original Office slide and explicitly associate its visual copy as a new page", async () => {
    const ids = await sdk().evaluate(() => {
      const api = window.Asc.editor, doc = api.WordControl.m_oLogicDocument;
      const original = doc.Slides.map(slide => slide.Get_Id());
      api.DublicateSlide();
      return { original, copied: doc.Slides.map(slide => slide.Get_Id()) };
    });
    assert.equal(ids.copied.length, 4);
    assert.deepEqual(ids.copied.filter(id => ids.original.includes(id)), ids.original);
    await goToPage(0);
    const remaining = await sdk().evaluate(() => {
      window.Asc.editor.DeleteSlide();
      return window.Asc.editor.WordControl.m_oLogicDocument.Slides.map(slide => slide.Get_Id());
    });
    assert.equal(remaining.length, 3); assert(!remaining.includes(ids.original[0]));
    assert.deepEqual(remaining.slice(1), ids.original.slice(1));
    const oldHash = await sha(); await invoke("pptEditorSave");
    await expect.poll(sha, { timeout: 240_000 }).not.toBe(oldHash);
    await page().locator(".courseware-teaching").getByRole("button", { name: /审核已保存的 PPTX 变更|Review saved PPTX changes/ }).click();
    const review = page().locator(".courseware-source-review");
    await expect(review.locator("select")).toHaveCount(3, { timeout: 120_000 });
    for (const [index, value] of ["new", "1", "2"].entries()) await review.locator("select").nth(index).selectOption(value);
    await review.locator("input[type=checkbox]").click();
    await review.getByRole("button", { name: /采用这些关联|Use these associations/ }).click();
    await expect(review).toHaveCount(0, { timeout: 120_000 });
    await goToPage(0); await loadPage();
    associated = await persisted();
    assert(!associated.pages.some(entry => entry.pageId === before.pages[0].pageId));
    assert.deepEqual(associated.pages[0].actions, []);
    assert.deepEqual(associated.pages.slice(1).map(entry => entry.actions), before.pages.slice(1).map(entry => entry.actions));
    savedHash = await sha(); await record("after-association.json", associated);
    await copyFile(file, join(out, "native-deleted-source.pptx"));
  });
  await step("Read and preview deleted narration without mutating teaching or source", async () => {
    await history().locator("summary").click();
    await history().getByRole("button", { name: "加载已删除页历史", exact: true }).click();
    await expect(history().locator("select")).toBeVisible();
    const options = await history().locator("option").evaluateAll(nodes => nodes.map(node => ({ value: node.value, text: node.textContent })));
    const selected = options.find(option => option.text.includes(before.teachingRevision) && option.text.includes("第 1 页"));
    assert(selected); await history().locator("select").selectOption(selected.value);
    await expect(history().getByRole("list")).toContainText(original);
    await expect(history().getByRole("note")).toContainText("不恢复旧音频和高亮/聚光效果");
    await expect(history().getByRole("button", { name: "复制到当前页草稿" })).toBeDisabled();
    assert.deepEqual(await persisted(), associated); assert.equal(await sha(), savedHash);
    await record("history-preview.json", { options, selected }); await page().screenshot({ path: join(out, "history-preview.png") });
    await history().locator("input[type=checkbox]").click();
    await history().getByRole("button", { name: "复制到当前页草稿" }).click();
    await expect(speech()).toHaveValue(original);
    await speech().fill(edited);
    await expect(page().locator(".courseware-teaching").getByText("草稿已保留在本机", { exact: false })).toBeVisible();
    const next = await current(), draft = (await invoke("pptEditorTeachingDraftGet", { viewId: next.viewId })).draft;
    assert.equal(draft.actions.find(action => action.type === "speech").text, edited);
    const oldIds = new Set(before.pages[0].actions.map(action => action.id));
    assert(draft.actions.every(action => !oldIds.has(action.id)));
    assert(draft.actions.every(action => !action.audio && !action.cues));
    assert.deepEqual(next.project, associated); assert.equal(await sha(), savedHash);
    await record("recovered-draft.json", draft);
  });
  await step("Restart restores the recovered draft without silently applying it", async () => {
    await stop(); await start(); await goToPage(0); await load().click();
    await expect(speech()).toHaveValue(edited);
    assert.deepEqual(await persisted(), associated);
    await expect(save()).toBeEnabled(); await save().click(); await expect(load()).toBeEnabled();
    recovered = await persisted();
    assert.equal(recovered.pages[0].actions.find(action => action.type === "speech").text, edited);
    assert.deepEqual(recovered.pages.slice(1), associated.pages.slice(1));
    assert.equal(await sha(), savedHash); await record("saved-recovery.json", recovered);
  });
  await step("Second restart retains explicitly saved narration and unchanged PPTX", async () => {
    await stop(); await start(); await goToPage(0); await loadPage();
    await expect(speech()).toHaveValue(edited);
    const view = await current(); assert.deepEqual(view.project, recovered);
    assert.equal((await invoke("pptEditorTeachingDraftGet", { viewId: view.viewId })).draft, null);
    assert.equal(await sha(), savedHash);
    await loadPage();
    await history().locator("summary").click();
    await expect(history().getByRole("button", { name: "加载已删除页历史", exact: true })).toBeDisabled();
    await record("after-restart.json", view.project);
    report.recovery = { deletedPageId: before.pages[0].pageId, destinationPageId: view.pageId,
      sourceSha256: savedHash, draftRestart: true, explicitSave: true, savedRestart: true };
  });
}
