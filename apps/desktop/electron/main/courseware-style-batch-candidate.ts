import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { candidateHash, resolvePageFadeTarget } from "@pi-desktop/agent-runtime";
import type { CoursewarePageContext } from "@pi-desktop/courseware-runtime/authoring";
import { readCandidateSource } from "./courseware-candidate-source";
import { coursewareAuthoringUrl } from "./courseware-runtime";
import { createCoursewareSceneGenerator } from "./courseware-scene-generator";
import type { CoursewareStyleReviewCoordinator } from "./courseware-style-review";
import type { renderCoursewareSourceVisuals } from "./courseware-source-visuals";

type Render = (input: Omit<Parameters<typeof renderCoursewareSourceVisuals>[0], "ipcMain">) => ReturnType<typeof renderCoursewareSourceVisuals>;

/** Confirmed Main scope produces one pending copy; each model sees its actual current-stage page. */
export async function stagePageStyleBatchCandidate(input: {
  sessionId: string; jobId: string; scope: { reviewId: string; pageIds: string[] }; style: CoursewareStyleReviewCoordinator;
  modelKey: string; thinkingLevel?: string; signal: AbortSignal;
  render: Render; complete: Parameters<typeof createCoursewareSceneGenerator>[1];
  assertCurrent(): Promise<void>;
  parseOutput(path: string, sha256: string): Promise<string>;
}) {
  const { sessionId, jobId, signal, style, modelKey, thinkingLevel, render, complete, parseOutput } = input;
  const scope = structuredClone(input.scope);
  const assertInputCurrent = input.assertCurrent;
  const assertConfirmed = style.assertConfirmed.bind(style);
  const loadConfirmed = style.loadConfirmed.bind(style);
  signal.throwIfAborted();
  await assertInputCurrent();
  signal.throwIfAborted();
  const retained = await loadConfirmed(sessionId);
  const { host, project, snapshot, context, generated: representative, instruction, confirmation, reviewId, pageIds } = retained;
  if (!scope || scope.reviewId !== reviewId || JSON.stringify(scope.pageIds) !== JSON.stringify(pageIds))
    throw new Error("Confirmed batch scope changed; review the representative and pages again");
  const call = host.call.bind(host);
  const current = async () => {
    signal.throwIfAborted();
    await assertInputCurrent();
    await assertConfirmed(sessionId, reviewId, pageIds);
    signal.throwIfAborted();
  };
  await current();
  const authoring = coursewareAuthoringUrl();
  if (!authoring) throw new Error("Installed courseware compiler is unavailable");
  const { generatePageStyleBatchCandidate } = await import(/* @vite-ignore */ authoring) as typeof import("@pi-desktop/courseware-runtime/authoring");
  const source = await readCandidateSource(snapshot.path, snapshot.sha256, signal);
  await current();
  const contexts = async (): Promise<CoursewarePageContext[]> => {
    await current();
    const latest = await call<{ project: unknown }>("courseware.project.get", { sessionId, projectId: project.projectId });
    if (JSON.stringify(latest.project) !== JSON.stringify(project)) throw new Error("Confirmed batch teaching changed");
    const result: CoursewarePageContext[] = [];
    for (const pageId of pageIds) {
      const index = project.pages.findIndex(page => page.pageId === pageId);
      if (index < 0 || project.pages[index].locked) throw new Error("Confirmed batch page is missing or locked");
      const { text } = await call<{ text: string }>("courseware.pageText", { sessionId, jobId, pageNumber: index + 1 });
      if (typeof text !== "string" || text.length > 32000) throw new Error("Invalid confirmed page text");
      result.push({ project, documentId: context.documentId, pageId, pageText: text, clean: true, readOnly: false });
      await current();
    }
    return result;
  };
  const initial = await contexts();
  const candidateId = randomUUID(), identity = { sessionId, projectId: project.projectId, candidateId };
  await current();
  await call("courseware.sourceCandidate.prepare", { sessionId, jobId, request: {
    candidateId, pageId: representative.baseline.pageId, kind: "page-style-batch",
    expectedSourceRevision: project.source.revision, expectedTeachingRevision: project.teachingRevision,
    styleBatch: { ...confirmation, representativeCandidateId: retained.candidateId },
  } });
  const { mapping, assetLocks } = await call<{ mapping: { revision: string }; assetLocks?: { revision: string; images: Array<{
    pageId: string; objectId: string; sourceSha256: string; mappingRevision: string; image: import("./courseware-asset-locks").ImageProof;
  }> } | null }>("courseware.sourceCandidate.context", identity);
  const preservedImages: Record<string, import("@pi-desktop/courseware-runtime/authoring").PreservedPageImage[]> = {};
  for (const lock of assetLocks?.images ?? []) {
    if (!pageIds.includes(lock.pageId)) continue;
    if (lock.sourceSha256 !== snapshot.sha256 || lock.mappingRevision !== mapping.revision) throw new Error("Stale locked images require explicit review");
    (preservedImages[lock.pageId] ??= []).push({ objectId: lock.objectId, ...lock.image });
  }
  await current();
  if (JSON.stringify(mapping) !== JSON.stringify(retained.mapping)) throw new Error("Confirmed batch source mapping changed");
  const targets = [];
  for (const page of initial) {
    const target = await resolvePageFadeTarget(source, mapping, page.pageId);
    targets.push({ context: page, slidePart: target.slidePart });
  }
  await current();
  const directory = await mkdtemp(join(dirname(snapshot.path), ".style-batch-"));
  let stage = 0;
  try {
    const generated = await generatePageStyleBatchCandidate({ sourcePptx: source, sourceMapping: mapping, representative, preservedImages,
      instruction, confirmation, targets, getCurrentContexts: contexts, signal,
      generate: async (request, requestSignal) => {
        await current();
        requestSignal?.throwIfAborted();
        const sourcePptx = Buffer.from(request.sourcePptx);
        if (sourcePptx.length > 50 * 1024 * 1024 || candidateHash(sourcePptx) !== request.sourceHash)
          throw new Error("Invalid batch stage bytes");
        const pageNumber = project.pages.findIndex(page => page.pageId === request.pageId) + 1;
        if (!pageIds.includes(request.pageId) || pageNumber < 1) throw new Error("Unconfirmed batch page");
        const path = join(directory, `stage-${++stage}.pptx`);
        await writeFile(path, sourcePptx, { flag: "wx", mode: 0o600 });
        await current();
        const visuals = await render({ workspace: retained.workspace, snapshot: { sourcePath: path, sha256: request.sourceHash.slice(7) },
          page: pageNumber, signal, assertCurrent: current });
        await current();
        if (visuals.pageCount !== project.pages.length || visuals.normal.page !== pageNumber || visuals.textless.page !== pageNumber ||
            visuals.normal.sourceSha256 !== request.sourceHash.slice(7) || visuals.textless.sourceSha256 !== request.sourceHash.slice(7) ||
            visuals.normal.nativeTextOmitted || visuals.textless.nativeTextOmitted !== true ||
            visuals.normal.pageToken !== visuals.textless.pageToken) throw new Error("Batch render differs from the current stage");
        const normal = visuals.normal.image, clean = visuals.textless.image;
        const generate = createCoursewareSceneGenerator({ sessionId, modelKey, thinkingLevel,
          visualMasterAssetId: normal.assetIds[0], cleanPlateAssetId: clean.assetIds[0], images: [normal, clean],
          sourceVisual: { pageId: request.pageId, sourceHash: request.sourceHash },
          representativePreview: { pageId: representative.baseline.pageId, outputSha256: representative.hash.slice(7), image: retained.representativeImage },
        }, async completion => {
          await current();
          const result = await complete(completion);
          await current();
          return result;
        });
        return generate({ ...request, sourcePptx }, signal);
      },
    });
    await current();
    if (generated.kind !== "page-style-batch" || generated.pptx.length > 50 * 1024 * 1024 || candidateHash(generated.pptx) !== generated.hash ||
        JSON.stringify(generated.scope.pageIds) !== JSON.stringify(pageIds) || JSON.stringify(generated.scope.rebuiltPageIds) !== JSON.stringify(pageIds) ||
        generated.reference.projectId !== project.projectId || generated.reference.outputSha256 !== generated.hash.slice(7) ||
        JSON.stringify(generated.reference.targetPageIds) !== JSON.stringify(pageIds)) throw new Error("Invalid compiled batch candidate");
    const outputSha256 = generated.hash.slice(7), path = join(directory, "candidate.pptx");
    await writeFile(path, generated.pptx, { flag: "wx", mode: 0o600 });
    await current();
    const outputJob = await parseOutput(path, outputSha256);
    await current();
    const batchEvidence = { protocol: "deckwise-main-style-batch/1", sourceSha256: snapshot.sha256, outputSha256,
      mappingRevision: mapping.revision, targets: targets.map(target => ({ pageId: target.context.pageId, slidePart: target.slidePart })) };
    const staged = await call<{ kind: string; status: string; outputSha256: string; candidateId: string; stale: boolean; applied: boolean; lineageVerified: boolean; targetPageIds: string[] }>(
      "courseware.sourceCandidate.stage", { ...identity, jobId: outputJob, outputSha256, batchEvidence,
        preservedImages: generated.report.preservedImages.map(image => ({ pageId: image.pageId, objectId: image.objectId, outputShapeId: image.outputShapeId })) });
    if (staged.kind !== "page-style-batch" || staged.status !== "needs-review" || staged.candidateId !== candidateId || staged.outputSha256 !== outputSha256 ||
        staged.stale !== false || staged.applied !== false || staged.lineageVerified !== true || JSON.stringify(staged.targetPageIds) !== JSON.stringify(pageIds))
      throw new Error("Invalid staged batch candidate");
    await current();
    return { candidateId, kind: "page-style-batch" as const, targetPageIds: [...pageIds], outputSha256,
      warnings: generated.report.warnings, reviewState: "needs-review" as const, applied: false as const };
  } finally { await rm(directory, { recursive: true, force: true }); }
}
