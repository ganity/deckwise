import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { app, BrowserWindow, ipcMain } from "electron";
import { PptEditorController } from "../electron/main/ppt-editor";
import { registerEditorHostScheme } from "../electron/main/editor-host-protocol";
import { CoursewareTeachingCoordinator } from "../electron/main/courseware-teaching";
import { CoursewareVisualReview } from "../electron/main/courseware-visual-review";
import { renderCoursewareSourceVisuals } from "../electron/main/courseware-source-visuals";
import { stagePageRedoCandidate } from "../electron/main/courseware-redo-candidate";
import { candidateHash, type PptCandidateBaseline } from "@pi-desktop/agent-runtime";
import { Host, resolveHostBinary } from "../../../scripts/e2e/host.mjs";

const root = process.env.DECKWISE_E2E_TEMP!, output = process.env.DECKWISE_E2E_OUTPUT!;
assert(root && output && process.env.DECKWISE_EDITOR_URL && process.env.DECKWISE_PPTX_WORKER && process.env.DECKWISE_PPTX_NODE);
app.setPath("userData", join(root, "profile")); app.setAppPath(process.env.DECKWISE_E2E_APP!);
registerEditorHostScheme();
const checks: string[] = [];
async function main() {
  await app.whenReady();
  const workspace = join(root, "workspace"), data = join(root, "host");
  await mkdir(workspace); await mkdir(join(data, "plugins/market"), { recursive: true });
  await writeFile(join(data, "plugins/market/catalog.json"), JSON.stringify({ schemaVersion: 2, providerId: "official", plugins: [] }));
  const source = await readFile(process.env.DECKWISE_E2E_PPTX!), sourcePath = join(workspace, "lesson.pptx");
  await writeFile(sourcePath, source);
  const host = new Host(resolveHostBinary(), data); await host.start();
  const sessionId = (await host.call("session.create", { projectPath: workspace })).session.id;
  const window = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
  const editor = new PptEditorController(ipcMain, () => {});
  let active = true;
  let cancelRendering = false;
  const assertOwner = () => { if (!active) throw new Error("Chat owner changed"); };
  const teaching = new CoursewareTeachingCoordinator(editor, () => host, async () => workspace, () => active ? sessionId : null, assertOwner);
  const visuals = new CoursewareVisualReview(teaching, editor, async () => workspace, assertOwner,
    request => {
      const result = renderCoursewareSourceVisuals({ ...request, ipcMain });
      if (cancelRendering) setTimeout(() => visuals.clear(), 100);
      return result;
    });
  try {
    await editor.open(window, workspace, sourcePath);
    let ready = false;
    for (let attempt = 0; attempt < 240; attempt++) {
      try { if ((await editor.getContext(workspace)).page) { ready = true; break; } } catch {}
      await delay(250);
    }
    assert(ready, "Owning native editor did not become ready");
    await teaching.open(sessionId);
    const before = await editor.getContext(workspace);
    const windowsBefore = BrowserWindow.getAllWindows().length;
    const review = await visuals.prepare({ sessionId });
    assert.equal(review.pageNumber, before.page); assert.equal(review.original.width, 1600);
    assert.notEqual(review.original.preview, review.nativeTextless.preview);
    assert.equal(BrowserWindow.getAllWindows().length, windowsBefore);
    checks.push("current owning editor and real Host parser/project resolve to separately rendered readonly visuals; renderer disposed");
    await assert.rejects(visuals.load(review.reviewId), /not been approved/);
    await visuals.approve({ reviewId: review.reviewId });
    const loaded = await visuals.load(review.reviewId);
    const project = (await host.call("courseware.project.get", { sessionId, projectId: review.projectId })).project;
    assert.equal(review.pageId, project.pages[review.pageNumber - 1].pageId);
    assert.equal(loaded.visuals.normal.sourceSha256, project.source.sha256);
    await writeFile(join(output, "original.png"), loaded.visuals.normal.image.bytes);
    await writeFile(join(output, "textless.png"), loaded.visuals.textless.image.bytes);
    assert.deepEqual(await editor.getContext(workspace), before);
    assert.deepEqual(await readFile(sourcePath), source);
    checks.push("explicit review releases current logical-page visuals; original source/native editor remain unchanged");
    const page = project.pages[review.pageNumber - 1];
    await host.call("courseware.teaching.setLock", { sessionId, projectId: project.projectId, pageId: page.pageId,
      expectedSourceRevision: project.source.revision, expectedTeachingRevision: project.teachingRevision, locked: true });
    await assert.rejects(visuals.load(review.reviewId), /changed/);
    checks.push("actual Host teaching lock/revision invalidates approved visuals");
    const locked = (await host.call("courseware.project.get", { sessionId, projectId: project.projectId })).project;
    await host.call("courseware.teaching.setLock", { sessionId, projectId: project.projectId, pageId: page.pageId,
      expectedSourceRevision: locked.source.revision, expectedTeachingRevision: locked.teachingRevision, locked: false });
    if (process.env.DECKWISE_E2E_REDO === "1") {
      const run = async (behavior: "normal" | "clear" | "invalid" | "cancel") => {
        const prepared = await visuals.prepare({ sessionId }); await visuals.approve({ reviewId: prepared.reviewId });
        const reviewed = await visuals.load(prepared.reviewId), controller = new AbortController();
        return teaching.withSaved(sessionId, async (host, jobId, snapshot, context, _session, parseOutput) => {
          const baselineProject = (await host.call<{ project: typeof project }>("courseware.project.get", { sessionId, projectId: prepared.projectId })).project;
          const { text } = await host.call<{ text: string }>("courseware.pageText", { sessionId, jobId, pageNumber: context.page });
          const baseline: PptCandidateBaseline = { projectId: context.projectId, documentId: context.documentId, sessionId: context.sessionId,
            editGeneration: context.editGeneration, coursewareProjectId: baselineProject.projectId, pageId: prepared.pageId,
            sourceRevision: baselineProject.source.revision, sourceSha256: snapshot.sha256,
            teachingRevision: baselineProject.teachingRevision, contentSha256: candidateHash(text).slice(7) };
          const generationBaseline = { projectId: baselineProject.projectId, documentId: context.documentId, pageId: prepared.pageId,
            sourceRevision: baseline.sourceRevision, sourceHash: `sha256:${snapshot.sha256}`, teachingRevision: baseline.teachingRevision,
            contentHash: candidateHash(text), clean: true, readOnly: false, manualLocked: false };
          return stagePageRedoCandidate({ host, sessionId, jobId, sourcePath: snapshot.path, baseline, generationBaseline,
            pageText: text, instruction: "Rebuild this page with a blue title and native editable elements", reviewed,
            modelKey: "fixture/model", signal: controller.signal,
            current: async () => { await teaching.assertCurrent(snapshot, context, sessionId, host); return generationBaseline; },
            parseOutput: async (path, hash) => { await writeFile(join(output, "candidate.pptx"), await readFile(path)); return parseOutput(path, hash); },
            complete: async request => {
              const data = JSON.parse(request.data);
              assert.equal(data.pageId, prepared.pageId); assert.equal(data.sourceHash, `sha256:${snapshot.sha256}`);
              assert.equal(request.images.length, 2);
              assert.deepEqual(Buffer.from(request.images[0].bytes), Buffer.from(reviewed.visuals.normal.image.bytes));
              assert.deepEqual(Buffer.from(request.images[1].bytes), Buffer.from(reviewed.visuals.textless.image.bytes));
              if (behavior === "clear") visuals.clear();
              if (behavior === "cancel") controller.abort(new Error("Cancelled scene completion"));
              return { text: JSON.stringify({ version: 1, slideId: behavior === "invalid" ? "other-page" : data.pageId,
                canvas: data.canvas, sourceHash: data.sourceHash, visualMasterAssetId: data.visualMasterAssetId,
                cleanPlateAssetId: data.cleanPlateAssetId, elements: [
                  { id: "title", type: "native_text", content: "Reviewed editable title", bboxPx: [50, 40, 800, 90], zIndex: 1,
                    style: { fontFace: "Arial", fontSizePt: 28, color: "#1234AA" } },
                  { id: "shape", type: "native_shape", shape: "ellipse", fill: "#DDEEFF", bboxPx: [80, 220, 150, 150], zIndex: 2 },
                ] }) };
            } });
        }, controller.signal);
      };
      const staged = await run("normal");
      const candidate = await host.call<{ lineageVerified: boolean; applied: boolean; kind: string }>("courseware.sourceCandidate.get", {
        sessionId, projectId: project.projectId, candidateId: staged.candidateId });
      assert.equal(candidate.lineageVerified, true); assert.equal(candidate.applied, false); assert.equal(candidate.kind, "page-pptx");
      assert.deepEqual(await readFile(sourcePath), source); assert.deepEqual(await editor.getContext(workspace), before);
      await writeFile(join(output, "candidate.json"), JSON.stringify({ staged, candidate }, null, 2));
      checks.push("actual reviewed native PNGs compile into a byte-verified editable copy and real Host stages trusted redo without source adoption");
      const previewPath = join(workspace, "review-candidate.pptx");
      await writeFile(previewPath, await readFile(join(output, "candidate.pptx")));
      const previewWindow = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
      const preview = new PptEditorController(ipcMain, () => {});
      try {
        await preview.open(previewWindow, workspace, previewPath, undefined, [], true);
        let context;
        for (let attempt = 0; attempt < 240; attempt++) {
          try { const next = await preview.getContext(workspace); if (next.page) { context = next; break; } } catch {}
          await delay(250);
        }
        assert(context, "Candidate readonly editor did not become ready"); assert.equal(context.readOnly, true);
        const result = await preview.execute({ projectId: context.projectId, documentId: context.documentId, sessionId: context.sessionId,
          editGeneration: context.editGeneration, requestId: randomUUID(), tool: "get_presentation_text", input: {} }, workspace);
        assert(result.tool === "get_presentation_text"); assert.match(result.result.text, /Reviewed editable title/);
        const rendered = await preview.renderSavedPagePreview(workspace, review.pageNumber);
        await writeFile(join(output, "candidate-preview.png"), rendered.image.bytes);
        assert.deepEqual(await readFile(sourcePath), source);
        assert.deepEqual(await editor.getContext(workspace), before);
      } finally { preview.dispose(); previewWindow.destroy(); }
      checks.push("real WiseOffice reopens the candidate readonly, reads its native text and renders it without changing the owning editor");
      await assert.rejects(run("clear"), /expired/);
      await assert.rejects(run("invalid"), /Invalid|differs/);
      await assert.rejects(run("cancel"), /Cancelled/);
      const snapshot = editor.teachingSnapshot(workspace);
      assert(!(await readdir(join(snapshot.path, ".."))).some(name => name.startsWith(".candidate-")));
      assert.deepEqual(await readFile(sourcePath), source);
      checks.push("review revoked during model completion, wrong-page scene and cancelled completion never replace source or retain temporary outputs");
    }
    cancelRendering = true;
    const pending = visuals.prepare({ sessionId });
    await assert.rejects(pending);
    assert.equal(BrowserWindow.getAllWindows().length, windowsBefore);
    checks.push("cancelled preparation releases parser and readonly window");
    await teaching.open(sessionId);
    active = false;
    await assert.rejects(visuals.prepare({ sessionId }));
    checks.push("changed owning Chat refuses new preparation");
    await writeFile(join(output, "report.json"), JSON.stringify({ status: "PASS", checks, realMain: true, realOffice: true,
      realHostParserSqlite: true, rendererClosed: true, fullDesktopApplication: false, packaged: false, modelCalled: false,
      publicRedo: false, redoCandidate: process.env.DECKWISE_E2E_REDO === "1", localSceneCallback: process.env.DECKWISE_E2E_REDO === "1", sandbox: "--no-sandbox" }, null, 2));
  } finally { visuals.clear(); editor.dispose(); window.destroy(); await host.stop(); }
}
main().then(() => { console.log(`PASS ${checks.length} Main/Office/Host visual-review groups`); app.exit(0); }).catch(async error => {
  console.error(error); await writeFile(join(output, "failure.json"), JSON.stringify({ checks, error: String(error.stack ?? error) }, null, 2)); app.exit(1);
});
