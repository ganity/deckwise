import { getOfficeExtension, OFFICE_FORMATS } from "@pi-desktop/shared";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { api, type PptEditorState } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
import { IconCheck, IconClose, IconExternal, IconFileText, IconPanelMaximize, IconPanelRestore, IconRefresh } from "../icons";
import { WorkTabEmpty } from "./WorkTabEmpty";
import { PptxInspectionPanel } from "./PptxInspectionPanel";

export function PptEditorTab({
  path,
  mimeType,
  tabId,
  maximized = false,
  onToggleMaximize,
  actions,
  reviewPanel,
}: {
  path: string;
  mimeType?: string;
  tabId: string;
  maximized?: boolean;
  onToggleMaximize?: () => void;
  actions?: ReactNode;
  reviewPanel?: ReactNode;
}) {
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const openRequest = useRef(0);
  const [state, setState] = useState<PptEditorState>({ status: "opening", path });
  const [inspectionOpen, setInspectionOpen] = useState(false);
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
    const root = document.documentElement;
    const sync = () => void api.pptEditorConfigureUi({ theme: root.dataset.theme === "dark" ? "dark" : "light" })
      .catch(error => useAppStore.getState().showToast(String(error)));
    const observer = new MutationObserver(sync);
    observer.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
    sync();
    return () => observer.disconnect();
  }, []);

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
          .workPanelTabs.some((tab) => tab.id === tabId || tab.resource === path);
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
    if (surface.parentElement?.parentElement) observer.observe(surface.parentElement.parentElement);
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
    <div className={`ppt-editor-tab${inspectionOpen && extension === "pptx" ? " has-inspection" : ""}`}>
      <div className="ppt-editor-toolbar">
        <div className="ppt-editor-document">
          <span role="status" title={state.savedPath}>{state.status === "error" ? state.message || t("panel.pptEditor.error") : state.status === "opening" ? t("panel.pptEditor.loading") : state.status === "saving" ? t("panel.pptEditor.saving") : state.dirty ? t("panel.pptEditor.unsaved") : state.status === "saved" ? t("panel.pptEditor.savedToFile") : t("panel.pptEditor.opened")}{state.status === "saved" && saveCopy && state.savedPath ? ` · ${state.savedPath}` : ""}</span>
        </div>
        {state.teachingProgress && <span className="courseware-teaching-progress" role="status">
          {t("coursewareWorkflow.teachingProgress", state.teachingProgress)}
        </span>}
        {extension === "pptx" && state.module && <button type="button" aria-pressed={state.teachingOpen !== false}
          disabled={!state.nativeTeaching} onClick={() => void api.pptEditorConfigureUi({ teachingOpen: state.teachingOpen === false })
            .catch(error => useAppStore.getState().showToast(String(error)))}>{t("panel.pptEditor.teachingFlow")}</button>}
        {extension === "pptx" && <button type="button" aria-expanded={inspectionOpen} onClick={() => setInspectionOpen(value => !value)}>{t("panel.pptEditor.inspection")}</button>}
        {actions}
        <button type="button" aria-pressed={maximized} disabled={!onToggleMaximize} onClick={() => onToggleMaximize?.()}>
          {maximized ? <IconPanelRestore size={13} /> : <IconPanelMaximize size={13} />}
          {maximized ? t("panel.pptEditor.returnToChat") : t("panel.pptEditor.focus")}
        </button>
        <button type="button" className="ppt-editor-save" disabled={busy || !state.canSave || state.readOnly} onClick={() => void api.pptEditorSave().catch((error) => useAppStore.getState().showToast(String(error)))}>
          <IconCheck size={13} /> {t(saveCopy ? "panel.pptEditor.saveCopy" : "panel.pptEditor.save")}
        </button>
        {tabId !== "ppt" && <button type="button" className="icon" disabled={busy} aria-label={t("panel.pptEditor.close")} onClick={close}>
          <IconClose size={14} />
        </button>}
      </div>
      {extension === "pptx" && inspectionOpen && <aside className="ppt-editor-review" aria-label={t("panel.pptEditor.inspection")}>
        <header className="ppt-editor-review-heading">
          <strong>{t("panel.pptEditor.inspection")}</strong>
          <button type="button" className="btn btn-ghost" aria-label={t("common.close")} onClick={() => setInspectionOpen(false)}><IconClose size={16} /></button>
        </header>
        <div className="ppt-editor-review-content">
        <PptxInspectionPanel key={path} revision={state.revision} enabled={!busy && !state.readOnly && (state.status === "ready" || state.status === "saved")} />
        {reviewPanel}
        </div>
      </aside>}
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
      </div>
    </div>
  );
}
