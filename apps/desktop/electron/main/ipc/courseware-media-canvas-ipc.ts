import { IPC } from "@pi-desktop/shared";
import { CoursewareMediaCanvasCoordinator } from "../courseware-media-canvas";
import type { IpcRegistrar } from "./types";

export function registerCoursewareMediaCanvasIpc(registrar: IpcRegistrar, canvas: CoursewareMediaCanvasCoordinator) {
  for (const [channel, method] of [[IPC.invoke.coursewareMediaCanvasGet, "get"], [IPC.invoke.coursewareMediaCanvasSet, "set"]] as const) {
    registrar.handleWithEvent(channel, async (event, payload: unknown, ...extra: unknown[]) => {
      registrar.assertMainWindowSender(event);
      if (extra.length || !payload || typeof payload !== "object" || Array.isArray(payload) ||
          typeof Reflect.get(payload, "sessionId") !== "string") throw new Error("Invalid media canvas parameters");
      const { sessionId, ...args } = payload as { sessionId: string };
      return canvas.run(sessionId, method, args);
    });
  }
}
