import { expect, it } from 'vitest';
import { quizPptxScene } from '../quiz-pptx';
import { parseMaicClassroom } from '../../maic-classroom';

it('uses a short-answer instruction in the actual learner projection', () => {
  const classroom = parseMaicClassroom({ id: 'p', createdAt: '2026-01-01T00:00:00.000Z',
    stage: { id: 'p', name: 'Lesson', createdAt: 0, updatedAt: 0 },
    scenes: [{ id: 'q', stageId: 'p', order: 0, title: '练习', type: 'quiz', actions: [],
      content: { type: 'quiz', questions: [{ id: 'q1', type: 'short_answer', question: '表达什么感情？', options: [], answer: ['思乡'] }] } }] });
  const scene = quizPptxScene(classroom.scenes[0], 'sha256:' + 'a'.repeat(64), { width: 1000, height: 562.5 }, 'bg');
  expect(scene.elements.find(e => e.id === 'q_hint')).toMatchObject({ content: '请写出你的答案' });
});
