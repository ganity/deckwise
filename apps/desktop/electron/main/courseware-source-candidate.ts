import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { candidateHash, generatePageFadeCandidate, resolvePageFadeTarget, type PptCandidateBaseline } from "@pi-desktop/agent-runtime";
import { readCandidateSource } from "./courseware-candidate-source";

type Host = { call<T>(method: string, params: unknown): Promise<T> };

/** Main owns paths and the retained generator result. No source replacement is authorized here. */
export async function stagePageFadeCandidate(input: {
  host: Host; sessionId: string; jobId: string; sourcePath: string;
  baseline: PptCandidateBaseline; generationBaseline: unknown; pageText: string;
  current: () => Promise<unknown>;
  parseOutput: (path: string, sha256: string) => Promise<string>;
  signal: AbortSignal;
}) {
  const { host, sessionId, baseline, signal } = input;
  const candidateId = randomUUID();
  const identity = { sessionId, projectId: baseline.coursewareProjectId, candidateId };
  const current = async () => { signal.throwIfAborted(); const result = await input.current(); signal.throwIfAborted(); return result; };
  await current();
  await host.call("courseware.sourceCandidate.prepare", { sessionId, jobId: input.jobId, request: {
    candidateId, pageId: baseline.pageId, kind: "page-fade", expectedSourceRevision: baseline.sourceRevision, expectedTeachingRevision: baseline.teachingRevision,
  } });
  const context = await host.call<{ mapping: { revision: string } }>("courseware.sourceCandidate.context", identity);
  await current();
  const source = await readCandidateSource(input.sourcePath, baseline.sourceSha256, signal);
  await current();
  const target = await resolvePageFadeTarget(source, context.mapping, baseline.pageId);
  const generated = await generatePageFadeCandidate({ baseline: input.generationBaseline, sourcePptx: source,
    pageText: input.pageText, target, getCurrentBaseline: current, signal });
  if (generated.pptx.length > 50 * 1024 * 1024) throw new Error("Candidate output exceeds limits");
  if (generated.hash !== candidateHash(generated.pptx) || generated.kind !== "page-fade" ||
      generated.scope.slidePart !== target.slidePart || generated.scope.pageIds.length !== 1 ||
      generated.scope.pageIds[0] !== baseline.pageId || generated.report.changedParts.length !== 1 ||
      generated.report.changedParts[0] !== target.slidePart || generated.report.addedParts.length !== 0) {
    throw new Error("Invalid retained fade result");
  }
  await current();
  const directory = await mkdtemp(join(dirname(input.sourcePath), ".candidate-"));
  try {
    const path = join(directory, "candidate.pptx");
    await writeFile(path, generated.pptx, { flag: "wx", mode: 0o600 });
    await current();
    const outputSha256 = generated.hash.slice(7);
    const jobId = await input.parseOutput(path, outputSha256);
    await current();
    const fadeEvidence = { protocol: "deckwise-main-fade/1", sourceSha256: baseline.sourceSha256,
      outputSha256, mappingRevision: context.mapping.revision, pageId: baseline.pageId, slidePart: target.slidePart };
    const staged = await host.call<{ status: string; outputSha256: string; candidateId: string; stale: boolean; applied: boolean; lineageVerified: boolean }>("courseware.sourceCandidate.stage", { ...identity, jobId, outputSha256, fadeEvidence });
    if (staged.status !== "needs-review" || staged.candidateId !== candidateId || staged.outputSha256 !== outputSha256 || staged.stale !== false || staged.applied !== false || staged.lineageVerified !== true) throw new Error("Invalid staged source candidate");
    await current();
    return { candidateId, kind: "page-fade", baseline, outputSha256, reviewState: "needs-review", applied: false };
  } finally { await rm(directory, { recursive: true, force: true }); }
}
