import { expect, it } from 'vitest';
import { SaxesParser } from 'saxes';
import { parseMaicClassroom } from '../maic-classroom';
import { createMaicInteractionCanvas } from '../maic-interaction-canvas';
import { assessmentSvg } from './assessment-svg';

it('keeps mixed-language questions intact across editable SVG lines without revealing grading text', () => {
  const question = '举起你的相册，指着一位家人说 This is my family! 再用英文介绍这位家人的称呼，和旁边的小朋友分享。 & < > "';
  const scene = parseMaicClassroom({ id: 'lesson', createdAt: '2026-11-08',
    stage: { id: 'stage', name: 'Lesson', createdAt: 0, updatedAt: 0 }, scenes: [{
      id: 'interaction', stageId: 'stage', title: 'Family', type: 'slide', order: 0,
      content: { type: 'slide', canvas: createMaicInteractionCanvas('interaction', 'Family', question) },
      actions: [{ id: 'checkpoint', type: 'interaction_checkpoint', checkpointId: 'checkpoint',
        checkpointKind: 'chapter_summary', chapterId: 'family', chapterTitle: 'Family', question,
        referenceAnswer: { summary: 'SECRET ANSWER', keyPoints: ['SECRET KEY'] }, constraintPrompt: 'SECRET RULE',
        context: { chapterSummary: 'Family', sourceSceneIds: ['interaction'] } }],
    }] }).scenes[0];
  const svg = assessmentSvg(scene, { width: 1000, height: 562.5 });
  let inQuestion = false, text = '', lines = 0;
  const parser = new SaxesParser({ xmlns: false });
  parser.on('opentag', tag => {
    if (tag.name === 'text' && tag.attributes.id === 'interaction_question') inQuestion = true;
    if (inQuestion && tag.name === 'tspan') lines++;
  });
  parser.on('text', value => { if (inQuestion) text += value; });
  parser.on('closetag', tag => { if (tag.name === 'text') inQuestion = false; });
  parser.write(svg).close();
  expect(text).toBe(question);
  expect(lines).toBeGreaterThan(1);
  expect(svg).not.toContain('SECRET');
  expect(svg).not.toMatch(/<image|<animate|<script/);
  const checkpoint = scene.actions![0];
  if (checkpoint.type !== 'interaction_checkpoint' || checkpoint.checkpointKind !== 'chapter_summary') throw Error('Fixture');
  const tooLong = '家'.repeat(2000);
  checkpoint.question = tooLong;
  if (scene.content.type !== 'slide') throw Error('Fixture');
  scene.content.canvas = createMaicInteractionCanvas('interaction', 'Family', tooLong);
  expect(() => assessmentSvg(scene, { width: 1000, height: 562.5 })).toThrow(/exceeds its fixed layout/);
});
