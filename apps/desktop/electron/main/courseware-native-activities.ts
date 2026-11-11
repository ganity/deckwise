import { createHash } from "node:crypto";
import { isCoursewareQuestionResponse, isCoursewareInteractionCheckpoint, type CoursewareTeachingView } from "@pi-desktop/shared";
import { parseMaicClassroom } from "@pi-desktop/courseware-runtime/node";
import { coursewareAuthoringUrl } from "./courseware-runtime";
import type { CoursewareTeachingCoordinator } from "./courseware-teaching";

/** Reconcile an explicitly mapped plan activity through existing assessment projection/history. */
export async function insertNativeActivity(input: {
  teaching: CoursewareTeachingCoordinator; view: CoursewareTeachingView; args: Record<string, unknown>; check(): void;
}) {
  const { view, args } = input;
  const plan = view.enrichment?.plan;
  const unit = plan?.units.find(u => u.id === args.unitId);
  if (!unit || unit.kind === "teaching" || !view.enrichment || view.enrichmentCapabilities?.version !== 1 ||
      typeof args.apply !== "boolean" || typeof args.afterPageId !== "string") throw new Error("Bind a real lesson-plan activity before inserting its page");
  const matches = view.project.pages.flatMap(p => p.actions.filter(a => a.id === unit.activityId).map(action => ({ page: p, action })));
  if (matches.length === 1 && unit.pageIds.includes(matches[0].page.pageId)) return { applied: args.apply === true, saved: false, reused: true, pageId: matches[0].page.pageId };
  if (matches.length || unit.activityId) throw new Error("Existing activity binding is ambiguous or missing; reconcile it explicitly before inserting another page");
  const after = view.project.pages.findIndex(p => p.pageId === args.afterPageId);
  if (after < 0 || view.project.pages[after].locked || view.project.pages.length >= 100 || view.readOnly) throw new Error("Activity insertion target is unavailable");
  input.check();
  const capture = (await input.teaching.native("narration-context", {}, after + 1))?.value as {
    view: CoursewareTeachingView; editor: { editGeneration: number }; text: string; evidence: { width: number; height: number };
  } | undefined;
  input.check();
  if (!capture || JSON.stringify(capture.view.project) !== JSON.stringify(view.project)) throw new Error("Native activity target changed");
  if (typeof args.question !== "string" || !args.question.trim() || args.question.length > 160 || !isCoursewareQuestionResponse(args.response) ||
      typeof args.referenceEvidence !== "string" || !args.referenceEvidence.trim() || args.referenceEvidence.length > 4000 ||
      ![capture.text, ...plan!.units.map(u => u.evidence)].some(text => text.includes(String(args.referenceEvidence))))
    throw new Error("Activity needs a valid question, answer format and exact evidence from its page or accepted plan");
  const normalize = (text: string) => text.replace(/[\s\p{P}]/gu, "").toLocaleLowerCase();
  const duplicates = view.project.pages.flatMap(page => page.actions.flatMap(action =>
    action.type === "interaction_checkpoint" && typeof action.question === "string" && normalize(action.question) === normalize(String(args.question))
      ? [{ pageId: page.pageId, activityId: String(action.id), question: action.question }] : []));
  if (duplicates.length) return { applied: false, saved: false, requiresMapping: true, duplicateCandidates: duplicates };
  // Imported slides may contain a visible question without executable assessment metadata.
  const visibleCandidates: Array<{ pageId: string; question: string; requiresConversion: true }> = [];
  for (const [index, page] of view.project.pages.entries()) {
    input.check();
    const current = index === after ? capture : (await input.teaching.native("narration-context", {}, index + 1))?.value as typeof capture;
    input.check();
    if (!current || JSON.stringify(current.view.project) !== JSON.stringify(view.project)) throw new Error("Teaching changed while checking existing questions");
    if (normalize(current.text).includes(normalize(args.question))) visibleCandidates.push({ pageId: page.pageId, question: args.question, requiresConversion: true });
  }
  if (visibleCandidates.length) return { applied: false, saved: false, requiresMapping: true, duplicateCandidates: visibleCandidates };
  const response = args.response;
  if (unit.kind === "checkpoint" && ["single", "multiple", "judge"].includes(response.kind)) throw new Error("Objective questions require an independent Quiz page");
  if (unit.kind === "quiz" && ["discussion", "practice", "pbl"].includes(response.kind)) throw new Error("Teacher-led activities require a checkpoint page");
  for (const i of response.answerIndices) if (!args.referenceEvidence.toLocaleLowerCase().includes(response.options[i].toLocaleLowerCase()))
    throw new Error("The selected answer is not backed by the supplied exact evidence");
  const identity = createHash("sha256").update(plan!.sha256 + ":" + unit.id).digest("hex").slice(0, 40);
  const pageId = `activity-${identity}`, activityId = `question-${identity}`;
  const checkpoint = { id: activityId, type: "interaction_checkpoint", checkpointId: activityId, checkpointKind: "chapter_summary",
    chapterId: pageId, chapterTitle: unit.title, question: args.question, response,
    referenceAnswer: { summary: args.referenceEvidence, keyPoints: [args.referenceEvidence] },
    context: { chapterSummary: unit.title, sourceSceneIds: [args.afterPageId] } };
  if (!isCoursewareInteractionCheckpoint(checkpoint)) throw new Error("Invalid checkpoint content");
  // Quiz owns its answer key; a checkpoint owns its teacher guidance. Both have one visible question.
  const quiz = { type: "quiz", interactionMode: "classroom_instant_feedback", questions: [{ id: activityId, type: response.kind,
    question: args.question, options: response.options.map((label, i) => ({ value: String.fromCharCode(65 + i), label })),
    answer: response.kind === "short_answer" ? args.referenceEvidence : response.answerIndices.map(i => String.fromCharCode(65 + i)),
    explanation: args.referenceEvidence, referenceAnswer: args.referenceEvidence }] };
  const width = capture.evidence.width, height = capture.evidence.height;
  if (![width, height].every(n => Number.isFinite(n) && n > 0)) throw new Error("Native canvas dimensions are unavailable");
  const canvas = { width: 1000, height: height / width * 1000 };
  const escape = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const { response: _localResponse, ...maicCheckpoint } = checkpoint;
  const classroom = parseMaicClassroom({ id: view.project.projectId, createdAt: new Date(0).toISOString(),
    stage: { id: view.project.projectId, name: view.project.title, createdAt: 0, updatedAt: 0 },
    scenes: [{ id: pageId, stageId: view.project.projectId, order: 0, title: unit.title, type: unit.kind === "quiz" ? "quiz" : "slide",
      content: unit.kind === "quiz" ? quiz : { type: "slide", canvas: { id: pageId, viewportSize: canvas.width, viewportRatio: canvas.height / canvas.width,
        theme: { backgroundColor: "#FFFFFF", themeColors: ["#3B82F6"], fontColor: "#111827", fontName: "Noto Sans SC" }, elements: [{ id: `${pageId}_question`, type: "text",
        left: 80, top: canvas.height * .2, width: 840, height: canvas.height * .5, content: `<p style="font-size:32px">${escape(args.question)}</p>`,
        defaultFontName: "Noto Sans SC", defaultColor: "#111827" }] } }, actions: unit.kind === "checkpoint" ? [maicCheckpoint] : [] }] });
  const url = coursewareAuthoringUrl();
  if (!url) throw new Error("Assessment authoring module is unavailable");
  const authoring = await import(/* @vite-ignore */ url) as typeof import("@pi-desktop/courseware-runtime/authoring");
  const projection = authoring.assessmentPptxScene(classroom.scenes[0], `sha256:${view.project.source.sha256}`, canvas);
  const enrichment = structuredClone(view.enrichment);
  const mapped = enrichment.plan!.units.find(u => u.id === unit.id)!;
  mapped.pageIds = [pageId]; mapped.activityId = activityId;
  const reading = [args.question, ...response.options.map((option, i) => `${String.fromCharCode(65 + i)}. ${option}`)].join("\n");
  const actions = [{ id: `reading-${identity}`, type: "speech", text: reading, source: "generated" }, checkpoint];
  if (!args.apply) return { applied: false, saved: false, preview: true, pageId, activityId, afterPageId: args.afterPageId, question: args.question };
  input.check();
  const latest = (await input.teaching.native("open", {}, after + 1))?.value as CoursewareTeachingView | undefined;
  if (!latest || JSON.stringify(latest.project) !== JSON.stringify(view.project) || JSON.stringify(latest.enrichment) !== JSON.stringify(view.enrichment)) throw new Error("Activity mapping changed during preparation");
  const result = await input.teaching.native("assessment-insert", { viewId: capture.view.viewId,
    expectedTeachingRevision: view.project.teachingRevision, expectedEditGeneration: capture.editor.editGeneration,
    pageId, actions, enrichment, projection, ...(unit.kind === "quiz" ? { quiz: classroom.scenes[0].content } : {}) }, after + 1);
  input.check();
  if (!result) throw new Error("Activity insertion outcome unavailable; reread context before retrying");
  return { applied: true, saved: false, pageId, activityId };
}
