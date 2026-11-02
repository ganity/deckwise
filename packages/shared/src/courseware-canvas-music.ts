import type { MediaCanvasDraft } from "./courseware-media-canvas.js";
import type { CoursewareTaskRef } from "./courseware-contract.js";

export type CoursewareCanvasMusicOptions = { title: string; tags?: string | null; negativeTags?: string | null; instrumental?: boolean | null };
export type CoursewareCanvasMusicCandidate = {
  candidateId: string; order: number; state: "pending" | "processing" | "completed" | "failed";
  durationMs?: number; exportable: boolean;
};
export type CoursewareCanvasMusicAsset = { taskRef: CoursewareTaskRef; sha256: string; mimeType: "audio/mpeg"; byteLength: number };
export type CoursewareMusicTarget = { version: 1; projectId: string; pageId: string; actionId: string; source: { revision: string; sha256: string }; prompt: string };
export type CoursewareCanvasMusicView = {
  target?: CoursewareMusicTarget;
  unresolvedProjectId?: string;
  intentId: string; draft: MediaCanvasDraft; model: string; operation: "music" | "music-export";
  sourceIntentId?: string; candidateId?: string; music?: CoursewareCanvasMusicOptions;
  phase: "prepared" | "submission-unknown" | "submitted" | "rejected"; current: boolean;
  candidates: CoursewareCanvasMusicCandidate[]; previews: Array<{ candidateId: string; asset: CoursewareCanvasMusicAsset }>;
  asset: CoursewareCanvasMusicAsset | null;
  task: { state: string; feeState: string; reservedPoints: number; actualPoints: number | null; errorCode: string | null } | null;
};
export type CoursewareCanvasMusicQuoteView = { quoteId: string; intentId: string; model: string; maxPoints: number; maxChars: number; expiresAt: string };
export type CoursewareCanvasMusicPreview = { intentId: string; candidateId?: string; asset: CoursewareCanvasMusicAsset; dataUrl: string };
export type CoursewareCanvasMusicModels = { generation: Array<{ model: string }>; export: Array<{ model: string }> };
export type CoursewareCanvasMusicPrepareRequest = {
  sessionId: string; intentId: string; draftId: string; expectedRevision: string; expectedDraftRevision: number;
  model: string; music: CoursewareCanvasMusicOptions; target?: CoursewareMusicTarget;
};
export type CoursewareCanvasMusicExportPrepareRequest = { sessionId: string; intentId: string; exportIntentId: string; candidateId: string; model: string };
export type CoursewareCanvasMusicAdoptRequest = {
  sessionId: string; intentId: string; viewId: string; expectedTeachingRevision: string;
};
