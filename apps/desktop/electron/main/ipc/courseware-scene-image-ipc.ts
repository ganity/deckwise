import { IPC } from "@pi-desktop/shared";
import { CoursewareSceneImages } from "../courseware-scene-images";
import { CoursewareSceneGeneration, type SceneCourseGenerationServices } from "../courseware-scene-generation";
import type { DesktopAuthSession } from "../auth-session";
import type { HostProcess } from "../host-process";
import type { IpcRegistrar } from "./types";

export function registerCoursewareSceneImageIpc(input: {
  registrar: IpcRegistrar; getHost: () => HostProcess | null;
  getViewingSessionId: () => string | null; activeTurns: ReadonlyMap<string, string>; authSession: DesktopAuthSession;
  generation: SceneCourseGenerationServices;
}) {
  const images = new CoursewareSceneImages(input.getHost, input.getViewingSessionId,
    (sessionId) => input.activeTurns.has(sessionId), input.authSession, input.generation?.planVisualMaster, input.generation?.layerFallback);
  const generation = new CoursewareSceneGeneration(images, input.generation);
  for (const [channel, method] of [[IPC.invoke.coursewareSceneGenerate, "generate"], [IPC.invoke.coursewareSceneGenerateCancel, "cancel"]] as const) {
    input.registrar.handleWithEvent(channel, async (event, value: unknown, ...extra: unknown[]) => {
      input.registrar.assertMainWindowSender(event);
      if (extra.length) throw new Error("Unexpected scene generation parameters");
      return generation[method](value);
    });
  }
  for (const [channel, method] of [
    [IPC.invoke.coursewareSceneImageModels, "models"], [IPC.invoke.coursewareSceneImageList, "list"],
    [IPC.invoke.coursewareSceneImagePrepare, "prepare"], [IPC.invoke.coursewareSceneImageQuote, "quote"],
    [IPC.invoke.coursewareSceneImageSubmitConfirmed, "submitConfirmed"], [IPC.invoke.coursewareSceneImageStatus, "status"],
    [IPC.invoke.coursewareSceneImageArchive, "archive"], [IPC.invoke.coursewareSceneImagePreview, "preview"],
    [IPC.invoke.coursewareSceneImageAdopt, "adopt"],
  ] as const) {
    input.registrar.handleWithEvent(channel, async (event, value: unknown, ...extra: unknown[]) => {
      input.registrar.assertMainWindowSender(event);
      if (extra.length) throw new Error("Unexpected scene image parameters");
      if (method === "submitConfirmed" && value && typeof value === "object" && !Object.hasOwn(value, "quoteId"))
        return images.generate(value);
      return images[method](value);
    });
  }
}
