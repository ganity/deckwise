import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  isCoursewareCandidate,
  type CoursewareCandidate,
} from '../conversion/lib/courseware/canonical/courseware-contract';
import { coursewarePageBaseline, type CoursewarePageContext } from './canonical-page-context';
import {
  candidateHash,
  checkPageCandidateBaseline,
  PageCandidateError,
} from './page-candidate-baseline';
import { createPageCandidateLineage, generatePagePptxCandidate } from './page-pptx-candidate';
import type { PreservedPageImage } from './page-asset-locks';

type PageCandidate = Awaited<ReturnType<typeof generatePagePptxCandidate>> & {
  reference: CoursewareCandidate;
};
type Generate = Parameters<typeof generatePagePptxCandidate>[0]['generate'];
export const pageStyleBatchConfirmationSchema = z
  .object({
    representativeCandidateId: z.string().min(1).max(128),
    representativeOutputSha256: z.string().regex(/^[a-f0-9]{64}$/),
    instructionHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    pageIds: z.array(z.string().min(1).max(128)).min(2).max(20),
  })
  .strict();

/** Trusted Host scope confirmation only; never call from an unreviewed model request. */
export async function generatePageStyleBatchCandidate(input: {
  preservedImages?: Readonly<Record<string,readonly PreservedPageImage[]>>;
  sourcePptx: Uint8Array;
  sourceMapping: unknown;
  representative: PageCandidate;
  instruction: string;
  confirmation: unknown;
  targets: Array<{ context: CoursewarePageContext; slidePart: string }>;
  getCurrentContexts: () => Promise<CoursewarePageContext[]>;
  generate: (
    request: Parameters<Generate>[0] & {
      /** Owned current-stage copy for trusted source-bound rendering; never send PPTX to the model. */
      sourcePptx: Uint8Array;
      representative: { pageId: string; outputSha256: string; pptx: Uint8Array };
    },
    signal?: AbortSignal,
  ) => ReturnType<Generate>;
  signal?: AbortSignal;
}) {
  const { getCurrentContexts, generate, signal } = input;
  const locks = structuredClone(input.preservedImages ?? {});
  const source = Buffer.from(input.sourcePptx);
  const { pptx: representativeBytes, ...metadata } = input.representative;
  const representative = { ...structuredClone(metadata), pptx: Buffer.from(representativeBytes) };
  const mapping = z.record(z.string(), z.unknown()).parse(structuredClone(input.sourceMapping));
  const confirmation = pageStyleBatchConfirmationSchema.parse(input.confirmation);
  const instruction = z.string().trim().min(1).max(8000).parse(input.instruction);
  const targets = structuredClone(input.targets);
  const baselines = targets.map(({ context }) => coursewarePageBaseline(context));
  const first = baselines[0];
  const projectSnapshot = JSON.stringify(targets[0]?.context.project);
  const invalid = (message: string): never => {
    throw new PageCandidateError('INVALID_SOURCE', message);
  };
  if (
    !first ||
    targets.length !== confirmation.pageIds.length ||
    new Set(confirmation.pageIds).size !== targets.length ||
    new Set(baselines.map((b) => b.pageId)).size !== targets.length ||
    new Set(targets.map((t) => t.slidePart)).size !== targets.length ||
    [...new Set(targets.map(({ context }) => context.project))].some(
      (project) => JSON.stringify(project) !== projectSnapshot,
    ) ||
    baselines.some(
      (b) =>
        !confirmation.pageIds.includes(b.pageId) ||
        b.projectId !== first.projectId ||
        b.documentId !== first.documentId ||
        b.sourceHash !== first.sourceHash ||
        b.sourceRevision !== first.sourceRevision ||
        b.teachingRevision !== first.teachingRevision,
    ) ||
    candidateHash(source) !== first.sourceHash ||
    confirmation.instructionHash !== candidateHash(instruction) ||
    confirmation.representativeCandidateId !== representative.candidateId ||
    confirmation.representativeOutputSha256 !== representative.hash.slice(7)
  )
    invalid(
      'Batch confirmation must bind the exact representative, instruction, source and page scope',
    );
  const representativeIndex = baselines.findIndex(
    (b) => b.pageId === representative.baseline.pageId,
  );
  if (
    representativeIndex < 0 ||
    targets[representativeIndex].slidePart !== representative.scope.slidePart
  )
    invalid('The reviewed representative must belong to the confirmed scope');
  const representativeLocks = representative.report.preservedImages ?? [];
  const lockIdentity = (images: readonly PreservedPageImage[]) => JSON.stringify([...images].sort((a,b)=>a.zIndex-b.zIndex).map(image =>
    [image.objectId,image.sourceShapeId,image.assetSha256,image.pictureSha256,image.zIndex]));
  if (lockIdentity(representativeLocks) !== lockIdentity(locks[representative.baseline.pageId] ?? [])) invalid('Representative locked images changed');
  await checkPageCandidateBaseline(
    representative.baseline,
    async () => baselines[representativeIndex],
    signal,
  );

  const assertCurrent = async () => {
    signal?.throwIfAborted();
    const current = await getCurrentContexts();
    const latest = current.map(coursewarePageBaseline);
    if (
      [...new Set(current.map((context) => context.project))].some(
        (project) => JSON.stringify(project) !== projectSnapshot,
      )
    )
      throw new PageCandidateError('STALE_BASELINE', 'Project or teaching context changed');
    if (
      latest.length !== baselines.length ||
      new Set(latest.map((b) => b.pageId)).size !== baselines.length
    )
      throw new PageCandidateError('STALE_BASELINE', 'Confirmed page scope changed');
    for (const expected of baselines) {
      const found = latest.findIndex((b) => b.pageId === expected.pageId);
      if (found < 0) throw new PageCandidateError('STALE_BASELINE', 'Confirmed page scope changed');
      await checkPageCandidateBaseline(expected, async () => latest[found], signal);
    }
  };
  await assertCurrent();
  let lineage = await createPageCandidateLineage({
    sourcePptx: source,
    candidate: representative,
    mapping,
    targets: targets.map(({ context, slidePart }) => ({ pageId: context.pageId, slidePart })),
    signal,
  });
  const summarize = ({
    pptx: _bytes,
    ...stage
  }: Awaited<ReturnType<typeof generatePagePptxCandidate>>) => stage;
  const stages = [summarize(representative)];
  let staged: Buffer = representative.pptx;
  for (const pageId of confirmation.pageIds) {
    const index = baselines.findIndex((b) => b.pageId === pageId);
    if (index === representativeIndex) continue;
    await assertCurrent();
    const baseline = { ...baselines[index], sourceHash: candidateHash(staged) };
    const candidate = await generatePagePptxCandidate({
      preservedImages: locks[pageId],
      baseline,
      sourcePptx: staged,
      pageText: targets[index].context.pageText,
      instruction,
      target: { pageId, slidePart: targets[index].slidePart },
      signal,
      getCurrentBaseline: async () => {
        await assertCurrent();
        return baseline;
      },
      generate: (request, signal) =>
        generate(
          {
            ...request,
            sourcePptx: Buffer.from(staged),
            representative: {
              pageId: representative.baseline.pageId,
              outputSha256: representative.hash.slice(7),
              pptx: Buffer.from(representative.pptx),
            },
          },
          signal,
        ),
    });
    // Each stage proves unchanged page order and non-target bytes before composing lineage.
    const next = await createPageCandidateLineage({
      sourcePptx: staged,
      candidate,
      mapping: { ...mapping, sourceSha256: baseline.sourceHash.slice(7) },
      signal,
    });
    if (JSON.stringify(next.pages) !== JSON.stringify(lineage.pages))
      invalid('Batch page structure changed');
    lineage = { ...next, previousSourceSha256: first.sourceHash.slice(7) };
    stages.push(summarize(candidate));
    staged = candidate.pptx;
  }
  await assertCurrent();
  const candidateId = randomUUID();
  const hash = candidateHash(staged);
  const reference = {
    candidateId,
    projectId: first.projectId,
    source: { revision: first.sourceRevision, sha256: first.sourceHash.slice(7) },
    teachingRevision: first.teachingRevision,
    targetPageIds: [...confirmation.pageIds],
    outputSha256: hash.slice(7),
  };
  if (!isCoursewareCandidate(reference)) invalid('Invalid canonical batch reference');
  const changedParts = [...new Set(stages.flatMap((s) => s.report.changedParts))];
  return {
    version: 1 as const,
    kind: 'page-style-batch' as const,
    candidateId,
    reference,
    confirmation,
    baselines,
    pptx: staged,
    hash,
    lineage,
    scope: { pageIds: [...confirmation.pageIds], rebuiltPageIds: [...confirmation.pageIds] },
    report: {
      preservedImages: stages.flatMap(stage => (stage.report.preservedImages ?? []).map(image => ({ ...image, pageId: stage.baseline.pageId }))),
      changedParts,
      addedParts: stages.flatMap((s) => s.report.addedParts),
      preservedParts: Object.fromEntries(
        Object.entries(representative.report.preservedParts).filter(
          ([part]) => !changedParts.includes(part),
        ),
      ),
      stages: stages.map((s) => ({
        pageId: s.baseline.pageId,
        candidateId: s.candidateId,
        sourceHash: s.baseline.sourceHash,
        outputHash: s.hash,
      })),
      warnings: [...new Set(stages.flatMap((s) => s.report.warnings))],
    },
    reviewState: 'needs-review' as const,
    applied: false as const,
  };
}
