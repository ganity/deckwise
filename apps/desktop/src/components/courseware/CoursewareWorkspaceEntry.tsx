import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../lib/api";
import { toolWorkPanelTab } from "../../lib/work-panel-tabs";
import { useAppStore } from "../../stores/app-store";

export function CoursewareWorkspaceEntry() {
  const sessionId = useAppStore(state => state.activeSessionId);
  return sessionId ? <Entry key={sessionId} sessionId={sessionId} /> : null;
}
function Entry({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation();
  const messageCount = useAppStore(state => state.messages.length);
  const running = useAppStore(state => state.runningSessions[sessionId] ?? false);
  const [available, setAvailable] = useState(false);
  const opened = useRef(false);
  useEffect(() => {
    let disposed = false;
    void api.coursewareTaskGet(sessionId).then(view => {
      if (disposed || useAppStore.getState().activeSessionId !== sessionId) return;
      setAvailable(!!view.task);
      if (view.task && !opened.current) {
        opened.current = true;
        const store = useAppStore.getState();
        if (!store.workPanelTabs.length) store.openWorkPanelTab(toolWorkPanelTab("ppt"));
      }
    }).catch(() => { /* The workspace owns actionable read errors. */ });
    return () => { disposed = true; };
  }, [sessionId, messageCount, running]);
  return available ? <div className="courseware-workspace-entry">
    <button type="button" onClick={() => useAppStore.getState().openWorkPanelTab(toolWorkPanelTab("ppt"))}>
      {t("coursewareWorkflow.openWorkspace")}
    </button>
  </div> : null;
}
