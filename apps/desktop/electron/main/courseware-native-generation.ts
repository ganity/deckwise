import { createHash, randomUUID } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { isCoursewareSceneTeaching, type CoursewareSceneTeaching, type CoursewarePlannedQuiz, type CoursewareProject } from "@pi-desktop/shared";
import { parseMaicClassroom } from "@pi-desktop/courseware-runtime/node";
import { coursewareAuthoringUrl } from "./courseware-runtime";
import { readNativeTeachingPackage } from "./courseware-native-package";
import { resolveRealOpenablePath, resolveRealPathForCreateWithinRoot } from "./fs-panel";
import { jobIdFor, listRevisions, publishRevision } from "./ppt-editor-files";

export type NativeGenerationPage = { pageId: string; title?: string; narration?: string; teaching?: CoursewareSceneTeaching; quiz?: CoursewarePlannedQuiz };
type Host = { call<T>(method: string, params: unknown): Promise<T> };
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Both generators use the same portable actions; no editable canonical classroom is created. */
function nativePages(pages: NativeGenerationPage[]) {
  return pages.map(page => {
    if (page.teaching && !isCoursewareSceneTeaching(page.teaching)) throw new Error("Invalid generated teaching requirements");
    const question = page.teaching?.question, actions: Array<Record<string, unknown>> = [];
    // Planning narration is evidence for the structured generator, never a completed speech.
    let narration = "";
    const title = page.title ?? page.teaching?.objective ?? "Teaching";
    if (page.quiz) {
      const classroom = parseMaicClassroom({ id: "generation", stage: { id: "generation", name: title, createdAt: 0, updatedAt: 0 },
        createdAt: new Date(0).toISOString(), scenes: [{ id: page.pageId, stageId: "generation", title, order: 0, type: "quiz", content: page.quiz, actions: [] }] });
      const quiz = classroom.scenes[0].content;
      if (quiz.type !== "quiz" || quiz.questions.length !== 1 || question) throw new Error("Generated Quiz requires one independent question");
      const q = quiz.questions[0], options = q.options ?? [];
      narration = [q.question, ...options.map(o => `${o.value}. ${o.label}`)].join("\n");
      actions.push({ id: `${page.pageId}-question`, type: "interaction_checkpoint", checkpointId: `${page.pageId}-checkpoint`,
        checkpointKind: "chapter_summary", chapterId: page.pageId, chapterTitle: title, question: q.question,
        response: { kind: q.type, options: options.map(o => o.label), answerIndices: options.flatMap((o, i) => q.answer?.includes(o.value) ? [i] : []) },
        referenceAnswer: { summary: q.referenceAnswer ?? (q.type === "short_answer" ? q.answer?.join("；") : q.analysis) ?? "", keyPoints: q.keyPoints ?? [] },
        context: { chapterSummary: [title, q.commentPrompt].filter(Boolean).join("\n"), sourceSceneIds: [page.pageId] } });
    } else if (question) {
      narration = question.text;
      actions.push({ id: `${page.pageId}-question`, type: "interaction_checkpoint", checkpointId: `${page.pageId}-checkpoint`,
        checkpointKind: "chapter_summary", chapterId: page.pageId, chapterTitle: title, question: question.text,
        response: question.response, referenceAnswer: question.referenceAnswer ?? { summary: "", keyPoints: [] },
        context: { chapterSummary: [page.teaching?.objective ?? title, question.constraintPrompt].filter(Boolean).join("\n"), sourceSceneIds: [page.pageId] } });
    }
    if (page.teaching?.music) actions.push({ id: `${page.pageId}-music`, type: "music_slot", title: page.teaching.music.purpose, prompt: page.teaching.music.prompt });
    if (page.teaching?.video) actions.push({ id: `${page.pageId}-video`, type: "video_slot", prompt: page.teaching.video.prompt });
    return { pageId: page.pageId, ...(question ? { questionText: question.text } : {}), ...(narration !== undefined ? { narration } : {}), actions };
  });
}

/** Publish complete native bytes first; attach only the verified generated path to the task. */
export async function publishNativeGeneratedCourse(input: {
  workspace: string; sessionId: string; title: string; pptx: Uint8Array; pages: NativeGenerationPage[]; host: Host;
  sceneProof?: { planSha256: string; principalKey: string; selectedIntentIds: string[] };
  sceneMapping?: unknown;
  presentation?: { path: string; sourceSha256: string; pages: import("@pi-desktop/shared").CoursewarePresentationPage[] };
  signal?: AbortSignal; assertCurrent?: () => Promise<void>;
}) {
  const check = async () => { input.signal?.throwIfAborted(); await input.assertCurrent?.(); input.signal?.throwIfAborted(); };
  await check();
  const { task } = await input.host.call<{ task?: { educationContext?: CoursewareProject["educationContext"] } }>("courseware.task.get", { sessionId: input.sessionId });
  await check();
  const educationContext = task?.educationContext;
  const url = coursewareAuthoringUrl();
  if (!url) throw new Error("Installed native courseware compiler is unavailable");
  const authoring = await import(/* @vite-ignore */ url) as typeof import("@pi-desktop/courseware-runtime/authoring");
  if (typeof authoring.packNativeTeachingPptx !== "function") throw new Error("Installed courseware compiler requires the native generation update");
  const bytes = await authoring.packNativeTeachingPptx({ source: input.pptx, title: input.title, pages: nativePages(input.pages),
    generation: { ...(educationContext ? { educationContext } : {}), sourceSha256: hash(input.pptx), pages: input.pages.map(({ pageId, title, narration, teaching, quiz }) => ({ pageId, title, narration, teaching, quiz })) } });
  await check();
  const native = await readNativeTeachingPackage(bytes);
  if (!native || native.pages.length !== input.pages.length) throw new Error("Generated native package validation failed");
  const sha256 = hash(bytes), relative = join(".deckwise-ppt", "generated", `${sha256}.pptx`);
  const path = await resolveRealPathForCreateWithinRoot(input.workspace, relative);
  if (!path) throw new Error("Generated course directory is outside the workspace");
  await fs.mkdir(dirname(path), { recursive: true });
  if (await resolveRealPathForCreateWithinRoot(input.workspace, relative) !== path) throw new Error("Generated course directory changed");
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporaryPath, bytes, { flag: "wx", mode: 0o600, flush: true });
    // Publish complete bytes without replacing an existing content-addressed source.
    try { await fs.link(temporaryPath, path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const file = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try { if (!(await file.stat()).isFile() || hash(await file.readFile()) !== sha256) throw new Error("Existing generated PPTX differs from content hash"); }
      finally { await file.close(); }
    }
    if (process.platform !== "win32") {
      const directory = await fs.open(dirname(path), "r");
      try { await directory.sync(); } finally { await directory.close(); }
    }
  } finally { await fs.rm(temporaryPath, { force: true }); }
  if (await resolveRealOpenablePath(path, input.workspace) !== path) throw new Error("Generated PPTX left the workspace");
  const revisionRoot = await resolveRealPathForCreateWithinRoot(input.workspace, join(".deckwise-ppt", "revisions")), documentId = jobIdFor(input.workspace, path);
  if (!revisionRoot || !await resolveRealPathForCreateWithinRoot(input.workspace, join(".deckwise-ppt", "revisions", documentId))) throw new Error("Generated revision directory escaped workspace");
  const saved = (await listRevisions(revisionRoot, documentId)).at(-1);
  if (saved && saved.sha256 !== sha256) throw new Error("Generated document already has a different saved revision");
  const revision = saved ?? await publishRevision({ root: revisionRoot, jobId: documentId, bytes: Buffer.from(bytes), extension: "pptx", cause: "generated", expectedRevision: 0 });
  const project: CoursewareProject = { schemaVersion: "deckwise-courseware/1", projectId: native.documentId, teachingRevision: native.revision,
    taskType: input.presentation ? "plain" : "scene", title: input.title, ...(educationContext ? { educationContext } : {}), source: { revision: native.revision, sha256 }, pages: native.pages };
  let jobId: string | undefined, terminal = false;
  try {
    await check();
    jobId = (await input.host.call<{ jobId: string }>("courseware.parseStart", { sessionId: input.sessionId, path: revision.documentPath })).jobId;
    while (true) {
      await check();
      const status = await input.host.call<{ status: string; message?: string; summary?: { sourceSha256: string } }>("courseware.parseStatus", { jobId });
      if (status.status === "RUNNING") { await delay(100, undefined, { signal: input.signal }); continue; }
      terminal = true;
      if (status.status !== "SUCCEEDED" || status.summary?.sourceSha256 !== sha256) throw new Error(status.message || "Generated native PPTX parsing failed");
      break;
    }
    await check();
    await input.host.call("courseware.task.attachNativeGenerated", { sessionId: input.sessionId, jobId, path, project, identity: native.identity,
      ...(input.sceneProof ? { sceneProof: input.sceneProof, sceneMapping: input.sceneMapping } : {}), ...(input.presentation ? { presentation: input.presentation } : {}) });
    return { path, project, projectId: project.projectId, sourceSha256: sha256, sha256, generated: true, nativeTeaching: true };
  } finally {
    if (jobId) {
      if (!terminal) { await input.host.call("courseware.parseCancel", { jobId }); while ((await input.host.call<{ status: string }>("courseware.parseStatus", { jobId })).status === "RUNNING") await delay(100); }
      await input.host.call("courseware.parseRelease", { jobId });
    }
  }
}
