import { createCanvas } from '@napi-rs/canvas';
import type { MaicClassroom } from '../maic-classroom';
import { assessmentPptxScene } from './classroom-pptx';

const escape = (text: string) => text.replace(/[&<>"']/gu, value => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[value]!);

/** The same fixed assessment projection used by scene compilation, before media generation. */
export function assessmentSvg(scene: MaicClassroom['scenes'][number], canvas: { width: number; height: number }) {
  const projected = assessmentPptxScene(scene, 'sha256:assessment-preview', canvas);
  const context = createCanvas(1, 1).getContext('2d');
  const elements = projected.elements.map(element => {
    const [x, y, width, height] = element.bboxPx;
    const id = escape(element.id);
    if (element.type === 'native_shape')
      return `<rect id="${id}" x="${x}" y="${y}" width="${width}" height="${height}" rx="${Math.min(28, height / 4)}" fill="${escape(element.fill ?? '#F6F8FC')}"/>`;
    if (element.type !== 'native_text') throw new Error('Assessment SVG requires text/shape content; generate option images through shared media tools');
    const style = element.style;
    const font = style.fontFace;
    let size = style.fontSizePt / .72;
    let lines: string[] = [];
    const minimum = Math.min(size, 12 * canvas.width / 1000);
    for (;;) {
      context.font = `${style.fontWeight ?? 400} ${size}px "${font}"`;
      lines = [''];
      let advance = 0;
      for (const character of element.content) {
        const last = lines.length - 1;
        // Missing CJK fonts can report zero-width glyphs; retain a conservative advance.
        const glyph = Math.max(context.measureText(character).width, size * (character.codePointAt(0)! < 128 ? .65 : 1));
        if (character === '\n') { lines.push(''); advance = 0; }
        else if (lines[last] && advance + glyph > width * .96) { lines.push(character); advance = glyph; }
        else { lines[last] += character; advance += glyph; }
      }
      if (lines.length * size * (style.lineHeight ?? 1.3) <= height) break;
      if (size <= minimum) throw new Error(`Assessment text exceeds its fixed layout: ${element.id}`);
      size = Math.max(minimum, size - 1);
    }
    return `<text id="${id}" x="${x}" y="${y + size}" font-family="${escape(font)}" font-size="${size}" font-weight="${style.fontWeight ?? 400}" fill="${escape(style.color)}" xml:space="preserve">${lines.map((line, index) => `<tspan x="${x}" dy="${index ? size * (style.lineHeight ?? 1.3) : 0}">${escape(line)}</tspan>`).join('')}</text>`;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${canvas.width}" height="${canvas.height}" viewBox="0 0 ${canvas.width} ${canvas.height}" font-family="Noto Sans SC" data-pptx-page-role="content"><rect id="background" data-pptx-role="background" width="${canvas.width}" height="${canvas.height}" fill="#FFFFFF"/><g id="assessment" data-pptx-bounds="0 0 ${canvas.width} ${canvas.height}">${elements.join('')}</g></svg>\n`;
}
