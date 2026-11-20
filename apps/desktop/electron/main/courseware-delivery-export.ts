import { coursewareWorkerPath } from "./courseware-runtime";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { adaptCanonicalSnapshot, buildFixedCourseware, exportMaicClassroom, mapMaicSlideIrToScenes, parseMaicClassroom, type MaicClassroom } from "@pi-desktop/courseware-runtime/node";
import { inspectCoursewareEnrichment, inspectCoursewareTeaching, type CoursewareEnrichment, type CoursewareSnapshot, type CoursewareTeachingView } from "@pi-desktop/shared";
import { captureNativeTeachingSnapshot } from "./courseware-native-snapshot";
import { readNativeTeachingPackage } from "./courseware-native-package";
import { projectDeliveryAssessments } from "./courseware-delivery-assessment";
import { reconcileMaicNativeSource, type NativeClassroomSeed } from "./courseware-classroom-native";
import type { NativeResource } from "./courseware-classroom-timeline";
import type { PptEditorController } from "./ppt-editor";
import type { CoursewareTeachingCoordinator } from "./courseware-teaching";
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const DELIVERY_ADAPTER_VERSION = "native-maic-delivery/4";
export const coursewareDeliveryFingerprint = (sourceHash: string, converterHash: string) => digest(Buffer.from(JSON.stringify([DELIVERY_ADAPTER_VERSION, sourceHash, converterHash])));
type DeliveryTeachingView = CoursewareTeachingView & { enrichment?: CoursewareEnrichment };

export function assertNativeCoursewareReady(view: DeliveryTeachingView) {
  const silent = new Set(view.enrichment?.script?.silentPageIds ?? []);
  const requirements = new Map((view.teachingRequirements ?? []).map(({ pageId, teaching }) => [pageId, teaching]));
  const assessments = new Set([...requirements].filter(([, teaching]) => teaching.pageType !== "slide").map(([pageId]) => pageId));
  const teaching = inspectCoursewareTeaching(view.project, requirements, assessments, true);
  const enrichment = inspectCoursewareEnrichment(view.enrichment, view.project.pages);
  const issues = teaching.issues.filter(issue => issue.code !== "FOCUS_MISSING" &&
    !(silent.has(issue.pageId) && ["NARRATION_MISSING", "AUDIO_MISSING"].includes(issue.code)));
  for (const [index, page] of view.project.pages.entries()) if (!silent.has(page.pageId) &&
      !page.actions.some(action => action.type === "speech" && typeof action.text === "string" && action.text.trim()))
    issues.push({ code: "NARRATION_MISSING", pageId: page.pageId, pageNumber: index + 1, repair: "narration", repairable: !page.locked });
  if (issues.length || !enrichment.ready)
    throw new Error(`Complete courseware before synchronizing: ${[...issues.map(issue => `${issue.code} on ${issue.pageId}`), ...enrichment.issues.map(issue => issue.code)].join(", ")}`);
}

/** Export verified source and native teaching in the platform's playback format. */
export async function exportNativeDelivery(input: { sessionId: string; workspace: string; editor: PptEditorController;
  teaching: CoursewareTeachingCoordinator; outputDirectory: string; reviewedWarningCodes?: string[]; assertOwner(): void;
  host: { call<T>(method: string, params: unknown): Promise<T> } }) {
  const opened = await input.teaching.native("open");
  if (!opened) throw new Error("Open the native courseware before synchronizing");
  const view = opened.value as DeliveryTeachingView;
  const captured = await captureNativeTeachingSnapshot({ ...input, payload: { viewId: view.viewId, expectedTeachingRevision: view.project.teachingRevision } });
  if (!captured) throw new Error("Native courseware snapshot is unavailable");
  const snapshot = captured.value as CoursewareSnapshot;
  const raw = await input.host.call<{ project: NativeClassroomSeed["project"]; mapping: NativeClassroomSeed["mapping"]; sourcePath: string; assets: unknown }>("courseware.snapshot.get", {
    sessionId: input.sessionId, projectId: snapshot.projectId, snapshotId: snapshot.snapshotId });
  input.assertOwner();
  const carrier = await readNativeTeachingPackage(await readFile(raw.sourcePath));
  if (!carrier) throw new Error("Native teaching is unavailable");
  assertNativeCoursewareReady(view);
  const worker = coursewareWorkerPath();
  const manifest = await readFile(join(dirname(worker), "manifest.json"));
  const buildInput = adaptCanonicalSnapshot(raw.project, snapshot, { sourcePath: raw.sourcePath, mapping: raw.mapping, assets: raw.assets,
    converter: { version: "maic-pptx-import-ir/1", manifestSha256: digest(manifest) }, reviewedWarningCodes: input.reviewedWarningCodes ?? [] }, { nativeTeaching: true });
  let bytes: Uint8Array | undefined;
  await buildFixedCourseware(buildInput, { workerDirectory: dirname(worker), outputDirectory: input.outputDirectory,
    ...(carrier.assessments ? { nativeAssessments: carrier.assessments } : {}),
    onConverted: async ({ ir, input: convertedInput, pages, directory, assets }) => {
      input.assertOwner();
      const deliveryPages = carrier.pages.map(page => {
        const converted = convertedInput.teaching.pages.find(candidate => candidate.pageId === page.pageId);
        if (!converted) throw new Error("Native teaching page binding is incomplete");
        return { ...page, actions: converted.actions };
      });
      const now = 0, resources = new Map<string, NativeResource>();
      for (const asset of assets) resources.set(asset.id, { url: asset.path, mimeType: asset.mimeType, durationMs: carrier.media.find(m => m.id === asset.id)?.durationMs });
      const imageAssets = new Map<string, { url: string; mimeType: string }>();
      for (const assessment of Object.values(carrier.assessments ?? {})) {
        const quiz = assessment as { questions?: Array<{ image?: { src: string }; options?: Array<{ image?: { src: string } }> }> };
        for (const question of quiz.questions ?? []) for (const image of [question.image, ...(question.options ?? []).map(option => option.image)]) if (image) {
          const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/u.exec(image.src);
          if (!match) throw new Error("Invalid native assessment image");
          const id = `quiz-${digest(Buffer.from(match[2], "base64"))}`;
          const asset = assets.find(item => item.id === id);
          if (!asset) throw new Error("Native assessment image was not included in the fixed build");
          imageAssets.set(image.src, { url: asset.path, mimeType: asset.mimeType });
        }
      }
      const seed: NativeClassroomSeed = { projectId: snapshot.projectId, revision: null, sourceRevision: snapshot.source.revision,
        currentSourceRevision: snapshot.source.revision, ir, project: { ...raw.project, pages: deliveryPages },
        mapping: convertedInput.mapping, convertedSlides: new Map(pages.map(page => [page.pageId, page])), assets: [],
        classroom: parseMaicClassroom({ id: snapshot.projectId, createdAt: new Date(now).toISOString(),
          stage: { id: snapshot.projectId, name: view.project.title || ir.title || "Course", createdAt: now, updatedAt: now },
          scenes: mapMaicSlideIrToScenes(snapshot.projectId, ir).map((scene, index) => ({ ...scene, id: raw.project.pages[index].pageId, actions: [], metadata: { nativePageId: raw.project.pages[index].pageId, nativeEmbeddedAssessments: true, nativeTeachingSignature: "" } })) }) };
      const classroom: MaicClassroom = projectDeliveryAssessments(reconcileMaicNativeSource(seed, resources, true),
        deliveryPages, carrier.assessments, view.enrichment, imageAssets);
      const educationContext = view.project.educationContext;
      const durationByUrl = new Map([...resources.values()].map(asset => [asset.url, asset.durationMs]));
      const timedMedia = classroom.scenes.flatMap(scene => (scene.actions ?? []).flatMap(action => {
        if (action.type === "speech" && action.audioUrl) {
          const duration = durationByUrl.get(action.audioUrl);
          return [duration === undefined ? undefined : duration + (action.pauseAfterMs ?? 0)];
        }
        if (action.type !== "play_audio" && action.type !== "play_video") return [];
        const asset = classroom.mediaManifest?.find(entry => entry.sceneId === scene.id && entry.elementId === action.elementId);
        return [asset && durationByUrl.get(asset.src)];
      }));
      const durationMs = timedMedia.every((duration): duration is number => typeof duration === "number" && Number.isFinite(duration))
        ? timedMedia.reduce((sum, duration) => sum + duration, 0)
        : 0;
      classroom.metadata = {
        ...classroom.metadata,
        ...(educationContext ? { educationContext } : {}),
        ...(durationMs > 0 ? { playbackDurationSeconds: Math.ceil(durationMs / 1000) } : {}),
      };
      if (educationContext?.fullEnglishTeaching) classroom.stage.language = "en";
      // A final package may never silently fall back to runtime TTS.
      if (classroom.scenes.some(s => s.actions?.some(a => a.type === "speech" && a.text.trim() && !a.audioUrl))) throw new Error("Complete narration audio before synchronizing");
      bytes = await exportMaicClassroom(classroom, async asset => {
        const source = assets.find(item => item.path === asset.url);
        if (!source) throw new Error("Unarchived native resource");
        const data = await readFile(join(directory, source.path));
        if (digest(data) !== source.sha256) throw new Error("Native resource changed");
        return data;
      });
    } });
  input.assertOwner();
  await input.editor.verifyTeachingSource(input.workspace);
  input.assertOwner();
  if (!bytes) throw new Error("Complete MAIC export is unavailable");
  return { bytes: Buffer.from(bytes), documentId: snapshot.projectId, sourceHash: snapshot.source.sha256,
    fingerprint: coursewareDeliveryFingerprint(snapshot.source.sha256, digest(manifest)) };
}
