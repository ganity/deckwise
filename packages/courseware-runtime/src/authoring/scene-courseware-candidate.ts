import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { COURSEWARE_MAX_BYTES } from '../conversion/lib/courseware/canonical/courseware-contract';
import { editablePptxSceneSchema } from './kindergarten/image2-pptist/contracts';
import { compileScenesToPptx } from './kindergarten/scene-to-pptx';
import { candidateHash, PageCandidateError } from './page-candidate-baseline';
import { coursewareNarrationActions } from './page-narration-actions';
import { pageNarrationOutputSchema } from './page-narration-schema';

const pagesSchema = z
  .array(
    z
      .object({
        scene: editablePptxSceneSchema,
        narration: pageNarrationOutputSchema,
      })
      .strict(),
  )
  .min(1)
  .max(100);

/** New scene tasks only. Host supplies authorized outputs/assets and owns identity binding/adoption. */
export async function compileSceneCoursewareCandidate(
  input: unknown,
  assets: Readonly<Record<string, Uint8Array>>,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const pages = pagesSchema.parse(input);
  const candidateId = randomUUID();
  let teachingBytes = 2;
  const teachingPages = pages.map(({ scene, narration }, index) => {
    if (
      scene.elements.length > 200 ||
      !scene.elements.some((element) => element.type !== 'image_layer')
    )
      throw new PageCandidateError(
        'INVALID_OUTPUT',
        'Each scene needs native objects within the 200-object budget',
      );
    const actions = coursewareNarrationActions(narration, `${candidateId}-${index}`);
    const page = {
      sceneId: scene.slideId,
      slidePart: `ppt/slides/slide${index + 1}.xml`,
      actions,
      locked: false as const,
      reviewState: 'review' as const,
    };
    teachingBytes += Buffer.byteLength(JSON.stringify(page)) + (index ? 1 : 0);
    if (teachingBytes > COURSEWARE_MAX_BYTES)
      throw new PageCandidateError('INVALID_OUTPUT', 'Scene teaching exceeds its 2 MiB budget');
    return page;
  });
  // Compiler captures all page descriptions and referenced bytes before its first await.
  const compiled = await compileScenesToPptx(
    pages.map((page) => page.scene),
    assets,
  );
  signal?.throwIfAborted();
  if (compiled.pptx.byteLength > 50 * 1024 * 1024)
    throw new PageCandidateError('INVALID_OUTPUT', 'Scene PPTX exceeds its 50 MiB budget');
  return {
    ...compiled,
    candidateId,
    taskType: 'scene' as const,
    outputSha256: candidateHash(compiled.pptx).slice(7),
    teachingPages,
    reviewState: 'needs-review' as const,
    applied: false as const,
    audioReady: false as const,
  };
}
