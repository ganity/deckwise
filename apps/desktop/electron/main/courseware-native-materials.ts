import { createHash } from "node:crypto";
import { isCoursewareEnrichment, parseCoursewareScript, inspectCoursewareEnrichment,
  type CoursewareEnrichment, type CoursewareTeachingView, type PptEditorContext } from "@pi-desktop/shared";
import type { CoursewareTeachingCoordinator } from "./courseware-teaching";

export type NativeMaterials = {
  apply: boolean;
  script?: { text: string; policy: "preserve" | "revise" | "generate-missing";
    assignments?: Array<{ segmentId: string; pageId: string }>; silentPageIds?: string[] };
  lessonPlan?: { text: string; units: NonNullable<CoursewareEnrichment["plan"]>["units"] };
};
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
type Capture = { view: CoursewareTeachingView; editor: PptEditorContext; text: string; evidence: unknown };

/** Deterministic material adoption; never calls a model or creates speech to fill gaps. */
export async function adoptNativeMaterials(input: {
  teaching: CoursewareTeachingCoordinator; materials: NativeMaterials; view: CoursewareTeachingView;
  check(): void;
}) {
  const { materials, view } = input;
  if (view.enrichmentCapabilities?.version !== 1) throw new Error("This editor cannot preserve teaching sources; update the paired editor before applying materials");
  if (typeof materials.apply !== "boolean" || !materials.script && !materials.lessonPlan) throw new Error("Select a script or lesson plan");
  if (view.readOnly) throw new Error("Teaching is read-only");
  const enrichment: CoursewareEnrichment = structuredClone(view.enrichment ?? {
    schemaVersion: "deckwise-teaching-enrichment/1",
    originalPages: view.project.pages.map((p, index) => ({ pageId: p.pageId, pageNumber: index + 1 })),
  });
  const pages = structuredClone(view.project.pages);
  const changes = new Set<string>();
  if (materials.script) {
    const source = materials.script;
    const segments = parseCoursewareScript(source.text);
    const assignments = source.assignments ?? [];
    if (!Array.isArray(assignments)) throw new Error("script.assignments must be an array of segment-to-page mappings");
    const assigned = new Set<string>();
    for (const [index, item] of assignments.entries()) {
      const field = `script.assignments[${index}]`;
      if (!item || typeof item !== "object") throw new Error(`${field} requires segmentId and pageId`);
      if (!segments.some(s => s.id === item.segmentId)) throw new Error(`${field}.segmentId: unknown segment ${item.segmentId}; use a segment from this script preview`);
      if (assigned.has(item.segmentId)) throw new Error(`${field}.segmentId: duplicate assignment for ${item.segmentId}; keep one mapping`);
      if (!pages.some(p => p.pageId === item.pageId)) throw new Error(`${field}.pageId: page ${item.pageId} is unavailable for segment ${item.segmentId}; read current page IDs`);
      assigned.add(item.segmentId);
    }
    const digest = hash(source.text);
    for (const segment of segments) {
      const labelled = enrichment.originalPages.find(p => p.pageNumber === segment.sourcePageNumber)?.pageId;
      const explicit = assignments.find(a => a.segmentId === segment.id)?.pageId;
      if (explicit && labelled && explicit !== labelled) throw new Error(`Script assignment contradicts its original page label: segment ${segment.id} belongs to page ${labelled}, received ${explicit}`);
      const pageId = labelled ?? explicit;
      if (pageId && pages.some(p => p.pageId === pageId)) {
        segment.pageId = pageId;
        segment.actionId = `script-${hash(digest + segment.id).slice(0, 40)}`;
      }
    }
    // Explicit anchors constrain unlabelled paragraphs. A unique remaining page is deterministic.
    for (let i = 0; i < segments.length; i++) {
      if (segments[i].pageId || segments[i].sourcePageNumber !== undefined) continue;
      const before = segments.slice(0, i).findLast(s => s.pageId)?.pageId;
      const after = segments.slice(i + 1).find(s => s.pageId)?.pageId;
      const start = enrichment.originalPages.findIndex(p => p.pageId === before);
      const end = after ? enrichment.originalPages.findIndex(p => p.pageId === after) : enrichment.originalPages.length - 1;
      const candidates = enrichment.originalPages.filter((p, index) => index >= Math.max(0, start) && index <= end && pages.some(page => page.pageId === p.pageId));
      if (candidates.length === 1) {
        segments[i].pageId = candidates[0].pageId;
        segments[i].actionId = `script-${hash(digest + segments[i].id).slice(0, 40)}`;
      }
    }
    let previousPage = -1;
    for (const segment of segments.filter(s => s.pageId)) {
      const position = enrichment.originalPages.findIndex(p => p.pageId === segment.pageId);
      if (position < 0 || position < previousPage) throw new Error(`Script assignments are out of original page order at ${segment.id} (page ${segment.pageId}); correct this mapping`);
      previousPage = position;
    }
    const silentPageIds = source.silentPageIds ?? [];
    if (!Array.isArray(silentPageIds)) throw new Error("script.silentPageIds must be an array");
    for (const [i, id] of silentPageIds.entries()) {
      if (!pages.some(p => p.pageId === id)) throw new Error(`script.silentPageIds[${i}]: page ${id} is unavailable`);
      if (silentPageIds.indexOf(id) !== i || segments.some(s => s.pageId === id)) throw new Error(`script.silentPageIds[${i}]: page ${id} must be unique and have no assigned speech`);
    }
    if (!["preserve", "revise", "generate-missing"].includes(source.policy)) throw new Error("script.policy must be preserve, revise or generate-missing");
    enrichment.script = { sha256: digest, policy: source.policy, segments, silentPageIds };
    for (const page of pages) {
      const selected = segments.filter(s => s.pageId === page.pageId);
      if (!selected.length && !silentPageIds.includes(page.pageId)) continue;
      if (page.locked) throw new Error(`Script target ${page.pageId} is manually locked; inspect the saved page before applying its script`);
      const used = new Set<string>();
      const speeches = selected.map(s => {
        const matching = page.actions.filter(a => a.type === "speech" && a.text === s.text && !used.has(String(a.id)));
        const existing = matching.find(a => a.id === s.actionId) ?? (matching.length === 1 ? matching[0] : undefined);
        if (existing) { s.actionId = String(existing.id); used.add(s.actionId); }
        return existing ?? { id: s.actionId!, type: "speech", text: s.text, source: "external" };
      });
      // Preserve media, checkpoints and native animations at their original timeline positions.
      let cursor = 0;
      const oldCount = page.actions.filter(a => a.type === "speech").length;
      const actions = page.actions.flatMap(a => {
        if (a.type !== "speech") return [a];
        const replacement = speeches[cursor++];
        const extra = cursor === oldCount ? speeches.slice(cursor) : [];
        return [...(replacement ? [replacement] : []), ...extra];
      });
      if (!oldCount) actions.unshift(...speeches);
      if (JSON.stringify(page.actions) !== JSON.stringify(actions)) { page.actions = actions; changes.add(page.pageId); }
    }
  }
  if (materials.lessonPlan) {
    const plan = materials.lessonPlan;
    if (typeof plan.text !== "string" || !plan.text.trim() || plan.text.length > 500000) throw new Error("lessonPlan.text must contain 1-500000 characters of source text");
    if (!Array.isArray(plan.units) || !plan.units.length || plan.units.length > 100) throw new Error("lessonPlan.units must contain 1-100 units");
    const unitIds = new Set<string>();
    for (const [index, unit] of plan.units.entries()) {
      const field = `lessonPlan.units[${index}]`;
      if (!unit || typeof unit.id !== "string" || !/^[\w.-]{1,128}$/u.test(unit.id) || unitIds.has(unit.id)) throw new Error(`${field}.id must be a unique unit identifier`);
      unitIds.add(unit.id);
      if (typeof unit.title !== "string" || !unit.title.trim() || unit.title.length > 200) throw new Error(`${field}.title must contain 1-200 characters`);
      if (!["teaching", "quiz", "checkpoint"].includes(unit.kind)) throw new Error(`${field}.kind must be teaching, quiz or checkpoint`);
      if (!unit || typeof unit.evidence !== "string" || !unit.evidence.trim() || !plan.text.includes(unit.evidence)) throw new Error(`${field}.evidence: quote the exact source passage for this unit`);
      if (!Array.isArray(unit.pageIds) || new Set(unit.pageIds).size !== unit.pageIds.length) throw new Error(`${field}.pageIds must be an array of unique current page IDs`);
      for (const id of unit.pageIds) if (!pages.some(p => p.pageId === id)) throw new Error(`${field}.pageIds: page ${id} is unavailable; update this unit using current page IDs`);
    }
    enrichment.plan = { sha256: hash(plan.text), units: structuredClone(plan.units) };
  }
  if (!isCoursewareEnrichment(enrichment)) throw new Error("Invalid teaching material policy or mapping");
  const coverage = inspectCoursewareEnrichment(enrichment, pages);
  if (!materials.apply) return { applied: false, saved: false, preview: true, enrichment, coverage,
    pages: [...changes].map(pageId => ({ pageId, applied: false })) };
  // Metadata-only changes also go through a page's single native history/CAS transaction.
  if (!changes.size) changes.add(pages.find(p => !p.locked)?.pageId ?? "");
  let live = view.project;
  const savedPages: Array<{ pageId: string; pageNumber: number; applied: boolean }> = [];
  const failures: Array<{ pageId: string; error: string }> = [];
  for (const pageId of changes) {
    try {
    const n = live.pages.findIndex(p => p.pageId === pageId) + 1;
    if (!n) throw new Error("No editable page is available for source adoption");
    input.check();
    const before = (await input.teaching.native("narration-context", {}, n))?.value as Capture | undefined;
    input.check();
    if (!before?.editor || before.editor.readOnly || JSON.stringify(before.view.project) !== JSON.stringify(live)) throw new Error("Teaching changed before material adoption");
    const desired = pages.find(p => p.pageId === pageId)!;
    let result;
    try {
      result = await input.teaching.native("write", { viewId: before.view.viewId, expectedTeachingRevision: live.teachingRevision,
        expectedEditGeneration: before.editor.editGeneration, actions: desired.actions, enrichment }, n);
    } catch (error) {
      input.check();
      const reread = (await input.teaching.native("open", {}, n))?.value as CoursewareTeachingView | undefined;
      if (!reread || reread.project.projectId !== live.projectId || JSON.stringify(reread.enrichment) !== JSON.stringify(enrichment) ||
          JSON.stringify(reread.project.pages.find(p => p.pageId === pageId)?.actions) !== JSON.stringify(desired.actions)) throw error;
      result = { value: reread };
    }
    input.check();
    if (!result) throw new Error("Material write outcome unavailable; reread saved teaching before retrying");
    live = (result.value as CoursewareTeachingView).project;
    savedPages.push({ pageId, pageNumber: n, applied: true });
    } catch (error) {
      if (!savedPages.length) throw error;
      failures.push({ pageId, error: String(error) });
      break;
    }
  }
  return { applied: savedPages.length > 0, saved: false, pages: savedPages, failures, coverage: inspectCoursewareEnrichment(enrichment, live.pages),
    unmatchedSegments: enrichment.script?.segments.filter(s => !s.pageId).map(s => ({ id: s.id, sourceLine: s.sourceLine })) ?? [] };
}
