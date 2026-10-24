import { createHash } from 'node:crypto';
import { z } from 'zod';

const id = z.string().min(1).max(128);
export const pageCandidateBaselineSchema = z.object({
  projectId: id, documentId: id, pageId: id,
  sourceRevision: z.union([z.string().regex(/^[\w.-]{1,128}$/u), z.number().int().positive()]),
  sourceHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  teachingRevision: z.union([z.string().regex(/^[\w.-]{1,128}$/u), z.number().int().nonnegative()]),
  contentHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  clean: z.boolean(), readOnly: z.boolean(), manualLocked: z.boolean(),
}).strict();
export type PageCandidateBaseline = z.infer<typeof pageCandidateBaselineSchema>;
export const candidateHash = (bytes: Uint8Array | string) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

export class PageCandidateError extends Error {
  constructor(public readonly code: 'STALE_BASELINE' | 'READ_ONLY' | 'MANUAL_LOCK' | 'DIRTY_SOURCE' | 'INVALID_SOURCE' | 'UNSAFE_PACKAGE' | 'INVALID_OUTPUT', message: string) {
    super(message);
    this.name = 'PageCandidateError';
  }
}

export async function checkPageCandidateBaseline(
  expected: PageCandidateBaseline,
  getCurrent: () => Promise<unknown>,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const current = pageCandidateBaselineSchema.parse(await getCurrent());
  signal?.throwIfAborted();
  if (current.readOnly) throw new PageCandidateError('READ_ONLY', 'The current project is read-only');
  if (current.manualLocked) throw new PageCandidateError('MANUAL_LOCK', 'The target page is manually locked');
  if (!current.clean) throw new PageCandidateError('DIRTY_SOURCE', 'Save and freeze the latest PPTX before generating a candidate');
  for (const key of Object.keys(expected) as Array<keyof PageCandidateBaseline>) {
    if (current[key] !== expected[key]) throw new PageCandidateError('STALE_BASELINE', `Page baseline changed: ${key}`);
  }
}
