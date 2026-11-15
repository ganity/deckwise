import { PageCandidateError } from './page-candidate-baseline';
import { pageNarrationOutputSchema } from './page-narration-schema';

/** Canonical speech actions keep waits structured and start without generated audio. */
export function coursewareNarrationActions(input: unknown, candidateId: string) {
  const narration = pageNarrationOutputSchema.parse(input);
  const actions: Array<{ id: string; type: 'speech'; text: string; pauseAfterMs?: number } | { id: string; type: 'interaction_checkpoint'; checkpointId: string; checkpointKind: 'teacher_continue' }> = [];
  for (const block of narration.blocks) {
    if (block.type === 'wait') {
      if (block.mode === 'teacher_continue') {
        const checkpointId = `wait-${candidateId}-${actions.length}`;
        actions.push({ id: checkpointId, type: 'interaction_checkpoint', checkpointId, checkpointKind: 'teacher_continue' });
        continue;
      }
      const previous = actions.at(-1);
      if (!previous || previous.type !== 'speech' || (previous.pauseAfterMs ?? 0) + block.durationMs > 30000)
        throw new PageCandidateError(
          'INVALID_OUTPUT',
          'Waiting requires preceding speech and at most 30 seconds per speech',
        );
      previous.pauseAfterMs = (previous.pauseAfterMs ?? 0) + block.durationMs;
    } else
      actions.push({
        id: `speech-${candidateId}-${actions.length}`,
        type: 'speech',
        text: block.text,
      });
  }
  return actions;
}
