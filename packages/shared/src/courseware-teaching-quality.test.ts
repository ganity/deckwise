import { expect, it } from 'vitest';
import fixture from './courseware-contract.fixtures/accepted.json';
import { isCoursewareProject, type CoursewareProject } from './courseware-contract.js';
import { inspectCoursewareTeaching } from './courseware-teaching-quality.js';
import { isCoursewareQuestionResponse } from './courseware-question.js';
import { isCoursewareSceneTeaching, type CoursewareSceneTeaching } from './courseware-scene-teaching.js';

it.each(['single', 'multiple', 'judge', 'short_answer', 'discussion', 'practice', 'pbl'])(
  'accepts bounded %s activities and rejects forged options and answers', kind => {
    const choice = ['single', 'multiple', 'judge'].includes(kind);
    const response = { kind, options: choice ? ['Hello', 'Bye'] : [], answerIndices: choice ? [0] : [] };
    expect(isCoursewareQuestionResponse(response)).toBe(true);
    for (const patch of [{ answerIndices: [9] }, { options: ['same', 'same'] }, { kind: 'unknown' }, { graded: true }, { answerIndices: null }])
      expect(isCoursewareQuestionResponse({ ...response, ...patch })).toBe(false);
    expect(isCoursewareSceneTeaching({ pageType: kind === 'pbl' ? 'pbl' : choice ? 'quiz' : 'interactive', phase: 'practice',
      objective: 'Practice greeting', durationSeconds: 30, requiredObjects: ['Monkey'], question: { text: 'Say hello', response } })).toBe(true);
  },
);
it('reports page-bound quality gaps after reorder, respects locks and never blocks a saved artifact', () => {
  if (!isCoursewareProject(fixture.project)) throw new Error('Invalid fixture');
  const project: CoursewareProject = structuredClone(fixture.project);
  const first = project.pages[0];
  first.actions = [{ id: 'speech', type: 'speech', text: 'Monkey says hello', visualCues: [] },
    { id: 'song', type: 'music_slot', title: 'Hello song', prompt: 'A greeting song' }];
  first.locked = true;
  const teaching: CoursewareSceneTeaching = { pageType: 'quiz', phase: 'practice', objective: 'Say hello', durationSeconds: 30,
    requiredObjects: ['Monkey'], question: { text: 'Which greeting?', response: { kind: 'single', options: ['Hello', 'Bye'], answerIndices: [0] } } };
  project.pages.reverse();
  const report = inspectCoursewareTeaching(project, new Map([[first.pageId, teaching]]));
  expect(report.blocking).toBe(false);
  expect(report.issues.filter(i => i.pageId === first.pageId).map(i => i.code)).toEqual(['AUDIO_MISSING', 'FOCUS_MISSING', 'QUESTION_MISSING', 'MUSIC_PENDING']);
  expect(report.issues.filter(i => i.pageId === first.pageId).every(i => i.pageNumber === project.pages.indexOf(first) + 1 && !i.repairable)).toBe(true);
});


it('counts repeated diagnostics from saved actions rather than estimated report totals', () => {
  if (!isCoursewareProject(fixture.project)) throw new Error('Invalid fixture');
  const project: CoursewareProject = structuredClone(fixture.project);
  project.pages[0].actions = Array.from({ length: 20 }, (_, i) => ({ id: `speech-${i}`, type: 'speech', text: 'Monkey says hello', audioAssetId: 'tts-existing' }));
  project.pages.slice(1).forEach(page => { page.actions = [{ id: 'ready', type: 'speech', text: 'Ready', audioAssetId: 'tts-existing' }]; });
  const report = inspectCoursewareTeaching(project, new Map([[project.pages[0].pageId,
    { pageType: 'slide', phase: 'opening', objective: 'Greet', durationSeconds: 30, requiredObjects: ['Monkey'] }]]));
  expect(report.counts).toEqual({ FOCUS_MISSING: 20 });
});

it('reports seeded outline speech as missing detailed narration, matching the TTS admission rule', () => {
  if (!isCoursewareProject(fixture.project)) throw new Error('Invalid fixture');
  const project = structuredClone(fixture.project);
  project.taskType = 'scene';
  project.pages[0].actions = [{ id: 'narration-0', type: 'speech', text: 'Already split planning speech.' }];
  expect(inspectCoursewareTeaching(project).issues).toContainEqual(expect.objectContaining({ pageId: project.pages[0].pageId, code: 'NARRATION_MISSING' }));
  expect(inspectCoursewareTeaching(project, undefined, new Set(), true).issues.filter(issue => issue.pageId === project.pages[0].pageId && issue.code === 'NARRATION_MISSING')).toEqual([]);
  project.pages[0].actions[0].source = 'generated';
  expect(inspectCoursewareTeaching(project).issues.filter(issue => issue.pageId === project.pages[0].pageId && issue.code === 'NARRATION_MISSING')).toEqual([]);
});

it('keeps adopted ordinary outlines incomplete and checks requested effects before and after audio timing', () => {
  if (!isCoursewareProject(fixture.project)) throw new Error('Invalid fixture');
  const project: CoursewareProject = structuredClone(fixture.project);
  project.taskType = 'plain';
  const page = project.pages[0];
  const teaching: CoursewareSceneTeaching = { pageType: 'slide', phase: 'explore', objective: 'Name family',
    durationSeconds: 30, requiredObjects: [], requiredEffects: ['highlight', 'animation'] };
  const requirements = new Map([[page.pageId, teaching]]);
  page.actions = [{ id: 'narration-0', type: 'speech', text: 'father' }];
  expect(inspectCoursewareTeaching(project, requirements).issues.filter(i => i.pageId === page.pageId).map(i => i.code))
    .toEqual(['NARRATION_MISSING', 'EFFECT_MISSING', 'EFFECT_MISSING', 'AUDIO_MISSING']);
  page.actions = [{ id: 'speech', type: 'speech', text: 'father', attention: { type: 'highlight', objectIds: ['label'], animation: 'pulse' } }];
  expect(inspectCoursewareTeaching(project, requirements).issues.filter(i => i.pageId === page.pageId).map(i => i.code)).toEqual(['AUDIO_MISSING']);
  page.actions = [{ id: 'speech', type: 'speech', text: 'father', audioAssetId: 'audio', visualCues: [
    { effect: { type: 'highlight' } }, { effect: { type: 'element_animation' } },
  ] }];
  expect(inspectCoursewareTeaching(project, requirements).issues.filter(i => i.pageId === page.pageId)).toEqual([]);
});
