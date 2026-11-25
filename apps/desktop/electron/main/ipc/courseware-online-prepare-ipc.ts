import { IPC } from "@pi-desktop/shared";
import type { CoursewareOnlinePreparation } from "../courseware-online-prepare";
import type { IpcRegistrar } from "./types";

export function registerCoursewareOnlinePreparationIpc(registrar: IpcRegistrar, preparation: CoursewareOnlinePreparation, available: () => boolean): void {
  for (const [channel, method] of [[IPC.invoke.coursewareOnlinePrepareReview, "review"],
    [IPC.invoke.coursewareOnlinePrepareConfirm, "confirm"], [IPC.invoke.coursewareOnlinePrepareCancel, "cancel"]] as const) {
    registrar.handleWithEvent(channel, async (event, payload: unknown, ...extra: unknown[]) => {
      registrar.assertMainWindowSender(event);
      const keys = method === "review" ? ["sessionId", "projectId"] : ["reviewId"];
      const includeTeaching = method === "review" && !!payload && typeof payload === "object" && Object.hasOwn(payload, "includeTeaching");
      const requireTaskSource = method === "review" && !!payload && typeof payload === "object" && Object.hasOwn(payload, "requireTaskSource");
      if (event.senderFrame !== event.sender.mainFrame || extra.length || !payload || typeof payload !== "object" || Array.isArray(payload) ||
          Object.keys(payload).length !== keys.length + Number(includeTeaching) + Number(requireTaskSource) || keys.some(key => !Object.hasOwn(payload, key) ||
            typeof Reflect.get(payload, key) !== "string" || !/^[\w.-]{1,128}$/u.test(Reflect.get(payload, key))) ||
          includeTeaching && typeof Reflect.get(payload, "includeTeaching") !== "boolean" ||
          requireTaskSource && typeof Reflect.get(payload, "requireTaskSource") !== "boolean") throw new Error("COURSEWARE_ONLINE_INVALID_REQUEST");
      if (method === "cancel") { preparation.cancel(Reflect.get(payload, "reviewId")); return { ok: true }; }
      if (!available()) throw new Error("COURSEWARE_ONLINE_DISABLED");
      try {
        return await (method === "review" ? preparation.review(Reflect.get(payload, "sessionId"), Reflect.get(payload, "projectId"),
          includeTeaching ? Reflect.get(payload, "includeTeaching") : false,
          requireTaskSource ? Reflect.get(payload, "requireTaskSource") : false) :
          preparation.confirm(Reflect.get(payload, "reviewId")));
      } catch (error) {
        const known = ["COURSEWARE_ONLINE_SESSION_ACTIVE", "COURSEWARE_ONLINE_OWNER_REQUIRED", "COURSEWARE_ONLINE_SOURCE_TOO_LARGE",
          "COURSEWARE_ONLINE_PREPARATION_CHANGED", "COURSEWARE_ONLINE_PREPARATION_BUSY", "COURSEWARE_ONLINE_INVALID_REQUEST",
          "COURSEWARE_ONLINE_TEACHING_NOT_READY", "COURSEWARE_ONLINE_TEACHING_CONFLICT", "COURSEWARE_ONLINE_TEACHING_MEDIA_UNAVAILABLE"];
        const code = error instanceof Error && known.includes(error.message) ? error.message : "COURSEWARE_ONLINE_PREPARATION_FAILED";
        throw new Error(code, { cause: error });
      }
    });
  }
}
