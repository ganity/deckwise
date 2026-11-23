import { isCoursewareSpeechTrigger, rebaseSpeechTrigger, type CoursewareSpeechTrigger } from './courseware-speech-trigger.js';
import { isCoursewareQuestionResponse } from "./courseware-question.js";
import type { CoursewareBuildRef, CoursewareProject, CoursewareSnapshot } from "./courseware-contract.js";
import { isCoursewareProject, isTeachingWrite } from "./courseware-contract.js";
import type { CoursewareChatChange, CoursewareSourceChange } from "./courseware-source-change.js";

export type CoursewareBuildDiagnostic = { code: string; message?: string; severity?: "error" | "warning" | "info" };
export type CoursewareFixedBuildView =
  | { status: "review"; reviewId: string; snapshot: CoursewareSnapshot; diagnostics: CoursewareBuildDiagnostic[] }
  | { status: "ready"; previewId: string; snapshot: CoursewareSnapshot; buildRef: CoursewareBuildRef;
      report: { visualFidelity: string; diagnostics: CoursewareBuildDiagnostic[] } };

export type CoursewareTeachingView = {
  enrichment?: import("./courseware-enrichment.js").CoursewareEnrichment;
  enrichmentCapabilities?: { version: 1 };
  nativeTeaching?: true;
  /** Editable generated body with an extractable opaque image background. */
  backgroundRegionRepair?: boolean;
  readOnly?: boolean;
  teaching?: import("./courseware-scene-teaching.js").CoursewareSceneTeaching;
  teachingRequirements?: Array<{ pageId: string; teaching: import("./courseware-scene-teaching.js").CoursewareSceneTeaching }>;
  viewId: string;
  project: CoursewareProject;
  pageId: string;
  pageNumber: number;
  saveWarnings?: string[];
  sourceChange?: CoursewareSourceChange;
  chatChanges?: CoursewareChatChange[];
  teachingObjects?: Array<{
    objectId: string;
    name: string;
    role?: string;
    aliases: string[];
    status: "mapped" | "missing" | "content_changed" | "identity_mismatch";
    effectTargetEligible?: boolean;
    /** Current saved OOXML shape identity, never a display ordinal. */
    sourceShapeId?: string;
    /** Compiler-owned unique name for SDKs that renumber shape IDs on import. */
    sourceObjectName?: string;
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

// Intent and rendered cues share the existing player target bound.
export const COURSEWARE_ATTENTION_TARGET_LIMIT = 200;

/** Existing fixed-player visualCues, timed only against their parent speech audio. */
export type CoursewareAttentionIntent = { type: "highlight" | "spotlight"; objectIds: string[]; animation?: "fadeIn" | "fadeOut" | "pulse" | "zoomIn" | "slideInLeft" | "slideInRight" | "gentleRotate" };
export function isCoursewareAttentionIntent(value: unknown): value is CoursewareAttentionIntent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const intent = value as Record<string, unknown>;
  return Object.hasOwn(intent, "type") && Object.hasOwn(intent, "objectIds") &&
    Object.keys(intent).every(key => ["type", "objectIds", "animation"].includes(key)) &&
    (intent.animation === undefined || ["fadeIn", "fadeOut", "pulse", "zoomIn", "slideInLeft", "slideInRight", "gentleRotate"].includes(String(intent.animation))) && ["highlight", "spotlight"].includes(String(intent.type)) &&
    Array.isArray(intent.objectIds) && intent.objectIds.length > 0 && intent.objectIds.length <= COURSEWARE_ATTENTION_TARGET_LIMIT &&
    intent.objectIds.every(id => typeof id === "string" && id.length > 0 && id.length <= 200) && new Set(intent.objectIds).size === intent.objectIds.length;
}

export type CoursewareAttentionCue = {
  trigger?: CoursewareSpeechTrigger;
  /** Unique logical object owning a saved native effect; never a display step ordinal. */
  nativeAnimation?: string;
  id: string;
  atMs: number;
  endMs: number;
  effect: { type: "highlight"; elementIds: string[]; color?: string; style?: "outline" | "fill" | "glow"; opacity?: number } |
    { type: "spotlight"; elementId: string; elementIds?: string[]; dimOpacity?: number } |
    { type: "element_animation"; elementId: string; elementIds?: never; effect: "fadeIn" | "fadeOut" | "pulse" | "zoomIn" | "slideInLeft" | "slideInRight" | "gentleRotate" };
};

export function isCoursewareAttentionCue(value: unknown): value is CoursewareAttentionCue {
  const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
  const fields = (v: Record<string, unknown>, required: string[], optional: string[] = []) =>
    required.every(key => Object.hasOwn(v, key)) && Object.keys(v).every(key => required.includes(key) || optional.includes(key));
  const id = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 200;
  const unit = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
  if (!record(value) || !fields(value, ["id", "atMs", "endMs", "effect"], ["trigger", "nativeAnimation"]) || !id(value.id) ||
      typeof value.atMs !== "number" || !Number.isInteger(value.atMs) || value.atMs < 0 ||
      typeof value.endMs !== "number" || !Number.isInteger(value.endMs) || value.endMs <= value.atMs || value.endMs > 3_600_000 || !record(value.effect)) return false;
  if ((value.trigger !== undefined && (!isCoursewareSpeechTrigger(value.trigger) || value.effect.type !== "element_animation")) ||
      (value.nativeAnimation !== undefined && (!id(value.nativeAnimation) || value.effect.type !== "element_animation" || value.nativeAnimation !== value.effect.elementId))) return false;
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
  } else if (effect.type === "element_animation") {
    if (!fields(effect, ["type", "elementId", "effect"]) || !id(effect.elementId) ||
        !["fadeIn", "fadeOut", "pulse", "zoomIn", "slideInLeft", "slideInRight", "gentleRotate"].includes(String(effect.effect)) || value.endMs - value.atMs > 5000) return false;
    targets = [effect.elementId];
  } else return false;
  return targets.length <= COURSEWARE_ATTENTION_TARGET_LIMIT && targets.every(id) && new Set(targets).size === targets.length;
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

/** Portable teacher-led questions use the fixed player's existing checkpoint contract. */
export function isCoursewareInteractionCheckpoint(value: unknown): boolean {
  const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
  const fields = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).length === keys.length && keys.every(key => Object.hasOwn(v, key));
  const id = (v: unknown) => typeof v === "string" && /^[\w.-]{1,128}$/u.test(v) && v !== "." && v !== "..";
  const text = (v: unknown, max = 4000) => typeof v === "string" && !!v.trim() && v.length <= max;
  if (!record(value) || value.type !== "interaction_checkpoint" || !id(value.id) || !id(value.checkpointId)) return false;
  if (value.checkpointKind === "teacher_continue") return fields(value, ["id", "type", "checkpointId", "checkpointKind"]);
  const answer = value.referenceAnswer, context = value.context;
  return value.checkpointKind === "chapter_summary" && fields(value, ["id", "type", "checkpointId", "checkpointKind", "chapterId", "chapterTitle", "question", "referenceAnswer", "context", ...(Object.hasOwn(value, "response") ? ["response"] : [])]) &&
    (!Object.hasOwn(value, "response") || isCoursewareQuestionResponse(value.response)) &&
    id(value.chapterId) && text(value.chapterTitle, 1000) && text(value.question) &&
    record(answer) && fields(answer, ["summary", "keyPoints"]) && text(answer.summary) &&
    Array.isArray(answer.keyPoints) && answer.keyPoints.length > 0 && answer.keyPoints.length <= 8 && answer.keyPoints.every(point => text(point, 1000)) &&
    record(context) && fields(context, ["chapterSummary", "sourceSceneIds"]) && text(context.chapterSummary) &&
    Array.isArray(context.sourceSceneIds) && context.sourceSceneIds.length > 0 && context.sourceSceneIds.length <= 100 &&
    context.sourceSceneIds.every(id) && new Set(context.sourceSceneIds).size === context.sourceSceneIds.length;
}

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
      if (action.type === "delay") return fields(action, ["id", "type", "durationMs"]) && count(action.durationMs, 30_000);
      if (action.type === "video_slot") return fields(action, ["id", "type", "prompt"], ["durationSeconds"]) && id(action.id) &&
        typeof action.prompt === "string" && !!action.prompt.trim() && action.prompt.length <= 4000 &&
        (action.durationSeconds === undefined || Number.isInteger(action.durationSeconds) && Number(action.durationSeconds) >= 4 && Number(action.durationSeconds) <= 30);
      return isCoursewareInteractionCheckpoint(action);
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
  for (const key of ["audioId", "audioUrl", "audioAssetId", "duration", "durationMs", "visualCues", "speechCuePlans", "pptxCue", "attention"]) {
    delete changed[key];
  }
  if (Array.isArray(action.visualCues)) {
    const retained = action.visualCues.filter(isCoursewareAttentionCue).filter(cue => cue.trigger).map(cue =>
      ({ ...cue, trigger: rebaseSpeechTrigger(cue.trigger!, text) }));
    if (retained.length) changed.visualCues = retained;
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
  effectCues?: Array<{ pageNumber: number; effect: "highlight" | "spotlight" | "fadeIn" | "fadeOut" | "pulse" | "zoomIn" | "slideInLeft" | "slideInRight" | "gentleRotate"; atMs: number; endMs: number }>;
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

/** Only read/open races may be retried; callers must never retry writes with this predicate. */
export function isTransientTeachingRace(error: unknown): boolean {
  const message = String(error);
  return ["PPTX or current page changed; reload teaching", "Teaching view changed; reload current page",
    "No editable current slide", "Teaching is already opening"].some(text => message.includes(text));
}

/** Other pages may advance the revision without invalidating this recovery draft. */
export function sameTeachingDraftPage(baseline: CoursewareProject, current: CoursewareProject, pageId: string): boolean {
  const { pages: before, teachingRevision: _beforeRevision, ...beforeScope } = baseline;
  const { pages: after, teachingRevision: _afterRevision, ...afterScope } = current;
  const page = before.find(page => page.pageId === pageId);
  return !!page && JSON.stringify(beforeScope) === JSON.stringify(afterScope) &&
    JSON.stringify(page) === JSON.stringify(after.find(page => page.pageId === pageId));
}
