import { z } from 'zod';
import { isCoursewareProject } from '../conversion/lib/courseware/canonical/courseware-contract';
import {
  candidateHash,
  pageCandidateBaselineSchema,
  PageCandidateError,
} from './page-candidate-baseline';

/** Host-owned current state, not renderer/model-supplied project or page identity. */
export type CoursewarePageContext = {
  project: unknown;
  documentId: string;
  pageId: string;
  pageText: string;
  clean: boolean;
  readOnly: boolean;
};

export function coursewarePageBaseline(context: CoursewarePageContext) {
  const { project } = context;
  if (!isCoursewareProject(project))
    throw new PageCandidateError('INVALID_SOURCE', 'Invalid canonical project');
  const page = project.pages.find((page) => page.pageId === context.pageId);
  if (!page) throw new PageCandidateError('INVALID_SOURCE', 'Logical page is missing');
  return pageCandidateBaselineSchema.parse({
    projectId: project.projectId,
    documentId: context.documentId,
    pageId: page.pageId,
    sourceRevision: project.source.revision,
    sourceHash: `sha256:${project.source.sha256.toLowerCase()}`,
    teachingRevision: project.teachingRevision,
    contentHash: candidateHash(z.string().max(32000).parse(context.pageText)),
    clean: context.clean,
    readOnly: context.readOnly,
    manualLocked: page.locked,
  });
}
