import { setTimeout as delay } from "node:timers/promises";
import type { CoursewareProject, CoursewareTaskRef } from "@pi-desktop/shared";
import type { DesktopAuthSession } from "./auth-session";
import type { SavedCourseware } from "./courseware-saved-narration";

export type SavedVideoIntent = { intentId: string; principalKey: string; projectId: string; pageId: string; slotId: string;
  source: { revision: string; sha256: string }; model: string; prompt: string; idempotencyKey: string; requestHash: string;
  phase: "prepared" | "submission-unknown" | "submitted" | "adopted"; taskRef: CoursewareTaskRef | null;
  submissionScope: { sessionId: string; teamProjectId: string | null } | null;
  placements?: Array<{ pageId: string; actionId: string }>;
  asset: { sha256: string; byteLength: number; durationMs: number; width: number; height: number } | null };

/** Uses the original Host intent even after an uncertain submission or Chat restart. */
export async function savedVideo(input: Record<string, unknown>, saved: SavedCourseware, sessionId: string,
  auth: Pick<DesktopAuthSession, "getCoursewarePrincipal" | "coursewareMedia">,
  decodeVideo: (bytes: Buffer) => Promise<{ durationMs: number; width: number; height: number }>) {
  const principal = auth.getCoursewarePrincipal(), client = auth.coursewareMedia.video;
  const check = async () => { await saved.check(); principal.assertCurrent(); };
  const scope = { sessionId, projectId: saved.project.projectId, principalKey: principal.key };
  const pageNumber = Number(input.pageNumber), page = saved.project.pages[pageNumber - 1];
  if (!page || page.locked) throw new Error("Saved video page missing or locked");
  let intent: SavedVideoIntent;
  if (typeof input.model === "string") {
    const slot = page.actions.find(a => a.id === input.actionId && ["video_slot", "video_clip"].includes(String(a.type)));
    if (!slot) throw new Error("Generate a planned video slot in saved narration first");
    intent = (await saved.host.call<{ intent: SavedVideoIntent }>("courseware.video.prepare", { ...scope, pageId: page.pageId,
      slotId: input.actionId, model: input.model })).intent;
  } else intent = (await saved.host.call<{ intent: SavedVideoIntent }>("courseware.video.get", { ...scope, intentId: input.intentId })).intent;
  if (intent.pageId !== page.pageId || intent.projectId !== scope.projectId || intent.principalKey !== principal.key ||
    intent.source.sha256 !== saved.project.source.sha256) throw new Error("Video intent belongs to another saved page");
  const job = { kind: "video", intentId: intent.intentId, pageNumber, sourceSha256: intent.source.sha256 };
  if (intent.phase === "adopted" && intent.asset && page.actions.some(a => a.type === "video_clip" && a.id === intent.slotId && a.videoAssetId === `video-${intent.asset!.sha256}`))
    return { job, saved: true, videoReady: true };
  await check();
  const params = { ...scope, intentId: intent.intentId };
  let task;
  if (intent.phase === "prepared") {
    const quote = await client.quote(intent.model); await check();
    intent = (await saved.host.call<{ intent: SavedVideoIntent }>("courseware.video.begin", params)).intent;
    await check();
    try { task = await client.submit(intent.idempotencyKey, { kind: "video", model: intent.model, input: intent.prompt }, quote, intent.submissionScope?.teamProjectId ?? undefined); }
    catch (error) {
      await check();
      if (!(error instanceof Error) || !["COURSEWARE_MEDIA_TRANSPORT_FAILED", "COURSEWARE_MEDIA_WAIT_CANCELLED"].includes(error.message)) throw error;
      task = await client.find({ idempotencyKey: intent.idempotencyKey, requestHash: intent.requestHash });
    }
  } else task = intent.taskRef ? await client.get(intent.taskRef) : await client.find({ idempotencyKey: intent.idempotencyKey, requestHash: intent.requestHash });
  await check();
  if (!task) return { job, saved: false, waitingFor: "service", state: "submission_unknown" };
  const taskRef = { taskId: task.taskId, idempotencyKey: task.idempotencyKey, requestHash: task.requestHash };
  intent = (await saved.host.call<{ intent: SavedVideoIntent }>("courseware.video.bind", { ...params, taskRef })).intent;
  for (let attempt = 0; input.waitForUpdate === true && attempt < 10 && !["ready", "failed", "cancelled", "archive_failed"].includes(task.state); attempt++) {
    await delay(3000); await check(); task = await client.get(taskRef); await check();
  }
  if (task.state !== "ready") return { job, saved: false, waitingFor: ["failed", "cancelled", "archive_failed"].includes(task.state) ? null : "service",
    state: task.state, errorCode: task.errorCode };
  if (!intent.asset) {
    const { task: ready, bytes } = await client.download(taskRef); await check();
    if (!ready.assetRef || ready.feeState !== "settled") throw new Error("Video is not settled and archived");
    const metadata = await decodeVideo(bytes); await check();
    intent = (await saved.host.call<{ intent: SavedVideoIntent }>("courseware.video.stage", { ...params, taskRef,
      asset: { sha256: ready.assetRef.sha256, byteLength: bytes.length, ...metadata }, bytesBase64: bytes.toString("base64") })).intent;
  }
  await check();
  const current = await saved.host.call<{ project: CoursewareProject }>("courseware.project.get", { sessionId, projectId: scope.projectId });
  const adopted = await saved.host.call<{ project: CoursewareProject }>("courseware.video.adopt", { ...params, expectedTeachingRevision: current.project.teachingRevision });
  await check();
  return { job, saved: true, videoReady: true, teachingRevision: adopted.project.teachingRevision };
}
