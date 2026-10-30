import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, isAbsolute } from "node:path";
import type { CoursewareTeachingCoordinator } from "./courseware-teaching";

export type LocalSnapshotAsset = { asset: { id: string; sha256: string; mimeType: string }; local: true };
type Context = Awaited<ReturnType<CoursewareTeachingCoordinator["ttsContext"]>>;
type Action = Context["project"]["pages"][number]["actions"][number];
type Stored = { asset: LocalSnapshotAsset["asset"]; path: string; byteLength: number; durationMs: number };
export type PortableMediaMime = "audio/wav" | "audio/mpeg" | "audio/ogg" | "audio/mp4" | "video/mp4";
const invalid = () => new Error("COURSEWARE_LOCAL_MEDIA_INVALID");
const assetId = (action: Action) => action.type === "video_clip" ? action.videoAssetId : action.audioAssetId;

/** Imported media is local content, with no provider receipt or account dependency. */
export class CoursewarePortableMedia {
  constructor(private teaching: Pick<CoursewareTeachingCoordinator, "ttsContext">,
    private decode: (bytes: Buffer, mime: PortableMediaMime) => Promise<{ durationMs: number }>) {}

  private async context(value: unknown, preview: boolean) {
    const keys = preview ? ["viewId", "expectedTeachingRevision", "actionId"] : ["viewId", "expectedTeachingRevision"];
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== keys.length ||
        keys.some(key => typeof Reflect.get(value, key) !== "string" || !/^[A-Za-z0-9._-]{1,128}$/u.test(Reflect.get(value, key)) ||
          [".", ".."].includes(Reflect.get(value, key)))) throw invalid();
    const input = value as Record<string, string>;
    const context = await this.teaching.ttsContext({ viewId: input.viewId, expectedTeachingRevision: input.expectedTeachingRevision });
    await context.assertCurrent();
    return { context, input };
  }

  private async stored(context: Context, pageId: string, action: Action): Promise<Stored | null> {
    const result = await context.host.call<{ media: Stored | null }>("courseware.project.localMedia", {
      sessionId: context.sessionId, projectId: context.projectId, pageId, actionId: action.id,
      expectedSourceRevision: context.expectedSourceRevision, expectedTeachingRevision: context.expectedTeachingRevision,
    });
    await context.assertCurrent();
    if (!result || Object.keys(result).length !== 1 || !Object.hasOwn(result, "media")) throw invalid();
    const media = result.media;
    if (media === null) return null;
    if (!media || !media.asset || Object.keys(media).sort().join(",") !== "asset,byteLength,durationMs,path" ||
        Object.keys(media.asset).sort().join(",") !== "id,mimeType,sha256" || media.asset.id !== assetId(action) ||
        !/^[a-f0-9]{64}$/u.test(media.asset.sha256) || typeof media.path !== "string" || !isAbsolute(media.path) ||
        basename(media.path) !== `${media.asset.sha256}.bin` || !Number.isSafeInteger(media.byteLength) ||
        media.byteLength < 1 || media.byteLength > 50 * 1024 * 1024 || !Number.isSafeInteger(media.durationMs) ||
        media.durationMs < 1 || media.durationMs > 3_600_000 ||
        !(action.type === "video_clip" ? media.asset.mimeType === "video/mp4" :
          ["audio/wav", "audio/mpeg", "audio/ogg", "audio/mp4"].includes(media.asset.mimeType))) throw invalid();
    return media;
  }

  private async read(context: Context, media: Stored): Promise<Buffer> {
    const file = await open(media.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    let bytes: Buffer;
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size !== media.byteLength) throw invalid();
      bytes = Buffer.alloc(media.byteLength);
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
        if (!bytesRead) throw invalid();
        offset += bytesRead;
      }
      const after = await file.stat();
      if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw invalid();
    } finally { await file.close(); }
    if (bytes.length !== media.byteLength || createHash("sha256").update(bytes).digest("hex") !== media.asset.sha256) throw invalid();
    await context.assertCurrent();
    const decoded = await this.decode(bytes, media.asset.mimeType as PortableMediaMime);
    await context.assertCurrent();
    if (decoded.durationMs !== media.durationMs) throw new Error("COURSEWARE_LOCAL_MEDIA_DURATION_MISMATCH");
    return bytes;
  }

  async preview(value: unknown, kind: "speech" | "clip"): Promise<{ bytes: Uint8Array; mimeType: string } | null> {
    const { context, input } = await this.context(value, true);
    if (!context.projectId.startsWith("portable-")) return null;
    const action = context.project.pages.find(page => page.pageId === context.pageId)?.actions.find(action => action.id === input.actionId);
    if (!action || !(kind === "speech" ? action.type === "speech" : kind === "clip" && ["audio_clip", "video_clip"].includes(String(action.type)))) throw invalid();
    const media = await this.stored(context, context.pageId, action);
    if (!media) return null;
    return { bytes: new Uint8Array(await this.read(context, media)), mimeType: media.asset.mimeType };
  }

  async snapshotAssets(value: unknown): Promise<LocalSnapshotAsset[]> {
    const { context } = await this.context(value, false);
    if (!context.projectId.startsWith("portable-")) return [];
    const assets = new Map<string, Stored>(), unavailable = new Set<string>();
    let total = 0;
    for (const page of context.project.pages) for (const action of page.actions) {
      if (!["speech", "audio_clip", "video_clip"].includes(String(action.type))) continue;
      const id = assetId(action);
      if (typeof id !== "string") continue;
      const media = await this.stored(context, page.pageId, action);
      if (!media) { unavailable.add(id); continue; }
      const previous = assets.get(id);
      if (previous) {
        if (JSON.stringify(previous) !== JSON.stringify(media)) throw invalid();
      } else {
        total += media.byteLength;
        if (assets.size >= 1000 || total > 128 * 1024 * 1024) throw invalid();
        await this.read(context, media);
        assets.set(id, media);
      }
    }
    await context.assertCurrent();
    return [...assets.values()].filter(media => !unavailable.has(media.asset.id)).map(media => ({ asset: media.asset, local: true }));
  }
}
