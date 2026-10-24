import { IPC } from "@pi-desktop/shared";
import { CoursewareCanvasImages } from "../courseware-canvas-images";
import type { DesktopAuthSession } from "../auth-session";
import type { HostProcess } from "../host-process";
import type { IpcRegistrar } from "./types";

export function registerCoursewareCanvasImageIpc(input: {
  registrar: IpcRegistrar; getHost: () => HostProcess | null;
  getViewingSessionId: () => string | null; activeTurns: ReadonlyMap<string, string>; authSession: DesktopAuthSession;
}) {
  const images = new CoursewareCanvasImages(input.getHost, input.getViewingSessionId,
    sessionId => input.activeTurns.has(sessionId), input.authSession);
  for (const [channel, method] of [
    [IPC.invoke.coursewareCanvasImageModels, "models"], [IPC.invoke.coursewareCanvasImageList, "list"],
    [IPC.invoke.coursewareCanvasImagePrepare, "prepare"], [IPC.invoke.coursewareCanvasImageQuote, "quote"],
    [IPC.invoke.coursewareCanvasImageSubmitConfirmed, "submitConfirmed"], [IPC.invoke.coursewareCanvasImageStatus, "status"],
    [IPC.invoke.coursewareCanvasImageArchive, "archive"], [IPC.invoke.coursewareCanvasImagePreview, "preview"],
    [IPC.invoke.coursewareCanvasImageReferencePreview, "referencePreview"],
    [IPC.invoke.coursewareCanvasImageRestore, "restore"],
  ] as const) {
    input.registrar.handleWithEvent(channel, async (event, value: unknown, ...extra: unknown[]) => {
      input.registrar.assertMainWindowSender(event);
      if (extra.length) throw new Error("Unexpected canvas image parameters");
      return images[method](value);
    });
  }
}
