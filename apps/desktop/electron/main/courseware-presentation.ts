import { setTimeout as delay } from "node:timers/promises";
import { constants, promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { coursewarePresentationIssues, isCoursewarePresentationPages, type CoursewareProject } from "@pi-desktop/shared";
import { canonicalJson, decodeHtmlEntities, mapMaicSlideIrToScenes, parseMaicClassroom, prepareMaicAssessmentSpeech } from "@pi-desktop/courseware-runtime/node";
import { adoptionRevision, readLiveSource, sourceHash } from "./courseware-source-files";
import type { NativeClassroomSeed } from "./courseware-classroom-native";

type Host = { call<T>(method: string, args: unknown): Promise<T> };
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Official exports enter the same Host-owned teaching and assessment lifecycle as saved decks. */
export async function adoptPresentation(input: {
  host: Host; workspace: string; sessionId: string; args: Record<string, unknown>; check(): void;
}) {
  const { host, workspace, sessionId, args, check } = input;
  if (Object.keys(args).some(key => !["path", "sourceSha256", "pages", "continueTeaching"].includes(key)) ||
      typeof args.path !== "string" || typeof args.sourceSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(args.sourceSha256) ||
      !isCoursewarePresentationPages(args.pages) || args.continueTeaching !== undefined && typeof args.continueTeaching !== "boolean")
    throw new Error(`Invalid presentation teaching plan: ${coursewarePresentationIssues(args.pages).join("; ") || "expected path, sourceSha256, pages and optional continueTeaching only"}`);
  const pages = args.pages, path = args.path;
  const bytes = await readLiveSource(workspace, path); check();
  if (sourceHash(bytes) !== args.sourceSha256) throw new Error("Exported presentation changed; read the actual source again");
  const planPath = join(dirname(dirname(path)), "presentation-plan.json");
  try {
    const file = await fs.open(planPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw new Error("Invalid saved presentation plan");
      const plan = JSON.parse(await file.readFile("utf8"));
      if (plan.version !== 1 || canonicalJson(plan.pages) !== canonicalJson(pages))
        throw new Error("Adoption differs from presentation-plan.json; preserve the saved assessment plan");
    } finally { await file.close(); }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  check();
  const revision = await adoptionRevision(workspace, path, bytes); check();
  let jobId: string | undefined, terminal = false;
  try {
    jobId = (await host.call<{ jobId: string }>("courseware.parseStart", { sessionId, path: revision.documentPath })).jobId;
    const deadline = Date.now() + 90_000;
    while (true) {
      check();
      const status = await host.call<{ status: string; message?: string; summary?: { sourceSha256: string; pages: number } }>("courseware.parseStatus", { jobId }); check();
      if (status.status !== "RUNNING") {
        terminal = true;
        if (status.status !== "SUCCEEDED" || status.summary?.sourceSha256 !== args.sourceSha256 || status.summary.pages !== pages.length)
          throw new Error(status.message || "Presentation teaching plan differs from the exported physical pages");
        break;
      }
      if (Date.now() >= deadline) throw new Error("Presentation parsing timed out");
      await delay(100);
    }
    const { project } = await host.call<{ project: CoursewareProject }>("courseware.project.openSaved", { sessionId, jobId }); check();
    const seed = await host.call<NativeClassroomSeed>("courseware.classroom.source", { sessionId, jobId, projectId: project.projectId }); check();
    if (seed.classroom) {
      // Adoption is retryable, but never reconstructs an independently edited classroom.
      const result = await host.call("courseware.presentation.adopt", { sessionId, jobId, path, sourceSha256: args.sourceSha256,
        projectId: project.projectId, pages, classroom: seed.classroom }); check();
      return result;
    }
    const now = Date.now(), stageId = `${project.projectId}-stage`;
    const scenes = mapMaicSlideIrToScenes(stageId, seed.ir).map((slide, index) => {
      const page = pages[index], pageId = project.pages[index].pageId;
      const question = page.teaching.question;
      const metadata = { ...slide.metadata, nativePageId: pageId, nativeNarrationText: "", teachingRequirements: page.teaching };
      if (page.quiz) return { ...slide, id: pageId, title: page.quiz.questions[0].question, type: "quiz" as const,
        content: { ...page.quiz, interactionMode: page.quiz.interactionMode ?? "classroom_instant_feedback" as const }, actions: [], metadata };
      if (!question) return { ...slide, id: pageId, actions: [], metadata };
      if (slide.content.type !== "slide") throw new Error("Presentation interaction requires a native slide");
      const matches = slide.content.canvas.elements.filter(element => element.type === "text" &&
        decodeHtmlEntities(element.content.replace(/<[^>]*>/gu, "")).replaceAll("\u00a0", " ").trim() === question.text.trim());
      if (matches.length !== 1) throw new Error(`Page ${index + 1}: bind the exact interaction question to one exported text box`);
      const id = `${pageId}-checkpoint`;
      return { ...slide, id: pageId, actions: [{ id, type: "interaction_checkpoint" as const, checkpointId: id,
        checkpointKind: "chapter_summary" as const, chapterId: pageId, chapterTitle: slide.title, question: question.text,
        ...(question.constraintPrompt ? { constraintPrompt: question.constraintPrompt } : {}),
        referenceAnswer: question.referenceAnswer ?? { summary: page.teaching.objective, keyPoints: [] },
        context: { chapterSummary: page.teaching.objective, sourceSceneIds: [pageId] } }],
        metadata: { ...metadata, nativeQuestionElementId: matches[0].id, nativeQuestionText: question.text } };
    });
    const classroom = prepareMaicAssessmentSpeech(parseMaicClassroom({ id: project.projectId, createdAt: new Date(now).toISOString(),
      stage: { id: stageId, name: project.title, createdAt: now, updatedAt: now }, scenes }));
    if (sourceHash(await readLiveSource(workspace, path)) !== args.sourceSha256) throw new Error("Presentation source changed before adoption");
    check();
    const result = await host.call<unknown>("courseware.presentation.adopt", { sessionId, jobId, path,
      sourceSha256: args.sourceSha256, projectId: project.projectId, pages, classroom }); check();
    if (!record(result) || result.generated !== true) throw new Error("Invalid presentation adoption receipt");
    return result;
  } finally {
    if (jobId) {
      if (!terminal) {
        await host.call("courseware.parseCancel", { jobId });
        while ((await host.call<{ status: string }>("courseware.parseStatus", { jobId })).status === "RUNNING") await delay(100);
      }
      await host.call("courseware.parseRelease", { jobId });
    }
  }
}
