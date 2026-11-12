import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { assessmentBackground, assessmentPptxScene, syncClassroomPptx } from '../classroom-pptx';
import { compileScenesToPptx } from '../kindergarten/scene-to-pptx';
import { createMaicInteractionCanvas } from '../../maic-interaction-canvas';
import { parseMaicClassroom, type MaicClassroom } from '../../maic-classroom';
import { pptxPackage } from '../page-pptx-candidate';
import { importPptxFromBuffer } from '../../conversion/lib/import/pptx/import-pptx-from-buffer';

function fixture(): MaicClassroom {
  return parseMaicClassroom({ id: 'course', stage: { id: 'stage', name: 'Lesson', createdAt: 1, updatedAt: 1 }, createdAt: new Date(0).toISOString(), scenes: [
    { id: 'interaction', stageId: 'stage', title: 'Discussion', type: 'slide', order: 0,
      metadata: { nativePageId: 'page-1' }, content: { type: 'slide', canvas: createMaicInteractionCanvas('interaction', 'Discussion', 'Old question') },
      actions: [{ id: 'checkpoint', type: 'interaction_checkpoint', checkpointKind: 'chapter_summary', checkpointId: 'checkpoint', chapterId: 'chapter', chapterTitle: 'Discussion', question: 'Old question', referenceAnswer: { summary: 'Reference', keyPoints: [] }, context: { chapterSummary: 'Lesson', sourceSceneIds: [] } }] },
    { id: 'quiz', stageId: 'stage', title: 'Quiz', type: 'quiz', order: 1, metadata: { nativePageId: 'page-2' },
      content: { type: 'quiz', questions: [{ id: 'question', type: 'single', question: 'Choose', options: [{ value: 'A', label: 'Hello' }, { value: 'B', label: 'Bye' }], answer: ['A'] }] }, actions: [] },
  ] });
}
async function compile(previous: MaicClassroom) {
  return compileScenesToPptx(previous.scenes.map(scene => assessmentPptxScene(scene, 'sha256:test', { width: 1000, height: 562.5 })), { [assessmentBackground.id]: assessmentBackground.bytes });
}
const pages = [{ pageId: 'page-1' }, { pageId: 'page-2' }];

describe('canonical classroom native pages', () => {
  it('uses English hints for English questions and retains Chinese hints for Chinese questions', () => {
    const scene = fixture().scenes[1];
    const english = assessmentPptxScene(scene, 'sha256:test', { width: 1000, height: 562.5 });
    expect(JSON.stringify(english.elements)).toContain('Choose the best answer.');
    expect(JSON.stringify(english.elements)).not.toMatch(/[\u4e00-\u9fff]/u);
    if (scene.content.type !== 'quiz') throw Error('fixture');
    scene.content.questions[0].question = '请选择圆形';
    expect(JSON.stringify(assessmentPptxScene(scene, 'sha256:test', { width: 1000, height: 562.5 }).elements)).toContain('请选择最合适的答案');
  });
  it('keeps the English interaction template English including nested projected text', () => {
    const canvas = createMaicInteractionCanvas('oral', 'Round objects', 'Name a round object around you.');
    expect(JSON.stringify(canvas)).not.toMatch(/[\u4e00-\u9fff]/u);
    expect(JSON.stringify(canvas)).toContain('Classroom discussion');
    expect(JSON.stringify(createMaicInteractionCanvas('oral', '圆形', '请说一个圆形物品'))).toContain('课堂互动问答');
  });
  it('projects encoded checkpoint canvas text as readable native text', () => {
    const scene = fixture().scenes[0];
    if (scene.content.type !== 'slide') throw new Error('fixture');
    const question = scene.content.canvas.elements.find(element => element.id === 'interaction_question');
    if (question?.type !== 'text') throw new Error('fixture');
    question.content = '<p>This&#160;is&#xA0;my&nbsp;family! &lt;name&gt;</p>';
    const projected = assessmentPptxScene(scene, 'sha256:test', {width:1000, height:562.5});
    expect(projected.elements.find(element => element.id === question.id)).toMatchObject({content:'This is my family! <name>'});
  });
  it('keeps multiline Quiz and checkpoint text bound to one imported object each', async () => {
    const classroom = fixture();
    const quiz = classroom.scenes[1].content;
    if (quiz.type !== 'quiz') throw new Error('fixture');
    classroom.scenes[0].content = { type: 'slide', canvas: createMaicInteractionCanvas('interaction', 'Discussion', 'First line\n第二行') };
    const result = await compile(classroom);
    const ir = await importPptxFromBuffer({ arrayBuffer: Uint8Array.from(result.pptx).buffer, fileName: 'lesson.pptx' });
    expect(ir.pages).toHaveLength(2);
    for (const [index, page] of ir.pages.entries()) {
      const elements = result.mapping.pages[index].elements;
      expect(page.elements).toHaveLength(elements.length);
      for (const element of elements) {
        const imported = page.elements.filter(item => item.sourceShapeId === element.sourceShapeId);
        expect(imported).toHaveLength(1);
        expect(imported[0].type).toBe(element.type === 'native_text' ? 'text' : 'shape');
      }
    }
    expect(JSON.stringify(ir.pages[1])).toContain('Choose');
    expect(JSON.stringify(ir.pages[0])).toContain('第二行');
  });

  it('rejects multiple questions on a physical Quiz slide even in review mode', async () => {
    const classroom = fixture(), quiz = classroom.scenes[1].content;
    if (quiz.type !== 'quiz') throw new Error('fixture');
    quiz.interactionMode = 'assessment_review';
    quiz.questions.push({ ...quiz.questions[0], id: 'second' });
    await expect(compile(classroom)).rejects.toThrow('exactly one question');
  });

  it('writes only the bound question, preserving all formatting and geometry; reimports actual PPTX', async () => {
    const previous = fixture(), source = await compile(previous), next = structuredClone(previous);
    const checkpoint = next.scenes[0].actions![0];
    if (checkpoint.type !== 'interaction_checkpoint' || checkpoint.checkpointKind !== 'chapter_summary') throw new Error('fixture');
    checkpoint.question = 'New <question> & answer\n第二行';
    const result = await syncClassroomPptx({ previous, classroom: next, source: source.pptx, sourceHash: 'sha256:test', pages });
    const before = (await JSZip.loadAsync(source.pptx)).file('ppt/slides/slide1.xml')!;
    const zip = await JSZip.loadAsync(result.pptx), parts = (await pptxPackage.presentationSlides(zip)).slideParts;
    const after = await zip.file(parts[0])!.async('string');
    expect(after.replace('New &lt;question&gt; &amp; answer\n第二行', 'Old question')).toBe(await before.async('string'));
    expect(await zip.file(parts[1])!.async('string')).toBe(await (await JSZip.loadAsync(source.pptx)).file('ppt/slides/slide2.xml')!.async('string'));
    const ir = await importPptxFromBuffer({ arrayBuffer: Uint8Array.from(result.pptx).buffer, fileName: 'lesson.pptx' });
    expect(ir.pages).toHaveLength(2);
    expect(JSON.stringify(ir.pages[0])).toContain('第二行');
    expect(next.scenes[1].content).not.toHaveProperty('canvas');
  });

  it('copies, reorders, adds and deletes independent pages without changing existing objects', async () => {
    const previous = fixture(), source = await compile(previous), next = structuredClone(previous);
    const copy = structuredClone(next.scenes[0]); copy.id = 'copy'; copy.metadata = { copiedFromNativePageId: 'page-1', nativeQuestionElementId: 'interaction_question' };
    const added = structuredClone(next.scenes[1]); added.id = 'new-quiz'; added.metadata = {};
    next.scenes = [next.scenes[1], copy, next.scenes[0], added];
    const result = await syncClassroomPptx({ previous, classroom: next, source: source.pptx, sourceHash: 'sha256:test', pages });
    const zip = await JSZip.loadAsync(result.pptx), parts = (await pptxPackage.presentationSlides(zip)).slideParts;
    expect(new Set(parts).size).toBe(4);
    expect(await zip.file(parts[1])!.async('string')).toBe(await zip.file(parts[2])!.async('string'));
    const ir = await importPptxFromBuffer({ arrayBuffer: Uint8Array.from(result.pptx).buffer, fileName: 'lesson.pptx' });
    expect(ir.pages).toHaveLength(4);
    expect(result.pages.map(page => page.sourcePageId)).toEqual(['page-2', 'page-1', 'page-1', undefined]);
    const removed = structuredClone(previous); removed.scenes = [removed.scenes[1]];
    removed.scenes[0].title = 'Renamed Quiz';
    const deleted = await syncClassroomPptx({ previous, classroom: removed, source: source.pptx, sourceHash: 'sha256:test', pages });
    const imported = await importPptxFromBuffer({ arrayBuffer: Uint8Array.from(deleted.pptx).buffer, fileName: 'lesson.pptx' });
    expect(imported.pages).toHaveLength(1);
    expect(JSON.stringify(imported.pages[0])).toContain('Renamed');
    expect(await (await JSZip.loadAsync(deleted.pptx)).file('ppt/slides/slide1.xml')!.async('string')).toContain('Renamed Quiz');
  });

  it('projects options and images after option-only edits, with no answers or prompts on the learner page', async () => {
    const previous = fixture(), source = await compile(previous), next = structuredClone(previous);
    const before = await importPptxFromBuffer({ arrayBuffer: Uint8Array.from(source.pptx).buffer, fileName: 'quiz.pptx' });
    const content = next.scenes[1].content;
    if (content.type !== 'quiz') throw new Error('fixture');
    content.questions[0].options![0].label = 'Updated option';
    content.questions[0].options![1].image = { src: '.deckwise-ppt/quiz.png', mimeType: 'image/png' };
    content.questions[0].analysis = 'SECRET explanation';
    const reads: string[] = [];
    const result = await syncClassroomPptx({ previous, classroom: next, source: source.pptx, sourceHash: 'sha256:test', pages,
      readImage: async src => { reads.push(src); return assessmentBackground.bytes; } });
    expect(reads).toEqual(['.deckwise-ppt/quiz.png']);
    const zip = await JSZip.loadAsync(result.pptx), xml = await zip.file('ppt/slides/slide2.xml')!.async('string');
    expect(xml).toContain('Updated option'); expect(xml).toContain('<p:pic>'); expect(xml).not.toContain('SECRET');
    expect(await zip.file('ppt/slides/slide1.xml')!.async('string')).toBe(await (await JSZip.loadAsync(source.pptx)).file('ppt/slides/slide1.xml')!.async('string'));
    const ir = await importPptxFromBuffer({ arrayBuffer: Uint8Array.from(result.pptx).buffer, fileName: 'quiz.pptx' });
    expect(ir.pages[0].elements.map(element => [element.sourceShapeId, element.type, element.sourceObjectName]))
      .toEqual(before.pages[0].elements.map(element => [element.sourceShapeId, element.type, element.sourceObjectName]));
    expect(ir.pages[1].elements.some(element => element.type === 'image')).toBe(true);
    expect(content).not.toHaveProperty('canvas');
    await expect(syncClassroomPptx({ previous, classroom: next, source: source.pptx, sourceHash: 'sha256:test', pages })).rejects.toThrow('image resolver');
  });
});
