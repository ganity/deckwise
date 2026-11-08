import type { CoursewareSceneTeaching } from "./courseware-scene-teaching.js";
export type CoursewarePlannedQuiz = {
  type: "quiz";
  questions: Array<{ id: string; type: "single" | "multiple" | "judge" | "short_answer"; question: string;
    options?: Array<{ value: string; label: string; image?: { src: string; assetId?: string; mimeType?: string } }>;
    answer?: string[]; image?: { src: string; assetId?: string; mimeType?: string };
    analysis?: string; referenceAnswer?: string; keyPoints?: string[]; commentPrompt?: string; points?: number; hasAnswer?: boolean }>;
  interactionMode?: "assessment_review" | "classroom_instant_feedback";
};
export type CoursewareScenePlanPage = {
  pageId: string;
  sourceHash: string;
  title: string;
  visibleText: string[];
  visualIntent: string;
  narration: string;
  teaching?: CoursewareSceneTeaching;
  quiz?: CoursewarePlannedQuiz;
};

/** A validated generation draft, not the authoritative teaching of an open PPTX. */
export type CoursewareScenePlanSnapshot = {
  storySha256?: string;
  relativePath: string;
  sha256: string;
  approvedSha256: string | null;
  /** Maximum number of正文 pages; MAIC quiz and checkpoint pages are interactive content. */
  bodyPageLimit?: number;
  visualBible?: { artDirection: string; characters: string; setting: string };
  title: string;
  pages: CoursewareScenePlanPage[];
};

/** Quiz and standalone checkpoint scenes do not consume the illustrated正文 page budget. */
export function coursewareSceneBodyPageCount(pages: readonly Pick<CoursewareScenePlanPage, "quiz" | "teaching">[]): number {
  return pages.filter(page => !page.quiz && !page.teaching?.question).length;
}

/** A page visual request pinned to an approved draft, before Office page identity exists. */
export type CoursewareSceneImageAsset = {
  sha256: string;
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  byteLength: number;
  width: number;
  height: number;
  normalizedBoundingBox?: [number, number, number, number];
  sourceZIndex?: number;
};

export type CoursewareSceneImageTarget =
  | { kind: "visualMaster" | "cleanPlate" }
  | { kind: "layer"; name: string };

/** The original bounded supplier response, without interpreting its contents. */
export type CoursewareUpstreamResponse = { status: number; contentType: string | null; requestId: string | null;
  body: string; bodyEncoding: "utf-8" | "base64"; truncated: boolean };

export function isCoursewareSceneImageTarget(value: unknown): value is CoursewareSceneImageTarget {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  const keys = Object.keys(v).sort().join(",");
  if (v.kind === "visualMaster" || v.kind === "cleanPlate") return keys === "kind";
  return v.kind === "layer" && keys === "kind,name" && typeof v.name === "string" &&
    v.name.length > 0 && v.name.length <= 80 && v.name === v.name.trim() && !/[\u0000-\u001f\u007f-\u009f]/u.test(v.name);
}

export type CoursewareSceneImageView = {
  decomposition?: boolean;
  referenceImage?: { intentId: string; sha256: string; mimeType: "image/png" | "image/jpeg"; byteLength: number };
  intentId: string;
  planSha256: string;
  pageId: string;
  target: CoursewareSceneImageTarget;
  model: string;
  prompt: string;
  phase: "prepared" | "submission-unknown" | "submitted" | "rejected";
  current: boolean;
  asset: CoursewareSceneImageAsset | null;
  selected: boolean;
  task: { state: string; feeState: string; reservedPoints: number; actualPoints: number | null; errorCode: string | null;
    upstreamResponse?: CoursewareUpstreamResponse } | null;
};

export type CoursewareSceneImagePreview = { image: CoursewareSceneImageView; dataUrl: string };

export type CoursewareSceneImageQuoteView = {
  quoteId: string;
  intentId: string;
  model: string;
  maxPoints: number;
  maxChars: number;
  expiresAt: string;
};
