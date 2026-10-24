import type { CoursewareSceneImageAsset } from "./courseware-scene-plan.js";

export const MEDIA_CANVAS_KINDS = ["image", "video", "music", "sound"] as const;
export type MediaCanvasKind = (typeof MEDIA_CANVAS_KINDS)[number];
export type MediaCanvasReference = { assetId: string; revision: string; label: string };
export type MediaCanvasDraft = {
  id: string;
  revision: number;
  kind: MediaCanvasKind;
  title: string;
  prompt: string;
  references: MediaCanvasReference[];
  x: number;
  y: number;
};
export type MediaCanvasViewport = { x: number; y: number; zoom: number };
export type MediaCanvasDocument = {
  version: 1;
  projectId: string;
  revision: number;
  viewport: MediaCanvasViewport;
  drafts: MediaCanvasDraft[];
};
export type MediaCanvasDraftPatch = Partial<Pick<MediaCanvasDraft, "title" | "prompt" | "references">>;
export type MediaCanvasChatRequest = { projectId: string; draftId: string; expectedRevision: number; instruction: string };
export type MediaCanvasView = { projectId: string; revision: string | null; document: MediaCanvasDocument | null };
export type CoursewareCanvasImageView = {
  intentId: string; draft: MediaCanvasDraft; model: string; current: boolean;
  phase: "prepared" | "submission-unknown" | "submitted" | "rejected";
  asset?: CoursewareSceneImageAsset | null;
  task: { state: string; feeState: string; reservedPoints: number; actualPoints: number | null; errorCode: string | null } | null;
};
export type CoursewareCanvasImageQuoteView = {
  quoteId: string; intentId: string; model: string; maxPoints: number; maxChars: number; expiresAt: string;
};
export type CoursewareCanvasImagePreview = { image: CoursewareCanvasImageView; dataUrl: string };
export type CoursewareCanvasImageReferencePreview = { intentId: string; reference: MediaCanvasReference; dataUrl: string };
