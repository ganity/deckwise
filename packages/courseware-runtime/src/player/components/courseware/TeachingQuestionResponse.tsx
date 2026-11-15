import { useState } from 'react';
import type { QuestionResponse } from '../../../question-response';
import { evaluateQuestionAnswer } from '../../../question-response';
import type { FixedPlayerLabels } from '../../labels';
import { englishPlayerLabels } from '../../labels';

export function TeachingQuestionResponse({ response, labels }: { response: QuestionResponse; labels: FixedPlayerLabels }) {
  const [selected, setSelected] = useState<number[]>([]);
  const [result, setResult] = useState<boolean | undefined>();
  const choice = response.options.length > 0;
  return <fieldset>
    <legend>{choice ? labels.chooseAnswer ?? englishPlayerLabels.chooseAnswer : labels.activityResponse ?? englishPlayerLabels.activityResponse}</legend>
    {choice ? response.options.map((option, index) => <label key={index} style={{ display: 'block' }}>
      <input type={response.kind === 'multiple' ? 'checkbox' : 'radio'} name="teaching-answer" checked={selected.includes(index)}
        onChange={() => { setResult(undefined); setSelected(response.kind === 'multiple' ? selected.includes(index) ? selected.filter(i => i !== index) : [...selected, index] : [index]); }} /> {option}
    </label>) : <textarea aria-label={labels.activityResponse ?? englishPlayerLabels.activityResponse} maxLength={4000} />}
    {choice ? <button type="button" disabled={!selected.length} onClick={() => setResult(evaluateQuestionAnswer(response, selected) ?? undefined)}>{labels.checkAnswer ?? englishPlayerLabels.checkAnswer}</button> :
      <p>{labels.teacherAssessment ?? englishPlayerLabels.teacherAssessment}</p>}
    {result !== undefined && <p role="status">{result ? labels.answerCorrect ?? englishPlayerLabels.answerCorrect : labels.answerTryAgain ?? englishPlayerLabels.answerTryAgain}</p>}
  </fieldset>;
}
