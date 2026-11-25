import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { coursewareStoryRequirementsMatch, storyNeedsApproval, coursewareSceneBodyPageCount, type CoursewareWorkflowView } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
import { CoursewareSourceVisuals } from "../workpanel/CoursewareSourceVisuals";
import { PptEditorTab } from "../workpanel/PptEditorTab";
import { CoursewareClassroomEditor } from "../workpanel/CoursewareClassroomEditor";
import { CoursewareDeliveryActions } from "./CoursewareDeliveryActions";
import { CoursewareChatPresentation } from "./CoursewareChatPresentation";
import { CoursewareChatNarration } from "./CoursewareChatNarration";
import { CoursewareChatPptxCandidates } from "./CoursewareChatPptxCandidates";
import { CoursewareChatImages } from "./CoursewareChatImages";
import { CoursewareStoryPreview } from "./CoursewareStoryPreview";
import { CoursewareTeamAssignment } from "../workpanel/CoursewareTeamAssignment";

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
  const [classroomOpen, setClassroomOpen] = useState(false);
  const visualWasBusy = useRef(false);
  const [refresh, setRefresh] = useState(0);
  const active = useRef(true), inFlight = useRef(false), epoch = useRef(0);
  useEffect(() => {
    active.current = true;
    const unsubscribe = api.onAuthChanged((state) => {
      if (state.status !== "authenticated") { epoch.current++; setView(null); setPlainPath(null); }
      setRefresh(value => value + 1);
    });
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


  const story = view?.story;
  const storyRequirementsChanged = !!story?.draft && !coursewareStoryRequirementsMatch(story.educationContext, view?.task?.educationContext);
  const storyDecision = (action: "approve" | "disable") => run(async valid => {
    if (!story) return;
    const result = await api.coursewareStoryDecision(sessionId, story.revision, story.sha256, action);
    if (!valid()) return;
    setView(value => value ? { ...value, story: result.story } : value);
    if (!await useAppStore.getState().sendPrompt(t(action === "approve" ? "coursewareStory.continuePrompt" : "coursewareStory.directPrompt"), undefined, sessionId))
      throw new Error(t("coursewareWorkflow.sendFailed"));
  });
  const storyReview = story && <div className="courseware-plan-review courseware-story-review">
    {story.draft ? <CoursewareStoryPreview draft={story.draft} /> :
      <div className="courseware-story-heading"><h2>{t("coursewareStory.title")}</h2><p>{t("coursewareStory.empty")}</p></div>}
    {story.draft && <p className="courseware-story-note">{t(story.bound ? "coursewareStory.bound" : "coursewareStory.revise")}</p>}
    {storyRequirementsChanged && <p role="status">{t("coursewareStory.requirementsChanged")}</p>}
    {!story.bound && <footer className="courseware-plan-footer">
      {storyRequirementsChanged ? <button type="button" disabled={blocked} onClick={() => void run(async () => {
        if (!await useAppStore.getState().sendPrompt(t("coursewareStory.updatePrompt"), undefined, sessionId)) throw new Error(t("coursewareWorkflow.sendFailed"));
      })}>{t("coursewareStory.update")}</button> : storyNeedsApproval(story) && <button type="button" disabled={blocked || !story.draft} onClick={() => void storyDecision("approve")}>{t("coursewareStory.approve")}</button>}
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
    <CoursewareDeliveryActions sessionId={sessionId} title={session?.title ?? t("coursewareWorkflow.workspace")} disabled={blocked} />
    <CoursewareClassroomEditor sessionId={sessionId} readOnly={blocked} />
  </section>;

  const renderEditor = (previewButton?: ReactNode) => path && <PptEditorTab key={path} path={path} tabId="ppt"
    blocked={panelBlocked} maximized={maximized} onToggleMaximize={onToggleMaximize} previewButton={previewButton}
    actions={<>
      <CoursewareDeliveryActions sessionId={sessionId} title={session?.title ?? t("coursewareWorkflow.workspace")} disabled={blocked} />
      {view?.task?.sourcePath &&
        <CoursewareTeamAssignment sessionId={sessionId} title={session?.title ?? t("coursewareWorkflow.workspace")} disabled={blocked} />}
      <button type="button" disabled={busy} onClick={() => setRefresh(value => value + 1)}>{t("coursewareWorkflow.refresh")}</button>
    </>}
    storyPanel={storyReview}
    reviewPanel={<>
      {!ordinary && sourceVisuals}
      <CoursewareChatNarration sessionId={sessionId} disabled={blocked} />
      <CoursewareChatPptxCandidates sessionId={sessionId} disabled={blocked} />
    </>} />;

  return <section className={`courseware-chat-workflow courseware-workspace${path ? " has-editor" : ""}`} aria-label={t("coursewareWorkflow.workspace")}>
    {!path && <header className="courseware-workspace-heading">
      <strong>{t("coursewareWorkflow.workspace")}</strong>
      <div className="courseware-workflow-actions">
        <button type="button" disabled={blocked} onClick={() => setClassroomOpen(true)}>Quiz / 互动编辑</button>
        <CoursewareDeliveryActions sessionId={sessionId} title={session?.title ?? t("coursewareWorkflow.workspace")} disabled={blocked} />
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
                {page.visualSettingIds?.length && <div><dt>{t("chat.visualSettings")}</dt><dd>{page.visualSettingIds.map(id =>
                  messages.flatMap(message => message.attachments ?? []).find(image => image.ref === "attachments/" + id)?.name ?? id.slice(0, 12)).join(", ")}</dd></div>}
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
      {view.task.taskType === "plain" ? <CoursewareChatPresentation sessionId={sessionId} sourcePath={view.task.sourcePath} disabled={blocked} refreshKey={refresh}
        sourceVisuals={ordinary ? sourceVisuals : undefined} onReady={setPlainPath} renderEditor={path ? renderEditor : undefined} /> : renderEditor()}

    </>}
  </section>;
}
