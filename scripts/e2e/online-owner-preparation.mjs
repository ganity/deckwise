/** Owner UI/Main/Host boundary; only auth/Platform/online Docs are external fixtures. */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
export function ownerPreparationPlatform() {
  return {
    source: null, session: { epoch: 0, active: false, sessionId: null }, boundKey: null, mutations: [],
    async handle({ request, route, actor, send, projectId, documentKey, origin, output }) {
      const base = `/courseware/team/projects/${projectId}`;
      if (route === `${base}/sources/current` && request.method === "GET") {
        send(this.source, this.source ? 200 : 46402); return true;
      }
      if (route === `${base}/editing-session` && request.method === "GET") {
        send({ projectId, ...this.session }); return true;
      }
      if (request.method !== "POST" || ![`${base}/sources`, `${base}/editing-session`, `${base}/editing-session/document-binding`].includes(route)) return false;
      assert.equal(actor.role, "OWNER");
      const chunks = []; let size = 0;
      for await (const bytes of request) { size += bytes.length; assert(size <= 21 * 1024 * 1024); chunks.push(bytes); }
      const body = Buffer.concat(chunks);
      if (route === `${base}/sources`) {
        assert.equal(this.session.active, false); assert.equal(this.source, null);
        const form = await new Request("http://127.0.0.1/upload", { method: "POST", headers: request.headers, body }).formData();
        assert.deepEqual([...form.keys()].sort(), ["requestId", "source", "sourceSha256"]);
        const file = form.get("source"), bytes = Buffer.from(await file.arrayBuffer());
        assert(bytes.length > 0 && bytes.length <= 20 * 1024 * 1024);
        assert.deepEqual(bytes, await readFile(process.env.DECKWISE_E2E_PPTX));
        assert.equal(form.get("sourceSha256"), hash(bytes)); assert.match(form.get("requestId"), /^[a-f0-9-]{36}$/u);
        this.source = { projectId, source: { revision: randomUUID(), sha256: hash(bytes) }, byteLength: bytes.length,
          requestId: form.get("requestId"), sessionEpoch: null, callbackId: null };
        this.mutations.push({ type: "upload", filename: file.name, ...this.source });
        await writeFile(join(output, "uploaded-source.pptx"), bytes); send(this.source);
      } else if (route === `${base}/editing-session`) {
        assert.equal(this.session.active, false); assert(this.source);
        assert.deepEqual(JSON.parse(body.toString()), { expectedEpoch: this.session.epoch, expectedSourceRevision: this.source.source.revision });
        this.session = { epoch: this.session.epoch + 1, active: true, sessionId: documentKey };
        this.mutations.push({ type: "start", ...this.session }); send({ projectId, ...this.session });
      } else {
        assert.equal(this.session.active, true); assert.deepEqual(JSON.parse(body.toString()), { expectedEpoch: this.session.epoch });
        this.boundKey = documentKey; this.mutations.push({ type: "bind", epoch: this.session.epoch, key: documentKey });
        send({ key: documentKey, sessionEpoch: this.session.epoch, callbackUrl: `${origin}/callback` });
      }
      return true;
    },
  };
}

export async function verifyOwnerPreparation({ app, page, expect, invoke, step, teamPanel, nativeFrame,
  preparation, projectId, sessionId, workspace, output, requests, dataDir }) {
  const result = { realLocalOffice: true, realHost: true, realCoordinatorAndIpc: true,
    realSpringPlatform: false, onlineDocsProtocolFixture: true, realDocsEngine: false };
  await step("The real import task opens a saved PPTX in native WiseOffice owned by the current Chat", async () => {
    const file = join(workspace, "owner-lesson.pptx"); await copyFile(process.env.DECKWISE_E2E_PPTX, file);
    await page.evaluate(async id => { window.__PI_CAPTURE__ = true; await window.__PI_DESKTOP__.refreshProviders();
      await window.__PI_DESKTOP__.selectSession(id); window.__PI_DESKTOP__.openNewWorkPanelTab(); }, sessionId);
    await page.locator('[data-work-panel-launcher-item="ppt-master"]').last().click();
    await page.getByRole("button", { name: "已有 PPT 导入", exact: true }).click();
    await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, file);
    await page.getByRole("button", { name: "选择 PPTX 并导入", exact: true }).click();
    await expect.poll(async () => {
      for (const target of app.context().pages()) for (const frame of target.frames())
        if (await frame.evaluate(() => Boolean(window.Asc?.editor?.isLoadFullApi && window.Asc.editor.isDocumentLoadComplete)).catch(() => false)) return true;
      return false;
    }, { timeout: 90_000 }).toBe(true);
    result.localContext = await invoke("pptEditorGetContext");
    const task = (await invoke("coursewareTaskGet", { sessionId })).task;
    assert.equal(task.taskType, "import"); assert(task.importPath); assert.equal(task.teamProjectId, undefined);
    assert.equal(hash(await readFile(task.importPath)), hash(await readFile(file)));
    result.importedSha256 = hash(await readFile(file)); result.importedBytes = (await readFile(file)).length;
  });
  await step("Owner reviews the saved file through the visible team action with zero preparation POSTs", async () => {
    await teamPanel();
    await expect(page.getByRole("button", { name: "准备在线编辑", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "准备在线编辑", exact: true }).click();
    const review = page.locator(".team-project-row .team-project-play[aria-label]");
    await expect(review.locator("code")).toHaveText(result.importedSha256, { timeout: 20_000 });
    await expect(review).toContainText(projectId); await expect(review).toContainText(String(result.importedBytes));
    assert.deepEqual(preparation.mutations, []);
    assert(!requests.some(item => item.method === "POST" && /\/(sources|editing-session|document-binding)$/u.test(item.path)));
    assert.equal((await invoke("coursewareTaskGet", { sessionId })).task.teamProjectId, undefined);
    await expect(review.locator("button.btn-primary")).toBeDisabled();
    result.reviewLayout = await review.evaluate(element => {
      const bounds = node => { const { x, y, width, height, left, right } = node.getBoundingClientRect();
        return { x, y, width, height, left, right }; };
      const panel = element.closest(".work-panel-body"), confirm = element.querySelector("button.btn-primary");
      if (!panel || !confirm) throw new Error("Missing review panel or confirmation button");
      return { panel: { ...bounds(panel), clientWidth: panel.clientWidth, scrollWidth: panel.scrollWidth, scrollLeft: panel.scrollLeft },
        review: { ...bounds(element), clientWidth: element.clientWidth, scrollWidth: element.scrollWidth }, confirm: bounds(confirm) };
    });
    await writeFile(join(output, "review-layout.json"), JSON.stringify(result.reviewLayout, null, 2));
    const { panel, review: layout, confirm } = result.reviewLayout;
    assert.equal(panel.scrollLeft, 0, "Review must be usable without horizontal scrolling");
    assert(panel.scrollWidth <= panel.clientWidth + 1, "The work panel must not overflow horizontally");
    assert(layout.scrollWidth <= layout.clientWidth + 1, "Long filename, SHA and acknowledgement must wrap inside the review");
    assert(layout.left >= panel.left - 1 && layout.right <= panel.right + 1, "The review must fit the visible panel width");
    assert(confirm.width > 0 && confirm.left >= panel.left - 1 && confirm.right <= panel.right + 1,
      "The confirmation button must fit entirely inside the panel's default horizontal viewport");
    await page.screenshot({ path: join(output, "owner-review.png") });
    result.reviewZeroPost = true;
  });
  await step("Explicit review confirmation uploads the exact source, starts its version, binds, and mounts online editing", async () => {
    const review = page.locator(".team-project-row .team-project-play[aria-label]");
    await review.getByRole("checkbox").check(); await review.locator("button.btn-primary").click();
    const frame = await nativeFrame();
    await expect.poll(async () => (await invoke("coursewareOnlineState")).status, { timeout: 20_000 }).toBe("ready");
    await expect(frame.getByText("Isolated Docs API fixture", { exact: true })).toBeVisible();
    assert.deepEqual(preparation.mutations.map(item => item.type), ["upload", "start", "bind"]);
    const task = (await invoke("coursewareTaskGet", { sessionId })).task;
    assert.equal(task.teamProjectId, projectId); assert.equal(task.taskType, "import");
    const { stdout } = await promisify(execFile)("python3", ["-c",
      "import sqlite3,json,sys;db=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True);print(json.dumps([json.loads(r[0]) for r in db.execute(\"SELECT value_json FROM kv WHERE ns='coursewareOnlinePrepare.v1'\")]))",
      join(dataDir, "pi.sqlite")]);
    const receipts = JSON.parse(stdout); assert.equal(receipts.length, 1);
    assert.equal(receipts[0].phase, "bound"); assert.equal(receipts[0].projectId, projectId);
    assert.equal(receipts[0].uploadedRevision, preparation.source.source.revision);
    assert.equal(receipts[0].sourceSha256, result.importedSha256);
    result.receipt = receipts[0];
    result.onlineState = await invoke("coursewareOnlineState");
    result.mutations = preparation.mutations;
    await frame.page().screenshot({ path: join(output, "online-protocol-fixture.png") });
    await page.screenshot({ path: join(output, "owner-confirmed.png") });
  });
  return result;
}
