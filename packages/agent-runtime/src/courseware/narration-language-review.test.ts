import { expect, it } from 'vitest';
import { findTeacherNarrationIssues } from './narration-language-review.js';

it('identifies teacher directions and narrated design notes without changing the words', () => {
  const text = '教师应该引导学生观察 father。设计意图是认识 family。';
  expect(findTeacherNarrationIssues(text)).toHaveLength(2);
  expect(text).toBe('教师应该引导学生观察 father。设计意图是认识 family。');
  expect(findTeacherNarrationIssues('The teacher should guide students to read.')).toHaveLength(1);
});

it('allows ordinary direct teaching and avoids broad objective/stage/teacher-word matches', () => {
  for (const text of ['同学们，请看 father，跟我读：father。', '老师会和你们一起读。',
    '今天的学习目标是比较这两个数。', '我们进入应用实践环节。', 'Please read with me: father.']) {
    expect(findTeacherNarrationIssues(text)).toEqual([]);
  }
});

it('reports a rule once even when several sentences match and remains stable on repeated calls', () => {
  const text = '教师需要示范。教师应该引导学生朗读。';
  expect(findTeacherNarrationIssues(text)).toHaveLength(1);
  expect(findTeacherNarrationIssues(text)).toEqual(findTeacherNarrationIssues(text));
});
