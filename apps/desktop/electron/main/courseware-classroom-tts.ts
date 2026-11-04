import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parseMaicClassroom } from "@pi-desktop/courseware-runtime/node";
import type { DesktopAuthSession } from "./auth-session";
import type { ClassroomView } from "./courseware-classroom";
import type { CoursewareTtsQuote, CoursewareTtsRequest, CoursewareTtsTask } from "./courseware-media";
import { coursewareMediaSubmissionProject } from "./courseware-media-scope";
import { resolveRealPathForCreateWithinRoot } from "./fs-panel";

type Host = { call<T>(method: string, params: unknown): Promise<T> };
type Selection = { sessionId: string; projectId: string; expectedRevision: string; expectedSourceRevision: string;
  sceneId: string; actionId: string; model: string; voice: string | null };
type Quote = { quote: CoursewareTtsQuote; key: string; principalKey: string; revision: string; sourceRevision: string };
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const string = (value: unknown): value is string => typeof value === "string" && !!value.trim() && value.length <= 512;
function selection(value: unknown): Selection {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid classroom TTS request");
  const input = value as Record<string, unknown>;
  if (["sessionId", "projectId", "expectedRevision", "expectedSourceRevision", "sceneId", "actionId", "model"].some(key => !string(input[key])) ||
      input.voice !== null && !string(input.voice) || Object.keys(input).some(key => !["sessionId", "projectId", "expectedRevision", "expectedSourceRevision", "sceneId", "actionId", "model", "voice", "quoteId"].includes(key)))
    throw new Error("Invalid classroom TTS selection");
  return input as Selection;
}
export class CoursewareClassroomTts {
  private quotes = new Map<string, Quote>();
  private active = new Set<string>();
  constructor(private input: {
    auth: Pick<DesktopAuthSession, "getCoursewarePrincipal" | "coursewareMedia">;
    open: (sessionId: string) => Promise<ClassroomView>;
    getHost: () => Host | null; getWorkspace: () => Promise<string | null>;
    assertOwned: (sessionId: string) => void;
    decodeAudio: (bytes: Buffer, mime: "audio/wav" | "audio/mpeg") => Promise<number>;
  }) {}
  async models(value: unknown) {
    const sessionId = value && typeof value === "object" ? Reflect.get(value, "sessionId") : undefined;
    if (!string(sessionId)) throw new Error("Invalid classroom TTS session");
    this.input.assertOwned(sessionId);
    const principal = this.input.auth.getCoursewarePrincipal();
    const models = await this.input.auth.coursewareMedia.getTtsModels();
    this.input.assertOwned(sessionId); principal.assertCurrent();
    return models;
  }
  private async context(value: unknown) {
    const args = selection(value); this.input.assertOwned(args.sessionId);
    const principal = this.input.auth.getCoursewarePrincipal(), host = this.input.getHost(), workspace = await this.input.getWorkspace();
    if (!host || !workspace) throw new Error("Classroom TTS workspace unavailable");
    const check = async () => {
      this.input.assertOwned(args.sessionId); principal.assertCurrent();
      if (host !== this.input.getHost() || workspace !== await this.input.getWorkspace()) throw new Error("Classroom TTS owner changed");
      const current = await host.call<ClassroomView>("courseware.classroom.get", { sessionId: args.sessionId, projectId: args.projectId });
      if (current.revision !== args.expectedRevision || current.sourceRevision !== args.expectedSourceRevision)
        throw new Error("Classroom changed; reopen narration generation");
    };
    const view = await this.input.open(args.sessionId); await check();
    if (view.projectId !== args.projectId || !view.classroom) throw new Error("Canonical classroom not found");
    const classroom = parseMaicClassroom(view.classroom), scene = classroom.scenes.find(item => item.id === args.sceneId);
    const speech = scene?.actions?.find(item => item.id === args.actionId && item.type === "speech");
    if (!speech || speech.type !== "speech" || !speech.text.trim()) throw new Error("Saved classroom narration required");
    const request: CoursewareTtsRequest = { kind: "tts", model: args.model, input: speech.text, voice: args.voice };
    const fields = [request.kind, request.model, request.input, request.voice ?? null];
    const requestHash = hash(fields.reduce<string>((text, field) => `${text}:${field === null ? -1 : field.length}:${field ?? ""}`, "courseware-media-v1"));
    const key = `maic-${hash(JSON.stringify([principal.key, args.projectId, args.sceneId, args.actionId, requestHash]))}`;
    return { args, host, workspace, principal, classroom, speech, request, key, requestHash, check };
  }
  async quote(value: unknown) {
    const context = await this.context(value);
    const quote = await this.input.auth.coursewareMedia.getTtsQuote(context.args.model); await context.check();
    if (context.request.input.length > quote.maxChars) throw new Error("Classroom narration exceeds model text limit");
    for (const [key, saved] of this.quotes) if (Date.parse(saved.quote.expiresAt) <= Date.now()) this.quotes.delete(key);
    if (this.quotes.size >= 100) this.quotes.delete(this.quotes.keys().next().value!);
    const quoteId = randomUUID(); this.quotes.set(quoteId, { quote, key: context.key, principalKey: context.principal.key, revision: context.args.expectedRevision, sourceRevision: context.args.expectedSourceRevision });
    return { key: context.key, state: "quoted", quote: { quoteId, maxPoints: quote.maxPoints, expiresAt: quote.expiresAt } };
  }
  async submit(value: unknown) {
    const context = await this.context(value), quoteId = Reflect.get(value as object, "quoteId");
    const saved = typeof quoteId === "string" ? this.quotes.get(quoteId) : undefined;
    if (!saved || saved.key !== context.key || saved.principalKey !== context.principal.key || saved.revision !== context.args.expectedRevision || saved.sourceRevision !== context.args.expectedSourceRevision || Date.parse(saved.quote.expiresAt) <= Date.now())
      throw new Error("Confirm a current narration quote first");
    if (this.active.has(context.key)) throw new Error("Classroom narration submission already running");
    this.active.add(context.key);
    try {
      const previous = await this.input.auth.coursewareMedia.findTts({ idempotencyKey: context.key, requestHash: context.requestHash });
      await context.check();
      const task = previous ?? await this.input.auth.coursewareMedia.submitConfirmedTts(context.key, context.request, saved.quote, undefined, undefined, context.check, async () => {
        const scope = await context.host.call("courseware.classroom.mediaScope", { sessionId: context.args.sessionId, projectId: context.args.projectId,
          expectedRevision: context.args.expectedRevision, expectedSourceRevision: context.args.expectedSourceRevision });
        await context.check(); return coursewareMediaSubmissionProject(scope, context.args.sessionId);
      });
      await context.check(); this.quotes.delete(String(quoteId));
      return { key: context.key, state: task.state, task };
    } finally { this.active.delete(context.key); }
  }
  async refresh(value: unknown) {
    const context = await this.context(value);
    const found = await this.input.auth.coursewareMedia.findTts({ idempotencyKey: context.key, requestHash: context.requestHash });
    await context.check();
    if (!found) return { key: context.key, state: "not_submitted" };
    const ref = { taskId: found.taskId, idempotencyKey: context.key, requestHash: context.requestHash };
    const task = await this.input.auth.coursewareMedia.get(ref); await context.check();
    if (task.state !== "ready") return { key: context.key, state: task.state, task };
    const downloaded = await this.input.auth.coursewareMedia.download(ref); await context.check();
    const asset = downloaded.task.assetRef, bytes = downloaded.bytes;
    if (!asset || !["audio/wav", "audio/mpeg"].includes(asset.mime) || bytes.length < 1 || bytes.length > 16 * 1024 * 1024 || hash(bytes) !== asset.sha256)
      throw new Error("Classroom narration audio failed archive verification");
    const duration = await this.input.decodeAudio(bytes, asset.mime);
    if (!Number.isFinite(duration) || duration <= 0 || duration > 86_400_000) throw new Error("Invalid classroom narration audio duration");
    await context.check();
    const url = `.deckwise-ppt/classroom-assets/${asset.sha256}.${asset.mime === "audio/wav" ? "wav" : "mp3"}`;
    const destination = await resolveRealPathForCreateWithinRoot(context.workspace, url);
    if (!destination) throw new Error("Classroom narration directory escaped workspace");
    await mkdir(dirname(destination), { recursive: true });
    if (await resolveRealPathForCreateWithinRoot(context.workspace, url) !== destination) throw new Error("Classroom narration directory changed");
    try { await writeFile(destination, bytes, { flag: "wx", mode: 0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST" || hash(await readFile(destination)) !== asset.sha256) throw error; }
    const audioId = `tts-${asset.sha256}`;
    context.speech.audioId = audioId; context.speech.audioUrl = url;
    context.classroom.audioManifest = (context.classroom.audioManifest ?? []).filter(entry => entry.sceneId !== context.args.sceneId || entry.actionId !== context.args.actionId);
    context.classroom.audioManifest.push({ sceneId: context.args.sceneId, actionId: context.args.actionId, assetId: audioId, audioId,
      mimeType: asset.mime, url, originalUrl: url });
    await context.check();
    const view = await context.host.call<ClassroomView>("courseware.classroom.write", { sessionId: context.args.sessionId, projectId: context.args.projectId,
      expectedRevision: context.args.expectedRevision, expectedSourceRevision: context.args.expectedSourceRevision, classroom: context.classroom });
    this.input.assertOwned(context.args.sessionId); context.principal.assertCurrent();
    return { key: context.key, state: "adopted", task, view };
  }
}
