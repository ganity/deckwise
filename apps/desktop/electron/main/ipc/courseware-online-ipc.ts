import type { BrowserWindow } from "electron";
import { IPC } from "@pi-desktop/shared";
import type { DesktopAuthSession } from "../auth-session";
import { CoursewareOnlineViewController } from "../courseware-online-view";
import { coursewareOnlineDeployment } from "../courseware-online-deployment";
import { CoursewareOnlineTeachingCoordinator } from "../courseware-online-teaching";
import { CoursewareOnlinePauseCoordinator } from "../courseware-online-pause";
import { CoursewareOnlineBarrierCoordinator } from "../courseware-online-barrier";
import { CoursewareOnlineSourceReviewCoordinator } from "../courseware-online-source-review";
import type { HostProcess } from "../host-process";
import type { IpcRegistrar } from "./types";
import type { CoursewareOnlinePreparation } from "../courseware-online-prepare";

export function registerCoursewareOnlineIpc(input: {
  registrar: IpcRegistrar;
  authSession: DesktopAuthSession;
  getMainWindow(): BrowserWindow | null;
  sendToRenderer(channel: string, payload: unknown): void;
  getPreparation?(): CoursewareOnlinePreparation | undefined;
  getHost(): HostProcess | null;
  getWorkspaceRoot(): Promise<string | null>;
  getViewingSessionId(): string | null;
}): () => void {
  let deployment;
  try { deployment = coursewareOnlineDeployment(); }
  catch { console.warn("[courseware-online] COURSEWARE_ONLINE_INVALID_DEPLOYMENT"); deployment = null; }
  const controller = new CoursewareOnlineViewController({
    ipcMain: input.registrar.ipcMain, getMainWindow: input.getMainWindow, deployment,
    emit: state => input.sendToRenderer(IPC.event.coursewareOnlineState, state),
    authorize: () => input.authSession.getCoursewarePrincipal(),
    join: (projectId, signal, clientId) => input.getPreparation?.()?.join(projectId, signal, clientId) ?? input.authSession.joinCoursewareOnline(projectId, signal, clientId),
    client: () => input.authSession.getCoursewareOnlineClient(),
  });
  const teaching = new CoursewareOnlineTeachingCoordinator({
    binding: ownerId => controller.teachingBinding(ownerId),
    client: () => input.authSession.getCoursewareOnlineClient(),
    principal: () => input.authSession.getCoursewarePrincipal(),
  });
  const pause = new CoursewareOnlinePauseCoordinator({
    binding: ownerId => controller.teachingBinding(ownerId),
    client: () => input.authSession.getCoursewareOnlineClient(),
    principal: () => input.authSession.getCoursewarePrincipal(),
  });
  const barrier = new CoursewareOnlineBarrierCoordinator({
    binding: ownerId => controller.teachingBinding(ownerId),
    selection: ownerId => controller.recoverySelection(ownerId),
    client: () => input.authSession.getCoursewareOnlineClient(),
    principal: () => input.authSession.getCoursewarePrincipal(),
  });
  const source = new CoursewareOnlineSourceReviewCoordinator({
    binding: ownerId => ({ ...controller.teachingBinding(ownerId), documentKey: controller.registryBinding(ownerId).documentKey }),
    client: () => input.authSession.getCoursewareOnlineClient(),
    media: () => input.authSession.coursewareMedia,
    principal: () => input.authSession.getCoursewarePrincipal(),
    getHost: input.getHost, getWorkspaceRoot: input.getWorkspaceRoot, getViewingSessionId: input.getViewingSessionId,
    ipcMain: input.registrar.ipcMain,
  });
  const unsubscribe = input.authSession.onStateChanged(() => { input.getPreparation?.()?.invalidate(); source.invalidate(); barrier.invalidate(); pause.invalidate(); teaching.invalidate(); controller.invalidate(); });
  const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
  const exact = (value: unknown, keys: string[]): value is Record<string, unknown> => record(value) &&
    keys.length === Object.keys(value).length && keys.every(key => Object.hasOwn(value, key));
  const uuid = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(value);
  for (const channel of [IPC.invoke.coursewareOnlineState, IPC.invoke.coursewareOnlineOpen, IPC.invoke.coursewareOnlineSetBounds,
    IPC.invoke.coursewareOnlineSetVisible, IPC.invoke.coursewareOnlineClose]) input.registrar.handleWithEvent(channel, async (event, payload: unknown, ...extra: unknown[]) => {
    input.registrar.assertMainWindowSender(event);
    if (event.senderFrame !== event.sender.mainFrame || extra.length) throw new Error("COURSEWARE_ONLINE_INVALID_REQUEST");
    if (channel === IPC.invoke.coursewareOnlineState) {
      if (payload !== undefined) throw new Error("COURSEWARE_ONLINE_INVALID_REQUEST");
      return controller.state();
    }
    const keys = channel === IPC.invoke.coursewareOnlineOpen ? ["ownerId", "projectId"] :
      channel === IPC.invoke.coursewareOnlineSetBounds ? ["ownerId", "bounds"] :
      channel === IPC.invoke.coursewareOnlineSetVisible ? ["ownerId", "visible"] : ["ownerId"];
    if (!exact(payload, keys) || !uuid(payload.ownerId)) throw new Error("COURSEWARE_ONLINE_INVALID_REQUEST");
    if (channel === IPC.invoke.coursewareOnlineOpen) {
      if (!uuid(payload.projectId)) throw new Error("COURSEWARE_ONLINE_INVALID_REQUEST");
      teaching.invalidate();
      pause.invalidate();
      barrier.invalidate();
      source.invalidate();
      return controller.open(payload.ownerId, payload.projectId);
    }
    if (channel === IPC.invoke.coursewareOnlineSetVisible) {
      if (typeof payload.visible !== "boolean") throw new Error("COURSEWARE_ONLINE_INVALID_REQUEST");
      controller.setVisible(payload.ownerId, payload.visible);
    } else if (channel === IPC.invoke.coursewareOnlineSetBounds) {
      if (!exact(payload.bounds, ["x", "y", "width", "height"]) || !Object.values(payload.bounds).every(value =>
        typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 16_384))
        throw new Error("COURSEWARE_ONLINE_INVALID_REQUEST");
      controller.setBounds(payload.ownerId, payload.bounds as { x: number; y: number; width: number; height: number });
    } else {
      if (controller.state().ownerId === payload.ownerId) { source.invalidate(); teaching.invalidate(); pause.invalidate(); barrier.invalidate(); }
      controller.close(payload.ownerId);
    }
    return { ok: true };
  });
  for (const [channel, method] of [[IPC.invoke.coursewareOnlineTeachingRead, "read"],
    [IPC.invoke.coursewareOnlineTeachingAcquire, "acquire"], [IPC.invoke.coursewareOnlineTeachingRenew, "renew"],
    [IPC.invoke.coursewareOnlineTeachingSave, "save"], [IPC.invoke.coursewareOnlineTeachingRelease, "release"]] as const) {
    input.registrar.handleWithEvent(channel, async (event, payload: unknown, ...extra: unknown[]) => {
      input.registrar.assertMainWindowSender(event);
      const keys = method === "read" ? ["ownerId", ...(record(payload) && Object.hasOwn(payload, "pageId") ? ["pageId"] : [])] :
        method === "save" ? ["viewId", "actions"] : ["viewId"];
      if (event.senderFrame !== event.sender.mainFrame || extra.length || !exact(payload, keys) ||
          !uuid(payload[method === "read" ? "ownerId" : "viewId"]) ||
          method === "read" && Object.hasOwn(payload, "pageId") &&
          (typeof payload.pageId !== "string" || !/^[\w.-]{1,128}$/u.test(payload.pageId) || [".", ".."].includes(payload.pageId)))
        throw new Error("COURSEWARE_ONLINE_INVALID_REQUEST");
      try {
        if (method === "read") return await teaching.read(payload.ownerId as string, payload.pageId as string | undefined);
        if (method === "save") return await teaching.save(payload.viewId as string, payload.actions);
        return await teaching[method](payload.viewId as string);
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        const safe = /^COURSEWARE_ONLINE_(?:PLATFORM_\d+|TEACHING_(?:CHANGED|CONFLICT|BUSY|LOCKED|INVALID_ACTIONS|PENDING_WRITE|LEASE_EXPIRED))$/u;
        throw new Error(safe.test(message) ? message : "COURSEWARE_ONLINE_TEACHING_FAILED", { cause: error });
      }
    });
  }
  for (const [channel, method] of [[IPC.invoke.coursewareOnlinePauseRead, "read"], [IPC.invoke.coursewareOnlinePauseResume, "resume"]] as const) {
    input.registrar.handleWithEvent(channel, async (event, payload: unknown, ...extra: unknown[]) => {
      input.registrar.assertMainWindowSender(event);
      const key = method === "read" ? "ownerId" : "viewId";
      if (event.senderFrame !== event.sender.mainFrame || extra.length || !exact(payload, [key]) || !uuid(payload[key]))
        throw new Error("COURSEWARE_ONLINE_INVALID_REQUEST");
      try {
        if (method === "resume") { teaching.assertNoPendingOperation(); source.assertNoPendingOperation(); }
        return await pause[method](payload[key] as string);
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        throw new Error(/^COURSEWARE_ONLINE_(?:PLATFORM_\d+|PAUSE_(?:CHANGED|BUSY)|TEACHING_BUSY|SOURCE_BUSY)$/u.test(message)
          ? message : "COURSEWARE_ONLINE_PAUSE_FAILED", { cause: error });
      }
    });
  }
  for (const [channel, method] of [[IPC.invoke.coursewareOnlineBarrierRead, "read"],
    [IPC.invoke.coursewareOnlineBarrierStart, "start"], [IPC.invoke.coursewareOnlineBarrierResume, "resume"]] as const) {
    input.registrar.handleWithEvent(channel, async (event, payload: unknown, ...extra: unknown[]) => {
      input.registrar.assertMainWindowSender(event);
      const key = method === "read" ? "ownerId" : "viewId";
      if (event.senderFrame !== event.sender.mainFrame || extra.length || !exact(payload, [key]) || !uuid(payload[key]))
        throw new Error("COURSEWARE_ONLINE_INVALID_REQUEST");
      try {
        if (method !== "read") { teaching.assertNoPendingOperation(); source.assertNoPendingOperation(); }
        return await barrier[method](payload[key] as string);
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        throw new Error(/^COURSEWARE_ONLINE_(?:PLATFORM_\d+|BARRIER_(?:CHANGED|BUSY|UNCERTAIN)|TEACHING_BUSY|SOURCE_BUSY)$/u.test(message)
          ? message : "COURSEWARE_ONLINE_BARRIER_FAILED", { cause: error });
      }
    });
  }
  for (const [channel, method] of [[IPC.invoke.coursewareOnlineSourceBegin, "begin"],
    [IPC.invoke.coursewareOnlineSourceResolve, "resolve"], [IPC.invoke.coursewareOnlineSourcePreview, "preview"],
    [IPC.invoke.coursewareOnlineSourceCapture, "capture"],
    [IPC.invoke.coursewareOnlineSourceClear, "clear"]] as const) {
    input.registrar.handleWithEvent(channel, async (event, payload: unknown, ...extra: unknown[]) => {
      input.registrar.assertMainWindowSender(event);
      const keys = method === "begin" ? ["ownerId", "sessionId"] : method === "resolve" ? ["viewId", "decisions"] :
        method === "preview" ? ["viewId", "side", "page"] : ["viewId"];
      if (event.senderFrame !== event.sender.mainFrame || extra.length || !exact(payload, keys) ||
          !uuid(payload[method === "begin" ? "ownerId" : "viewId"]) ||
          method === "begin" && (typeof payload.sessionId !== "string" || !/^[\w.-]{1,128}$/u.test(payload.sessionId) || [".", ".."].includes(payload.sessionId)) ||
          method === "resolve" && !record(payload.decisions) ||
          method === "preview" && ((payload.side !== "original" && payload.side !== "target") ||
            typeof payload.page !== "number" || !Number.isSafeInteger(payload.page) || payload.page < 1 || payload.page > 100))
        throw new Error("COURSEWARE_ONLINE_INVALID_REQUEST");
      try {
        if (method === "begin") {
          teaching.assertNoPendingOperation();
          return await source.begin(payload.ownerId as string, payload.sessionId as string);
        }
        if (method === "resolve") return await source.resolve(payload.viewId as string, payload.decisions);
        if (method === "capture") return await source.capture(payload.viewId as string);
        if (method === "preview") return { image: await source.preview(payload.viewId as string, payload.side as "original" | "target", payload.page as number) };
        await source.clear(payload.viewId as string);
        return { ok: true };
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        throw new Error(/^COURSEWARE_ONLINE_(?:PLATFORM_\d+|SOURCE_(?:BUSY|CHANGED|CONTEXT_CHANGED|INVALID|CLEANUP_FAILED|TIMEOUT|NOT_READY|CAPTURE_UNCERTAIN|IMPORT_UNCERTAIN)|TEACHING_BUSY)$/u.test(message)
          ? message : "COURSEWARE_ONLINE_SOURCE_FAILED", { cause: error });
      }
    });
  }
  return () => { unsubscribe(); source.invalidate(); barrier.invalidate(); pause.invalidate(); teaching.invalidate(); controller.dispose(); };
}
