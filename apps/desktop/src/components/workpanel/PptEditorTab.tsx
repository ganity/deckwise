import { getOfficeExtension, OFFICE_FORMATS } from "@pi-desktop/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api, type PptEditorState } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
import { IconCheck, IconClose, IconExternal, IconFileText, IconPanelMaximize, IconPanelRestore, IconRefresh } from "../icons";
import { WorkTabEmpty } from "./WorkTabEmpty";
import { PptxInspectionPanel } from "./PptxInspectionPanel";
import { CoursewareTeachingPanel } from "./CoursewareTeachingPanel";

export function PptEditorTab({
  path,
  mimeType,
  tabId,
  maximized = false,
  onToggleMaximize,
}: {
  path: string;
  mimeType?: string;
  tabId: string;
  maximized?: boolean;
  onToggleMaximize?: () => void;
}) {
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const openRequest = useRef(0);
  const [state, setState] = useState<PptEditorState>({ status: "opening", path });
  const closeTab = useAppStore((store) => store.closeWorkPanelTab);
  const sessionId = useAppStore((store) => store.activeSessionId);
  const { t } = useTranslation();

  const openEditor = useCallback(() => {
    const request = ++openRequest.current;
    setState({ status: "opening", path });
    void api.pptEditorOpen(path, mimeType).then(
      (next) => {
        if (openRequest.current !== request) return;
        setState(next);
        void api.pptEditorSetVisible(true);
      },
      (error) => {
        if (openRequest.current === request) setState({ status: "error", path, canRetry: true, message: String(error) });
      },
    );
  }, [path, mimeType, sessionId]);

  useEffect(() => api.onPptEditorState(setState), []);

  useEffect(() => {
    // Cancel transient mounts before starting a native open (React StrictMode).
    const openTimer = setTimeout(openEditor, 0);
    return () => {
      clearTimeout(openTimer);
      ++openRequest.current;
      void api.pptEditorSetVisible(false);
      setTimeout(() => {
        const stillOpen = useAppStore
          .getState()
          .workPanelTabs.some((tab) => tab.id === tabId);
        if (!stillOpen) void api.pptEditorClose().catch((error) => useAppStore.getState().showToast(String(error)));
      }, 0);
    };
  }, [openEditor, tabId]);

  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;
    let frame = 0;
    const report = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const rect = surface.getBoundingClientRect();
        void api.pptEditorSetBounds({
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
        });
      });
    };
    const observer = new ResizeObserver(report);
    observer.observe(surface);
    window.addEventListener("resize", report);
    report();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", report);
      cancelAnimationFrame(frame);
    };
  }, []);

  const close = () => {
    void api.pptEditorClose().then(() => closeTab(tabId)).catch((error) => useAppStore.getState().showToast(String(error)));
  };
  const extension = getOfficeExtension(path, mimeType);
  const saveCopy = extension && OFFICE_FORMATS[extension].saveExt !== extension;
  const busy = state.status === "opening" || state.status === "saving";

  return (
    <div className={`ppt-editor-tab${extension === "pptx" ? " has-inspection" : ""}`}>
      <div className="ppt-editor-toolbar">
        <div className="ppt-editor-document">
          <strong>{path.split("/").at(-1) || path}</strong>
          <span role="status" title={state.savedPath}>{state.status === "error" ? state.message || t("panel.pptEditor.error") : state.status === "opening" ? t("panel.pptEditor.loading") : state.status === "saving" ? t("panel.pptEditor.saving") : state.dirty ? t("panel.pptEditor.unsaved") : state.status === "saved" ? t("panel.pptEditor.saved", { revision: state.revision ?? "—" }) : t("panel.pptEditor.revision", { revision: state.revision ?? "—" })}{state.status === "saved" && saveCopy && state.savedPath ? ` · ${state.savedPath}` : ""}</span>
        </div>
        <button type="button" onClick={() => onToggleMaximize?.()}>
          {maximized ? <IconPanelRestore size={13} /> : <IconPanelMaximize size={13} />}
          {maximized ? t("panel.pptEditor.restore") : t("panel.pptEditor.maximize")}
        </button>
        <button type="button" disabled={busy || !state.canSave || state.readOnly} onClick={() => void api.pptEditorSave().catch((error) => useAppStore.getState().showToast(String(error)))}>
          <IconCheck size={13} /> {t(saveCopy ? "panel.pptEditor.saveCopy" : "panel.pptEditor.save")}
        </button>
        <button type="button" className="icon" disabled={busy} aria-label={t("panel.pptEditor.close")} onClick={close}>
          <IconClose size={14} />
        </button>
      </div>
      {extension === "pptx" && <PptxInspectionPanel key={path} revision={state.revision} enabled={!busy && !state.readOnly && (state.status === "ready" || state.status === "saved")} />}
      <div className="ppt-editor-body">
      <div ref={surfaceRef} className="ppt-editor-surface">
        {state.status === "opening" && <WorkTabEmpty icon={IconFileText} title={t("panel.pptEditor.loading")} />}
        {state.status === "error" && (
          <WorkTabEmpty icon={IconFileText} title={t("panel.pptEditor.error")} body={state.message}>
            <button type="button" className="btn btn-secondary" onClick={() => void api.fsOpen(path)}><IconExternal size={14} /> {t("panel.files.openExternally")}</button>
            {state.canRetry && <button type="button" className="btn btn-secondary" onClick={() => openEditor()}><IconRefresh size={14} /> {t("panel.pptEditor.retry")}</button>}
          </WorkTabEmpty>
        )}
      </div>
      {extension === "pptx" && <CoursewareTeachingPanel key={`${path}:${sessionId}`} sessionId={sessionId}
        enabled={!busy && !state.readOnly && !state.dirty && (state.status === "ready" || state.status === "saved")} />}
      </div>
    </div>
  );
}
