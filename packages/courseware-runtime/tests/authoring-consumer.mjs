import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { candidateHash, coursewarePageBaseline, generatePageStyleBatchCandidate, compileScenesToPptx, createPageCandidateLineage, editablePptxSceneSchema, generatePagePptxCandidate } from './authoring.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64');
const assets = { master: png, clean: png, picture: png };
for (const [cx, cy] of [[12192000, 6858000], [9144000, 6858000]]) {
  const canvas = { width: cx / 9144, height: cy / 9144 };
  const scene = (slideId, sourceHash, content) => editablePptxSceneSchema.parse({
    version: 1, slideId, sourceHash, canvas, visualMasterAssetId: 'master', cleanPlateAssetId: 'clean',
    elements: [
      { id: 'title', type: 'native_text', bboxPx: [50, 50, 800, 100], zIndex: 2, content, style: { fontFace: 'Arial', fontSizePt: 32, color: '#173B65' } },
      { id: 'picture', type: 'image_layer', assetId: 'picture', layerRoute: 'A1', bboxPx: [50, 200, 200, 100], zIndex: 1, crop: [[10, 20], [90, 80]] },
      { id: 'badge', type: 'native_shape', shape: 'ellipse', fill: '#FFAA00', bboxPx: [400, 200, 100, 100], zIndex: 0 },
    ],
  });
  const source = await compileScenesToPptx(['first', 'target', 'last'].map(id => scene(id, 'fixture', `Original ${id}`)), assets);
  const sourcePptx = Buffer.from(source.pptx);
  const original = Buffer.from(sourcePptx);
  const baseline = { projectId: 'isolated', documentId: 'document', pageId: 'target', sourceRevision: 1, sourceHash: candidateHash(sourcePptx), teachingRevision: 2, contentHash: candidateHash('Original target'), clean: true, readOnly: false, manualLocked: false };
  let current = { ...baseline };
  let calls = 0;
  const input = {
    baseline, sourcePptx, pageText: 'Original target', instruction: 'Redo this page',
    target: { pageId: 'target', slidePart: 'ppt/slides/slide2.xml' },
    getCurrentBaseline: async () => current,
    generate: async request => {
      calls++;
      assert.deepEqual(request.canvas, canvas);
      return { scene: request.schema.parse(scene('target', baseline.sourceHash, 'Replacement < editable')), assets };
    },
  };
  const candidate = await generatePagePptxCandidate(input);
  assert.equal(calls, 1);
  assert.equal(candidate.applied, false);
  assert.equal(candidate.reviewState, 'needs-review');
  assert.equal(candidate.hash, candidateHash(candidate.pptx));
  assert.deepEqual(sourcePptx, original);
  const before = await JSZip.loadAsync(sourcePptx);
  const after = await JSZip.loadAsync(candidate.pptx);
  let notes = 0;
  for (const file of Object.values(before.files)) {
    if (file.dir || candidate.report.changedParts.includes(file.name)) continue;
    assert.deepEqual(await after.file(file.name).async('nodebuffer'), await file.async('nodebuffer'), file.name);
    if (/notesSlide\d+\.xml$/.test(file.name)) notes++;
  }
  assert(notes > 0, 'Source must exercise note preservation');
  const xml = await after.file('ppt/slides/slide2.xml').async('string');
  assert(xml.includes('Replacement &lt; editable'));
  assert(xml.includes('<p:pic>') && xml.includes('<p:sp>'));
  const presentation = await after.file('ppt/presentation.xml').async('string');
  assert(presentation.includes(`cx="${cx}" cy="${cy}"`));
  const mapping = { revision: 'M1', sourceSha256: baseline.sourceHash.slice(7), pages: ['first', 'target', 'last'].map((pageId, index) => ({ pageId, importPageId: `page_${index + 1}`, objects: [] })) };
  const lineage = await createPageCandidateLineage({ sourcePptx, candidate, mapping });
  assert.equal(lineage.currentSourceSha256, candidate.hash.slice(7));
  assert.deepEqual(lineage.pages.map(page => page.oldLogicalId), ['first', 'target', 'last']);
  current = { ...baseline, teachingRevision: 3 };
  await assert.rejects(generatePagePptxCandidate(input), { code: 'STALE_BASELINE' });
  assert.equal(calls, 1, 'Stale input must fail before generation');
  current = { ...baseline };
  await assert.rejects(generatePagePptxCandidate({ ...input, signal: AbortSignal.abort() }), { name: 'AbortError' });
  assert.equal(calls, 1);
  await assert.rejects(generatePagePptxCandidate({ ...input, generate: async request => {
    const output = await input.generate(request);
    current = { ...baseline, teachingRevision: 3 };
    return output;
  } }), { code: 'STALE_BASELINE' });
  assert.deepEqual(sourcePptx, original);
  console.log(`PASS public authoring: ${cx}×${cy} EMU; editable copy, exact peers/notes, lineage, stale and cancellation`);
  const project = {
    schemaVersion: 'deckwise-courseware/1', projectId: 'isolated', taskType: 'scene', title: 'Isolated batch fixture',
    source: { revision: 'R1', sha256: baseline.sourceHash.slice(7) }, teachingRevision: 'T2',
    pages: ['first', 'target', 'last'].map(pageId => ({ pageId, actions: [], locked: false, reviewState: 'ready' })),
  };
  const contexts = ['target', 'first'].map(pageId => ({ project, documentId: 'document', pageId, pageText: `Original ${pageId}`, clean: true, readOnly: false }));
  const generatedRepresentative = await generatePagePptxCandidate({ ...input, baseline: coursewarePageBaseline(contexts[0]), getCurrentBaseline: async () => coursewarePageBaseline(contexts[0]) });
  const representative = { ...generatedRepresentative, reference: {
    candidateId: generatedRepresentative.candidateId, projectId: project.projectId,
    source: { ...project.source }, teachingRevision: project.teachingRevision,
    targetPageIds: [contexts[0].pageId], outputSha256: generatedRepresentative.hash.slice(7),
  } };
  let batchCalls = 0;
  const batchInput = {
    sourcePptx, representative, instruction: input.instruction, sourceMapping: mapping,
    targets: contexts.map(context => ({ context, slidePart: `ppt/slides/slide${context.pageId === 'target' ? 2 : 1}.xml` })),
    confirmation: { representativeCandidateId: representative.candidateId, representativeOutputSha256: representative.hash.slice(7), instructionHash: candidateHash(input.instruction), pageIds: ['target', 'first'] },
    getCurrentContexts: async () => structuredClone(contexts),
    generate: async request => {
      batchCalls++;
      assert.equal(candidateHash(request.sourcePptx), request.sourceHash);
      assert.equal(candidateHash(request.representative.pptx), representative.hash);
      request.sourcePptx.fill(0); request.representative.pptx.fill(0);
      return { scene: scene(request.pageId, request.sourceHash, 'Batch first'), assets };
    },
  };
  const batch = await generatePageStyleBatchCandidate(batchInput);
  assert.equal(batchCalls, 1);
  assert.equal(batch.applied, false);
  assert.equal(batch.reviewState, 'needs-review');
  assert.deepEqual(batch.reference.targetPageIds, ['target', 'first']);
  assert.equal(batch.reference.source.sha256, baseline.sourceHash.slice(7));
  assert.equal(batch.lineage.previousSourceSha256, baseline.sourceHash.slice(7));
  assert.equal(batch.lineage.currentSourceSha256, candidateHash(batch.pptx).slice(7));
  const batchParts = await JSZip.loadAsync(batch.pptx);
  for (const [part, hash] of Object.entries(batch.report.preservedParts)) {
    const bytes = await batchParts.file(part).async('nodebuffer');
    assert.equal(candidateHash(bytes), hash);
    assert.deepEqual(bytes, await before.file(part).async('nodebuffer'), part);
  }
  assert(batch.report.preservedParts['ppt/slides/slide3.xml']);
  assert.deepEqual(sourcePptx, original);
  const preCalls = batchCalls;
  for (const kind of ['confirmation', 'scope', 'dirty', 'readonly', 'lock', 'cancel']) {
    const captured = structuredClone(contexts);
    if (kind === 'dirty') captured[1].clean = false;
    if (kind === 'readonly') captured[1].readOnly = true;
    if (kind === 'lock') captured[1].project.pages[0].locked = true;
    const altered = { ...batchInput, getCurrentContexts: async () => captured };
    if (kind === 'confirmation') altered.confirmation = { ...batchInput.confirmation, representativeOutputSha256: 'a'.repeat(64) };
    if (kind === 'scope') altered.confirmation = { ...batchInput.confirmation, pageIds: ['target', 'last'] };
    if (kind === 'cancel') altered.signal = AbortSignal.abort();
    await assert.rejects(generatePageStyleBatchCandidate(altered));
    assert.equal(batchCalls, preCalls, `${kind} must reject before callback`);
  }
  await assert.rejects(generatePageStyleBatchCandidate({ ...batchInput, generate: async request => {
    const output = await batchInput.generate(request); contexts[0].project.teachingRevision = 'late'; return output;
  } }), { code: 'STALE_BASELINE' });
  contexts[0].project.teachingRevision = 'T2';
  await assert.rejects(generatePageStyleBatchCandidate({ ...batchInput, generate: async request => ({ scene: scene(request.pageId, request.sourceHash, 'Missing asset'), assets: {} }) }), /Missing scene asset/);
  assert.deepEqual(sourcePptx, original);
  console.log(`PASS public batch: ${cx}×${cy} EMU; reviewed scope, current-stage copies, byte-exact peer/notes, six preflight refusals, late teaching and missing assets`);
}
