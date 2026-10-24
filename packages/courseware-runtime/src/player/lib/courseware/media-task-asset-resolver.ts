import { z } from "zod";
import type { FixedAssetResolver } from "./load-fixed-build";

// C owns this response; consume only the ready-asset projection, never task submission or fees.
const tasksSchema = z
  .array(
    z.object({
      version: z.literal("courseware-media-v1"),
      taskId: z.string().regex(/^[\w.-]{1,128}$/u),
      state: z.string(),
      assetRef: z
        .object({
          assetId: z.string().min(1).max(128),
          sha256: z.string().regex(/^[a-f0-9]{64}$/),
          mime: z.string().regex(/^(audio|image|video)\/[\w.+-]+$/),
          byteLength: z
            .number()
            .int()
            .positive()
            .max(16 * 1024 * 1024),
          downloadPath: z.string(),
        })
        .nullable(),
    }),
  )
  .max(10000);

/** Host supplies authenticated retrieval by task ID; package paths never choose a network destination. */
export function createMediaTaskAssetResolver(
  rawTasks: unknown,
  download: (taskId: string, signal?: AbortSignal) => Promise<Uint8Array>,
): FixedAssetResolver {
  const parsed = tasksSchema.safeParse(rawTasks);
  if (!parsed.success) throw new Error("MEDIA_TASK_INVALID");
  const assets = new Map<
    string,
    { taskId: string; sha256: string; mime: string; byteLength: number }
  >();
  const taskIds = new Set<string>();
  for (const task of parsed.data) {
    const ref = task.assetRef;
    if (task.state !== "ready" || !ref) throw new Error("MEDIA_TASK_NOT_READY");
    if (ref.downloadPath !== `/courseware/media/tasks/${task.taskId}/asset`)
      throw new Error("MEDIA_TASK_INVALID");
    if (taskIds.has(task.taskId) || assets.has(ref.assetId))
      throw new Error("MEDIA_TASK_AMBIGUOUS");
    taskIds.add(task.taskId);
    assets.set(ref.assetId, {
      taskId: task.taskId,
      sha256: ref.sha256,
      mime: ref.mime,
      byteLength: ref.byteLength,
    });
  }
  return async (asset, signal) => {
    signal?.throwIfAborted();
    const ref = assets.get(asset.id);
    if (!ref || ref.sha256 !== asset.sha256 || ref.mime !== asset.mimeType)
      throw new Error("MEDIA_ASSET_MISMATCH");
    const bytes = await download(ref.taskId, signal);
    signal?.throwIfAborted();
    if (bytes.length !== ref.byteLength)
      throw new Error("MEDIA_ASSET_LENGTH_MISMATCH");
    // loadFixedBuild verifies the bytes' SHA-256 before creating any playback URL.
    return bytes;
  };
}
