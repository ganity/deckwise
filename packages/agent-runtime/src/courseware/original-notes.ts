import { z } from 'zod';
import { SaxesParser } from 'saxes';
import { isCoursewareProject } from '@pi-desktop/shared';
import { candidateHash, PageCandidateError } from './page-candidate-baseline.js';
import { parsePptCandidateBaseline } from '../ppt-candidate-tools.js';
import { pageNarrationOutputSchema } from './page-narration-candidate.js';

const id = z.string().min(1).max(200);
const savedIdentity = z.object({
  schemaVersion: z.literal('maic-saved-source-identity/1'),
  mappingRevision: id,
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  pages: z
    .array(z.object({ logicalId: id, importPageId: id }))
    .min(1)
    .max(100),
});
const parsedSource = z.object({
  result: z.object({ status: z.literal('PARSED'), sourceSha256: z.string() }),
  ir: z.object({
    kind: z.literal('slide'),
    sourceType: z.literal('pptx'),
    pages: z
      .array(
        z.object({ id, notes: z.union([z.string(), z.array(z.string()).max(1000)]).optional() }),
      )
      .min(1)
      .max(100),
  }),
});

function notesText(notes: unknown) {
  const raw = (typeof notes === 'string' ? notes : z.array(z.string()).max(1000).parse(notes).join('\n'));
  if (raw.length > 64000)
    throw new PageCandidateError('INVALID_SOURCE', 'Parsed notes exceed the text budget');
  if (!/<\/?[a-z][^>]*>/iu.test(raw)) return raw;
  const parser = new SaxesParser({ fragment: true });
  parser.ENTITIES.nbsp = ' ';
  const text: string[] = [];
  const invalid = () => { throw new PageCandidateError('INVALID_SOURCE', 'Unsupported or malformed rich notes'); };
  parser.on('error', invalid);
  parser.on('doctype', invalid);
  parser.on('processinginstruction', invalid);
  parser.on('comment', invalid);
  parser.on('cdata', invalid);
  parser.on('opentag', (tag) => {
    if (!['p', 'div', 'span', 'b', 'strong', 'i', 'em', 'u', 's', 'strike', 'sub', 'sup', 'br', 'ul', 'ol', 'li'].includes(tag.name.toLowerCase())) invalid();
    if (tag.name.toLowerCase() === 'br') text.push('\n');
  });
  parser.on('closetag', (tag) => {
    if (['p', 'div', 'li'].includes(tag.name.toLowerCase())) text.push('\n');
  });
  parser.on('text', (value) => text.push(value));
  parser.write(raw.replace(/<br\s*>/giu, '<br/>')).close();
  return text.join('').trim();
}

/** Trusted Host callbacks only: D parses exact saved bytes; A owns consent and adoption. */
export async function resolveCoursewareOriginalNotes(input: {
  baseline: unknown;
  sourcePptx: Uint8Array;
  getCurrent: () => Promise<{ baseline: unknown; project: unknown; clean: boolean; readOnly: boolean; savedIdentity: unknown }>;
  parseSavedSource: (sourcePptx: Uint8Array, signal?: AbortSignal) => Promise<unknown>;
  signal?: AbortSignal;
}) {
  const { getCurrent, parseSavedSource, signal } = input;
  const baseline = parsePptCandidateBaseline(input.baseline);
  signal?.throwIfAborted();
  if (
    !(input.sourcePptx instanceof Uint8Array) ||
    !input.sourcePptx.byteLength ||
    input.sourcePptx.byteLength > 50 * 1024 * 1024
  )
    throw new PageCandidateError(
      'INVALID_SOURCE',
      'Saved notes require at most 50 MiB of source bytes',
    );
  const source = Buffer.from(input.sourcePptx);
  if (candidateHash(source).slice(7) !== baseline.sourceSha256)
    throw new PageCandidateError(
      'INVALID_SOURCE',
      'Saved notes source hash differs from the current baseline',
    );

  let pinned: string | undefined;
  const current = async () => {
    signal?.throwIfAborted();
    const snapshot = structuredClone(await getCurrent());
    signal?.throwIfAborted();
    const project = snapshot.project;
    if (!isCoursewareProject(project))
      throw new PageCandidateError('INVALID_SOURCE', 'Invalid canonical project');
    if (snapshot.readOnly)
      throw new PageCandidateError('READ_ONLY', 'The current project is read-only');
    if (!snapshot.clean)
      throw new PageCandidateError('DIRTY_SOURCE', 'Save the latest source before selecting notes');
    const page = project.pages.find((page) => page.pageId === baseline.pageId);
    if (!page) throw new PageCandidateError('INVALID_SOURCE', 'Logical page is missing');
    if (page.locked)
      throw new PageCandidateError('MANUAL_LOCK', 'The target page is manually locked');
    if (page.actions.some((action) => action.type !== 'speech'))
      throw new PageCandidateError('INVALID_SOURCE', 'Retain existing interactive teaching');
    const actual = parsePptCandidateBaseline(snapshot.baseline);
    if (project.projectId !== baseline.coursewareProjectId || project.source.revision !== baseline.sourceRevision ||
        project.source.sha256 !== baseline.sourceSha256 || project.teachingRevision !== baseline.teachingRevision)
      throw new PageCandidateError('STALE_BASELINE', 'Saved notes project baseline changed');
    if (Object.entries(baseline).some(([key, value]) => Reflect.get(actual, key) !== value))
      throw new PageCandidateError('STALE_BASELINE', 'Saved notes baseline changed');
    const mapping = savedIdentity.parse(snapshot.savedIdentity);
    if (
      mapping.sourceSha256 !== baseline.sourceSha256 ||
      mapping.pages.length !== project.pages.length ||
      new Set(mapping.pages.map((page) => page.logicalId)).size !== mapping.pages.length ||
      new Set(mapping.pages.map((page) => page.importPageId)).size !== mapping.pages.length ||
      mapping.pages.some(
        (page) => !project.pages.some((canonical) => canonical.pageId === page.logicalId),
      )
    )
      throw new PageCandidateError(
        'INVALID_SOURCE',
        'Saved notes require the complete current source mapping',
      );
    const identity = JSON.stringify({ mapping, policy: project.educationContext ?? null });
    if (pinned !== undefined && identity !== pinned)
      throw new PageCandidateError(
        'STALE_BASELINE',
        'Saved notes mapping or teaching policy changed',
      );
    pinned = identity;
    return mapping;
  };

  const mapping = await current();
  const parserSource = Buffer.from(source);
  const parsed = parsedSource.parse(await parseSavedSource(parserSource, signal));
  await current();
  if (
    parsed.result.sourceSha256 !== baseline.sourceSha256 ||
    candidateHash(parserSource).slice(7) !== baseline.sourceSha256 ||
    parsed.ir.pages.length !== mapping.pages.length ||
    new Set(parsed.ir.pages.map((page) => page.id)).size !== parsed.ir.pages.length ||
    mapping.pages.some(
      (page) => !parsed.ir.pages.some((parsedPage) => parsedPage.id === page.importPageId),
    )
  )
    throw new PageCandidateError(
      'INVALID_SOURCE',
      'Parsed notes do not match the saved source mapping',
    );
  const target = mapping.pages.find((page) => page.logicalId === baseline.pageId)!;
  const notes = parsed.ir.pages.find((page) => page.id === target.importPageId)!.notes;
  const text = notesText(notes);
  const narration = pageNarrationOutputSchema.parse({ blocks: [{ type: 'speech', text }] });
  const selectedText = narration.blocks[0];
  if (selectedText.type !== 'speech')
    throw new PageCandidateError('INVALID_SOURCE', 'Missing notes speech');
  return {
    selection: { kind: 'original-notes' as const, baseline, text: selectedText.text },
    source: {
      sourceSha256: baseline.sourceSha256,
      mappingRevision: mapping.mappingRevision,
      importPageId: target.importPageId,
      textSha256: candidateHash(selectedText.text).slice(7),
    },
  };
}
