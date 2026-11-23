import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../lib/api";
import { inspectProject, pptMasterRepairPrompt, referencedProject, type PptProjectState } from "../../lib/ppt-master-project";
import { pptEditorWorkPanelTab, svgEditorWorkPanelTab } from "../../lib/work-panel-tabs";
import { useAppStore } from "../../stores/app-store";

export function CoursewareChatPresentation({
  sessionId, sourcePath, disabled, refreshKey, sourceVisuals, onReady, renderEditor,
}: {
  sessionId: string;
  sourcePath?: string;
  disabled: boolean;
  refreshKey: number;
  sourceVisuals?: ReactNode;
  onReady?: (path: string | null) => void;
  renderEditor?: (previewButton: ReactNode) => ReactNode;
}) {
  const { t } = useTranslation();
  const messages = useAppStore(state => state.messages);
  const isRunning = useAppStore(state => state.runningSessions[sessionId] ?? false);
  const path = referencedProject(messages, sourcePath);
  const [project, setProject] = useState<PptProjectState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const working = useRef(false);
  const previewOpened = useRef<string | null>(null);
  const previewRequest = useRef(0);
  useEffect(() => {
    working.current = false;
    setBusy(false);
    previewOpened.current = null;
    return () => { ++previewRequest.current; };
  }, [sessionId, path]);
  useEffect(() => { setProject(null); }, [path]);
  useEffect(() => {
    let disposed = false, request = 0;
    const load = async () => {
      if (!path) return;
      const id = ++request;
      try {
        const value = await inspectProject(path);
        if (!disposed && id === request) { setProject(value); setError(""); }
      } catch (failure) { if (!disposed && id === request) setError(String(failure)); }
    };
    void load();
    const timer = disabled || isRunning ? window.setInterval(() => void load(), 2000) : undefined;
    return () => { disposed = true; if (timer !== undefined) window.clearInterval(timer); };
  }, [sessionId, path, disabled, isRunning, messages.length, refreshKey]);
  const run = async (operation: () => Promise<void>) => {
    if (working.current || disabled || useAppStore.getState().activeSessionId !== sessionId ||
        useAppStore.getState().runningSessions[sessionId]) return;
    working.current = true;
    setBusy(true); setError("");
    try { await operation(); }
    catch (failure) { if (useAppStore.getState().activeSessionId === sessionId) setError(String(failure)); }
    finally { working.current = false; setBusy(false); }
  };
  const openPreview = async (projectPath: string, requireSlide = false) => {
    if (working.current || useAppStore.getState().activeSessionId !== sessionId) return;
    const request = ++previewRequest.current;
    working.current = true;
    setBusy(true); setError("");
    try {
      const preview = await api.pptPreviewOpen(projectPath, sessionId, requireSlide);
      if (preview && request === previewRequest.current && useAppStore.getState().activeSessionId === sessionId) {
        previewOpened.current = projectPath;
        useAppStore.getState().openWorkPanelTab(svgEditorWorkPanelTab(projectPath));
      }
    } catch (failure) {
      if (request === previewRequest.current && useAppStore.getState().activeSessionId === sessionId) setError(String(failure));
    } finally {
      if (request === previewRequest.current) { working.current = false; setBusy(false); }
    }
  };
  useEffect(() => {
    if (!path || project?.projectPath !== path || project.pptxPath || previewOpened.current === path) return;
    const tabs = useAppStore.getState().workPanelTabs;
    if (tabs?.some(tab => tab.kind === "svg-editor" && tab.resource === path)) return;
    void openPreview(path, true);
  }, [sessionId, path, project]);
  const readyPath = project?.pptxPath && !project.needsPptxRegeneration && !project.qualityIssue ? project.pptxPath : null;
  useEffect(() => { onReady?.(readyPath); }, [readyPath, onReady]);
  const stage = isRunning ? "working" : !path ? "requirements" : !project ? "checkingPages" :
    project.qualityIssue ? "needsRepair" : project.needsPptxRegeneration ? "pagesChanged" :
    project.pptxPath ? "editable" : project.hasSvg ? "previewReady" : "pagesPending";
  const previewButton = project?.hasSvg && <button type="button" disabled={busy}
    onClick={() => void openPreview(project.projectPath)}>{t("coursewareWorkflow.previewPages")}</button>;
  return <>
    {!renderEditor && <header><strong>{t("coursewareWorkflow.title")}</strong><span role="status">{t(`coursewareWorkflow.${stage}`)}</span></header>}
    {!renderEditor && !path && <p>{t("coursewareWorkflow.briefHint")}</p>}
    {project?.hasSvg && (!renderEditor || project.needsPptxRegeneration || project.qualityIssue) && <div className="courseware-workflow-actions">
    {!renderEditor && previewButton}
    {project.pptxPath && !project.needsPptxRegeneration ?
      !renderEditor && <button type="button" disabled={disabled || busy} onClick={() =>
        void run(async () => { if (project.pptxPath) useAppStore.getState().openWorkPanelTab(pptEditorWorkPanelTab(project.pptxPath)); })}>{t("coursewareWorkflow.openEditor")}</button> :
      <button type="button" disabled={disabled || busy || !!project.qualityIssue} onClick={() => void run(async () => {
        if (!await useAppStore.getState().sendPrompt(t("coursewareWorkflow.exportPrompt"), undefined, sessionId))
          throw new Error(t("coursewareWorkflow.sendFailed"));
      })}>{t("coursewareWorkflow.buildPpt")}</button>}
    {project.qualityIssue && <p role="alert">{project.qualityIssue}</p>}
    {project.qualityIssue && <button type="button" disabled={disabled || busy} onClick={() => void run(async () => {
      if (!await useAppStore.getState().sendPrompt(pptMasterRepairPrompt(project), undefined, sessionId))
        throw new Error(t("coursewareWorkflow.sendFailed"));
    })}>{t("coursewareWorkflow.repairPages")}</button>}
    </div>}
    {project?.pptxPath && !project.needsPptxRegeneration && sourceVisuals}
    {error && <p role="alert" className="courseware-workflow-error">{error}</p>}
    {renderEditor?.(previewButton)}
  </>;
}
