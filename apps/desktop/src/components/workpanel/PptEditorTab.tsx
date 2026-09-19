import { useEffect, useRef, useState } from "react";
import { api, type PptEditorState } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
import { IconCheck, IconClose, IconPanelMaximize, IconPanelRestore } from "../icons";

export function PptEditorTab({
  path,
  tabId,
  maximized = false,
  onToggleMaximize,
}: {
  path: string;
  tabId: string;
  maximized?: boolean;
  onToggleMaximize?: () => void;
}) {
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const [state, setState] = useState<PptEditorState>({ status: "opening", path });
  const closeTab = useAppStore((store) => store.closeWorkPanelTab);

  useEffect(() => api.onPptEditorState(setState), []);

  useEffect(() => {
    let active = true;
    void api.pptEditorOpen(path).then(
      (next) => {
        if (!active) return;
        setState(next);
        void api.pptEditorSetVisible(true);
      },
      (error) => {
        if (active) setState({ status: "error", path, message: String(error) });
      },
    );
    return () => {
      active = false;
      void api.pptEditorSetVisible(false);
      setTimeout(() => {
        const stillOpen = useAppStore
          .getState()
          .workPanelTabs.some((tab) => tab.id === tabId);
        if (!stillOpen) void api.pptEditorClose();
      }, 0);
    };
  }, [path, tabId]);

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
    void api.pptEditorClose();
    closeTab(tabId);
  };
  const busy = state.status === "opening" || state.status === "saving";

  return (
    <div className="ppt-editor-tab">
      <div className="ppt-editor-toolbar">
        <div className="ppt-editor-document">
          <strong>{path.split("/").at(-1) || path}</strong>
          <span>
            {state.status === "error"
              ? state.message || "编辑器加载失败"
              : state.status === "saving"
                ? "正在保存…"
                : `Revision ${state.revision ?? "—"}`}
          </span>
        </div>
        <button type="button" onClick={() => onToggleMaximize?.()}>
          {maximized ? <IconPanelRestore size={13} /> : <IconPanelMaximize size={13} />}
          {maximized ? "退出全屏" : "全屏编辑"}
        </button>
        <button type="button" disabled={busy || state.status === "error"} onClick={() => void api.pptEditorSave()}>
          <IconCheck size={13} /> 保存到原文件
        </button>
        <button type="button" className="icon" aria-label="关闭 PPTX 编辑器" onClick={close}>
          <IconClose size={14} />
        </button>
      </div>
      <div ref={surfaceRef} className="ppt-editor-surface" />
    </div>
  );
}
