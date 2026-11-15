/** Regenerate the checked-in, isolated reference Quiz styles using the reference checkout's compiler. */
import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const cloud = resolve(process.env.MAIC_CLOUD_WEB_ROOT || join(root, '../../../../cloud-web-trainwise'));
const require = createRequire(join(cloud, 'package.json'));
const { compile } = require('@tailwindcss/node');
const postcss = require('postcss');
const globals = await readFile(join(cloud, 'app/globals.css'), 'utf8');
const darkVariant = globals.match(/@custom-variant dark\s+[^;]+;/)?.[0];
if (!darkVariant) throw new Error('Reference dark variant is missing; review before regenerating Quiz styles');
const sources = await Promise.all(['MaicInstantQuizCard', 'MaicAssessmentQuiz'].map(name =>
  readFile(join(root, `src/player/components/courseware/${name}.tsx`), 'utf8')));
const compiler = await compile(`@import "tailwindcss";\n${darkVariant}`, { base: cloud, onDependency() {} });
const candidates = sources.flatMap(source => [...source.matchAll(/["'`]([^"'`\n]+)["'`]/g)].flatMap(match => match[1].split(/\s+/)));
const css = postcss.parse(compiler.build(candidates));
css.walkRules(rule => {
  if (rule.parent.type === 'atrule' && /keyframes/.test(rule.parent.name)) return;
  for (let ancestor = rule.parent; ancestor; ancestor = ancestor.parent) if (ancestor.type === 'rule') return;
  rule.selectors = rule.selectors.map(selector => [':root', ':host', 'html'].includes(selector)
    ? '[data-maic-quiz-card]' : `[data-maic-quiz-card] ${selector}`);
});
// Course content keeps the reference 16px scale independently of app-shell rem units.
const compiled = css.toString().replace(/(-?\d*\.?\d+)rem\b/g, (_, value) => `${Number(value) * 16}px`);
await writeFile(join(root, 'src/maic-quiz.css'), `/* Scoped tokens compiled from pinned cloud-web Quiz presentation projections. */
${compiled}
[data-maic-quiz-card] .maic-quiz-feedback {padding:1rem 1.5rem;}
[data-maic-quiz-card].maic-assessment-shell {height:100%;min-height:0;}
/* Preview content uses the reference 16px scale independently of app chrome. */
[data-maic-quiz-card] { color: #000; font-size: 16px; color-scheme: light; }
/* Discard unlayered app-shell control styles without defeating Quiz utility classes. */
[data-maic-quiz-card][data-maic-quiz-card][data-maic-quiz-card] :is(button, input, textarea, select) { all: revert-layer; }
[data-maic-quiz-card][data-maic-quiz-card][data-maic-quiz-card] :is(input, textarea) { -webkit-user-select: text; user-select: text; }
`);
console.log('PASS regenerated scoped Quiz CSS using actual cloud-web dark variant');
