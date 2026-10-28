import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { CoursewareWorkflowView } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
import { CoursewareChatImages } from "../courseware/CoursewareChatImages";

export function CoursewareScenePreviewTab() {
  const sessionId = useAppStore(state => state.activeSessionId);
  return sessionId ? <Preview key={sessionId} sessionId={sessionId} /> : null;
}

function Preview({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation();
  const running = useAppStore(state => state.runningSessions[sessionId] ?? false);
  const messageCount = useAppStore(state => state.messages.length);
  const [view, setView] = useState<CoursewareWorkflowView | null>(null);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let disposed = false;
    setError("");
    void api.coursewareWorkflowGet(sessionId).then(value => { if (!disposed) setView(value); })
      .catch(failure => { if (!disposed) setError(String(failure)); });
    return () => { disposed = true; };
  }, [sessionId, running, messageCount, refresh]);
  const plan = view?.plan;
  return <div className="courseware-scene-preview-panel">
    {error && <p role="alert" className="courseware-workflow-error">{error}</p>}
    {plan && plan.sha256 === plan.approvedSha256 ? <CoursewareChatImages key={plan.sha256} sessionId={sessionId} plan={plan} disabled={running}
      refreshKey={messageCount} onContinue={async () => {
        const store = useAppStore.getState();
        if (store.activeSessionId !== sessionId || store.runningSessions[sessionId]) return;
        if (!await store.sendPrompt(t("coursewareWorkflow.continuePrompt"), undefined, sessionId))
          throw new Error(t("coursewareWorkflow.sendFailed"));
        setRefresh(value => value + 1);
      }} /> : <p role="status">{t(view?.task?.generated ? "coursewareWorkflow.editable" : "coursewareWorkflow.reviewPlan")}</p>}
  </div>;
}
