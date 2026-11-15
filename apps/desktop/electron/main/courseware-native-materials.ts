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
    if (assignments.length > segments.length || new Set(assignments.map(a => a.segmentId)).size !== assignments.length ||
        assignments.some(a => !segments.some(s => s.id === a.segmentId) || !pages.some(p => p.pageId === a.pageId))) throw new Error("Invalid or duplicate script assignments");
    const digest = hash(source.text);
    for (const segment of segments) {
      const labelled = enrichment.originalPages.find(p => p.pageNumber === segment.sourcePageNumber)?.pageId;
      const explicit = assignments.find(a => a.segmentId === segment.id)?.pageId;
      if (explicit && labelled && explicit !== labelled) throw new Error("Script assignment contradicts its original page label");
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
    const anchored = segments.filter(s => s.pageId).map(s => enrichment.originalPages.findIndex(p => p.pageId === s.pageId));
    if (anchored.some((n, i) => n < 0 || i > 0 && n < anchored[i - 1])) throw new Error("Script assignments are out of original page order");
    const silentPageIds = source.silentPageIds ?? [];
    if (silentPageIds.some(id => !pages.some(p => p.pageId === id))) throw new Error("Silent page is unavailable");
    enrichment.script = { sha256: digest, policy: source.policy, segments, silentPageIds };
    for (const page of pages) {
      const selected = segments.filter(s => s.pageId === page.pageId);
      if (!selected.length && !silentPageIds.includes(page.pageId)) continue;
      if (page.locked) throw new Error("Script target is manually locked");
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
    if (typeof plan.text !== "string" || !plan.text.trim() || plan.text.length > 500000 ||
        !Array.isArray(plan.units) || plan.units.some(u => typeof u.evidence !== "string" || !plan.text.includes(u.evidence) ||
          !Array.isArray(u.pageIds) || u.pageIds.some(id => !pages.some(p => p.pageId === id)))) throw new Error("Lesson-plan mapping requires exact source evidence and real pages");
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
