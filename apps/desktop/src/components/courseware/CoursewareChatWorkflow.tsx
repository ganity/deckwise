import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { storyNeedsApproval, coursewareSceneBodyPageCount, type CoursewareWorkflowView } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
import { CoursewareSourceVisuals } from "../workpanel/CoursewareSourceVisuals";
import { PptEditorTab } from "../workpanel/PptEditorTab";
import { CoursewareClassroomEditor } from "../workpanel/CoursewareClassroomEditor";
import { CoursewareImportDialog } from "../workpanel/CoursewareImportDialog";
import { CoursewareChatPresentation } from "./CoursewareChatPresentation";
import { CoursewareChatNarration } from "./CoursewareChatNarration";
import { CoursewareChatPptxCandidates } from "./CoursewareChatPptxCandidates";
import { CoursewareChatImages } from "./CoursewareChatImages";

type WorkspaceProps = { panelBlocked?: boolean; maximized?: boolean; onToggleMaximize?: () => void };
export function CoursewareChatWorkflow(props: WorkspaceProps) {
  const sessionId = useAppStore(state => state.activeSessionId);
  return sessionId ? <Workflow key={sessionId} sessionId={sessionId} {...props} /> : null;
}

function Workflow({ sessionId, panelBlocked = false, maximized, onToggleMaximize }: { sessionId: string } & WorkspaceProps) {
  const { t } = useTranslation();
  const isRunning = useAppStore(state => state.runningSessions[sessionId] ?? false);
  const messages = useAppStore(state => state.messages);
  const session = useAppStore(state => state.sessions.find(session => session.id === sessionId));
  const [view, setView] = useState<CoursewareWorkflowView | null>(null);
  const [error, setError] = useState("");
  const [readError, setReadError] = useState("");
  const [busy, setBusy] = useState(false);
  const [visualBusy, setVisualBusy] = useState(false);
  const [plainPath, setPlainPath] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [classroomOpen, setClassroomOpen] = useState(false);
  const visualWasBusy = useRef(false);
  const [refresh, setRefresh] = useState(0);
  const active = useRef(true), inFlight = useRef(false), epoch = useRef(0);
  useEffect(() => {
    active.current = true;
    const unsubscribe = api.onAuthChanged(() => { epoch.current++; setView(null); setPlainPath(null); setRefresh(value => value + 1); });
    return () => { active.current = false; epoch.current++; unsubscribe(); };
  }, []);
  const current = () => active.current && useAppStore.getState().activeSessionId === sessionId;
  useEffect(() => {
    let disposed = false, loading = false;
    const revision = epoch.current;
    const load = async () => {
      if (loading) return;
      loading = true;
      try {
        const value = await api.coursewareWorkflowGet(sessionId);
        if (!disposed && revision === epoch.current && current()) { setView(value); setReadError(""); }
      } catch (failure) {
        if (!disposed && revision === epoch.current && current()) setReadError(String(failure));
      } finally { loading = false; }
    };
    if (!session?.projectPath) return;
    void load();
    const timer = isRunning ? window.setInterval(() => void load(), 3000) : undefined;
    return () => { disposed = true; window.clearInterval(timer); };
  }, [sessionId, session?.projectPath, isRunning, messages.length, refresh]);

  const run = async (operation: (valid: () => boolean) => Promise<void>) => {
    if (!current() || inFlight.current || visualBusy || useAppStore.getState().runningSessions[sessionId]) return;
    const revision = epoch.current;
    const valid = () => current() && revision === epoch.current;
    inFlight.current = true; setBusy(true); setError("");
    try { await operation(valid); }
    catch (failure) { if (valid()) setError(String(failure)); }
    finally { if (current()) { setBusy(false); setRefresh(value => value + 1); } inFlight.current = false; }
  };
  const continueChat = async (action: "plan" | "style" | "resume" | "restyle", instruction = "") => {
    if (!current() || useAppStore.getState().runningSessions[sessionId]) return;
    setError("");
    const accepted = await useAppStore.getState().sendPrompt(t(`coursewareWorkflow.${action}Prompt`, { instruction }), undefined, sessionId);
    if (!accepted) throw new Error(t("coursewareWorkflow.sendFailed"));
  };
  const path = view?.task?.sourcePath ?? plainPath;
  useEffect(() => {
    if (view?.task?.canonicalProjectId && !path) setClassroomOpen(true);
  }, [view?.task?.canonicalProjectId, path]);
  useEffect(() => {
    if (path && current()) useAppStore.getState().replaceWorkPanelTab("ppt", { id: "ppt", kind: "ppt", resource: path });
  }, [path]);
  const plan = view?.plan;
  const approved = !!plan && plan.sha256 === plan.approvedSha256;
  const blocked = busy || isRunning || visualBusy;
  const ordinary = view?.task?.taskType === "plain" && !view.task.generated;
  const sourceVisuals = <details>
    <summary>{t("panel.pptEditor.visualTitle")}</summary>
    <CoursewareSourceVisuals sessionId={sessionId} enabled disabled={busy || isRunning} onActiveChange={value => {
      const finished = visualWasBusy.current && !value;
      visualWasBusy.current = value; setVisualBusy(value);
      if (finished && current()) useAppStore.setState({ coursewareTeachingRefresh: { sessionId, reread: true } });
    }} />
  </details>;
  const firstLessonPlan = messages.filter(message => message.role === "user").flatMap(message => message.attachments ?? [])
    .find(attachment => attachment.kind === "file" && /\.(pdf|docx?)$/i.test(attachment.name));

  const story = view?.story;
  const storyDecision = (action: "approve" | "disable") => run(async valid => {
    if (!story) return;
    const result = await api.coursewareStoryDecision(sessionId, story.revision, story.sha256, action);
    if (!valid()) return;
    setView(value => value ? { ...value, story: result.story } : value);
    if (!await useAppStore.getState().sendPrompt(t(action === "approve" ? "coursewareStory.continuePrompt" : "coursewareStory.directPrompt"), undefined, sessionId))
      throw new Error(t("coursewareWorkflow.sendFailed"));
  });
  const storyReview = story && <div className="courseware-plan-review">
    <h2>{t("coursewareStory.title")}</h2>
    {story.draft ? <div className="courseware-plan-scroll">
      <h3>{story.draft.title}</h3><p>{story.draft.summary}</p>
      <h4>{t("coursewareStory.objectives")}</h4><ul>{story.draft.objectives.map(item => <li key={item}>{item}</li>)}</ul>
      <h4>{t("coursewareStory.setting")}</h4><p>{story.draft.setting}</p>
      <ul>{story.draft.characters.map((character, index) => <li key={index}><strong>{character.name}</strong> · {character.description}</li>)}</ul>
      <ol>{story.draft.beats.map(beat => <li key={beat.id}>
        <h4>{beat.title}</h4><p>{beat.event}</p><dl>
          <dt>{t("coursewareStory.objective")}</dt><dd>{beat.objective}</dd>
          <dt>{t("coursewareStory.activity")}</dt><dd>{beat.activity}</dd>
          {beat.assessment && <><dt>{t(beat.assessment.kind === "quiz" ? "coursewareWorkflow.quizTemplate" : "coursewareStory.checkpoint")}</dt>
            <dd>{beat.assessment.question}</dd><dt>{t("coursewareStory.reference")}</dt><dd>{beat.assessment.referenceAnswer}</dd></>}
        </dl>
      </li>)}</ol>
      {(story.draft.durationMinutes || story.draft.bodyPageLimit) && <p>{story.draft.durationMinutes ? t("coursewareStory.duration", { count: story.draft.durationMinutes }) : ""} {story.draft.bodyPageLimit ? t("coursewareStory.pages", { count: story.draft.bodyPageLimit }) : ""}</p>}
      {!!story.draft.assumptions.length && <><h4>{t("coursewareStory.assumptions")}</h4><ul>{story.draft.assumptions.map(item => <li key={item}>{item}</li>)}</ul></>}
    </div> : <p>{t("coursewareStory.empty")}</p>}
    <p>{t(story.bound ? "coursewareStory.bound" : "coursewareStory.revise")}</p>
    {!story.bound && <footer className="courseware-plan-footer">
      {storyNeedsApproval(story) && <button type="button" disabled={blocked || !story.draft} onClick={() => void storyDecision("approve")}>{t("coursewareStory.approve")}</button>}
      <button type="button" disabled={blocked} onClick={() => void storyDecision("disable")}>{t("coursewareStory.disable")}</button>
    </footer>}
    {!storyNeedsApproval(story) && <button type="button" disabled={blocked} onClick={() => void run(async () => {
      if (!await useAppStore.getState().sendPrompt(t("coursewareStory.continuePrompt"), undefined, sessionId)) throw new Error(t("coursewareWorkflow.sendFailed"));
    })}>{t("coursewareWorkflow.resume")}</button>}
  </div>;
  if (storyNeedsApproval(story)) return <section className="courseware-chat-workflow courseware-workspace" aria-label={t("coursewareStory.title")}>
    {(error || readError) && <p role="alert">{error || readError}</p>}{storyReview}
  </section>;

  if (classroomOpen) return <section className="courseware-chat-workflow courseware-workspace has-editor">
    <button type="button" onClick={() => setClassroomOpen(false)}>返回课程工作区</button>
    <CoursewareClassroomEditor sessionId={sessionId} readOnly={blocked} />
  </section>;

  return <section className={`courseware-chat-workflow courseware-workspace${path ? " has-editor" : ""}`} aria-label={t("coursewareWorkflow.workspace")}>
    {!path && <header className="courseware-workspace-heading">
      <strong>{t("coursewareWorkflow.workspace")}</strong>
      <div className="courseware-workflow-actions">
        <button type="button" disabled={blocked} onClick={() => setClassroomOpen(true)}>Quiz / 互动编辑</button>
        {path && <button type="button" disabled={blocked} onClick={() => setImportOpen(true)}>{t("coursewareWorkflow.publish")}</button>}
        <button type="button" disabled={busy} onClick={() => setRefresh(value => value + 1)}>{t("coursewareWorkflow.refresh")}</button>
      </div>
    </header>}
    {(error || readError) && <p role="alert" className="courseware-workflow-error">{error || readError}</p>}
    {!view && !readError && <p role="status">{t("coursewareWorkflow.loadingWorkspace")}</p>}
    {view && !view.task && <p>{t("coursewareWorkflow.briefHint")}</p>}
    {view?.task && <>
      {story && !path && <details><summary>{t("coursewareStory.saved")}</summary>{storyReview}</details>}
      {!path && !ordinary && !plan && <p role="status">{t(view.task.taskType === "import" ? "coursewareWorkflow.importHint" : "coursewareWorkflow.briefHint")}</p>}
      {!path && plan && !approved && <div className="courseware-plan-review">
        <div className="courseware-plan-scroll">
          <div className="courseware-plan-heading">
            <span className="courseware-plan-status">{t("coursewareWorkflow.reviewPlan")}</span>
            <h2>{plan.title}</h2>
            <p>{t("coursewareWorkflow.pages", { count: coursewareSceneBodyPageCount(plan.pages) })}{plan.pages.some(page => page.quiz) ? ` · ${t("coursewareWorkflow.quizPages", { count: plan.pages.filter(page => page.quiz).length })}` : ""}{plan.pages.some(page => page.teaching?.question) ? ` · ${t("coursewareWorkflow.interactionPages", { count: plan.pages.filter(page => page.teaching?.question).length })}` : ""}</p>
          </div>
          {plan.visualBible && <details className="courseware-plan-guide">
            <summary>{t("coursewareWorkflow.visualBible")}</summary>
            <div><p>{plan.visualBible.artDirection}</p><p>{plan.visualBible.characters}</p><p>{plan.visualBible.setting}</p></div>
          </details>}
          <ol className="courseware-plan-pages">{plan.pages.map((page, index) => <li key={page.pageId}>
            <details open={index === 0}>
              <summary>
                <span className="courseware-plan-number" aria-hidden="true">{String(index + 1).padStart(2, "0")}</span>
                <span className="courseware-plan-page-heading"><strong>{page.title}</strong><span>{page.visibleText.join(" · ")}</span></span>
              </summary>
              <dl className="courseware-plan-page-content">
                <div><dt>{t("panel.scenePlan.visibleText")}</dt><dd className="courseware-plan-student-text">{page.visibleText.join(" · ")}</dd></div>
                <div><dt>{t("panel.scenePlan.visualIntent")}</dt><dd>{page.visualIntent}</dd></div>
                <div><dt>{t("panel.scenePlan.narration")}</dt><dd>{page.narration}</dd></div>
              </dl>
            </details>
          </li>)}</ol>
        </div>
        <footer className="courseware-plan-footer">
        <p>{t("coursewareWorkflow.revisePlanHint")}</p>
        <button type="button" className="courseware-scene-primary" disabled={blocked} onClick={() => void run(async valid => {
          const result = await api.coursewareScenePlanApprove(sessionId, plan.sha256);
          if (!valid()) return;
          if (!result.plan || result.plan.sha256 !== result.plan.approvedSha256) throw new Error(t("coursewareWorkflow.planChanged"));
          setView(value => value ? { ...value, plan: result.plan } : value);
          await continueChat("plan");
        })}>{t("coursewareWorkflow.approveContinue")}</button>
        </footer>
      </div>}
      {!path && plan && approved && <CoursewareChatImages key={plan.sha256} sessionId={sessionId} plan={plan} disabled={blocked}
        refreshKey={refresh} compilation={view.compilation} onContinue={continueChat} />}
      {view.task.taskType === "import" && !path && <button type="button" disabled={blocked} onClick={() => void run(async valid => {
        const picked = await api.pickFiles();
        if (!picked.token || !valid()) return;
        const imported = await api.coursewareImportPptx(sessionId, picked.token);
        if (valid()) setView(value => value?.task ? { ...value, task: { ...value.task, imported: true, sourcePath: imported.path } } : value);
      })}>{t("coursewareWorkflow.selectPpt")}</button>}
      {view.task.taskType === "plain" && <CoursewareChatPresentation sessionId={sessionId} sourcePath={view.task.sourcePath} disabled={blocked} refreshKey={refresh}
        sourceVisuals={ordinary ? sourceVisuals : undefined} onReady={setPlainPath} />}
      {path && <PptEditorTab key={path} path={path} tabId="ppt" blocked={panelBlocked || importOpen} maximized={maximized} onToggleMaximize={onToggleMaximize}
        actions={<>
          <button type="button" disabled={blocked} onClick={() => setImportOpen(true)}>{t("coursewareWorkflow.publish")}</button>
          <button type="button" disabled={busy} onClick={() => setRefresh(value => value + 1)}>{t("coursewareWorkflow.refresh")}</button>
        </>}
        storyPanel={storyReview}
        reviewPanel={<>
          {!ordinary && sourceVisuals}
          <CoursewareChatNarration sessionId={sessionId} disabled={blocked} />
          <CoursewareChatPptxCandidates sessionId={sessionId} disabled={blocked} />
        </>} />}
      {path && <CoursewareImportDialog open={importOpen} sessionId={sessionId} initialTitle={session?.title ?? t("coursewareWorkflow.workspace")}
        pptxPath={path} firstLessonPlan={firstLessonPlan ? { name: firstLessonPlan.name, path: firstLessonPlan.ref } : null} onClose={() => setImportOpen(false)} />}
    </>}
  </section>;
}
