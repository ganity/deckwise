import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import * as crypto from 'node:crypto';
import ts from 'typescript';

const exports = {};
const code = ts.transpileModule(await readFile(new URL('../electron/main/courseware-quiz-image-review.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
new Function('require', 'exports', code)(id => {
  if (id === 'node:crypto') return crypto;
  if (id === 'electron') return { nativeImage: { createFromBuffer: bytes => ({
    isEmpty: () => !bytes.length, getSize: () => ({ width: 32, height: 32 }), toPNG: () => bytes,
  }) } };
  throw Error(id);
}, exports);
const input = { sessionId: 'chat', question: { question: 'Which is attracted to a magnet?', answer: ['A'] },
  option: { value: 'B', label: 'Wooden block' }, bytes: Buffer.from('downloaded image') };

test('image review inspects downloaded pixels and rejects contradictory or malformed verdicts', async () => {
  let answer = { valid: true, reason: 'Neutral wood' }, calls = 0;
  const review = exports.createQuizImageReview(async request => {
    calls++;
    assert.deepEqual(request.images[0].bytes, input.bytes);
    assert.equal(request.images[0].sha256, crypto.createHash('sha256').update(input.bytes).digest('hex'));
    assert.match(request.system, /wood floating/);
    assert.equal(JSON.parse(request.data).option.label, 'Wooden block');
    return { text: JSON.stringify(answer) };
  }, async () => ({ modelKey: 'vision/model' }));
  await review(input);
  answer = { valid: false, reason: 'Wood is shown attracted' };
  await assert.rejects(review(input), /needs correction.*Wood is shown attracted/);
  answer = { reason: 'No verdict' };
  await assert.rejects(review(input), /Invalid Quiz image review/);
  assert.equal(calls, 3);
});

test('review fails closed without a selected model or after a model change', async () => {
  const complete = async () => ({ text: '{"valid":true,"reason":"OK"}' });
  await assert.rejects(exports.createQuizImageReview(complete)(input), /Select a Quiz/);
  let calls = 0;
  await assert.rejects(exports.createQuizImageReview(complete, async () => ({ modelKey: String(calls++) }))(input), /model changed/);
});
