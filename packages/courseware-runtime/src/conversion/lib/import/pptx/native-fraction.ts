import { SaxesParser } from 'saxes';

/** Finite OMML support: standalone numeric bar fractions; other equations retain the fidelity gate. */
export function nativeFraction(xml: string): { numerator: string; denominator: string } | undefined {
  if (!xml.includes('oMath') || /<a:t\b/.test(xml)) return;
  const allowed = new Set(['oMathPara', 'oMathParaPr', 'jc', 'oMath', 'f', 'fPr', 'type', 'ctrlPr', 'num', 'den', 'r', 'rPr', 'sty', 't']);
  const stack: string[] = [];
  let valid = true, fractions = 0, equations = 0, nums = 0, dens = 0, numerator = '', denominator = '';
  const parser = new SaxesParser();
  parser.on('opentag', tag => {
    stack.push(tag.name);
    if (!tag.name.startsWith('m:')) return;
    const name = tag.name.slice(2);
    if (!allowed.has(name)) valid = false;
    if (name === 'oMath') equations++;
    if (name === 'f') { fractions++; if (stack.at(-2) !== 'm:oMath') valid = false; }
    if (name === 'num') { nums++; if (stack.at(-2) !== 'm:f') valid = false; }
    if (name === 'den') { dens++; if (stack.at(-2) !== 'm:f') valid = false; }
    if (name === 'type' && tag.attributes['m:val'] !== 'bar') valid = false;
    if (name === 't' && (stack.at(-2) !== 'm:r' || !['m:num', 'm:den'].includes(stack.at(-3) ?? ''))) valid = false;
  });
  parser.on('text', value => {
    if (stack.at(-1) !== 'm:t') return;
    if (stack.includes('m:num')) numerator += value;
    if (stack.includes('m:den')) denominator += value;
  });
  parser.on('closetag', () => { stack.pop(); });
  try { parser.write(xml).close(); } catch { return; }
  // shortcut: expand to other OMML constructs only with a faithful renderer and fixtures.
  if (!valid || equations !== 1 || fractions !== 1 || nums !== 1 || dens !== 1 ||
      !/^-?\d{1,12}$/.test(numerator) || !/^-?\d{1,12}$/.test(denominator)) return;
  return { numerator, denominator };
}

export function fractionHtml(fraction: { numerator: string; denominator: string }, color: string, fontSize: number, align: string): string {
  return `<div style="text-align:${align};color:${color};font-family:Cambria Math,serif;font-size:${fontSize}px"><span style="display:inline-flex;flex-direction:column;align-items:stretch;text-align:center;line-height:1.05"><span style="padding:0 0.15em 0.08em">${fraction.numerator}</span><span style="border-top:0.04em solid currentColor;padding:0.08em 0.15em 0">${fraction.denominator}</span></span></div>`;
}
