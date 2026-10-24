import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { CoursewareWorkflowView } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { pptEditorWorkPanelTab } from "../../lib/work-panel-tabs";
import { useAppStore } from "../../stores/app-store";
import { CoursewareChatImages } from "./CoursewareChatImages";
import { CoursewareChatPresentation } from "./CoursewareChatPresentation";
import { CoursewareChatNarration } from "./CoursewareChatNarration";
import { CoursewareChatPptxCandidates } from "./CoursewareChatPptxCandidates";

export function CoursewareChatWorkflow() {
  const sessionId = useAppStore(state => state.activeSessionId);
  return sessionId ? <Workflow key={sessionId} sessionId={sessionId} /> : null;
}

function Workflow({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation();
  const isRunning = useAppStore(state => state.runningSessions[sessionId] ?? false);
  const messageCount = useAppStore(state => state.messages.length);
  const projectPath = useAppStore(state => state.sessions.find(session => session.id === sessionId)?.projectPath);
  const [view, setView] = useState<CoursewareWorkflowView | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const active = useRef(true), inFlight = useRef(false);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const current = () => active.current && useAppStore.getState().activeSessionId === sessionId;

  useEffect(() => {
    let disposed = false, request = 0;
    const load = async () => {
      const id = ++request;
      try {
        const value = await api.coursewareWorkflowGet(sessionId);
        if (!disposed && id === request) { setView(value); setError(""); }
      } catch (failure) {
        if (!disposed && id === request) setError(String(failure));
      }
    };
    if (!projectPath) return;
    void load();
    const timer = isRunning ? window.setInterval(() => void load(), 2000) : undefined;
    return () => { disposed = true; if (timer !== undefined) window.clearInterval(timer); };
  }, [sessionId, projectPath, isRunning, messageCount, refresh]);

  const run = async (operation: () => Promise<void>) => {
    if (!current() || inFlight.current || useAppStore.getState().runningSessions[sessionId]) return;
    inFlight.current = true; setBusy(true); setError("");
    try { await operation(); }
    catch (failure) { if (current()) setError(String(failure)); }
    finally { if (current()) { setBusy(false); setRefresh(value => value + 1); } inFlight.current = false; }
  };
  const continueChat = async () => {
    if (!current()) return;
    const accepted = await useAppStore.getState().sendPrompt(t("coursewareWorkflow.continuePrompt"), undefined, sessionId);
    if (!accepted) throw new Error(t("coursewareWorkflow.sendFailed"));
  };
  const openEditor = async () => {
    const { task } = await api.coursewareTaskGet(sessionId);
    if (!current()) return;
    const path = task?.generatedPath ?? task?.importPath;
    if (!path) throw new Error(t("coursewareWorkflow.sourceMissing"));
    useAppStore.getState().openWorkPanelTab(pptEditorWorkPanelTab(path));
  };
  if (!projectPath) return null;
  if (!view?.task) return error ? <section className="courseware-chat-workflow" aria-label={t("coursewareWorkflow.title")}>
    <p role="alert" className="courseware-workflow-error">{error}</p>
    <button type="button" onClick={() => setRefresh(value => value + 1)}>{t("coursewareWorkflow.refresh")}</button>
  </section> : null;
  const plan = view?.plan;
  const approved = !!plan && plan.sha256 === plan.approvedSha256;
  const blocked = busy || isRunning;
  const ordinary = view.task.taskType === "plain" && !view.task.generated;

  return <section className="courseware-chat-workflow" aria-label={t("coursewareWorkflow.title")} aria-busy={blocked}>
    {!ordinary && <header><strong>{t("coursewareWorkflow.title")}</strong><span role="status">{t(isRunning ? "coursewareWorkflow.working" :
      view?.task?.generated || view?.task?.imported ? "coursewareWorkflow.editable" : plan ? approved ? "coursewareWorkflow.assets" : "coursewareWorkflow.reviewPlan" : "coursewareWorkflow.requirements")}</span></header>}
    {error && <p role="alert" className="courseware-workflow-error">{error}</p>}
    <>
      {!ordinary && !plan && !view.task.imported && !view.task.generated && <p>{t(view.task.taskType === "import" ? "coursewareWorkflow.importHint" : "coursewareWorkflow.briefHint")}</p>}
      {plan && <details><summary>{plan.title} · {t("coursewareWorkflow.pages", { count: plan.pages.length })}</summary>
        <ol>{plan.pages.map(page => <li key={page.pageId}><strong>{page.title}</strong>
          <p>{page.visibleText.join(" · ")}</p><p>{page.visualIntent}</p><p>{page.narration}</p></li>)}</ol>
      </details>}
      {plan && !approved && <button type="button" disabled={blocked} onClick={() => void run(async () => {
        const result = await api.coursewareScenePlanApprove(sessionId, plan.sha256);
        if (!current()) return;
        if (!result.plan || result.plan.sha256 !== result.plan.approvedSha256) throw new Error(t("coursewareWorkflow.planChanged"));
        setView(value => value ? { ...value, plan: result.plan } : value);
        await continueChat();
      })}>{t("coursewareWorkflow.approveContinue")}</button>}
      {plan && approved && <CoursewareChatImages key={plan.sha256} sessionId={sessionId} plan={plan} disabled={blocked}
        refreshKey={refresh} onContinue={() => run(continueChat)} />}
      {view.task.taskType === "import" && !view.task.imported && <button type="button" disabled={blocked} onClick={() => void run(async () => {
        const picked = await api.pickFiles();
        if (!picked.token || !current()) return;
        await api.coursewareImportPptx(sessionId, picked.token);
        if (!current()) return;
        await openEditor();
      })}>{t("coursewareWorkflow.selectPpt")}</button>}
      {ordinary && <CoursewareChatPresentation sessionId={sessionId} disabled={blocked} refreshKey={refresh} />}
      <CoursewareChatNarration sessionId={sessionId} disabled={blocked} />
      <CoursewareChatPptxCandidates sessionId={sessionId} disabled={blocked} />
      {(view.task.generated || view.task.imported) && <button type="button" disabled={blocked} onClick={() => void run(openEditor)}>{t("coursewareWorkflow.openEditor")}</button>}
    </>
    <div className="courseware-workflow-actions">
      <button type="button" disabled={blocked} onClick={() => void run(continueChat)}>{t("coursewareWorkflow.continue")}</button>
      <button type="button" disabled={busy} onClick={() => setRefresh(value => value + 1)}>{t("coursewareWorkflow.refresh")}</button>
    </div>
  </section>;
}
