import { dirname, join } from "node:path";
import type { BrowserWindow } from "electron";
import { IPC } from "@pi-desktop/shared";
import { CoursewareFixedBuildCoordinator } from "../courseware-fixed-build";
import { CoursewarePlayerPreview } from "../courseware-player-preview";
import { openCoursewareBuildUpload } from "../courseware-build-files";
import type { HostProcess } from "../host-process";
import type { IpcRegistrar } from "./types";
import type { DesktopAuthSession } from "../auth-session";
import type { CoursewareFixedShareSelection } from "../courseware-media";
import type { ClassroomView } from "../courseware-classroom";
import { parseMaicClassroom } from "@pi-desktop/courseware-runtime/node";
import { readClassroomAsset } from "../courseware-classroom-assets";

type ShareIntent = { intentId: string; state: "unknown" | "bound"; selection: CoursewareFixedShareSelection; receiptAware?: boolean };

export function registerCoursewarePlaybackIpc(input: {
  registrar: IpcRegistrar;
  getMainWindow: () => BrowserWindow | null;
  getHost: () => HostProcess | null;
  getWorkspaceRoot: () => Promise<string | null>;
  getViewingSessionId: () => string | null;
  dataDir: string;
  authSession: DesktopAuthSession;
  refreshCanonical?: (sessionId: string, projectId: string) => Promise<void>;
}): () => void {
  const worker = process.env.DECKWISE_PPTX_WORKER || join(process.resourcesPath || "", "pptx-worker/pptx-worker.mjs");
  let observedHost: HostProcess | null = null;
  let detachHost: (() => void) | undefined;
  let sharing: AbortController | null = null;
  const getHost = () => {
    const host = input.getHost();
    if (host !== observedHost) {
      detachHost?.(); observedHost = host;
      detachHost = host?.onExit(() => cancel());
    }
    return host;
  };
  const builds = new CoursewareFixedBuildCoordinator(getHost, input.getWorkspaceRoot, input.getViewingSessionId,
    dirname(worker), join(input.dataDir, "courseware-builds"), input.refreshCanonical);
  const player = new CoursewarePlayerPreview(input.registrar.ipcMain, input.getMainWindow, builds, input.authSession.coursewareMedia);
  const cancel = () => { sharing?.abort(new Error("Courseware share canceled")); player.close(); builds.cancel(); };
  const previewClassroom = async (payload: unknown) => {
    if (!payload || typeof payload !== "object" || Array.isArray(payload) || Object.keys(payload).length !== 5 ||
        !["sessionId", "projectId", "expectedRevision", "expectedSourceRevision", "locale"].every(key => Object.hasOwn(payload, key))) throw new Error("Invalid canonical preview request");
    const sessionId = Reflect.get(payload, "sessionId"), projectId = Reflect.get(payload, "projectId");
    const revision = Reflect.get(payload, "expectedRevision"), sourceRevision = Reflect.get(payload, "expectedSourceRevision"), locale = Reflect.get(payload, "locale");
    if (typeof sessionId !== "string" || typeof projectId !== "string" || typeof revision !== "string" || typeof sourceRevision !== "string" || !["en", "zh-CN"].includes(locale)) throw new Error("Invalid canonical preview identity");
    const host = getHost(), workspace = await input.getWorkspaceRoot();
    if (!host || !workspace || input.getViewingSessionId() !== sessionId) throw new Error("Canonical preview owner changed");
    const { session } = await host.call<{ session?: { projectPath?: string; mode?: string } }>("session.get", { id: sessionId });
    if (session?.projectPath !== workspace || session.mode !== "agent") throw new Error("Canonical preview workspace changed");
    const assertCurrent = async () => {
      if (getHost() !== host || input.getViewingSessionId() !== sessionId || await input.getWorkspaceRoot() !== workspace) throw new Error("Canonical preview owner changed");
      const current = await host.call<ClassroomView>("courseware.classroom.get", { sessionId, projectId });
      if (current.revision !== revision || current.sourceRevision !== sourceRevision) throw new Error("Canonical classroom changed; reopen preview");
      if (getHost() !== host || input.getViewingSessionId() !== sessionId) throw new Error("Canonical preview owner changed");
    };
    await assertCurrent();
    const view = await host.call<ClassroomView>("courseware.classroom.get", { sessionId, projectId });
    const classroom = parseMaicClassroom(view.classroom), resources = new Map<string, { assetId: string; url: string; mimeType: string }>();
    for (const asset of classroom.mediaManifest ?? []) {
      resources.set(asset.assetId, { assetId: asset.assetId, url: asset.src, mimeType: asset.mimeType });
      if (asset.posterAssetId && asset.posterUrl) resources.set(asset.posterAssetId, { assetId: asset.posterAssetId, url: asset.posterUrl, mimeType: "image/*" });
    }
    for (const asset of classroom.audioManifest ?? []) resources.set(asset.assetId, { assetId: asset.assetId, url: asset.url, mimeType: asset.mimeType });
    await player.openClassroom({ classroom, buildId: revision, locale, assertCurrent, async readAsset(id) {
      const asset = typeof id === "string" ? resources.get(id) : undefined;
      if (!asset) throw new Error("Canonical asset is not in the selected manifest");
      await assertCurrent();
      const bytes = await readClassroomAsset(workspace, asset);
      await assertCurrent();
      return bytes;
    } });
    return { ok: true };
  };
  for (const [channel, operation] of [
    [IPC.invoke.coursewareClassroomPlay, previewClassroom],
    [IPC.invoke.coursewareFixedBuild, (payload: unknown) => { player.close(); return builds.build(payload); }],
    [IPC.invoke.coursewareFixedApprove, (payload: unknown) => builds.approveWarnings(payload)],
    [IPC.invoke.coursewareFixedPlay, async (payload: unknown) => {
      if (!payload || typeof payload !== "object" || Array.isArray(payload) || Object.keys(payload).length !== 2 ||
          !Object.hasOwn(payload, "previewId") || !Object.hasOwn(payload, "locale")) throw new Error("Invalid courseware preview request");
      await player.open(Reflect.get(payload, "previewId"), Reflect.get(payload, "locale"));
      return { ok: true };
    }],
    [IPC.invoke.coursewareFixedShare, async (payload: unknown) => {
      if (!payload || typeof payload !== "object" || Array.isArray(payload) || (Object.keys(payload).length !== 3 && Object.keys(payload).length !== 4) ||
          !Object.hasOwn(payload, "previewId") || !Object.hasOwn(payload, "projectId") || !Object.hasOwn(payload, "sessionId") ||
          Object.keys(payload).some((key) => !["previewId", "projectId", "sessionId", "channel"].includes(key))) throw new Error("Invalid team share request");
      const channel = Object.hasOwn(payload, "channel") ? Reflect.get(payload, "channel") : "shared";
      if (channel !== "shared" && channel !== "formal") throw new Error("Invalid team share channel");
      const sessionId = Reflect.get(payload, "sessionId"), projectId = Reflect.get(payload, "projectId"), previewId = Reflect.get(payload, "previewId");
      if (typeof projectId !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(projectId) ||
          typeof previewId !== "string" || !/^[\w.-]{1,128}$/u.test(previewId) ||
          typeof sessionId !== "string" || input.getViewingSessionId() !== sessionId) throw new Error("Invalid team share identity or owner changed");
      if (sharing) throw new Error("Courseware share is already running");
      const controller = new AbortController();
      let intent: ShareIntent | undefined;
      sharing = controller;
      try {
        const principal = input.authSession.getCoursewarePrincipal();
        const host = getHost();
        if (!host) throw new Error("Host is unavailable");
        const workspace = await input.getWorkspaceRoot();
        const assertCurrent = async () => {
          controller.signal.throwIfAborted();
          principal.assertCurrent();
          if (!workspace || getHost() !== host || input.getViewingSessionId() !== sessionId ||
              await input.getWorkspaceRoot() !== workspace) throw new Error("Courseware share owner changed");
          await builds.selected(previewId);
          controller.signal.throwIfAborted();
          principal.assertCurrent();
          if (getHost() !== host || input.getViewingSessionId() !== sessionId) throw new Error("Courseware share owner changed");
        };
        const checkBinding = async () => {
          await assertCurrent();
          const selected = await builds.selected(previewId);
          const origin = await host.call<{ teamProjectId: string | null }>("courseware.snapshot.onlineOrigin", {
            sessionId, projectId: selected.snapshot.projectId, snapshotId: selected.snapshot.snapshotId });
          await assertCurrent();
          if (!origin || !Object.hasOwn(origin, "teamProjectId")) throw new Error("Courseware snapshot origin is unavailable");
          if (origin.teamProjectId !== null) {
            if (origin.teamProjectId !== projectId || selected.snapshot.projectId !== projectId) throw new Error("Online snapshot belongs to another team project");
            return;
          }
          const { task } = await host.call<{ task: { teamProjectId?: string } | null }>("courseware.task.get", { sessionId });
          await assertCurrent();
          if (!task) throw new Error("Select a courseware task first");
          if (task.teamProjectId && task.teamProjectId !== projectId) throw new Error("Courseware task is already bound to another team project");
        };
        await checkBinding();
        const selected = await builds.selected(previewId);
        if (selected.canonical) throw new Error("Canonical MAIC classrooms must use MAIC ZIP export; this fixed-build sharing endpoint does not accept MAIC packages");
        const upload = await openCoursewareBuildUpload(selected.build.directory, selected.build.buildId);
        await checkBinding();
        ({ intent } = await host.call<{ intent: ShareIntent }>("courseware.fixedShare.prepare", { sessionId, principalKey: principal.key, receiptAware: true,
          selection: { projectId: selected.snapshot.projectId, snapshotId: selected.snapshot.snapshotId,
            buildId: selected.build.buildId, manifestSha256: upload.manifestHash, teamProjectId: projectId, channel } }));
        await assertCurrent();
        await input.authSession.coursewareMedia.uploadAndPublishFixedBuild(
          projectId, selected.snapshot.snapshotId, selected.build.buildId, upload, channel, controller.signal, intent.intentId);
        await assertCurrent();
        await host.call("courseware.fixedShare.complete", { sessionId, principalKey: principal.key, intentId: intent.intentId });
        await assertCurrent();
        return { ok: true };
      } catch (error) {
        if (intent) throw new Error("Courseware share result is unknown. Query the saved share result before sharing again.", { cause: error });
        throw error;
      } finally { if (sharing === controller) sharing = null; }
    }],
    [IPC.invoke.coursewareFixedShareStatus, async (payload: unknown) => {
      if (!payload || typeof payload !== "object" || Array.isArray(payload) || Object.keys(payload).length !== 1 ||
          typeof Reflect.get(payload, "sessionId") !== "string" || Reflect.get(payload, "sessionId") !== input.getViewingSessionId())
        throw new Error("Invalid share recovery session");
      const principal = input.authSession.getCoursewarePrincipal(), host = getHost();
      if (!host) throw new Error("Host is unavailable");
      const result = await host.call<{ intent: ShareIntent | null }>("courseware.fixedShare.get",
        { sessionId: Reflect.get(payload, "sessionId"), principalKey: principal.key });
      principal.assertCurrent();
      if (getHost() !== host || Reflect.get(payload, "sessionId") !== input.getViewingSessionId()) throw new Error("Courseware share owner changed");
      return result;
    }],
    [IPC.invoke.coursewareFixedShareRecover, async (payload: unknown) => {
      if (!payload || typeof payload !== "object" || Array.isArray(payload) || Object.keys(payload).length !== 2 ||
          typeof Reflect.get(payload, "sessionId") !== "string" || Reflect.get(payload, "sessionId") !== input.getViewingSessionId() ||
          typeof Reflect.get(payload, "intentId") !== "string" || !/^[a-f0-9-]{36}$/u.test(Reflect.get(payload, "intentId")))
        throw new Error("Invalid share recovery identity");
      if (sharing) throw new Error("Courseware share is already running");
      const sessionId = Reflect.get(payload, "sessionId"), intentId = Reflect.get(payload, "intentId");
      const principal = input.authSession.getCoursewarePrincipal(), host = getHost(), workspace = await input.getWorkspaceRoot();
      if (!host || !workspace) throw new Error("Courseware Host or workspace is unavailable");
      if (sharing) throw new Error("Courseware share is already running");
      const controller = new AbortController(); sharing = controller;
      const assertCurrent = async () => {
        controller.signal.throwIfAborted(); principal.assertCurrent();
        if (getHost() !== host || input.getViewingSessionId() !== sessionId || await input.getWorkspaceRoot() !== workspace)
          throw new Error("Courseware share owner changed");
        controller.signal.throwIfAborted(); principal.assertCurrent();
      };
      try {
        await assertCurrent();
        const { intent } = await host.call<{ intent: ShareIntent | null }>("courseware.fixedShare.get", { sessionId, principalKey: principal.key });
        if (!intent || intent.intentId !== intentId) throw new Error("Courseware share intent changed");
        await assertCurrent();
        await input.authSession.coursewareMedia.queryFixedBuildPublication(intent.selection, controller.signal, intent.receiptAware === true ? intent.intentId : undefined);
        await assertCurrent();
        const result = await host.call<{ intent: ShareIntent }>("courseware.fixedShare.complete", { sessionId, principalKey: principal.key, intentId });
        await assertCurrent();
        return result;
      } finally { if (sharing === controller) sharing = null; }
    }],
    [IPC.invoke.coursewareTeamPlay, async (payload: unknown) => {
      if (!payload || typeof payload !== "object" || Array.isArray(payload) || Object.keys(payload).length !== 3 ||
          !Object.hasOwn(payload, "projectId") || !Object.hasOwn(payload, "channel") || !Object.hasOwn(payload, "locale"))
        throw new Error("Invalid team preview request");
      await player.openTeam(Reflect.get(payload, "projectId"), Reflect.get(payload, "channel"), Reflect.get(payload, "locale"));
      return { ok: true };
    }],
  ] as const) input.registrar.handleWithEvent(channel, async (event, payload: unknown, ...extra: unknown[]) => {
    input.registrar.assertMainWindowSender(event);
    if (extra.length) throw new Error("Unexpected courseware build parameters");
    return operation(payload);
  });
  input.registrar.handleWithEvent(IPC.invoke.coursewareFixedCancel, async (event, ...args: unknown[]) => {
    input.registrar.assertMainWindowSender(event);
    if (args.length) throw new Error("Courseware cancel does not accept parameters");
    cancel(); return { ok: true };
  });
  return cancel;
}
