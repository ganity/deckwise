import type { MaicClassroom } from './maic-classroom';

type Canvas = Extract<MaicClassroom['scenes'][number]['content'], { type: 'slide' }>['canvas'];
const escape = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

/** MAIC build-interaction-scene's classroom template, scaled to the course canvas. */
export function createMaicInteractionCanvas(id: string, title: string, question: string,
  width = 1000, ratio = 0.5625): Canvas {
  const sx = width / 1000, sy = width * ratio / 562.5;
  const text = (suffix: string, value: string, top: number, height: number, size: number, color: string, bold = false) => ({
    id: `${id}_${suffix}`, type: 'text' as const, left: 136 * sx, top: top * sy,
    width: 728 * sx, height: height * sy, rotate: 0,
    content: `<p><span style="font-size: ${size * sx}px;${bold ? ' font-weight: 800;' : ''} color: ${color};">${escape(value)}</span></p>`,
    defaultFontName: 'Noto Sans SC', defaultColor: color, lineHeight: suffix === 'question' ? 1.45 : 1.3,
  });
  return { id: `${id}_canvas`, viewportSize: width, viewportRatio: ratio,
    theme: { backgroundColor: '#FFFFFF', themeColors: ['#3B82F6'], fontColor: '#1F2A44', fontName: 'Noto Sans SC' },
    background: { type: 'solid', color: '#FFFFFF' }, elements: [
      { id: `${id}_panel`, type: 'shape', left: 88 * sx, top: 72 * sy, width: 824 * sx, height: 384 * sy,
        rotate: 0, viewBox: [824, 384], path: 'M 28 0 L 796 0 Q 824 0 824 28 L 824 356 Q 824 384 796 384 L 28 384 Q 0 384 0 356 L 0 28 Q 0 0 28 0 Z',
        fixedRatio: false, fill: '#F6F8FC', opacity: 1 },
      text('chapter_title', title, 114, 54, 28, '#1F2A44', true),
      text('section_label', '课堂互动问答', 180, 32, 18, '#5B6B8C'),
      text('question', question, 240, 104, 24, '#111827'),
      text('hint', '请思考后回答，课堂互动结束后将继续播放。', 382, 28, 18, '#6B7280'),
    ] };
}
