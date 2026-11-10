import { TeachingQuestionResponse } from './TeachingQuestionResponse';
import type { InteractionCheckpointPayload } from '../../lib/types/action';
import { englishPlayerLabels, type FixedPlayerLabels } from '../../labels';

/** Shared question presentation; the caller's playback session owns continuation. */
export function TeachingQuestion({ question, labels }: {
  question: Extract<InteractionCheckpointPayload, { checkpointKind: 'chapter_summary' }>;
  labels: FixedPlayerLabels;
}) {
  return <>
    <p>{question.question}</p>
    {question.response && <TeachingQuestionResponse key={question.checkpointId} response={question.response} labels={labels} />}
    <details key={question.checkpointId}>
      <summary>{labels.referenceAnswer ?? englishPlayerLabels.referenceAnswer}</summary>
      <p>{question.referenceAnswer.summary}</p>
      <ul>{question.referenceAnswer.keyPoints.map((point, index) => <li key={index}>{point}</li>)}</ul>
    </details>
  </>;
}
