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
