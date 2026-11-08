import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { exportMaicClassroom, parseMaicClassroom, prepareMaicAssessmentSpeech, type MaicClassroom } from "@pi-desktop/courseware-runtime/node";
import { resolveRealPathForCreateWithinRoot } from "./fs-panel";
import { readClassroomAsset } from "./courseware-classroom-assets";
import type { CoursewareTeachingView } from "@pi-desktop/shared";

type Host = { call<T>(method: string, args: unknown): Promise<T> };
export type ClassroomView = { projectId: string; revision: string | null; sourceRevision: string; classroom: MaicClassroom | null; resourceUrls?: Record<string, string> };
type Request = { sessionId: string; projectId: string; expectedRevision: string | null; expectedSourceRevision: string };
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid classroom request");
  return value as Record<string, unknown>;
}
function fields(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  const input = object(value);
  if (required.some(key => !Object.hasOwn(input, key)) || Object.keys(input).some(key => !required.includes(key) && !optional.includes(key)))
    throw new Error("Invalid classroom request fields");
  return input;
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 512) throw new Error("Invalid classroom identity");
  return value;
}
function request(input: Record<string, unknown>): Request {
  if (input.expectedRevision !== null && typeof input.expectedRevision !== "string") throw new Error("Invalid classroom revision");
  return { sessionId: text(input.sessionId), projectId: text(input.projectId), expectedRevision: input.expectedRevision === null ? null : text(input.expectedRevision), expectedSourceRevision: text(input.expectedSourceRevision) };
}
function imageBytes(value: unknown): { bytes: Buffer; mimeType: string; suffix: string } {
  if (typeof value !== "string" || value.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 128) throw new Error("Quiz image exceeds 5 MiB");
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match || match[2].length % 4 !== 0) throw new Error("Quiz image must be PNG, JPEG or WebP base64");
  const bytes = Buffer.from(match[2], "base64");
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES || bytes.toString("base64") !== match[2]) throw new Error("Invalid Quiz image encoding");
  const valid = match[1] === "image/png" ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    : match[1] === "image/jpeg" ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
      : bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP";
  if (!valid) throw new Error("Quiz image content does not match its MIME type");
  return { bytes, mimeType: match[1], suffix: match[1] === "image/jpeg" ? "jpg" : match[1].slice(6) };
}

/** Owns the canonical document boundary; native PPT authoring remains a separate source. */
export class CoursewareClassroomCoordinator {
  constructor(private readonly input: {
    getHost: () => Host | null;
    getSessionId: () => string | null;
    getWorkspace: () => Promise<string | null>;
    assertOwned: (sessionId: string) => void;
    openProject: (sessionId: string) => Promise<{ project: { projectId: string } }>;
    refreshNative?: (sessionId: string, projectId: string) => Promise<ClassroomView>;
    writeNative?: (args: Request & { classroom: MaicClassroom }) => Promise<ClassroomView>;
    completeReference?: (sessionId: string, data: string, signal: AbortSignal) => Promise<string>;
  }) {}

  private async capture(sessionId: string) {
    this.input.assertOwned(sessionId);
    const host = this.input.getHost();
    if (!host || this.input.getSessionId() !== sessionId) throw new Error("Classroom session changed");
    const workspace = await this.input.getWorkspace();
    const { session } = await host.call<{ session?: { projectPath?: string; mode?: string } }>("session.get", { id: sessionId, messageLimit: 1, contentLimit: 1 });
    const check = async () => {
      this.input.assertOwned(sessionId);
      if (this.input.getHost() !== host || this.input.getSessionId() !== sessionId || await this.input.getWorkspace() !== workspace) throw new Error("Classroom session or workspace changed");
      this.input.assertOwned(sessionId);
      if (this.input.getHost() !== host || this.input.getSessionId() !== sessionId) throw new Error("Classroom session changed");
    };
    await check();
    if (!workspace || session?.projectPath !== workspace || session.mode !== "agent") throw new Error("Classroom workspace changed");
    return { host, workspace, check };
  }

  async open(value: unknown): Promise<ClassroomView> {
    const input = fields(value, ["sessionId"]), sessionId = text(input.sessionId);
    const captured = await this.capture(sessionId);
    const { task } = await captured.host.call<{ task?: { canonicalProjectId?: string } }>("courseware.task.get", { sessionId });
    await captured.check();
    const { project } = task?.canonicalProjectId ? { project: { projectId: task.canonicalProjectId } } : await this.input.openProject(sessionId);
    await captured.check();
    const result = this.input.refreshNative && !task?.canonicalProjectId
      ? await this.input.refreshNative(sessionId, project.projectId)
      : await captured.host.call<ClassroomView>("courseware.classroom.get", { sessionId, projectId: project.projectId });
    await captured.check();
    return this.display(this.validateView(result, project.projectId), captured);
  }

  async create(value: unknown): Promise<ClassroomView> {
    const input = fields(value, ["sessionId", "classroom"]), sessionId = text(input.sessionId);
    const classroom = prepareMaicAssessmentSpeech(parseMaicClassroom(input.classroom)), captured = await this.capture(sessionId);
    await captured.check();
    const result = await captured.host.call<ClassroomView>("courseware.classroom.create", { sessionId, classroom });
    await captured.check();
    return this.display(this.validateView(result, result.projectId), captured);
  }

  /** The native panel has already verified these saved bytes and current teaching. */
  async openNative(sessionId: string, native: CoursewareTeachingView): Promise<ClassroomView> {
    const captured = await this.capture(sessionId), project = native.project;
    let result: ClassroomView | undefined;
    try { result = this.validateView(await captured.host.call<ClassroomView>("courseware.classroom.get", {sessionId, projectId: project.projectId}), project.projectId); }
    catch (error) { if (!String(error).includes("COURSEWARE_CONFLICT: native source changed")) throw error; }
    await captured.check();
    if (!result || result.sourceRevision !== project.source.revision || result.classroom?.scenes.length !== project.pages.length ||
        result.classroom.scenes.some((scene, index) => scene.metadata?.nativeTeachingRevision !== project.teachingRevision || scene.metadata?.nativePageId !== project.pages[index].pageId)) {
      if (!this.input.refreshNative) throw new Error("Native teaching changed; synchronize before editing assessments");
      result = await this.input.refreshNative(sessionId, project.projectId);
      await captured.check();
      this.validateView(result, project.projectId);
    }
    if (result.sourceRevision !== project.source.revision) throw new Error("Native source changed; reopen teaching");
    const currentScene = result.classroom?.scenes.find(scene => scene.metadata?.nativePageId === native.pageId);
    if (!currentScene) throw new Error("Native assessment page binding changed; reopen teaching");
    return this.display(result, captured, currentScene.content.type === "quiz" ? new Set([currentScene.id]) : new Set());
  }

  async write(value: unknown): Promise<ClassroomView> {
    const input = fields(value, ["sessionId", "projectId", "expectedRevision", "expectedSourceRevision", "classroom"]);
    const args = request(input), parsed = parseMaicClassroom(input.classroom);
    const captured = await this.capture(args.sessionId);
    const current = await this.current(captured, args);
    if (JSON.stringify(current.classroom) === JSON.stringify(parsed)) return this.display(current, captured);
    const classroom = prepareMaicAssessmentSpeech(parsed);
    await captured.check();
    const result = await this.persist(captured, args, classroom);
    await captured.check();
    return this.display(this.validateView(result, args.projectId), captured);
  }

  async image(value: unknown): Promise<ClassroomView> {
    const input = fields(value, ["sessionId", "projectId", "expectedRevision", "expectedSourceRevision", "sceneId", "questionId", "dataUrl"], ["optionValue", "classroom"]);
    const args = request(input), sceneId = text(input.sceneId), questionId = text(input.questionId);
    const optionValue = input.optionValue === undefined ? undefined : text(input.optionValue);
    const image = imageBytes(input.dataUrl), captured = await this.capture(args.sessionId);
    const view = await this.current(captured, args);
    if (!view.classroom) throw new Error("Create or generate the canonical classroom first");
    // Carry unsaved question edits into the same native save; a separate save destroys the upload's iframe.
    const classroom = parseMaicClassroom(input.classroom ?? view.classroom), scene = classroom.scenes.find(item => item.id === sceneId);
    if (!scene || scene.content.type !== "quiz") throw new Error("Quiz scene is missing");
    const question = scene.content.questions.find(item => item.id === questionId);
    if (!question) throw new Error("Quiz question is missing");
    const target = optionValue === undefined ? question : question.options?.find(item => item.value === optionValue);
    if (!target) throw new Error("Quiz option is missing");
    const digest = createHash("sha256").update(image.bytes).digest("hex"), assetId = `image-${digest}`;
    const elementId = optionValue === undefined ? `quiz-question:${questionId}` : `quiz-option:${questionId}:${optionValue}`;
    const rel = `.deckwise-ppt/classroom-assets/${digest}.${image.suffix}`, src = rel;
    target.image = { src, assetId, mimeType: image.mimeType };
    classroom.mediaManifest = (classroom.mediaManifest ?? []).filter(item => !(item.sceneId === sceneId && item.elementId === elementId));
    classroom.mediaManifest.push({ sceneId, elementId, assetId, assetType: "image", mimeType: image.mimeType, src, originalSrc: src });
    const destination = await resolveRealPathForCreateWithinRoot(captured.workspace, rel);
    if (!destination) throw new Error("Quiz image archive escapes the workspace");
    await mkdir(dirname(destination), { recursive: true });
    if (await resolveRealPathForCreateWithinRoot(captured.workspace, rel) !== destination) throw new Error("Quiz image archive changed");
    await captured.check();
    try { await writeFile(destination, image.bytes, { flag: "wx", mode: 0o600 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (!(await readFile(destination)).equals(image.bytes)) throw new Error("Quiz image archive is corrupt");
    }
    await captured.check();
    const result = await this.persist(captured, args, prepareMaicAssessmentSpeech(parseMaicClassroom(classroom), false));
    await captured.check();
    return this.display(this.validateView(result, args.projectId), captured);
  }

  async previewAudio(value: unknown) {
    const input = fields(value, ["sessionId", "projectId", "expectedRevision", "expectedSourceRevision", "sceneId", "actionId"]);
    const args = request(input), captured = await this.capture(args.sessionId), view = await this.current(captured, args);
    const sceneId = text(input.sceneId), actionId = text(input.actionId);
    const speech = view.classroom?.scenes.find(scene => scene.id === sceneId)?.actions?.find(action => action.id === actionId && action.type === "speech");
    const asset = view.classroom?.audioManifest?.find(entry => entry.sceneId === sceneId && entry.actionId === actionId && speech?.type === "speech" && entry.audioId === speech.audioId);
    if (!asset || !["audio/wav", "audio/mpeg"].includes(asset.mimeType)) throw new Error("Generate the question audio before previewing");
    const bytes = await readClassroomAsset(captured.workspace, { assetId: asset.assetId, url: asset.url, mimeType: asset.mimeType });
    if (!bytes.length || bytes.length > 16 * 1024 * 1024) throw new Error("Question audio exceeds preview size limit");
    await captured.check(); await this.current(captured, args);
    return { bytes, mimeType: asset.mimeType };
  }

  async reference(value: unknown): Promise<ClassroomView> {
    const input = fields(value, ["sessionId", "projectId", "expectedRevision", "expectedSourceRevision", "sceneId", "actionId"]);
    const args = request(input), captured = await this.capture(args.sessionId), view = await this.current(captured, args);
    if (!this.input.completeReference || !view.classroom) throw new Error("Reference generation is unavailable");
    const classroom = parseMaicClassroom(view.classroom), scene = classroom.scenes.find(item => item.id === text(input.sceneId));
    const action = scene?.actions?.find(item => item.id === text(input.actionId));
    if (!scene || scene.content.type !== "slide" || !action || action.type !== "interaction_checkpoint" || action.checkpointKind !== "chapter_summary")
      throw new Error("Chapter interaction is missing");
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(new Error("Reference generation timed out")), 180_000);
    try {
      const output = await this.input.completeReference(args.sessionId, JSON.stringify({ title: scene.title, question: action.question,
        context: action.context, referenceAnswer: action.referenceAnswer, constraintPrompt: action.constraintPrompt }), controller.signal);
      controller.signal.throwIfAborted(); await captured.check();
      if (output.length > 128_000) throw new Error("Reference generation output exceeds limit");
      const result = fields(JSON.parse(output), ["summary", "keyPoints"], ["constraintPrompt"]);
      if (typeof result.summary !== "string" || !Array.isArray(result.keyPoints) || result.keyPoints.some(point => typeof point !== "string") ||
          (result.constraintPrompt !== undefined && typeof result.constraintPrompt !== "string")) throw new Error("Invalid reference generation output");
      action.referenceAnswer = { ...action.referenceAnswer, summary: result.summary, keyPoints: result.keyPoints as string[] };
      if (result.constraintPrompt !== undefined) action.constraintPrompt = result.constraintPrompt as string;
      await this.current(captured, args); await captured.check();
      const saved = await this.persist(captured, args, parseMaicClassroom(classroom));
      await captured.check();
      return this.display(this.validateView(saved, args.projectId), captured);
    } finally { clearTimeout(timeout); }
  }

  async export(value: unknown): Promise<{ fileName: string; bytes: number[] }> {
    const args = request(fields(value, ["sessionId", "projectId", "expectedRevision", "expectedSourceRevision"]));
    const captured = await this.capture(args.sessionId), view = await this.current(captured, args);
    if (!view.classroom) throw new Error("Generate the canonical classroom first");
    const bytes = await exportMaicClassroom(view.classroom, async asset => {
      await captured.check();
      const result = await readClassroomAsset(captured.workspace, asset);
      await captured.check();
      return result;
    });
    await this.current(captured, args);
    await captured.check();
    const title = view.classroom.stage.name.replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").slice(0, 100) || "classroom";
    return { fileName: `${title}.zip`, bytes: Array.from(bytes) };
  }

  private persist(captured: Awaited<ReturnType<CoursewareClassroomCoordinator["capture"]>>, args: Request, classroom: MaicClassroom) {
    return this.input.writeNative && args.projectId.startsWith("office-")
      ? this.input.writeNative({ ...args, classroom })
      : captured.host.call<ClassroomView>("courseware.classroom.write", { ...args, classroom });
  }

  private validateView(value: ClassroomView, projectId: string): ClassroomView {
    if (value.projectId !== projectId || (value.revision !== null && typeof value.revision !== "string") || typeof value.sourceRevision !== "string") throw new Error("Invalid classroom document");
    if (value.classroom !== null) parseMaicClassroom(value.classroom);
    return value;
  }
  private async display(view: ClassroomView, captured: Awaited<ReturnType<CoursewareClassroomCoordinator["capture"]>>, imageScenes?: ReadonlySet<string>): Promise<ClassroomView> {
    const resourceUrls: Record<string, string> = {};
    const questionImages = new Set(view.classroom?.scenes.flatMap(scene => scene.content.type === "quiz"
      && (!imageScenes || imageScenes.has(scene.id))
      ? scene.content.questions.flatMap(question => [question.image?.src, ...(question.options ?? []).map(option => option.image?.src)]) : []));
    for (const asset of view.classroom?.mediaManifest ?? []) {
      if (asset.assetType !== "image" || !asset.src.startsWith(".deckwise-ppt/") || !questionImages.has(asset.src) || resourceUrls[asset.src]) continue;
      const bytes = Buffer.from(await readClassroomAsset(captured.workspace, { assetId: asset.assetId, url: asset.src, mimeType: asset.mimeType }));
      if (bytes.length > MAX_IMAGE_BYTES) throw new Error("Quiz image exceeds 5 MiB");
      if (!["image/png", "image/jpeg", "image/webp", "image/svg+xml", "image/gif"].includes(asset.mimeType)) throw new Error("Unsupported classroom image MIME");
      const dataUrl = `data:${asset.mimeType};base64,${bytes.toString("base64")}`;
      resourceUrls[asset.src] = dataUrl;
      await captured.check();
    }
    return { ...view, resourceUrls };
  }
  private async current(captured: Awaited<ReturnType<CoursewareClassroomCoordinator["capture"]>>, args: Request): Promise<ClassroomView> {
    const view = this.validateView(await captured.host.call<ClassroomView>("courseware.classroom.get", { sessionId: args.sessionId, projectId: args.projectId }), args.projectId);
    await captured.check();
    if (view.revision !== args.expectedRevision || view.sourceRevision !== args.expectedSourceRevision) throw new Error("Classroom or source changed; reopen before saving");
    return view;
  }
}
