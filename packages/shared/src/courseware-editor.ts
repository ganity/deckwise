import type { CoursewareBuildRef, CoursewareProject, CoursewareSnapshot } from "./courseware-contract.js";
import { isCoursewareProject, isTeachingWrite } from "./courseware-contract.js";
import type { CoursewareChatChange, CoursewareSourceChange } from "./courseware-source-change.js";

export type CoursewareBuildDiagnostic = { code: string; message?: string; severity?: "error" | "warning" | "info" };
export type CoursewareFixedBuildView =
  | { status: "review"; reviewId: string; snapshot: CoursewareSnapshot; diagnostics: CoursewareBuildDiagnostic[] }
  | { status: "ready"; previewId: string; snapshot: CoursewareSnapshot; buildRef: CoursewareBuildRef;
      report: { visualFidelity: string; diagnostics: CoursewareBuildDiagnostic[] } };

export type CoursewareTeachingView = {
  viewId: string;
  project: CoursewareProject;
  pageId: string;
  pageNumber: number;
  sourceChange?: CoursewareSourceChange;
  chatChanges?: CoursewareChatChange[];
  teachingObjects?: Array<{
    objectId: string;
    name: string;
    role?: string;
    aliases: string[];
    status: "mapped" | "missing" | "content_changed" | "identity_mismatch";
    effectTargetEligible?: boolean;
    savedKind?: string;
    savedIndex?: number;
  }>;
};

/** Explicit saved-source image locks; paths and native XML stay in Main/Host. */
export type CoursewareAssetLocksView = {
  revision: string | null;
  sourceSha256: string;
  mappingRevision: string;
  pageId: string;
  objects: Array<{ objectId: string; index: number; assetSha256?: string; locked: boolean; eligible: boolean; reason?: string }>;
  staleLocks: Array<{ objectId: string; assetSha256: string }>;
};

/** Existing fixed-player visualCues, timed only against their parent speech audio. */
export type CoursewareAttentionCue = {
  id: string;
  atMs: number;
  endMs: number;
  effect: { type: "highlight"; elementIds: string[]; color?: string; style?: "outline" | "fill" | "glow"; opacity?: number } |
    { type: "spotlight"; elementId: string; elementIds?: string[]; dimOpacity?: number };
};

export function isCoursewareAttentionCue(value: unknown): value is CoursewareAttentionCue {
  const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
  const fields = (v: Record<string, unknown>, required: string[], optional: string[] = []) =>
    required.every(key => Object.hasOwn(v, key)) && Object.keys(v).every(key => required.includes(key) || optional.includes(key));
  const id = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 200;
  const unit = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
  if (!record(value) || !fields(value, ["id", "atMs", "endMs", "effect"]) || !id(value.id) ||
      typeof value.atMs !== "number" || !Number.isInteger(value.atMs) || value.atMs < 0 ||
      typeof value.endMs !== "number" || !Number.isInteger(value.endMs) || value.endMs <= value.atMs || value.endMs > 3_600_000 || !record(value.effect)) return false;
  const effect = value.effect;
  let targets: unknown[];
  if (effect.type === "highlight") {
    if (!fields(effect, ["type", "elementIds"], ["color", "style", "opacity"]) || !Array.isArray(effect.elementIds) ||
        effect.elementIds.length === 0 || (effect.color !== undefined && (typeof effect.color !== "string" || !/^#[a-fA-F0-9]{6}$/u.test(effect.color))) ||
        (effect.style !== undefined && !["outline", "fill", "glow"].includes(String(effect.style))) ||
        (effect.opacity !== undefined && !unit(effect.opacity))) return false;
    targets = effect.elementIds;
  } else if (effect.type === "spotlight") {
    if (!fields(effect, ["type", "elementId"], ["elementIds", "dimOpacity"]) || !id(effect.elementId) ||
        (effect.elementIds !== undefined && !Array.isArray(effect.elementIds)) || (effect.dimOpacity !== undefined && !unit(effect.dimOpacity))) return false;
    targets = [effect.elementId, ...(Array.isArray(effect.elementIds) ? effect.elementIds : [])];
  } else return false;
  return targets.length <= 200 && targets.every(id) && new Set(targets).size === targets.length;
}

/** Local recovery only; never a second authoritative teaching record. */
export type CoursewareTeachingDraft = {
  revision: string;
  baseline: CoursewareProject;
  pageId: string;
  actions: Array<Record<string, unknown>>;
  instruction: string;
};

/** Deleted-page text projected from this project's history; old media/object bindings are omitted. */
export type CoursewareTeachingHistoryEntry = {
  teachingRevision: string;
  sourceRevision: string;
  pageId: string;
  pageNumber: number;
  actions: Array<Record<string, unknown>>;
  omittedAudioCount: number;
  omittedCueCount: number;
};
export type CoursewareTeachingHistory = { entries: CoursewareTeachingHistoryEntry[]; skippedEntryCount: number };

export function isCoursewareTeachingHistory(value: unknown): value is CoursewareTeachingHistory {
  const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
  const fields = (v: Record<string, unknown>, required: string[], optional: string[] = []) =>
    required.every(key => Object.hasOwn(v, key)) && Object.keys(v).every(key => required.includes(key) || optional.includes(key));
  const id = (v: unknown): v is string => typeof v === "string" && /^[\w.-]{1,128}$/u.test(v);
  const count = (v: unknown, max: number) => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= max;
  if (!record(value) || !fields(value, ["entries", "skippedEntryCount"]) || !Array.isArray(value.entries) ||
      value.entries.length > 20 || !count(value.skippedEntryCount, 1_000_000)) return false;
  try { if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 2 * 1024 * 1024) return false; }
  catch { return false; }
  const entries = new Set<string>();
  return value.entries.every(entry => {
    if (!record(entry) || !fields(entry, ["teachingRevision", "sourceRevision", "pageId", "pageNumber", "actions", "omittedAudioCount", "omittedCueCount"]) ||
        !id(entry.teachingRevision) || !id(entry.sourceRevision) || !id(entry.pageId) || !count(entry.pageNumber, 100) || entry.pageNumber === 0 ||
        !count(entry.omittedAudioCount, 1000) || !count(entry.omittedCueCount, 200_000) ||
        !Array.isArray(entry.actions) || !entry.actions.length || entry.actions.length > 1000) return false;
    const key = JSON.stringify([entry.teachingRevision, entry.pageId]);
    if (entries.has(key)) return false;
    entries.add(key);
    const ids = new Set<string>();
    return entry.actions.every(action => {
      if (!record(action) || !id(action.id) || ids.has(action.id)) return false;
      ids.add(action.id);
      if (action.type === "speech") return fields(action, ["id", "type", "text"], ["source", "pauseAfterMs"]) &&
        typeof action.text === "string" && action.text.length <= 32_000 &&
        (!Object.hasOwn(action, "source") || (typeof action.source === "string" && ["notes", "external", "original", "light_rewrite", "generated"].includes(action.source))) &&
        (!Object.hasOwn(action, "pauseAfterMs") || count(action.pauseAfterMs, 30_000));
      return action.type === "interaction_checkpoint" && fields(action, ["id", "type", "checkpointId", "checkpointKind"]) &&
        id(action.checkpointId) && action.checkpointKind === "teacher_continue";
    });
  });
}

export function isCoursewareTeachingDraft(value: unknown): value is CoursewareTeachingDraft {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const draft = value as Record<string, unknown>;
  if (Object.keys(draft).length !== 5 || typeof draft.revision !== "string" || !draft.revision || draft.revision.length > 128 ||
      typeof draft.instruction !== "string" || draft.instruction.length > 4000 || !isCoursewareProject(draft.baseline) ||
      !draft.baseline.pages.some(page => page.pageId === draft.pageId)) return false;
  return isTeachingWrite({ projectId: draft.baseline.projectId, pageId: draft.pageId,
    expectedSourceRevision: draft.baseline.source.revision, expectedTeachingRevision: draft.baseline.teachingRevision, actions: draft.actions });
}

/** Task status only; server readiness does not imply teaching audio adoption. */
export type CoursewareTtsView = {
  intentId: string;
  pageId: string;
  actionId: string;
  model: string;
  voice: string | null;
  phase: "prepared" | "submission-unknown" | "submitted" | "rejected";
  current: boolean;
  audioReady: false;
  task: null | { state: string; feeState: string; reservedPoints: number; actualPoints: number | null; errorCode: string | null };
};

/** Verified local archive only; teaching adoption and playback remain separate. */
export type CoursewareTtsArchiveView = { intentId: string; archived: true; durationMs: number; audioReady: false };

export type CoursewareSourceReview = {
  reviewId: string;
  project: CoursewareProject;
  pageCount: number;
  targetSha256: string;
  targetPages?: Array<{ objects: Array<{ index: number; kind: string }> }>;
  effectTargets?: Array<{ pageId: string; objectId: string; kind: string; index: number }>;
};

/** Explicit old-object to current saved-page parser-order associations. */
export type CoursewareEffectBinding = { pageIndex: number; objectId: string; targetIndex: number };

/** Changing narration invalidates its recorded speech and audio-clock effects. */
export function replaceNarrationText(action: Record<string, unknown>, text: string): Record<string, unknown> {
  if (action.type !== "speech" || typeof action.text !== "string") throw new Error("Not an editable speech action");
  if (action.text === text) return action;
  const changed: Record<string, unknown> = { ...action, text };
  for (const key of ["audioId", "audioUrl", "audioAssetId", "duration", "durationMs", "visualCues", "speechCuePlans", "pptxCue"]) {
    delete changed[key];
  }
  return changed;
}

export type CoursewareNarrationReview = {
  reviewId: string;
  candidateId: string;
  status: "needs-review" | "adopted" | "rejected";
  teaching: CoursewareTeachingView;
  actions: Array<Record<string, unknown>>;
  stale: boolean;
  audioReady: false;
};

export type CoursewarePptxCandidateReview = {
  reviewId: string;
  candidateId: string;
  projectId: string;
  kind: "page-pptx" | "page-fade" | "page-style-batch";
  status: "needs-review";
  sourceSha256: string;
  teachingRevision: string;
  targetPageIds: string[];
  targetPages: Array<{ pageId: string; pageNumber: number }>;
  effectTargets?: Array<{ pageId: string; pageIndex: number; objectId: string; kind: string; index: number }>;
  effectPages?: CoursewareSourceReview["targetPages"];
  effectCues?: Array<{ pageNumber: number; effect: "highlight" | "spotlight"; atMs: number; endMs: number }>;
  outputSha256: string;
  pageCount: number;
  stale: boolean;
  lineageVerified: boolean;
  applied: false;
};

/** Actual retained candidate rendering; approval never adopts or changes the source. */
export type CoursewareStyleReview = {
  reviewId: string;
  candidateId: string;
  pageId: string;
  pageNumber: number;
  outputSha256: string;
  instruction: string;
  pages: Array<{ pageId: string; pageNumber: number; locked: boolean }>;
  preview: { width: number; height: number; preview: string };
};

export type CoursewareTtsModel = { model: string; voices: string[]; providerDefaultVoice: boolean };
export type CoursewareTtsQuoteView = { quoteId: string; intentId: string; model: string; voice: string | null;
  maxPoints: number; maxChars: number; expiresAt: string };
