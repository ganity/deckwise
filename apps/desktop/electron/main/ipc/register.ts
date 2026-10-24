import { join } from "node:path";
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from "electron";
import { err, ErrorCodes, IPC, ok, type Result } from "@pi-desktop/shared";
import type { AgentHostBridge } from "../agent-host-bridge";
import type { AgentSidecar } from "../agent-sidecar";
import type { HostProcess } from "../host-process";
import { registerAgentExtensionIpc } from "../agent-extensions-ipc";
import { registerAgentIpc } from "./agent-ipc";
import { registerAppIpc } from "./app-ipc";
import { registerDiagnosticsIpc } from "./diagnostics-ipc";
import { registerMarketIpc } from "./market-ipc";
import { registerMcpIpc } from "./mcp-ipc";
import { searchMcpMarket } from "../mcp-registry-catalog";
import { registerNotificationIpc } from "./notification-ipc";
import { registerPluginIpc } from "./plugin-ipc";
import { registerPluginUiIpc } from "./plugin-ui-ipc";
import { registerProviderIpc } from "./provider-ipc";
import { registerPullsIpc } from "./pulls-ipc";
import { registerScheduledIpc } from "./scheduled-ipc";
import { registerSessionIpc } from "./session-ipc";
import { registerCoursewareSceneImageIpc } from "./courseware-scene-image-ipc";
import { registerCoursewareMediaCanvasIpc } from "./courseware-media-canvas-ipc";
import { registerCoursewareCanvasImageIpc } from "./courseware-canvas-image-ipc";
import type { CoursewareMediaCanvasCoordinator } from "../courseware-media-canvas";
import { CoursewareChatWorkflow } from "../courseware-chat-workflow";
import { registerSettingsIpc } from "./settings-ipc";
import { registerSkillsIpc } from "./skills-ipc";
import { fetchSkillMarketDocument, searchSkillMarket } from "../skill-market-catalog";
import { registerWindowIpc } from "./window-ipc";
import { createComposerTemplateLoader, registerWorkspaceIpc } from "./workspace-ipc";
import { registerComposerIpc } from "./composer-ipc";
import { registerSpeechIpc } from "./speech-ipc";
import { registerPptEditorIpc } from "./ppt-editor-ipc";
import { registerCoursewarePlaybackIpc } from "./courseware-playback-ipc";
import { registerCoursewareOnlineIpc } from "./courseware-online-ipc";
import type { CoursewareOnlinePreparation } from "../courseware-online-prepare";
import { registerPptPreviewIpc } from "./ppt-preview-ipc";
import { registerAuthIpc } from "./auth-ipc";
import type { DesktopAuthSession } from "../auth-session";
import type { IpcRegistrar } from "./types";

export type RegisterIpcDependencies = {
  ipcMain: IpcMain;
  getMainWindow: () => BrowserWindow | null;
  getHost: () => HostProcess | null;
  getSidecar: () => AgentSidecar | null;
  getAgentHostBridge: () => AgentHostBridge | null;
  authSession: DesktopAuthSession;
  mediaCanvas: CoursewareMediaCanvasCoordinator;
  onCoursewareWorkflowReady?: (workflow: CoursewareChatWorkflow) => void;
  getNotificationViewingSessionId: () => string | null;
  setNotificationViewingSessionId: (sessionId: string | null) => void;
  activeUserSubagentDocuments: (...args: any[]) => Promise<any>;
  registerDocumentCleanup: (sessionId: string, turnId: string, fileUrls: string[]) => void;
  disabledBuiltinSubagents: () => Promise<string[]>;
  [name: string]: any;
};

function wrap<T>(fn: () => Promise<T>): Promise<Result<T>> {
  return fn()
    .then((data) => ok(data))
    .catch((e: any) =>
      err(
        e?.data?.errorCode || e?.errorCode || ErrorCodes.INTERNAL,
        e instanceof Error ? e.message : String(e),
        { retriable: e?.data?.retriable === true, details: e?.data },
      ),
    );
}

export function registerIpcHandlers(dependencies: RegisterIpcDependencies) {
  const {
    ipcMain,
    getMainWindow,
    getHost,
    getSidecar,
    getAgentHostBridge,
    authSession,
    registerDocumentCleanup,
    getNotificationViewingSessionId,
    setNotificationViewingSessionId: updateViewingSession,
    getPluginLauncherWindow,
    togglePluginLauncher,
    safeOpenExternal,
    updater,
    dataDir,
    activeTurns,
    isTurnDispatchable,
    sessionProjects,
    persistenceOutbox,
    logger,
    plugins,
    speech,
    sessionCapabilityContext,
    enrichSession,
    acquireSessionOperation,
    stripWinLongPrefix,
    normalizeSettings,
    validateSettingsWrite,
    testNetworkProxy,
    applyNetworkProxyFromAppSettings,
    currentNetworkProxy,
    applyApplicationMenuSettings,
    applyDeveloperMode,
    resolveEffectiveCommandShell,
    modelsDevCatalog,
    vendorOAuth,
    enrichProvider,
    listRuntimeProviders,
    enrichProviderList,
    bindingForModel,
    agentExtensions,
    activeUserSkills,
    activeUserSubagentDocuments,
    disabledBuiltinSubagents,
    pluginActiveInProject,
    getWorkPanelReservationWidth,
    setWorkPanelReservationWidth,
    setWorkPanelReservation,
    getWorkPanelChatWidthSetter,
    applyCloseBehavior,
    getCloseBehavior,
    markMenuRendererReady,
    executeNativeMenuAction,
    scheduledRunsBySession,
    isDevelopmentBuild,
    browserHost,
    clipboardHistory,
    recordPastedClipboardFiles,
    currentWorkspacePath,
    setCurrentWorkspacePath: updateWorkspacePath,
    withGitBranch,
    activeTurnUsages,
    approvedExecutionIdsBySession,
    claimedExecutionSessions,
    resolveAgentRuntimeLaunch,
    finishTurn,
    lockAbortReason,
    finishApprovedExecution,
    dispatchApprovedPlan,
    dispatchExecutionForProposal,
    emitAgentEvent,
    userMcp,
    refreshUserMcp,
    describeError,
    pluginViews,
    pluginSettingsViews,
    pluginScopes,
    rememberPluginScopes,
    pluginPanels,
    getUpdaterLocale,
    getPluginPanelTheme,
    isDeveloperMode,
    sendToRenderer,
  } = dependencies;

  let cancelCoursewarePlayback = () => {};
  const setNotificationViewingSessionId = (sessionId: string | null) => {
    if (sessionId !== getNotificationViewingSessionId()) cancelCoursewarePlayback();
    updateViewingSession(sessionId);
  };
  const setCurrentWorkspacePath = (path: string | null) => {
    cancelCoursewarePlayback();
    updateWorkspacePath(path);
  };


  const ipcHandlers = new Map<string, (...args: any[]) => Promise<any>>();
  const handle = (channel: string, fn: (...args: any[]) => Promise<any>) => {
    ipcHandlers.set(channel, fn);
    ipcMain.handle(channel, async (_event, ...args) => wrap(() => fn(...args)));
  };
  const handleWithEvent = (
    channel: string,
    fn: (event: IpcMainInvokeEvent, ...args: any[]) => Promise<any>,
  ) => {
    ipcMain.handle(channel, async (event, ...args) =>
      wrap(() => fn(event, ...args)),
    );
  };
  const assertMainWindowSender = (event: IpcMainInvokeEvent): void => {
    if (event.sender.id !== getMainWindow()?.webContents.id) {
      throw Object.assign(new Error("renderer is not the main window"), {
        errorCode: "PERMISSION_DENIED",
      });
    }
  };

  const optionalWorkspaceRoot = async (): Promise<string | null> => {
    const currentHost = getHost();
    if (!currentHost) return null;
    try {
      const result = (await currentHost.call("workspace.get")) as {
        workspace: { path?: string } | null;
      };
      return result.workspace?.path ?? null;
    } catch {
      return null;
    }
  };

  const registrar: IpcRegistrar = {
    ipcMain,
    handle,
    handleWithEvent,
    assertMainWindowSender,
  };

  registerAuthIpc({
    registrar,
    authSession,
    dataDir,
    getWorkspaceRoot: optionalWorkspaceRoot,
  });

  let onlinePreparation: CoursewareOnlinePreparation | undefined;
  registerCoursewareOnlineIpc({ registrar, authSession, getMainWindow, sendToRenderer, getPreparation: () => onlinePreparation,
    getHost, getWorkspaceRoot: optionalWorkspaceRoot, getViewingSessionId: getNotificationViewingSessionId });

  registerAppIpc({
    registrar,
    getHost,
    getPluginLauncherWindow,
    togglePluginLauncher,
    safeOpenExternal,
    updater,
  });
  registerPptPreviewIpc({
    registrar,
    getWorkspaceRoot: optionalWorkspaceRoot,
  });
  registerNotificationIpc({
    registrar,
    getHost,
    getMainWindow,
    getViewingSessionId: getNotificationViewingSessionId,
    setViewingSessionId: setNotificationViewingSessionId,
    sendToRenderer,
  });
  registerCoursewareSceneImageIpc({ registrar, getHost, getViewingSessionId: getNotificationViewingSessionId,
    activeTurns, authSession, generation: dependencies.sceneGeneration });
  const coursewareWorkflow = new CoursewareChatWorkflow(getHost, getNotificationViewingSessionId, authSession, dependencies.sceneGeneration);
  dependencies.onCoursewareWorkflowReady?.(coursewareWorkflow);
  registrar.handleWithEvent(IPC.invoke.coursewareWorkflowGet, async (event, value: unknown, ...extra: unknown[]) => {
    registrar.assertMainWindowSender(event);
    if (extra.length || !value || typeof value !== "object" || Array.isArray(value) ||
        Object.keys(value).join(",") !== "sessionId" || typeof Reflect.get(value, "sessionId") !== "string")
      throw new Error("Invalid courseware workflow request");
    return coursewareWorkflow.read(Reflect.get(value, "sessionId"));
  });
  registerCoursewareMediaCanvasIpc(registrar, dependencies.mediaCanvas);
  registerCoursewareCanvasImageIpc({ registrar, getHost, getViewingSessionId: getNotificationViewingSessionId,
    activeTurns, authSession });
  registerSessionIpc({
    registrar,
    getHost,
    getSidecar,
    dataDir,
    activeTurns,
    sessionProjects,
    persistenceOutbox,
    logger,
    plugins,
    sessionCapabilityContext,
    enrichSession,
    acquireSessionOperation,
    stripWinLongPrefix,
  });
  registerSettingsIpc({
    registrar,
    getHost,
    getSidecar,
    dataDir,
    normalizeSettings,
    validateSettingsWrite,
    testNetworkProxy,
    applyNetworkProxyFromAppSettings,
    currentNetworkProxy,
    applyApplicationMenuSettings,
    applyDeveloperMode,
    resolveEffectiveCommandShell,
  });
  registerProviderIpc({
    registrar,
    getHost,
    modelsDevCatalog,
    vendorOAuth,
    logger,
    enrichProvider,
    listRuntimeProviders,
    enrichProviderList,
    bindingForModel,
  });
  const loadComposerTemplatesCached = createComposerTemplateLoader(logger);
  const composerCommandService = registerComposerIpc({
    registrar,
    plugins,
    agentExtensions,
    optionalWorkspaceRoot,
    activeUserSkills,
    pluginActiveInProject,
    loadComposerTemplatesCached,
  });
  registerWindowIpc({
    registrar,
    getMainWindow,
    getWorkPanelReservationWidth,
    setWorkPanelReservationWidth,
    setWorkPanelReservation,
    getWorkPanelChatWidthSetter,
    applyCloseBehavior,
    getCloseBehavior,
    markMenuRendererReady,
    executeNativeMenuAction,
  });
  registerPullsIpc({ registrar, getHost });
  registerScheduledIpc({
    registrar,
    getHost,
    scheduledRunsBySession,
  });
  const { fsExtraRoots } = registerWorkspaceIpc({
    registrar,
    getHost,
    getSidecar,
    dataDir,
    isDevelopmentBuild,
    plugins,
    browserHost,
    clipboardHistory,
    logger,
    recordPastedClipboardFiles,
    currentWorkspacePath,
    setCurrentWorkspacePath,
    withGitBranch,
    stripWinLongPrefix,
  });

  cancelCoursewarePlayback = registerCoursewarePlaybackIpc({ registrar, getMainWindow, getHost,
    getWorkspaceRoot: optionalWorkspaceRoot, getViewingSessionId: getNotificationViewingSessionId, dataDir, authSession });
  registerPptEditorIpc({
    registrar,
    activeTurns,
    authSession,
    getMainWindow,
    getHost,
    getWorkspaceRoot: optionalWorkspaceRoot,
    getViewingSessionId: getNotificationViewingSessionId,
    onChatBridgeReady: dependencies.onPptEditorChatReady,
    onOnlinePreparationReady: preparation => { onlinePreparation = preparation; },
    completeNarration: dependencies.completeNarration,
    completeScene: dependencies.completeScene,
    sendToRenderer,
    getExtraRoots: fsExtraRoots,
    onDeactivate: cancelCoursewarePlayback,
  });

  registerAgentExtensionIpc({
    handle,
    bridge: agentExtensions,
    window: getMainWindow,
    importRoot: join(dataDir, "plugins", "imported"),
    loadDevPlugin: async (path) => {
      const currentHost = getHost();
      if (!currentHost) throw new Error("host unavailable");
      const loaded = await currentHost.call<{ plugin: any }>("plugins.loadDev", { path });
      await plugins.loadFromPath(path, loaded.plugin?.permissions ?? [], { development: true });
      if (loaded.plugin?.id) plugins.watchDevPlugin(loaded.plugin.id);
      sendToRenderer(IPC.event.pluginChanged, { reason: "importExtension", pluginId: loaded.plugin?.id });
      return loaded;
    },
    runCommand: async (input) => {
      const currentSidecar = getSidecar();
      if (!currentSidecar) throw new Error("agent sidecar unavailable");
      return currentSidecar.call<{ handled: boolean }>("extensions.command.run", input);
    },
  });
  registerAgentIpc({
    registrar,
    getHost,
    getSidecar,
    getAgentHostBridge,
    cancelSessionTools: (sessionId: string, reason?: string) => plugins.cancelSessionTools(sessionId, reason),
    logger,
    vendorOAuth,
    resolvePlatformAccessToken: () => authSession.resolveAccessToken(),
    parseDocument: (path) => authSession.parseDocument(path),
    cleanupDocuments: (fileUrls) => authSession.cleanupDocuments(fileUrls),
    registerDocumentCleanup,
    agentExtensions,
    persistenceOutbox,
    dataDir,
    activeTurns,
    isTurnDispatchable,
    activeTurnUsages,
    approvedExecutionIdsBySession,
    claimedExecutionSessions,
    resolveAgentRuntimeLaunch,
    acquireSessionOperation,
    finishTurn,
    lockAbortReason,
    finishApprovedExecution,
    dispatchApprovedPlan,
    dispatchExecutionForProposal,
    emitAgentEvent,
    setNotificationViewingSessionId,
    optionalWorkspaceRoot,
    composerCommandService,
    loadComposerTemplatesCached,
  });

  registerPluginIpc({
    registrar,
    getHost,
    plugins,
    agentExtensions,
    browserHost,
    pluginViews,
    pluginSettingsViews,
    pluginScopes,
    rememberPluginScopes,
    sendToRenderer,
    logger,
  });


  registerMcpIpc({
    registrar,
    getHost,
    userMcp,
    currentWorkspacePath,
    refreshUserMcp,
    describeError,
    sendToRenderer,
    searchMcpMarket,
  });


  registerSkillsIpc({
    registrar,
    getHost,
    searchSkillMarket,
    fetchSkillMarketDocument,
    optionalWorkspaceRoot,
    activeUserSubagentDocuments,
    disabledBuiltinSubagents,
    stripWinLongPrefix,
    sendToRenderer,
    logger,
  });


  registerPluginUiIpc({
    registrar,
    plugins,
    browserHost,
    pluginViews,
    pluginSettingsViews,
    pluginPanels,
    pluginActiveInProject,
    currentWorkspacePath,
    getUpdaterLocale,
    getPluginPanelTheme,
  });

  registerSpeechIpc({ registrar, speech });

  registerMarketIpc({
    registrar,
    getHost,
    plugins,
    agentExtensions,
    optionalWorkspaceRoot,
    pluginActiveInProject,
    sendToRenderer,
  });


  registerDiagnosticsIpc({
    registrar,
    dataDir,
    stripWinLongPrefix,
    isDeveloperMode,
    getMainWindow,
  });


  return async (channel: string, args: readonly unknown[] = []) => {
    const handler = ipcHandlers.get(channel);
    if (!handler) {
      throw Object.assign(new Error(`IPC channel is not available to external agents: ${channel}`), {
        errorCode: ErrorCodes.NOT_FOUND,
      });
    }
    return handler(...args);
  };
}
