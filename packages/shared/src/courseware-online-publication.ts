import type { CoursewareProject, CoursewareSnapshot } from "./courseware-contract.js";

/** Public association review. Parser jobs, callback credentials and archive paths stay in Main. */
export type CoursewareOnlineSourceReviewView = {
  viewId: string;
  ownerId: string;
  original: { project: CoursewareProject };
  previousPages: Array<{ pageId: string; pageNumber: number; objects: Array<{ objectId: string; index: number; kind: string }> }>;
  targetPages: Array<{ importPageId: string; pageNumber: number; objects: Array<{ importElementId: string; index: number; kind: string }> }>;
};

/** Resolved review only; authoritative associations and publication input stay in Main. */
export type CoursewareOnlineSourceReviewResult = {
  viewId: string;
  ownerId: string;
  status: "reviewed";
  readyPages: number;
  totalPages: number;
};

export type CoursewareOnlineSourceCaptureResult = {
  viewId: string;
  ownerId: string;
  snapshot: CoursewareSnapshot;
};

/** Explicit user decisions, subsequently checked against the pinned parser result by Host. */
export type CoursewareOnlineSourceDecisions = {
  pages: Array<
    { kind: "carry"; targetImportPageId: string; oldPageId: string; confirmReady: boolean } |
    { kind: "new"; targetImportPageId: string; confirmReady: boolean }
  >;
  removedPages: Array<{ oldPageId: string; confirmDelete: true }>;
  cues: Array<{
    oldPageId: string;
    actionId: string;
    cueId: string;
    deleteCue: boolean;
    targets: Array<
      { decision: "keep" | "rebind"; oldObjectId: string; targetImportElementId: string } |
      { decision: "remove"; oldObjectId: string }
    >;
  }>;
};
