import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../lib/api";
import { inspectProject, pptMasterRepairPrompt, referencedProject, type PptProjectState } from "../../lib/ppt-master-project";
import { pptEditorWorkPanelTab, svgEditorWorkPanelTab } from "../../lib/work-panel-tabs";
import { useAppStore } from "../../stores/app-store";

export function CoursewareChatPresentation({ sessionId, disabled, refreshKey }: { sessionId: string; disabled: boolean; refreshKey: number }) {
  const { t } = useTranslation();
  const messages = useAppStore(state => state.messages);
  const isRunning = useAppStore(state => state.runningSessions[sessionId] ?? false);
  const path = referencedProject(messages);
  const [project, setProject] = useState<PptProjectState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const working = useRef(false);
  useEffect(() => {
    let disposed = false, request = 0;
    setProject(null);
    const load = async () => {
      if (!path) return;
      const id = ++request;
      try {
        const value = await inspectProject(path);
        if (!disposed && id === request) { setProject(value); setError(""); }
      } catch (failure) { if (!disposed && id === request) setError(String(failure)); }
    };
    void load();
    const timer = disabled ? window.setInterval(() => void load(), 2000) : undefined;
    return () => { disposed = true; if (timer !== undefined) window.clearInterval(timer); };
  }, [path, disabled, messages.length, refreshKey]);
  const run = async (operation: () => Promise<void>) => {
    if (working.current || disabled || useAppStore.getState().activeSessionId !== sessionId ||
        useAppStore.getState().runningSessions[sessionId]) return;
    working.current = true;
    setBusy(true); setError("");
    try { await operation(); }
    catch (failure) { if (useAppStore.getState().activeSessionId === sessionId) setError(String(failure)); }
    finally { working.current = false; setBusy(false); }
  };
  const stage = isRunning ? "working" : !path ? "requirements" : !project ? "checkingPages" :
    project.qualityIssue ? "needsRepair" : project.needsPptxRegeneration ? "pagesChanged" :
    project.pptxPath ? "editable" : project.hasSvg ? "previewReady" : "pagesPending";
  return <>
    <header><strong>{t("coursewareWorkflow.title")}</strong><span role="status">{t(`coursewareWorkflow.${stage}`)}</span></header>
    {!path && <p>{t("coursewareWorkflow.briefHint")}</p>}
    {project?.hasSvg && <div className="courseware-workflow-actions">
    <button type="button" disabled={disabled || busy} onClick={() => void run(async () => {
      await api.pptPreviewOpen(project.projectPath);
      if (useAppStore.getState().activeSessionId === sessionId)
        useAppStore.getState().openWorkPanelTab(svgEditorWorkPanelTab(project.projectPath));
    })}>{t("coursewareWorkflow.previewPages")}</button>
    {project.pptxPath && !project.needsPptxRegeneration ?
      <button type="button" disabled={disabled || busy} onClick={() =>
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
    {error && <p role="alert" className="courseware-workflow-error">{error}</p>}
  </>;
}
