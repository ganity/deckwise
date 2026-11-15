import {
  MEDIA_CANVAS_KINDS, type MediaCanvasKind, type MediaCanvasReference, type MediaCanvasDraft,
  type MediaCanvasViewport, type MediaCanvasDocument, type MediaCanvasDraftPatch,
} from "../../../../packages/shared/src/courseware-media-canvas.ts";
export * from "../../../../packages/shared/src/courseware-media-canvas.ts";

const text = (value: unknown, max: number, empty = false): value is string =>
  typeof value === "string" && value.length <= max && (empty || value.trim().length > 0);
const coordinate = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 100_000;
const revision = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

export function createMediaCanvasDocument(projectId: string): MediaCanvasDocument {
  if (!text(projectId, 512)) throw new Error("Invalid media canvas project");
  return { version: 1, projectId, revision: 0, viewport: { x: 24, y: 24, zoom: 1 }, drafts: [] };
}

export function parseMediaCanvasDocument(value: unknown, projectId: string): MediaCanvasDocument {
  if (!record(value) || value.version !== 1 || value.projectId !== projectId || !text(projectId, 512) || !revision(value.revision) ||
    !record(value.viewport) || !coordinate(value.viewport.x) || !coordinate(value.viewport.y) ||
    typeof value.viewport.zoom !== "number" || !Number.isFinite(value.viewport.zoom) || value.viewport.zoom < 0.2 || value.viewport.zoom > 3 ||
    !Array.isArray(value.drafts) || value.drafts.length > 100) throw new Error("Invalid media canvas document");
  const ids = new Set<string>();
  const drafts = value.drafts.map((draft): MediaCanvasDraft => {
    if (!record(draft) || !text(draft.id, 160) || ids.has(draft.id) || !revision(draft.revision) ||
      !MEDIA_CANVAS_KINDS.includes(draft.kind as MediaCanvasKind) || !text(draft.title, 160) || !text(draft.prompt, 16_000, true) ||
      !coordinate(draft.x) || !coordinate(draft.y) || !Array.isArray(draft.references) || draft.references.length > 16) throw new Error("Invalid media canvas draft");
    ids.add(draft.id);
    const references = draft.references.map((reference): MediaCanvasReference => {
      if (!record(reference) || !text(reference.assetId, 512) || !text(reference.revision, 512) || !text(reference.label, 512)) {
        throw new Error("Invalid media canvas reference");
      }
      return { assetId: reference.assetId, revision: reference.revision, label: reference.label };
    });
    if (new Set(references.map(reference => reference.assetId)).size !== references.length) throw new Error("Duplicate media canvas reference");
    return { id: draft.id, revision: draft.revision, kind: draft.kind as MediaCanvasKind, title: draft.title,
      prompt: draft.prompt, references, x: draft.x, y: draft.y };
  });
  return { version: 1, projectId, revision: value.revision,
    viewport: { x: value.viewport.x, y: value.viewport.y, zoom: value.viewport.zoom }, drafts };
}

function change(document: MediaCanvasDocument, patch: Partial<Pick<MediaCanvasDocument, "viewport" | "drafts">>): MediaCanvasDocument {
  return parseMediaCanvasDocument({ ...document, ...patch, revision: document.revision + 1 }, document.projectId);
}

export function addMediaCanvasDraft(document: MediaCanvasDocument, id: string, kind: MediaCanvasKind, title: string): MediaCanvasDocument {
  const offset = document.drafts.length % 8 * 28;
  return change(document, { drafts: [...document.drafts, { id, revision: 0, kind, title, prompt: "", references: [],
    x: (24 - document.viewport.x) / document.viewport.zoom + offset,
    y: (24 - document.viewport.y) / document.viewport.zoom + offset }] });
}

export function editMediaCanvasDraft(document: MediaCanvasDocument, id: string, expectedRevision: number, patch: MediaCanvasDraftPatch): MediaCanvasDocument {
  const draft = document.drafts.find(candidate => candidate.id === id);
  if (!draft || draft.revision !== expectedRevision) throw new Error("Media canvas draft changed; read it again before editing");
  if (Object.keys(patch).some(key => !["title", "prompt", "references"].includes(key))) throw new Error("Unsupported media canvas edit");
  return change(document, { drafts: document.drafts.map(candidate => candidate.id === id ? { ...candidate, ...patch, revision: candidate.revision + 1 } : candidate) });
}

export function moveMediaCanvasDraft(document: MediaCanvasDocument, id: string, x: number, y: number): MediaCanvasDocument {
  if (!document.drafts.some(draft => draft.id === id)) throw new Error("Media canvas draft no longer exists");
  return change(document, { drafts: document.drafts.map(draft => draft.id === id ? { ...draft, x, y } : draft) });
}

export function removeMediaCanvasDraft(document: MediaCanvasDocument, id: string): MediaCanvasDocument {
  if (!document.drafts.some(draft => draft.id === id)) throw new Error("Media canvas draft no longer exists");
  return change(document, { drafts: document.drafts.filter(draft => draft.id !== id) });
}

export function setMediaCanvasViewport(document: MediaCanvasDocument, viewport: MediaCanvasViewport): MediaCanvasDocument {
  return change(document, { viewport });
}

export function zoomMediaCanvasViewport(viewport: MediaCanvasViewport, zoom: number, anchorX: number, anchorY: number): MediaCanvasViewport {
  const next = Math.min(3, Math.max(0.2, zoom));
  return { x: anchorX - (anchorX - viewport.x) * next / viewport.zoom,
    y: anchorY - (anchorY - viewport.y) * next / viewport.zoom, zoom: next };
}
