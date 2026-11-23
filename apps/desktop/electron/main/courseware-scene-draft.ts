import { createHash } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { CoursewareScenePlanSnapshot } from "@pi-desktop/shared";
import { resolveRealOpenablePath, resolveRealPathForCreateWithinRoot } from "./fs-panel";
import { parseSceneCoursePlan, sceneCoursePlanRelativePath } from "./courseware-scene-plan";

type Host = { call<T>(method: string, params: unknown): Promise<T> };

/** Read only the owning Chat's bounded draft; model output never selects a file path. */
export async function readSceneCourseDraft(host: Host, payload: unknown): Promise<{ plan: CoursewareScenePlanSnapshot | null }> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || Object.keys(payload).join(",") !== "sessionId")
    throw new Error("Invalid scene plan request");
  const sessionId = Reflect.get(payload, "sessionId");
  const relativePath = sceneCoursePlanRelativePath(sessionId);
  const capture = async () => {
    const [{ task }, { session }] = await Promise.all([
      host.call<{ task: { taskType: string; generatedPath?: string; storyFirst?: boolean; educationContext?: { bodyPageLimit?: number } } | null }>("courseware.task.get", { sessionId }),
      host.call<{ session: { projectPath?: string } | null }>("session.get", { id: sessionId, messageLimit: 1 }),
    ]);
    if (task?.taskType !== "scene" || task.generatedPath || !session?.projectPath || !isAbsolute(session.projectPath))
      throw new Error("Scene planning requires an ungenerated project-bound scene task");
    return { task, root: await fs.realpath(session.projectPath) };
  };
  const before = await capture();
  const path = await resolveRealPathForCreateWithinRoot(before.root, relativePath);
  if (!path || path !== resolve(before.root, relativePath)) throw new Error("Scene plan left its Chat directory");
  let file;
  try { file = await fs.open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { plan: null };
    throw error;
  }
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 256 * 1024) throw new Error("Scene course plan exceeds limits");
    const buffer = Buffer.alloc(256 * 1024 + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await file.read(buffer, size, buffer.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > 256 * 1024) throw new Error("Scene course plan exceeds limits");
    const bytes = buffer.subarray(0, size);
    const plan = parseSceneCoursePlan(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    const bodyPageLimit = before.task.educationContext?.bodyPageLimit;
    if (bodyPageLimit !== undefined && plan.bodyPageLimit !== bodyPageLimit)
      throw new Error(`Plan bodyPageLimit must match the saved body-page requirement ${bodyPageLimit}; Quiz and checkpoint pages are additional, not deducted. Correct the draft before submission.`);
    if (before.task.storyFirst) {
      const { story } = await host.call<{ story: import("@pi-desktop/shared").CoursewareStoryState | null }>("courseware.story.get", { sessionId });
      if (!story?.sha256 || story.sha256 !== story.approvedSha256 || plan.storySha256 !== story.sha256) return { plan: null };
    }
    const { approval } = await host.call<{ approval: { sha256: string } | null }>("courseware.scenePlan.get", { sessionId });
    const after = await capture();
    const finalInfo = await fs.stat(path);
    if (after.root !== before.root || JSON.stringify(after.task) !== JSON.stringify(before.task) ||
        await resolveRealOpenablePath(path, before.root) !== path ||
        finalInfo.dev !== info.dev || finalInfo.ino !== info.ino || finalInfo.size !== size ||
        finalInfo.mtimeMs !== info.mtimeMs || finalInfo.ctimeMs !== info.ctimeMs)
      throw new Error("Scene task or draft location changed while reading");
    return { plan: { relativePath, sha256: createHash("sha256").update(bytes).digest("hex"), approvedSha256: approval?.sha256 ?? null, ...plan } };
  } finally { await file.close(); }
}

/** Explicit UI approval pins the already reviewed file; the Host rechecks its bytes. */
export async function approveSceneCourseDraft(host: Host, payload: unknown, checkSettingIds?: (sessionId: string, ids: string[]) => Promise<void>): Promise<{ plan: CoursewareScenePlanSnapshot | null }> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || Object.keys(payload).sort().join(",") !== "sessionId,sha256")
    throw new Error("Invalid scene plan approval");
  const sessionId = Reflect.get(payload, "sessionId"), sha256 = Reflect.get(payload, "sha256");
  if (typeof sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(sha256)) throw new Error("Invalid scene plan hash");
  const { plan } = await readSceneCourseDraft(host, { sessionId });
  if (!plan || plan.sha256 !== sha256) throw new Error("Scene plan changed; review it again");
  const ids = [...new Set(plan.pages.flatMap(page => page.visualSettingIds ?? []))];
  if (ids.length) await checkSettingIds?.(sessionId, ids);
  if (!plan.approvedSha256 && plan.textMode === "native") throw new Error("New scene plans must omit textMode so visibleText is rendered in image layers; preserve already approved plans");
  await host.call("courseware.scenePlan.approve", { sessionId, sha256 });
  return readSceneCourseDraft(host, { sessionId });
}
