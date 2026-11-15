import { describe, expect, it } from 'vitest';
import { prepareMaicAssessmentSpeech } from './maic-assessment-speech';
import { parseMaicClassroom } from './maic-classroom';
import { createMaicInteractionCanvas } from './maic-interaction-canvas';

function fixture() {
  return parseMaicClassroom({ id: 'course', createdAt: '2026-11-06', stage: { id: 'stage', name: 'Lesson', createdAt: 1, updatedAt: 1 }, scenes: [
    { id: 'quiz', stageId: 'stage', type: 'quiz', title: 'Quiz', order: 0, content: { type: 'quiz', questions: [
      { id: 'q', type: 'single', question: 'Which one?', options: [{ value: 'A', label: 'Cat' }, { value: 'B', label: 'Dog' }], answer: ['A'] },
    ] }, actions: [{ id: 'review', type: 'speech', text: 'Answer explanation.' }] },
    { id: 'slide', stageId: 'stage', type: 'slide', title: 'Discussion', order: 1,
      content: { type: 'slide', canvas: createMaicInteractionCanvas('slide', 'Discussion', 'Say hello') }, actions: [
        { id: 'body', type: 'speech', text: 'Keep existing narration.' },
        { id: 'cp', type: 'interaction_checkpoint', checkpointKind: 'chapter_summary', checkpointId: 'cp', chapterId: 'chapter', chapterTitle: 'Greetings',
          question: 'Say hello', referenceAnswer: { summary: 'Hello', keyPoints: ['Greeting'] }, context: { chapterSummary: 'Greetings', sourceSceneIds: ['slide'] } },
      ] },
  ] });
}

describe('common assessment speech preparation', () => {
  it('creates Quiz question/options before explanation and checkpoint speech before the wait, idempotently', () => {
    const original = fixture(), prepared = prepareMaicAssessmentSpeech(original);
    expect(prepared.scenes[0].actions?.map(a => a.type === 'speech' ? a.text : a.type)).toEqual(['Which one?\nA. Cat\nB. Dog', 'Answer explanation.']);
    expect(prepared.scenes[1].actions?.map(a => a.type === 'speech' ? a.text : a.type)).toEqual(['Keep existing narration.', 'Say hello', 'interaction_checkpoint']);
    expect(prepareMaicAssessmentSpeech(prepared)).toEqual(prepared);
    expect(original.scenes[1].actions).toHaveLength(2);
    expect(parseMaicClassroom(prepared)).toEqual(prepared);
  });

  it('invalidates only question audio when spoken question/option text changes, preserving image-only edits', () => {
    const prepared = prepareMaicAssessmentSpeech(fixture());
    const speech = prepared.scenes[0].actions?.[0];
    if (speech?.type !== 'speech' || prepared.scenes[0].content.type !== 'quiz') throw Error('Fixture');
    speech.audioId = 'audio'; speech.audioUrl = 'assets/voice.wav';
    prepared.audioManifest = [{ sceneId: 'quiz', actionId: speech.id, assetId: 'audio', audioId: 'audio', mimeType: 'audio/wav', url: 'assets/voice.wav', originalUrl: 'assets/voice.wav' }];
    prepared.scenes[0].content.questions[0].options![0].image = { src: 'assets/cat.png' };
    expect(prepareMaicAssessmentSpeech(prepared).audioManifest).toHaveLength(1);
    prepared.scenes[0].content.questions[0].options![0].label = 'Tiger';
    const changed = prepareMaicAssessmentSpeech(prepared);
    expect(changed.scenes[0].actions?.[0]).not.toHaveProperty('audioUrl');
    expect(changed.audioManifest).toEqual([]);
    expect(changed.scenes[0].actions?.[1]).toEqual(prepared.scenes[0].actions?.[1]);
  });

  it('reuses exact question speech and retains its archived audio instead of duplicating it', () => {
    const original = fixture();
    original.scenes[1].actions!.splice(1, 0, { id: 'old-question-voice', type: 'speech', text: 'Say hello', audioId: 'voice', audioUrl: 'assets/voice.wav' });
    const prepared = prepareMaicAssessmentSpeech(original);
    expect(prepared.scenes[1].actions).toHaveLength(3);
    expect(prepared.scenes[1].metadata?.assessmentSpeechIds).toEqual({ cp: 'old-question-voice' });
    expect(prepared.scenes[1].actions?.[1]).toHaveProperty('audioUrl', 'assets/voice.wav');
  });

  it('removes the managed voice when its checkpoint is deleted, keeping body narration', () => {
    const prepared = prepareMaicAssessmentSpeech(fixture()), scene = prepared.scenes[1];
    scene.actions = scene.actions?.filter(action => action.id !== 'cp');
    const saved = prepareMaicAssessmentSpeech(prepared);
    expect(saved.scenes[1].actions?.map(action => action.id)).toEqual(['body']);
    expect(saved.scenes[1].metadata?.assessmentSpeechIds).toEqual({});
  });

  it('reads repeated questions at each checkpoint instead of sharing one earlier speech action', () => {
    const original = fixture(), scene = original.scenes[1], checkpoint = structuredClone(scene.actions![1]);
    if (checkpoint.type !== 'interaction_checkpoint' || checkpoint.checkpointKind !== 'chapter_summary') throw Error('Fixture');
    checkpoint.id = 'repeat'; checkpoint.checkpointId = 'repeat';
    scene.actions!.splice(1, 0, {id:'legacy-question',type:'speech',text:'Say hello'});
    scene.actions!.push(checkpoint);
    const prepared = prepareMaicAssessmentSpeech(original).scenes[1];
    expect(prepared.actions?.map(action => action.id)).toEqual(['body','legacy-question','cp','repeat-question-tts','repeat']);
    expect(prepareMaicAssessmentSpeech({...original,scenes:[prepared]}).scenes[0]).toEqual(prepared);
  });

  it('updates every checkpoint and removes obsolete question audio when its question is cleared', () => {
    const original = fixture(), second = structuredClone(original.scenes[1].actions![1]);
    if (second.type !== 'interaction_checkpoint' || second.checkpointKind !== 'chapter_summary') throw Error('Fixture');
    second.id = 'second'; second.checkpointId = 'second'; second.question = 'Say goodbye';
    original.scenes[1].actions!.push(second);
    const prepared = prepareMaicAssessmentSpeech(original);
    expect(prepared.scenes[1].actions?.map(a => a.type === 'speech' ? a.text : a.type)).toEqual([
      'Keep existing narration.', 'Say hello', 'interaction_checkpoint', 'Say goodbye', 'interaction_checkpoint',
    ]);
    const checkpoint = prepared.scenes[1].actions!.find(a => a.id === 'cp');
    if (checkpoint?.type !== 'interaction_checkpoint' || checkpoint.checkpointKind !== 'chapter_summary') throw Error('Fixture');
    checkpoint.question = '';
    expect(prepareMaicAssessmentSpeech(prepared).scenes[1].actions?.some(a => a.id === 'cp-question-tts')).toBe(false);
    expect(prepareMaicAssessmentSpeech(original, false)).toEqual(original);
  });
});
