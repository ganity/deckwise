import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api, type PptEditorState } from "../../lib/api";
import { CoursewareImportStart } from "./CoursewareImportStart";
import { toolWorkPanelTab } from "../../lib/work-panel-tabs";
import { useAppStore } from "../../stores/app-store";

export function CoursewareWorkspaceEntry({ onImport }: { onImport?: (sessionId: string | null) => void }) {
  const sessionId = useAppStore(state => state.activeSessionId);
  return sessionId ? <Entry key={sessionId} sessionId={sessionId} onImport={onImport} /> : null;
}
function Entry({ sessionId, onImport }: { sessionId: string; onImport?: (sessionId: string | null) => void }) {
  const { t } = useTranslation();
  const messageCount = useAppStore(state => state.messages.length);
  const running = useAppStore(state => state.runningSessions[sessionId] ?? false);
  const [available, setAvailable] = useState(false);
  const [task, setTask] = useState<Awaited<ReturnType<typeof api.coursewareTaskGet>>["task"]>(null);
  const [editor, setEditor] = useState<PptEditorState | null>(null);
  const [refresh, setRefresh] = useState(0);
  const opened = useRef(false);
  useEffect(() => api.onPptEditorState(value => {
    if (useAppStore.getState().activeSessionId !== sessionId) return;
    setEditor(value);
    if (["opening", "ready", "saved", "closed"].includes(value.status)) setRefresh(n => n + 1);
  }), [sessionId]);
  useEffect(() => {
    let disposed = false;
    void api.coursewareTaskGet(sessionId).then(view => {
      if (disposed || useAppStore.getState().activeSessionId !== sessionId) return;
      setAvailable(!!view.task);
      setTask(view.task);
      onImport?.(view.task?.taskType === "import" && view.task.importPath ? sessionId : null);
      if (view.task && !opened.current) {
        opened.current = true;
        const store = useAppStore.getState();
        if (!store.workPanelTabs.length) store.openWorkPanelTab(toolWorkPanelTab("ppt"));
      }
    }).catch(() => { /* The workspace owns actionable read errors. */ });
    return () => { disposed = true; };
  }, [sessionId, messageCount, running, refresh, onImport]);
  return available ? <><div className="courseware-workspace-entry">
    <button type="button" onClick={() => useAppStore.getState().openWorkPanelTab(toolWorkPanelTab("ppt"))}>
      {t("coursewareWorkflow.openWorkspace")}
    </button>
  </div>{task?.taskType === "import" && task.importPath && <CoursewareImportStart key={task.importPath}
    sessionId={sessionId} path={task.importPath} education={task.educationContext} editor={editor} />}</> : null;
}
