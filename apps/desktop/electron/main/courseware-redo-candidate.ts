import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { candidateHash, resolvePageFadeTarget, type PptCandidateBaseline } from "@pi-desktop/agent-runtime";
import { readCandidateSource } from "./courseware-candidate-source";
import { coursewareAuthoringUrl } from "./courseware-runtime";
import { createCoursewareSceneGenerator } from "./courseware-scene-generator";
import type { CoursewareVisualReview } from "./courseware-visual-review";

export type RetainedPageRedo = {
  candidateId: string;
  generated: Parameters<typeof import("@pi-desktop/courseware-runtime/authoring").generatePageStyleBatchCandidate>[0]["representative"];
  mapping: { revision: string };
  instruction: string;
};

/** Reviewed Main-owned images produce a private copy; Host alone retains adoption authority. */
export async function stagePageRedoCandidate(input: {
  host: { call<T>(method: string, params: unknown): Promise<T> };
  sessionId: string; jobId: string; sourcePath: string; baseline: PptCandidateBaseline;
  generationBaseline: unknown; pageText: string; instruction: string;
  reviewed: Awaited<ReturnType<CoursewareVisualReview["load"]>>;
  modelKey: string; thinkingLevel?: string;
  complete: Parameters<typeof createCoursewareSceneGenerator>[1];
  current(): Promise<unknown>;
  parseOutput(path: string, sha256: string): Promise<string>;
  signal: AbortSignal;
  retain?(result: RetainedPageRedo): Promise<void>;
}) {
  const { host, baseline, signal, reviewed } = input;
  const current = async () => {
    signal.throwIfAborted();
    await reviewed.assertCurrent();
    const value = await input.current();
    await reviewed.assertCurrent();
    signal.throwIfAborted();
    return value;
  };
  await current();
  if (reviewed.view.projectId !== baseline.coursewareProjectId || reviewed.view.pageId !== baseline.pageId ||
      reviewed.view.sourceSha256 !== baseline.sourceSha256) throw new Error("Reviewed visuals differ from candidate source/page");
  const source = await readCandidateSource(input.sourcePath, baseline.sourceSha256, signal);
  const authoring = coursewareAuthoringUrl();
  if (!authoring) throw new Error("Installed courseware compiler is unavailable");
  // Load beside the staged worker so native dependencies resolve outside Main's bundle.
  const { createPageCandidateLineage, generatePagePptxCandidate } = await import(/* @vite-ignore */ authoring) as typeof import("@pi-desktop/courseware-runtime/authoring");
  const candidateId = randomUUID();
  const identity = { sessionId: input.sessionId, projectId: baseline.coursewareProjectId, candidateId };
  await current();
  await host.call("courseware.sourceCandidate.prepare", { sessionId: input.sessionId, jobId: input.jobId, request: {
    candidateId, pageId: baseline.pageId, kind: "page-pptx", expectedSourceRevision: baseline.sourceRevision,
    expectedTeachingRevision: baseline.teachingRevision,
  } });
  const { mapping, assetLocks } = await host.call<{ mapping: { revision: string }; assetLocks?: { revision: string; images: Array<{
    pageId: string; objectId: string; sourceSha256: string; mappingRevision: string;
    image: import("./courseware-asset-locks").ImageProof;
  }> } | null }>("courseware.sourceCandidate.context", identity);
  const preservedImages = (assetLocks?.images ?? []).filter(lock => lock.pageId === baseline.pageId).map(lock => {
    if (lock.sourceSha256 !== baseline.sourceSha256 || lock.mappingRevision !== mapping.revision) throw new Error("Stale locked images require explicit review");
    return { objectId: lock.objectId, ...lock.image };
  });
  await current();
  const target = await resolvePageFadeTarget(source, mapping, baseline.pageId);
  const normal = reviewed.visuals.normal.image, textless = reviewed.visuals.textless.image;
  const generate = createCoursewareSceneGenerator({ sessionId: input.sessionId, modelKey: input.modelKey, thinkingLevel: input.thinkingLevel,
    visualMasterAssetId: normal.assetIds[0], cleanPlateAssetId: textless.assetIds[0], images: [normal, textless] }, async request => {
      await current();
      const output = await input.complete(request);
      await current();
      return output;
    });
  const generated = await generatePagePptxCandidate({ baseline: input.generationBaseline, sourcePptx: source,
    pageText: input.pageText, instruction: input.instruction, target, preservedImages, getCurrentBaseline: current, generate, signal });
  await createPageCandidateLineage({ sourcePptx: source, candidate: generated, mapping, signal });
  if (generated.pptx.length > 50 * 1024 * 1024 || generated.hash !== candidateHash(generated.pptx) || generated.kind !== "page-pptx")
    throw new Error("Invalid retained redo result");
  await current();
  const directory = await mkdtemp(join(dirname(input.sourcePath), ".candidate-"));
  try {
    const path = join(directory, "candidate.pptx"), outputSha256 = generated.hash.slice(7);
    await writeFile(path, generated.pptx, { flag: "wx", mode: 0o600 });
    await current();
    const jobId = await input.parseOutput(path, outputSha256);
    await current();
    const redoEvidence = { protocol: "deckwise-main-redo/1", sourceSha256: baseline.sourceSha256,
      outputSha256, mappingRevision: mapping.revision, pageId: baseline.pageId, slidePart: target.slidePart };
    const staged = await host.call<{ status: string; outputSha256: string; candidateId: string; stale: boolean; applied: boolean; lineageVerified: boolean }>(
      "courseware.sourceCandidate.stage", { ...identity, jobId, outputSha256, redoEvidence,
        preservedImages: (generated.report.preservedImages ?? []).map(image => ({ pageId: baseline.pageId, objectId: image.objectId, outputShapeId: image.outputShapeId })) });
    if (staged.status !== "needs-review" || staged.candidateId !== candidateId || staged.outputSha256 !== outputSha256 ||
        staged.stale !== false || staged.applied !== false || staged.lineageVerified !== true) throw new Error("Invalid staged redo candidate");
    await current();
    // Compiler IDs name embedded media; retain them separately from the Host archive ID.
    await input.retain?.({ candidateId, mapping, instruction: input.instruction.trim(), generated: { ...generated, reference: {
      candidateId: generated.candidateId, projectId: baseline.coursewareProjectId,
      source: { revision: baseline.sourceRevision, sha256: baseline.sourceSha256 }, teachingRevision: baseline.teachingRevision,
      targetPageIds: [baseline.pageId], outputSha256,
    } } });
    await current();
    return { candidateId, kind: "page-pptx", baseline, outputSha256, warnings: generated.report.warnings,
      reviewState: "needs-review", applied: false };
  } finally { await rm(directory, { recursive: true, force: true }); }
}
