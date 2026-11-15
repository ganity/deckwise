import { useState } from 'react';
import type { QuizContent, QuizQuestion } from '../../lib/types/stage';
import { MaicInstantQuizCard } from './MaicInstantQuizCard';
import { MaicAssessmentQuiz } from './MaicAssessmentQuiz';

export function scoreMaicQuiz(question: QuizQuestion, selected: string[]): boolean | null {
  if (question.type === 'short_answer' || question.hasAnswer === false || !question.answer?.length) return null;
  return new Set(selected).size === selected.length && selected.length === question.answer.length && selected.every(value => question.answer!.includes(value));
}

/** Independent Quiz scene. Classroom question checkpoints are rendered by the slide player. */
export function MaicQuiz({ content, onComplete, onInstantAnswer, disabled = false }: { content: QuizContent; onComplete?: () => void; onInstantAnswer?: (correct: boolean) => void; disabled?: boolean }) {
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const [texts, setTexts] = useState<Record<string, string>>({});
  const [checked, setChecked] = useState(false);
  const [index, setIndex] = useState(0);
  const instant = content.interactionMode === 'classroom_instant_feedback';
  const questions = instant ? content.questions.slice(index, index + 1) : content.questions;
  const scores = questions.map(q => scoreMaicQuiz(q, answers[q.id] ?? []));
  const correct = scores.every(score => score === true);
  const mayComplete = scores.every(score => score !== false);
  const change = (question: QuizQuestion, value: string) => {
    setChecked(false);
    setAnswers(previous => ({ ...previous, [question.id]: question.type === 'multiple'
      ? (previous[question.id] ?? []).includes(value) ? previous[question.id].filter(v => v !== value) : [...previous[question.id] ?? [], value]
      : [value] }));
  };
  if (!instant) return <MaicAssessmentQuiz questions={content.questions} disabled={disabled} onComplete={onComplete} />;
  if (instant && questions[0] && ['single', 'judge'].includes(questions[0].type)) {
    const question = questions[0];
    const score = scoreMaicQuiz(question, answers[question.id] ?? []);
    return <section aria-label="课堂测验" data-scene-type="quiz" data-maic-quiz-card>
      <MaicInstantQuizCard question={question} value={answers[question.id]?.[0]} disabled={disabled}
        result={checked && score !== null ? { status: score ? 'correct' : 'incorrect' } : undefined}
        onAnswer={value => {
          change(question, value); setChecked(true);
          const nextScore = scoreMaicQuiz(question, [value]);
          if (nextScore !== null) onInstantAnswer?.(nextScore);
        }} />
      {checked && score !== null && <div className="maic-quiz-feedback" role="status" aria-live="polite">
        {score ? content.playbackConfig?.successSpeechText || '回答正确！非常棒！'
          : content.playbackConfig?.failureSpeechText || '很遗憾，你选错了，再试一次吧！'}
      </div>}
      {checked && score === null && <div className="maic-quiz-feedback" role="status">
        本题需要教师或在线评价，当前尚未评分。
        <button type="button" disabled={disabled} onClick={onComplete}>完成测验</button>
      </div>}
    </section>;
  }
  return <section aria-label="课堂测验" data-scene-type="quiz" style={{ background: '#f4f7ff', padding: 20, borderRadius: 20 }}>
    <div style={{ background: 'white', border: '1px solid #d9e3ff', borderRadius: 32, padding: '36px 40px' }}>
      {questions.map((question, offset) => <fieldset disabled={disabled} key={question.id} style={{ border: 0, margin: 0, padding: 0 }}>
        <p style={{ color: '#387cfa', fontWeight: 600 }}>{instant ? '立即选择' : `第 ${offset + 1} 题`}</p>
        <legend style={{ fontSize: 30, fontWeight: 700, color: '#101a30', paddingTop: 20 }}>{question.question}</legend>
        {question.image && <img src={question.image.src} alt="题目图片" style={{ maxWidth: '100%', maxHeight: 260, objectFit: 'contain' }} />}
        <p style={{ color: '#8c9fb9' }}>{question.type === 'multiple' ? '请选择所有合适的答案' : question.type === 'short_answer' ? '请填写你的回答' : '请选择最合适的答案'}</p>
        {question.type === 'short_answer' ? <textarea aria-label="回答" value={texts[question.id] ?? ''}
          onChange={event => { setTexts(previous => ({ ...previous, [question.id]: event.target.value })); setChecked(false); }} />
          : <div style={{ display: 'flex', flexWrap: 'wrap', gap: 24, padding: '24px 0' }}>{question.options?.map(option => {
            const selected = (answers[question.id] ?? []).includes(option.value);
            return <button type="button" key={option.value} aria-pressed={selected} onClick={() => change(question, option.value)}
              style={{ display: 'grid', gap: 16, textAlign: 'left', padding: 24, minWidth: 160, maxWidth: 280,
                borderRadius: 28, border: selected ? '2px solid #387cfa' : '2px solid transparent', background: '#fff', boxShadow: '0 10px 35px #14213d0b' }}>
              {option.image && <img src={option.image.src} alt={option.label || option.value} style={{ width: '100%', height: 160, objectFit: 'contain', borderRadius: 20 }} />}
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 12 }}><strong style={{ borderRadius: 50, background: '#387cfa', color: 'white', padding: '12px 18px' }}>{option.value}</strong>{option.label}</span>
            </button>;
          })}</div>}
        {checked && <div role="status" aria-live="polite">
          {scoreMaicQuiz(question, answers[question.id] ?? []) === null ? '本题需要教师或在线评价，当前尚未评分。'
            : scoreMaicQuiz(question, answers[question.id] ?? []) ? content.playbackConfig?.successSpeechText || '回答正确！非常棒！'
              : content.playbackConfig?.failureSpeechText || '很遗憾，你选错了，再试一次吧！'}
          {(!instant || correct) && question.analysis && <p>{question.analysis}</p>}
        </div>}
      </fieldset>)}
      {!questions.length && <p>本页尚未添加题目。</p>}
      <button type="button" disabled={disabled || !questions.length || questions.some(q => q.type === 'short_answer' ? !texts[q.id]?.trim() : !answers[q.id]?.length)}
        onClick={() => setChecked(true)}>{instant ? '检查答案' : '提交答案'}</button>
      {checked && (!instant || mayComplete) && <button type="button" disabled={disabled} onClick={() => {
        if (instant && index < content.questions.length - 1) { setIndex(index + 1); setChecked(false); }
        else onComplete?.();
      }}>{instant && index < content.questions.length - 1 ? '下一题' : '完成测验'}</button>}
    </div>
  </section>;
}
