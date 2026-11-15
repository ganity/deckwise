import { createHash, randomUUID } from "node:crypto";
import type { DesktopAuthSession } from "./auth-session";
import type { CoursewareClassroomCoordinator } from "./courseware-classroom";
import type { CoursewareImageRequest } from "./courseware-media";
import { coursewareMediaSubmissionProject } from "./courseware-media-scope";

type Host = { call<T>(method: string, params: unknown): Promise<T> };
type Selection = { sessionId: string; projectId: string; expectedRevision: string; expectedSourceRevision: string;
  sceneId: string; questionId: string; optionValue: string; model: string };
export type QuizImageReview = (input: { sessionId: string; question: unknown; option: { value: string; label: string }; bytes: Buffer }) => Promise<void>;
type Quote = { quote: Awaited<ReturnType<DesktopAuthSession["coursewareMedia"]["getImageQuote"]>>; key: string; principalKey: string; revision: string; sourceRevision: string };
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const string = (value: unknown): value is string => typeof value === "string" && !!value.trim() && value.length <= 512;

function selection(value: unknown): Selection {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid classroom image request");
  const input = value as Record<string, unknown>;
  if (["sessionId", "projectId", "expectedRevision", "expectedSourceRevision", "sceneId", "questionId", "optionValue", "model"].some(key => !string(input[key])) ||
      Object.keys(input).some(key => !["sessionId", "projectId", "expectedRevision", "expectedSourceRevision", "sceneId", "questionId", "optionValue", "model", "quoteId"].includes(key)))
    throw new Error("Invalid classroom image selection");
  return input as Selection;
}

export class CoursewareClassroomImages {
  private quotes = new Map<string, Quote>();
  private active = new Set<string>();
  constructor(private input: {
    auth: Pick<DesktopAuthSession, "getCoursewarePrincipal" | "coursewareMedia">;
    classroom: Pick<CoursewareClassroomCoordinator, "open" | "image">;
    getHost: () => Host | null; getWorkspace: () => Promise<string | null>;
    assertOwned: (sessionId: string) => void; review: QuizImageReview;
  }) {}

  async models(value: unknown) {
    const sessionId = value && typeof value === "object" ? Reflect.get(value, "sessionId") : undefined;
    if (!string(sessionId)) throw new Error("Invalid classroom image session");
    this.input.assertOwned(sessionId);
    const principal = this.input.auth.getCoursewarePrincipal(), models = await this.input.auth.coursewareMedia.getImageModels();
    this.input.assertOwned(sessionId); principal.assertCurrent();
    return models.map(({ model }) => model);
  }

  private async context(value: unknown) {
    const args = selection(value); this.input.assertOwned(args.sessionId);
    const principal = this.input.auth.getCoursewarePrincipal(), host = this.input.getHost(), workspace = await this.input.getWorkspace();
    if (!host || !workspace) throw new Error("Classroom image workspace unavailable");
    const check = async () => {
      this.input.assertOwned(args.sessionId); principal.assertCurrent();
      if (host !== this.input.getHost() || workspace !== await this.input.getWorkspace()) throw new Error("Classroom image owner changed");
      const current = await this.input.classroom.open({ sessionId: args.sessionId });
      if (current.readOnly || current.revision !== args.expectedRevision || current.sourceRevision !== args.expectedSourceRevision) throw new Error("Classroom changed; reopen image generation");
    };
    const view = await this.input.classroom.open({ sessionId: args.sessionId }); await check();
    if (view.projectId !== args.projectId || !view.classroom) throw new Error("Canonical classroom not found");
    const scene = view.classroom.scenes.find(item => item.id === args.sceneId), question = scene?.content.type === "quiz" ? scene.content.questions.find(item => item.id === args.questionId) : undefined;
    const option = question?.options?.find(item => item.value === args.optionValue);
    if (!scene || !question || !option || !option.label.trim()) throw new Error("Saved Quiz option text required");
    const legacyPrompt = `Create one clear educational illustration for a classroom multiple-choice question. Lesson: ${view.classroom.stage.name}. Question: ${question.question}. Illustrate option ${option.value}: ${option.label}. Do not include letters, words, labels, borders, or multiple panels. Compose a centered square image appropriate for this lesson.`;
    const prompt = `Create a neutral, centered square educational illustration of this option alone: ${option.label}. Show its ordinary identity and properties. Do not imply that it satisfies an unstated question or add forces, motion, interactions, correctness marks, comparisons or other answer clues. No letters, words, labels, borders or multiple panels.`;
    const request: CoursewareImageRequest = { kind: "image", model: args.model, input: prompt };
    const reference = (input: string) => {
      const requestHash = hash([request.kind, request.model, input, null]
        .reduce<string>((text, field) => `${text}:${field === null ? -1 : field.length}:${field ?? ""}`, "courseware-media-v1"));
      return { requestHash, idempotencyKey: `maic-${hash(JSON.stringify([principal.key, args.projectId, args.sceneId, args.questionId, args.optionValue, requestHash]))}` };
    };
    const ref = reference(prompt), legacy = reference(legacyPrompt);
    const find = async () => {
      for (const ref of [reference(prompt), legacy]) {
        const task = await this.input.auth.coursewareMedia.findImage(ref); await check();
        if (task) return { ...ref, task };
      }
      return null;
    };
    return { args, host, workspace, principal, view, request, ...ref, key: ref.idempotencyKey, check, find, question, option };
  }

  async quote(value: unknown) {
    const context = await this.context(value), quote = await this.input.auth.coursewareMedia.getImageQuote(context.args.model);
    await context.check();
    if (context.request.input.length > quote.maxChars) throw new Error("Quiz image prompt exceeds model text limit");
    for (const [key, saved] of this.quotes) if (Date.parse(saved.quote.expiresAt) <= Date.now()) this.quotes.delete(key);
    if (this.quotes.size >= 100) this.quotes.delete(this.quotes.keys().next().value!);
    const quoteId = randomUUID(); this.quotes.set(quoteId, { quote, key: context.key, principalKey: context.principal.key,
      revision: context.args.expectedRevision, sourceRevision: context.args.expectedSourceRevision });
    return { key: context.key, state: "quoted", quote: { quoteId, maxPoints: quote.maxPoints, expiresAt: quote.expiresAt } };
  }

  async submit(value: unknown) {
    const context = await this.context(value), quoteId = Reflect.get(value as object, "quoteId"), saved = typeof quoteId === "string" ? this.quotes.get(quoteId) : undefined;
    if (!saved || saved.key !== context.key || saved.principalKey !== context.principal.key || saved.revision !== context.args.expectedRevision ||
        saved.sourceRevision !== context.args.expectedSourceRevision || Date.parse(saved.quote.expiresAt) <= Date.now()) throw new Error("Confirm a current Quiz image quote first");
    if (this.active.has(context.key)) throw new Error("Quiz image submission already running");
    this.active.add(context.key);
    try {
      const previous = await context.find();
      await context.check();
      const task = previous?.task ?? await this.input.auth.coursewareMedia.submitConfirmedImage(context.key, context.request, saved.quote, undefined, undefined, context.check, async () => {
        const scope = await context.host.call(context.view.nativeTeaching ? "courseware.mediaRelay.scope" : "courseware.classroom.mediaScope", { sessionId: context.args.sessionId, ...(context.view.nativeTeaching ? {} : { projectId: context.args.projectId, expectedRevision: context.args.expectedRevision, expectedSourceRevision: context.args.expectedSourceRevision }) });
        await context.check(); return coursewareMediaSubmissionProject(scope, context.args.sessionId);
      });
      await context.check(); this.quotes.delete(String(quoteId));
      return { key: previous?.idempotencyKey ?? context.key, state: task.state, task };
    } finally { this.active.delete(context.key); }
  }

  async refresh(value: unknown) {
    const context = await this.context(value);
    const found = await context.find(); await context.check();
    if (!found) return { key: context.key, state: "not_submitted" };
    const taskRef = { taskId: found.task.taskId, idempotencyKey: found.idempotencyKey, requestHash: found.requestHash }, task = await this.input.auth.coursewareMedia.getImage(taskRef); await context.check();
    if (task.state !== "ready") return { key: context.key, state: task.state, task };
    const downloaded = await this.input.auth.coursewareMedia.downloadImage(taskRef), asset = downloaded.task.assetRef;
    await context.check();
    if (!asset || !["image/png", "image/jpeg", "image/webp"].includes(asset.mime) || downloaded.bytes.length > 5 * 1024 * 1024)
      throw new Error("Quiz option image exceeds the supported archive size or format");
    if (asset.byteLength !== downloaded.bytes.length || asset.sha256 !== hash(downloaded.bytes)) throw new Error("Quiz image integrity check failed");
    await this.input.review({ sessionId: context.args.sessionId, question: context.question, option: context.option, bytes: downloaded.bytes });
    await context.check();
    const dataUrl = `data:${asset.mime};base64,${downloaded.bytes.toString("base64")}`;
    const view = await this.input.classroom.image({ sessionId: context.args.sessionId, projectId: context.args.projectId,
      expectedRevision: context.args.expectedRevision, expectedSourceRevision: context.args.expectedSourceRevision,
      sceneId: context.args.sceneId, questionId: context.args.questionId, optionValue: context.args.optionValue, dataUrl,
      classroom: context.view.classroom });
    this.input.assertOwned(context.args.sessionId); context.principal.assertCurrent();
    return { key: context.key, state: "adopted", task, view };
  }
}
