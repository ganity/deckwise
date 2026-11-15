/** Canvas candidate HTTP fixture and actual Main/Host/Office adoption acceptance. */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const hash = value => createHash("sha256").update(value).digest("hex");
export function createCanvasReplacementFixture(getBytes) {
  const prompt = "A friendly rabbit for the current lesson";
  let task, submissions = 0, assetReads = 0;
  return {
    prompt,
    get submissions() { return submissions; }, get assetReads() { return assetReads; },
    ready() {
      assert(task); const bytes = getBytes();
      Object.assign(task, { state: "ready", feeState: "settled", actualPoints: 3, receiptId: `courseware-media:${task.taskId}`,
        assetRef: { assetId: "canvas-image-candidate", sha256: hash(bytes), mime: "image/png", byteLength: bytes.length,
          width: 2, height: 2, downloadPath: `/courseware/media/tasks/${task.taskId}/asset` } });
    },
    async handle(request, response) {
      const url = new URL(request.url, "http://127.0.0.1");
      if (!url.pathname.startsWith("/courseware/media/")) return false;
      const send = data => { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ code: 200, data })); };
      if (url.pathname === "/courseware/media/models") {
        assert.equal(request.method, "GET"); assert.equal(url.searchParams.get("kind"), "image");
        send([{ model: "canvas-replacement-image", voices: [], providerDefaultVoice: false, supportsReferenceImage: false }]);
      } else if (url.pathname === "/courseware/media/models/canvas-replacement-image/quote") {
        assert.equal(request.method, "GET"); const expiry = Math.floor(Date.now() / 1000) + 300;
        send({ version: "courseware-media-quote-v1", kind: "image", model: "canvas-replacement-image", priceVersion: "image-v1",
          maxPoints: 3, maxChars: 4000, expiresAt: new Date(expiry * 1000).toISOString(), quoteToken: `${expiry}.${"a".repeat(43)}` });
      } else if (url.pathname === "/courseware/media/tasks/confirmed") {
        assert.equal(request.method, "POST"); assert.equal(submissions, 0, "Canvas replacement has exactly one explicit media dispatch");
        let raw = ""; for await (const chunk of request) raw += chunk;
        const body = JSON.parse(raw), key = request.headers["idempotency-key"];
        assert.match(key, /^[a-f0-9-]{36}$/u);
        assert.deepEqual(body.request, { kind: "image", model: "canvas-replacement-image", input: prompt });
        assert.equal(body.confirmation.maxPoints, 3); assert.equal(body.confirmation.priceVersion, "image-v1");
        submissions++;
        const requestHash = hash("courseware-media-v1" + [body.request.kind, body.request.model, body.request.input, null]
          .map(value => `:${value === null ? -1 : value.length}:${value ?? ""}`).join(""));
        task = { version: "courseware-media-v1", kind: "image", taskId: "canvas-replacement-task", idempotencyKey: key,
          requestHash, model: body.request.model, state: "queued", feeState: "reserved", reservedPoints: 3, actualPoints: null,
          errorCode: null, receiptId: null, assetRef: null };
        send(task);
      } else if (url.pathname === "/courseware/media/tasks/canvas-replacement-task") {
        assert.equal(request.method, "GET"); assert(task); send(task);
      } else if (url.pathname === "/courseware/media/tasks/canvas-replacement-task/asset") {
        assert.equal(request.method, "GET"); assert.equal(task?.state, "ready");
        assert.equal(assetReads, 0, "Candidate must be reused from its private archive after initial download");
        assetReads++; response.setHeader("content-type", "image/png"); response.end(getBytes());
      } else throw new Error(`Unexpected canvas fixture route ${request.method} ${url.pathname}`);
      return true;
    },
  };
}

export async function testCanvasImageReplacement(input) {
  const { getPage, getSdk, invoke, expect, sessionId, otherSessionId, file, artifact, out, report, fixture,
    goToPage, waitForOffice, step, send, stop, start, setAssetId, runFile, getBytes } = input;
  const page = () => getPage(), sdk = () => getSdk();
  const panel = () => page().locator(".courseware-image-assets");
  const operation = input.operation ?? "replace", inserting = operation === "insert";
  assert(["replace", "insert"].includes(operation));
  const tool = inserting ? "insert_slide_image_from_asset" : "replace_slide_image_from_asset";
  const geometry = { xMm: 25, yMm: 35, widthMm: 40, heightMm: 30 };
  let intentId, assetId, firstTarget;
  const native = () => sdk().evaluate(() => {
    const doc = window.Asc.editor.WordControl.m_oLogicDocument;
    return { history: window.AscCommon.History.Index, slides: doc.Slides.map(slide => slide.cSld.spTree.map(shape => ({
      text: shape.getDocContent?.()?.GetAllText?.() ?? "", raster: shape.blipFill?.RasterImageId ?? null,
      transform: shape.spPr?.xfrm ? Object.fromEntries(["offX", "offY", "extX", "extY", "rot", "flipH", "flipV"].map(key => [key, shape.spPr.xfrm[key] ?? null])) : null,
    }))) };
  });
  const select = ordinal => sdk().evaluate(ordinal => {
    const doc = window.Asc.editor.WordControl.m_oLogicDocument;
    const pictures = doc.Slides[1].cSld.spTree.filter(shape => shape.blipFill && !shape.group &&
      shape.isPlaceholder?.() === false && shape.spPr?.geometry?.preset === "rect" &&
      shape.blipFill.srcRect == null && shape.blipFill.tile == null && shape.blipFill.transparent == null);
    if (pictures.length < 2) throw new Error("Canvas target acceptance needs two ordinary images on slide 2");
    const picture = pictures[ordinal]; picture.Set_CurrentElement(); doc.Document_UpdateSelectionState();
    return { index: doc.Slides[1].cSld.spTree.indexOf(picture), raster: picture.blipFill.RasterImageId };
  }, ordinal);
  const clearSelection = () => sdk().evaluate(() => {
    const doc = window.Asc.editor.WordControl.m_oLogicDocument;
    doc.GetCurrentController().resetSelection(); doc.Document_UpdateSelectionState();
  });
  const selectTarget = () => inserting ? clearSelection() : select(0);
  const editorCommand = context => ({ projectId: context.projectId, documentId: context.documentId, sessionId: context.sessionId,
    requestId: randomUUID(), editGeneration: context.editGeneration, tool, input: { assetId, ...(inserting ? geometry : {}) } });
  const approve = async () => {
    await panel().getByRole("button", { name: /Preview image|预览图片/u }).click();
    await expect(panel().getByRole("img")).toBeVisible();
    await expect(panel().getByText(/Target: page 2|目标：第 2 页/u)).toBeVisible();
    const use = panel().getByRole("button", { name: /Use in this PPTX|用于当前 PPTX/u });
    await expect(use).toBeDisabled(); await panel().getByRole("checkbox").check(); await use.click();
    await expect(panel().getByRole("status")).toContainText(/Approved image:|已批准图片：/u);
    const context = await invoke("pptEditorGetContext");
    const capability = context.capabilities.find(value => value.name === tool);
    assert(capability); const ids = capability.inputSchema.properties.assetId.enum;
    assert.equal(ids.length, 1); assetId = ids[0]; setAssetId(assetId);
    return context;
  };
  await step("Canvas UI freezes a saved prompt, confirms its quote, and archives a single settled candidate", async () => {
    await page().evaluate(() => { window.__PI_CAPTURE__ = true; window.__PI_DESKTOP__.openNewWorkPanelTab(); });
    await page().locator('[data-work-panel-launcher-item="media-canvas"]').click();
    const canvas = page().locator(".courseware-media-canvas");
    await canvas.getByRole("button", { name: /Add image|添加图片/u, exact: true }).click();
    await canvas.locator(".courseware-media-canvas-properties").getByRole("textbox", { name: /^(Prompt|提示词)$/u }).fill(fixture.prompt);
    await expect.poll(async () => (await invoke("coursewareMediaCanvasGet", { sessionId })).document?.drafts[0]?.prompt).toBe(fixture.prompt);
    const draft = (await invoke("coursewareMediaCanvasGet", { sessionId })).document.drafts[0];
    const images = page().getByRole("region", { name: /Generate canvas images|画布生图/u });
    await images.getByRole("button", { name: /Load image models|加载图片模型/u }).click();
    await expect(images.getByRole("combobox", { name: /^(Image model|图片模型)$/u }).locator('option[value="canvas-replacement-image"]')).toHaveCount(1);
    await images.getByRole("combobox", { name: /Saved image draft|已保存的图片草稿/u }).selectOption(draft.id);
    await images.getByRole("combobox", { name: /^(Image model|图片模型)$/u }).selectOption("canvas-replacement-image");
    await images.getByRole("button", { name: /Prepare and get quote|准备请求并获取报价/u }).click();
    await expect(images.getByText(/Maximum: 3 points|最多 3 积分/u)).toBeVisible();
    assert.equal(fixture.submissions, 0);
    const generate = images.getByRole("button", { name: /Confirm and generate|确认并生成/u });
    await expect(generate).toBeDisabled();
    await images.getByRole("checkbox", { name: /I approve the displayed maximum cost for this exact saved prompt|我确认使用这份已保存的完整提示词/u }).check();
    await generate.click();
    await expect(images.getByText(/Task: queued|任务：queued/u)).toBeVisible(); assert.equal(fixture.submissions, 1);
    intentId = (await invoke("coursewareCanvasImageList", { sessionId }))[0].intentId;
    fixture.ready();
    const row = images.locator(`[data-canvas-image-intent="${intentId}"]`);
    await row.getByRole("button", { name: /Check original task status|查询原任务/u }).click();
    await expect(row.getByText(/Task: ready|任务：ready/u)).toBeVisible();
    await row.getByRole("button", { name: /Download and archive candidate|下载并归档候选/u }).click();
    await expect.poll(() => row.getByRole("img").evaluate(image => image.complete && image.naturalWidth === 2)).toBe(true);
    const candidate = (await invoke("coursewareCanvasImageList", { sessionId }))[0];
    assert.equal(candidate.asset.sha256, hash(getBytes())); assert.equal(fixture.assetReads, 1);
    await page().screenshot({ path: join(out, "canvas-candidate-archived.png") });
    await page().evaluate(async path => window.__PI_DESKTOP__.openWorkPanelArtifact("file", path), artifact);
    await waitForOffice(); await goToPage(1); firstTarget = await selectTarget();
    await copyFile(file, join(out, "image-baseline.pptx"));
  });
  await step("Canvas page and selection changes before approval refuse without native edits", async () => {
    const before = await native();
    const prepare = () => invoke("pptEditorImagePrepare", { sessionId, intentId, operation });
    let review = await prepare(); await goToPage(0);
    await assert.rejects(invoke("pptEditorImageApprove", { reviewId: review.reviewId }), /fresh|changed|expired|context|target/iu);
    await goToPage(1); await selectTarget(); review = await prepare(); await select(1);
    await invoke("pptEditorGetContext");
    await assert.rejects(invoke("pptEditorImageApprove", { reviewId: review.reviewId }), /fresh|changed|expired|context|target/iu);
    assert.deepEqual(await native(), before); assert.equal(hash(await readFile(file)), report.savedSha256);
  });
  await step(`Visible canvas ${operation} approval cannot be reused on a different eligible target`, async () => {
    await selectTarget();
    await panel().getByRole("combobox", { name: /^(Image source|图片来源)$/u }).selectOption("canvas");
    await panel().getByRole("button", { name: /Refresh archived candidates|刷新已归档候选/u }).click();
    await panel().getByRole("combobox", { name: /^(Archived candidate|已归档候选)$/u }).selectOption(intentId);
    await panel().getByRole("combobox", { name: /^(Requested change|修改操作)$/u }).selectOption(operation);
    const approved = await approve(), before = await native();
    if (inserting) { await goToPage(0); await clearSelection(); } else await select(1);
    const changed = await invoke("pptEditorGetContext");
    assert(changed.editGeneration > approved.editGeneration);
    assert(changed.capabilities.some(value => value.name === tool), "Refusal must bind the target, not just lack the requested native capability");
    await assert.rejects(invoke("pptEditorExecute", editorCommand(changed)), /Canvas image target changed|preview and approve/iu);
    assert.deepEqual(await native(), before); assert.equal(hash(await readFile(file)), report.savedSha256);
    await goToPage(1); await selectTarget(); await approve(); await page().screenshot({ path: join(out, "canvas-target-reapproved.png") });
  });
  await step(`Existing Main Chat ${inserting ? "inserts" : "replaces"} the reviewed canvas image; save and full restart retain it`, async () => {
    const before = await native(), savedHash = report.savedSha256;
    const approved = await invoke("pptEditorGetContext");
    await send(inserting ? `CHAT_NATIVE_IMAGE_INSERT 将已确认的 ${assetId} 插入当前页，左25毫米、上35毫米、宽40毫米、高30毫米，不要保存。`
      : `CHAT_NATIVE_IMAGE 将当前选中的图片替换为已确认的 ${assetId}，不要保存。`);
    await expect(page().getByText("CHAT_NATIVE_IMAGE_DONE", { exact: true })).toBeVisible({ timeout: 90_000 });
    assert.equal(hash(await readFile(file)), savedHash, "Chat replacement remains unsaved");
    const after = await native();
    const expected = structuredClone(before.slides);
    let targetIndex;
    if (inserting) {
      targetIndex = before.slides[1].length;
      const added = after.slides[1][targetIndex];
      assert(added?.raster, "Insertion adds one native picture");
      assert.deepEqual([added.transform.offX, added.transform.offY, added.transform.extX, added.transform.extY], [25, 35, 40, 30]);
      assert.equal(added.transform.rot ?? 0, 0);
      assert(!added.transform.flipH && !added.transform.flipV);
      expected[1].push(added);
      await assert.rejects(invoke("pptEditorExecute", editorCommand(approved)), /save|stale|fresh|changed|review/iu);
      assert.deepEqual(await native(), after, "An old approval cannot duplicate insertion");
    } else {
      targetIndex = firstTarget.index;
      assert.notEqual(after.slides[1][targetIndex].raster, before.slides[1][targetIndex].raster);
      expected[1][targetIndex].raster = after.slides[1][targetIndex].raster;
    }
    assert.deepEqual(after.slides, expected, "Only the explicitly requested image operation may change native content");
    await invoke("pptEditorSave");
    await expect(page().locator(".courseware-teaching").getByRole("button", { name: /Load current page|读取当前页讲解/u })).toBeEnabled({ timeout: 240_000 });
    await copyFile(file, join(out, "image-saved.pptx")); await writeFile(join(out, "canvas-approved.png"), getBytes());
    report.savedSha256 = hash(await readFile(file));
    const readback = await runFile("python3", ["-c", pythonReadback, join(out, "image-baseline.pptx"), join(out, "image-saved.pptx"),
      join(out, "canvas-approved.png"), String(targetIndex), operation]);
    await writeFile(join(out, "canvas-pptx-readback.json"), readback.stdout);
    await stop(); await start(); await goToPage(1);
    const restarted = await native();
    assert.deepEqual(restarted.slides.map(slide => slide.map(({ raster, ...shape }) => shape)), after.slides.map(slide => slide.map(({ raster, ...shape }) => shape)));
    assert(!(await invoke("pptEditorGetContext")).capabilities.some(value => value.name === tool));
    const preview = await invoke("coursewareCanvasImagePreview", { sessionId, intentId });
    assert.equal(preview.dataUrl, `data:image/png;base64,${getBytes().toString("base64")}`);
    assert.equal(fixture.assetReads, 1); assert.equal(fixture.submissions, 1);
    report.image = { source: "canvas", operation, ...(inserting ? { geometry, staleInsertionCannotDuplicate: true } : {}), intentId, assetId, sha256: hash(getBytes()), actualAuthSession: true,
      platformFixture: true, supplierFixture: true, mainChatFixture: true, paidCalls: false,
      pageChangedBeforeApprovalRefused: true, selectionChangedBeforeApprovalRefused: true,
      newerGenerationForeignTargetRefused: true, independentSavedReadback: true, completeRestart: true,
      restartRevokesReview: true, archivedPreviewWithoutDownload: true };
    await page().screenshot({ path: join(out, "canvas-image-saved-restarted.png") });
  });
  await step("The other Chat cannot borrow the original private canvas candidate", async () => {
    await page().evaluate(async id => window.__PI_DESKTOP__.selectSession(id), otherSessionId);
    await invoke("coursewareTaskSet", { sessionId: otherSessionId, taskType: "plain", educationContext: {} });
    assert.deepEqual(await invoke("coursewareCanvasImageList", { sessionId: otherSessionId }), []);
    await assert.rejects(invoke("coursewareCanvasImagePreview", { sessionId: otherSessionId, intentId }), /not found|missing|not exist|不存在/iu);
    await page().evaluate(async id => window.__PI_DESKTOP__.selectSession(id), sessionId);
    assert.equal((await invoke("coursewareCanvasImageList", { sessionId }))[0].asset.sha256, hash(getBytes()));
    assert.equal(fixture.assetReads, 1); assert.equal(fixture.submissions, 1);
  });
}

const pythonReadback = String.raw`
import hashlib,json,posixpath,sys,zipfile,xml.etree.ElementTree as E
n={'p':'http://schemas.openxmlformats.org/presentationml/2006/main','a':'http://schemas.openxmlformats.org/drawingml/2006/main','r':'http://schemas.openxmlformats.org/officeDocument/2006/relationships'}
def sha(b): return hashlib.sha256(b).hexdigest()
def inspect(path):
 with zipfile.ZipFile(path) as z:
  slides=[]; notes=[]
  names=sorted((x for x in z.namelist() if __import__('re').fullmatch(r'ppt/slides/slide[0-9]+\.xml',x)),key=lambda x:int(__import__('re').search(r'slide([0-9]+)',x).group(1)))
  for name in names:
   relname=posixpath.join(posixpath.dirname(name),'_rels',posixpath.basename(name)+'.rels')
   rels={r.attrib['Id']:posixpath.normpath(posixpath.join(posixpath.dirname(name),r.attrib['Target'])) for r in E.fromstring(z.read(relname))}
   shapes=[]
   for shape in E.fromstring(z.read(name)).find('p:cSld/p:spTree',n):
    kind=shape.tag.rsplit('}',1)[-1]
    if kind in ('nvGrpSpPr','grpSpPr','extLst'): continue
    transform=shape.find('.//a:xfrm',n)
    blip=shape.find('.//a:blip',n)
    shapes.append({'kind':kind,'text':[x.text or '' for x in shape.findall('.//a:t',n)],'transform':E.tostring(transform).decode() if transform is not None else None,
      'raster':sha(z.read(rels[blip.attrib['{'+n['r']+'}embed']])) if blip is not None else None})
   slides.append(shapes)
  for name in sorted(x for x in z.namelist() if __import__('re').fullmatch(r'ppt/notesSlides/notesSlide[0-9]+\.xml',x)):
   notes.append([x.text or '' for x in E.fromstring(z.read(name)).findall('.//a:t',n)])
  return {'slides':slides,'notes':notes}
before,after=inspect(sys.argv[1]),inspect(sys.argv[2]); target=int(sys.argv[4]); operation=sys.argv[5]; approved=sha(open(sys.argv[3],'rb').read())
assert after['slides'][1][target]['raster']==approved
if operation=='insert':
 assert target==len(before['slides'][1]) and len(after['slides'][1])==target+1
 added=after['slides'][1].pop(); assert added['kind']=='pic'
 xfrm=E.fromstring(added['transform']); off=xfrm.find('a:off',n); ext=xfrm.find('a:ext',n)
 assert off.attrib=={'x':'900000','y':'1260000'} and ext.attrib=={'cx':'1440000','cy':'1080000'}
else:
 assert operation=='replace' and before['slides'][1][target]['raster']!=approved
 before['slides'][1][target]['raster']=approved
assert before==after,'Peer shape geometry/text/media or notes changed'
print(json.dumps({'status':'PASS','operation':operation,'page':2,'objectIndex':target,'approvedPngSha256':approved,'unchangedPeerGeometryTextMediaAndNotes':True},indent=2))
`;
