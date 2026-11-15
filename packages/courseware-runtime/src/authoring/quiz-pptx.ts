import type { MaicClassroom } from '../maic-classroom';
import { editablePptxSceneSchema } from './kindergarten/image2-pptist/contracts';

/** A fixed learner-facing projection; answers and grading prompts stay in canonical Quiz data. */
export function quizPptxScene(scene: MaicClassroom['scenes'][number], sourceHash: string,
  canvas: { width: number; height: number }, backgroundId: string) {
  if (scene.content.type !== 'quiz') throw new Error('Expected Quiz content');
  if (scene.content.questions.length !== 1) throw new Error('Each Quiz slide requires exactly one question');
  type Element = ReturnType<typeof editablePptxSceneSchema.parse>['elements'][number];
  const elements: Element[] = [], sx = canvas.width / 1000, sy = canvas.height / 562.5;
  const box = (x: number, y: number, w: number, h: number): [number, number, number, number] => [x * sx, y * sy, w * sx, h * sy];
  const base = (id: string, bboxPx: [number, number, number, number]) => ({ id: `${scene.id}_${id}`, bboxPx, zIndex: elements.length + 1, spokenAliases: [] });
  const text = (id: string, content: string, x: number, y: number, w: number, h: number, size = 24, color = '#111827', bold = false) => {
    if (content.trim()) elements.push({ ...base(id, box(x, y, w, h)), type: 'native_text', content,
      style: { fontFace: 'Noto Sans SC', fontSizePt: size * sx * .72, color, fontWeight: bold ? 700 : 400, align: 'left', lineHeight: 1.2 } });
  };
  const card = (id: string, x: number, y: number, w: number, h: number) => elements.push({ ...base(id, box(x, y, w, h)), type: 'native_shape', shape: 'rounded_rectangle', fill: '#F6F8FC' });
  const image = (id: string, src: string | undefined, x: number, y: number, w: number, h: number) => {
    if (src) elements.push({ ...base(id, box(x, y, w, h)), type: 'image_layer', assetId: src, layerRoute: 'A1' });
  };
  const english = /[a-z]/iu.test(scene.content.questions[0].question) && !/[\u4e00-\u9fff]/u.test(scene.content.questions[0].question);
  text('title', `Quiz · ${scene.title}`, 38, 20, 924, 30, 18, '#387CF6', true);
  const questions = scene.content.questions, rowHeight = 474;
  questions.forEach((q, index) => {
    const top = 65;
    const questionHeight = 94;
    const font = 32;
    text(`q${index}_question`, q.question, 38, top, q.image ? 700 : 924, questionHeight, font, '#111827', true);
    image(`q${index}_image`, q.image?.src, 780, top, 180, questionHeight);
    const spacing = Math.min(10, rowHeight * .06);
    const optionTop = top + questionHeight + spacing, optionHeight = rowHeight - questionHeight - spacing * 2;
    if (q.type === 'short_answer') {
      card(`q${index}_answer_area`, 38, optionTop, 924, optionHeight);
      text(`q${index}_answer_hint`, english ? 'Think, then answer.' : '请思考后回答', 60, optionTop + optionHeight * .1, 870, Math.min(40, optionHeight * .8), Math.min(20, optionHeight * .3), '#8C9DB8');
      return;
    }
    const options = q.options ?? [], count = Math.max(1, options.length), gap = 16, width = (924 - gap * (count - 1)) / count;
    options.forEach((option, optionIndex) => {
      const left = 38 + optionIndex * (width + gap), imageHeight = option.image ? optionHeight * .66 : 0;
      card(`q${index}_option${optionIndex}_card`, left, optionTop, width, optionHeight);
      image(`q${index}_option${optionIndex}_image`, option.image?.src, left + 12, optionTop + optionHeight * .04, width - 24, Math.max(.1, imageHeight - optionHeight * .08));
      text(`q${index}_option${optionIndex}_label`, `${option.value}  ${option.label}`, left + 14, optionTop + imageHeight + optionHeight * .04,
        width - 28, Math.max(.1, optionHeight - imageHeight - optionHeight * .08), Math.min(26, optionHeight * .28), '#1E3A5F', true);
    });
  });
  text('hint', english ? 'Choose the best answer.' : '请选择最合适的答案', 38, 537, 924, 20, 14, '#8C9DB8');
  return editablePptxSceneSchema.parse({ version: 1, slideId: scene.id, sourceHash, canvas,
    visualMasterAssetId: backgroundId, cleanPlateAssetId: backgroundId, elements });
}
