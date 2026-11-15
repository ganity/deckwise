import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, isAbsolute } from "node:path";
import type { DesktopAuthSession } from "./auth-session";
import type { CoursewareCanvasMusic } from "./courseware-canvas-music";
import type { CoursewareTeachingCoordinator } from "./courseware-teaching";
import type { SavedVideoIntent } from "./courseware-saved-video";
import { videoPlacementMatches } from "./courseware-video-placement";
import type { CoursewarePortableMedia } from "./courseware-portable-media";

type Asset = { sha256: string; byteLength: number; mimeType?: string };
const invalid = () => new Error("COURSEWARE_MEDIA_PREVIEW_INVALID");

/** Local media browsing/preview never generates; explicit reuse rechecks permission. */
export class CoursewareNativeMedia {
  constructor(private teaching: Pick<CoursewareTeachingCoordinator, "ttsContext" | "reuseVideo">,
    private auth: Pick<DesktopAuthSession, "getCoursewarePrincipal" | "coursewareMedia">,
    private music: Pick<CoursewareCanvasMusic, "list" | "adopt">,
    private local?: Pick<CoursewarePortableMedia, "preview">) {}

  private async context(value: unknown, extra: string[] = []) {
    const keys = ["viewId", "expectedTeachingRevision", ...extra].sort();
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== keys.join(",")) throw invalid();
    const input = value as Record<string, unknown>;
    for (const key of keys) if (typeof input[key] !== "string" || !/^[A-Za-z0-9._-]{1,128}$/u.test(input[key]) || input[key] === "." || input[key] === "..") throw invalid();
    const principal = this.auth.getCoursewarePrincipal();
    const context = await this.teaching.ttsContext({ viewId: input.viewId, expectedTeachingRevision: input.expectedTeachingRevision });
    const check = async () => { await context.assertCurrent(); principal.assertCurrent(); };
    await check();
    return { ...context, principal, check, input: input as Record<string, string>, scope: { sessionId: context.sessionId, projectId: context.projectId, principalKey: principal.key } };
  }

  async list(value: unknown) {
    const c = await this.context(value);
    const music = await this.music.list({ sessionId: c.sessionId });
    await c.check();
    const { intents } = await c.host.call<{ intents: SavedVideoIntent[] }>("courseware.video.list", c.scope);
    if (!Array.isArray(intents) || intents.length > 1000) throw invalid();
    const video = intents.filter(i => i.phase === "adopted" && i.principalKey === c.principal.key && i.projectId === c.projectId && i.asset &&
      i.submissionScope?.sessionId === c.sessionId && i.source.sha256 === c.project.source.sha256 && i.source.revision === c.expectedSourceRevision &&
      c.project.pages.some(p => !p.locked && p.actions.some(a => a.type === "video_clip" && a.videoAssetId === `video-${i.asset!.sha256}` && videoPlacementMatches(i, p.pageId, a.id))));
    await c.check();
    return [
      ...music.filter(m => m.operation === "music-export" && m.phase === "submitted" && m.asset).map(m => ({
        kind: "music", intentId: m.intentId, title: m.draft.title || "音乐", model: m.model,
        inPage: c.project.pages.find(p => p.pageId === c.pageId)?.actions.some(a => a.type === "audio_clip" && a.audioAssetId === `music-${m.asset!.sha256}`) ?? false,
      })),
      ...video.map(i => ({ kind: "video", intentId: i.intentId, title: i.prompt, model: i.model, inPage: false })),
    ];
  }

  async adopt(value: unknown) {
    const c = await this.context(value, ["kind", "intentId", "actionId"]);
    const { kind, intentId, actionId } = c.input;
    if (kind === "music") {
      const result = await this.music.adopt({ sessionId: c.sessionId, intentId, viewId: c.input.viewId, expectedTeachingRevision: c.input.expectedTeachingRevision });
      c.principal.assertCurrent();
      return result;
    }
    if (kind !== "video") throw invalid();
    const { intents } = await c.host.call<{ intents: SavedVideoIntent[] }>("courseware.video.list", c.scope);
    if (!Array.isArray(intents) || intents.length > 1000) throw invalid();
    const intent = intents.find(i => i.intentId === intentId && i.phase === "adopted" && i.principalKey === c.principal.key &&
      i.projectId === c.projectId && i.source.sha256 === c.project.source.sha256 && i.source.revision === c.expectedSourceRevision && i.submissionScope?.sessionId === c.sessionId);
    if (!intent?.asset || !intent.taskRef) throw invalid();
    // Reuse needs current service permission, but never creates or downloads media.
    const task = await this.auth.coursewareMedia.video.get(intent.taskRef);
    if (task.kind !== "video" || task.state !== "ready" || task.feeState !== "settled" || task.model !== intent.model ||
      task.taskId !== intent.taskRef.taskId || task.requestHash !== intent.taskRef.requestHash || task.idempotencyKey !== intent.taskRef.idempotencyKey) throw invalid();
    await c.check();
    return this.teaching.reuseVideo({ viewId: c.input.viewId, expectedTeachingRevision: c.input.expectedTeachingRevision, principalKey: c.principal.key, intentId, actionId, assetId: `video-${intent.asset.sha256}` });
  }

  async preview(value: unknown): Promise<{ bytes: Uint8Array; mimeType: string }> {
    const local = await this.local?.preview(value, "clip");
    if (local) return local;
    const context = await this.context(value, ["actionId"]);
    const { input, principal, scope, check } = context;
    const action = context.project.pages.find(p => p.pageId === context.pageId)?.actions.find(a => a.id === input.actionId);
    if (!action || !["audio_clip", "video_clip"].includes(String(action.type))) throw invalid();
    let stored: { path: string; asset: Asset }, mimeType: string, assetId: unknown;
    if (action.type === "audio_clip") {
      assetId = action.audioAssetId;
      const result = await context.host.call<{ assets: Array<{ asset: { id: string; sha256: string; mimeType: string }; music: { principalKey: string; intentId: string } }> }>(
        "courseware.mediaCanvas.music.snapshotAssets", { ...scope, expectedSourceRevision: context.expectedSourceRevision,
          expectedTeachingRevision: context.expectedTeachingRevision });
      await check();
      if (!Array.isArray(result.assets) || result.assets.length > 1000) throw invalid();
      const matches = result.assets.filter(a => a.asset?.id === assetId && a.music?.principalKey === principal.key);
      if (matches.length !== 1 || matches[0].asset.mimeType !== "audio/mpeg") throw invalid();
      const entry = matches[0];
      const saved = await context.host.call<{ path: string; intent: { asset: Asset | null } }>("courseware.mediaCanvas.music.asset.get",
        { sessionId: context.sessionId, principalKey: principal.key, intentId: entry.music.intentId });
      if (!saved.intent.asset || saved.intent.asset.sha256 !== entry.asset.sha256) throw invalid();
      stored = { path: saved.path, asset: saved.intent.asset };
      mimeType = "audio/mpeg";
      if (stored.asset.mimeType !== mimeType || assetId !== `music-${stored.asset.sha256}`) throw invalid();
    } else {
      assetId = action.videoAssetId;
      const { intents } = await context.host.call<{ intents: SavedVideoIntent[] }>("courseware.video.list", scope);
      await check();
      if (!Array.isArray(intents) || intents.length > 1000) throw invalid();
      const matches = intents.filter(i => i.phase === "adopted" && i.projectId === context.projectId && i.principalKey === principal.key &&
        videoPlacementMatches(i, context.pageId, action.id) && i.source.revision === context.project.source.revision &&
        i.source.sha256 === context.project.source.sha256 && i.asset && assetId === `video-${i.asset.sha256}`);
      if (matches.length !== 1) throw invalid();
      stored = await context.host.call("courseware.video.asset.get", { ...scope, intentId: matches[0].intentId });
      mimeType = "video/mp4";
      if (assetId !== `video-${stored.asset.sha256}`) throw invalid();
    }
    await check();
    const { asset, path } = stored;
    if (!asset || !/^[a-f0-9]{64}$/u.test(asset.sha256) || !Number.isSafeInteger(asset.byteLength) || asset.byteLength < 1 ||
        asset.byteLength > 40 * 1024 * 1024 || typeof path !== "string" || !isAbsolute(path) || basename(path) !== `${asset.sha256}.bin`) throw invalid();
    const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    let bytes: Buffer;
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size !== asset.byteLength) throw invalid();
      bytes = await file.readFile();
    } finally { await file.close(); }
    if (bytes.length !== asset.byteLength || createHash("sha256").update(bytes).digest("hex") !== asset.sha256) throw invalid();
    await check();
    return { bytes: new Uint8Array(bytes), mimeType };
  }
}
