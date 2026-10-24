import { IPC } from "@pi-desktop/shared";
import { CoursewareCanvasMusic } from "../courseware-canvas-music";
import type { DesktopAuthSession } from "../auth-session";
import type { HostProcess } from "../host-process";
import type { IpcRegistrar } from "./types";
import type { CoursewareTeachingCoordinator } from "../courseware-teaching";
import { decodeCoursewareAudio } from "../courseware-audio-decode";

export function registerCoursewareCanvasMusicIpc(input: {
  registrar: IpcRegistrar; getHost: () => HostProcess | null;
  getViewingSessionId: () => string | null; activeTurns: ReadonlyMap<string, string>; authSession: DesktopAuthSession;
  teaching: CoursewareTeachingCoordinator;
}) {
  const music = new CoursewareCanvasMusic(input.getHost, input.getViewingSessionId,
    sessionId => input.activeTurns.has(sessionId), input.authSession, { teaching: input.teaching, decodeAudio: decodeCoursewareAudio });
  for (const [channel, method] of [
    [IPC.invoke.coursewareCanvasMusicModels, "models"], [IPC.invoke.coursewareCanvasMusicList, "list"],
    [IPC.invoke.coursewareCanvasMusicPrepare, "prepare"], [IPC.invoke.coursewareCanvasMusicQuote, "quote"],
    [IPC.invoke.coursewareCanvasMusicSubmitConfirmed, "submitConfirmed"], [IPC.invoke.coursewareCanvasMusicStatus, "status"],
    [IPC.invoke.coursewareCanvasMusicPreview, "preview"], [IPC.invoke.coursewareCanvasMusicExportPrepare, "exportPrepare"],
    [IPC.invoke.coursewareCanvasMusicExportQuote, "exportQuote"], [IPC.invoke.coursewareCanvasMusicExportSubmitConfirmed, "exportSubmitConfirmed"],
    [IPC.invoke.coursewareCanvasMusicExportStatus, "exportStatus"], [IPC.invoke.coursewareCanvasMusicExportArchive, "exportArchive"],
    [IPC.invoke.coursewareCanvasMusicAdopt, "adopt"],
  ] as const) {
    input.registrar.handleWithEvent(channel, async (event, value: unknown, ...extra: unknown[]) => {
      input.registrar.assertMainWindowSender(event);
      if (extra.length) throw new Error("Unexpected canvas music parameters");
      return music[method](value);
    });
  }
}
