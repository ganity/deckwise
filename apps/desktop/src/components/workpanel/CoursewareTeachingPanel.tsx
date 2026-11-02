import { replaceNarrationText, isCoursewareInteractionCheckpoint, type CoursewareTeachingDraft, type CoursewareTeachingView, type CoursewarePptxCandidateReview as PptxReview, type CoursewareSourceReview as SourceReview } from "@pi-desktop/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { IconFileText, IconMic, IconSparkles, IconImage, IconCheck } from "../icons";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
import { CoursewareSourceReview } from "./CoursewareSourceReview";
import { CoursewarePptxCandidateReview } from "./CoursewarePptxCandidateReview";
import { CoursewarePlaybackPanel } from "./CoursewarePlaybackPanel";
import { CoursewareTtsTasks } from "./CoursewareTtsTasks";
import { CoursewareImageAssets } from "./CoursewareImageAssets";
import { CoursewareTeachingEffects } from "./CoursewareTeachingEffects";
import { CoursewareAssetLocks } from "./CoursewareAssetLocks";
import { CoursewareChatChanges } from "./CoursewareChatChanges";
import { CoursewareTeachingHistory } from "./CoursewareTeachingHistory";

export function CoursewareTeachingPanel({ sessionId, enabled }: { sessionId?: string; enabled: boolean }) {
  const { t } = useTranslation();
  const sendPrompt = useAppStore((state) => state.sendPrompt);
  const teachingRefresh = useAppStore(state => state.coursewareTeachingRefresh);
  const refreshSeen = useRef<typeof teachingRefresh>(undefined);
  const [view, setView] = useState<CoursewareTeachingView | null>(null);
  const [actions, setActions] = useState<Array<Record<string, unknown>>>([]);
  const [working, setBusy] = useState(false);
  const [previewActive, setPreviewActive] = useState(false);
  const [ttsActive, setTtsActive] = useState(false);
  const [imageActive, setImageActive] = useState(false);
  const [assetLocksActive, setAssetLocksActive] = useState(false);
  const busy = working || previewActive || ttsActive || imageActive || assetLocksActive;
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [review, setReview] = useState<SourceReview | null>(null);
  const [pptxCandidate, setPptxCandidate] = useState<PptxReview | null>(null);
  const [pptxCandidateId, setPptxCandidateId] = useState("");
  const [narrationInstruction, setNarrationInstruction] = useState({ viewId: "", text: "" });
  const request = useRef(0);
  const readingContext = useRef(false);
  const draftQueue = useRef<Promise<void>>(Promise.resolve());
  const draftScope = useRef<{ viewId: string; revision: string | null; serial: number; failed: boolean } | null>(null);
  const [draftLoading, setDraftLoading] = useState(false);
  const [draftSaving, setDraftSaving] = useState(false);
  const [draftError, setDraftError] = useState("");
  const [recovered, setRecovered] = useState(false);
  const [staleDraft, setStaleDraft] = useState<CoursewareTeachingDraft | null>(null);
  const [activeTab, setActiveTab] = useState("narration");
  const page = view?.project.pages.find((entry) => entry.pageId === view.pageId);
  const changed = !!page && JSON.stringify(actions) !== JSON.stringify(page.actions);
  const instructionPending = narrationInstruction.viewId === view?.viewId && !!narrationInstruction.text;
  const canEdit = enabled && !busy && !draftLoading && !!draftScope.current && !staleDraft && !review && !pptxCandidate && !!page && !page.locked;
  const applyView = useCallback(async (next: CoursewareTeachingView) => {
    const id = request.current;
    draftScope.current = null; setDraftLoading(true); setDraftError(""); setRecovered(false); setStaleDraft(null);
    setView(next); setReview(null); setPptxCandidate(null);
    setActions(next.project.pages.find((entry) => entry.pageId === next.pageId)!.actions); setSaved(true);
    setNarrationInstruction({ viewId: next.viewId, text: "" });
    try {
      await draftQueue.current;
      const { draft } = await api.pptEditorTeachingDraftGet(next.viewId);
      if (id !== request.current) return;
      draftScope.current = { viewId: next.viewId, revision: draft?.revision ?? null, serial: 0, failed: false };
      if (draft) {
        if (draft.pageId === next.pageId && JSON.stringify(draft.baseline) === JSON.stringify(next.project) &&
            !next.project.pages.find(entry => entry.pageId === next.pageId)!.locked) {
          setActions(draft.actions); setNarrationInstruction({ viewId: next.viewId, text: draft.instruction });
          setRecovered(true); setSaved(false);
        } else setStaleDraft(draft);
      }
    } catch (failure) { if (id === request.current) setDraftError(String(failure)); }
    finally { if (id === request.current) { setDraftLoading(false); setDraftSaving(false); } }
  }, []);
  const persistDraft = (nextActions: Array<Record<string, unknown>>, instruction: string) => {
    const scope = draftScope.current;
    if (!scope || !page) return;
    const serial = ++scope.serial;
    const content = JSON.stringify(nextActions) === JSON.stringify(page.actions) && !instruction ? null : { actions: nextActions, instruction };
    setDraftSaving(true); setRecovered(false);
    draftQueue.current = draftQueue.current.then(async () => {
      if (serial !== scope.serial) return;
      if (scope.failed) {
        if (draftScope.current === scope && serial === scope.serial) setDraftSaving(false);
        return;
      }
      try {
        const result = await api.pptEditorTeachingDraftSet(scope.viewId, scope.revision, content);
        scope.revision = result.draft?.revision ?? null;
      } catch (failure) {
        scope.failed = true;
        if (draftScope.current === scope) setDraftError(String(failure));
      } finally {
        if (draftScope.current === scope && serial === scope.serial) setDraftSaving(false);
      }
    });
  };
  const editActions = (next: Array<Record<string, unknown>>) => {
    if (!canEdit) return;
    setSaved(false); setActions(next);
    persistDraft(next, narrationInstruction.viewId === view?.viewId ? narrationInstruction.text : "");
  };
  const discardDraft = () => {
    const scope = draftScope.current;
    if (!scope || !page || !view) return;
    const id = ++request.current;
    setBusy(true);
    void draftQueue.current.then(async () => {
      await api.pptEditorTeachingDraftSet(scope.viewId, scope.revision, null);
      if (id !== request.current) return;
      scope.revision = null; scope.failed = false;
      setActions(page.actions); setNarrationInstruction({ viewId: view.viewId, text: "" });
      setStaleDraft(null); setDraftError(""); setRecovered(false); setError(""); setSaved(false);
    }).catch(failure => { if (id === request.current) setDraftError(String(failure)); })
      .finally(() => { if (id === request.current) setBusy(false); });
  };
  const run = useCallback(async (operation: () => Promise<CoursewareTeachingView>) => {
    const id = ++request.current;
    setBusy(true); setError(""); setSaved(false);
    try {
      await draftQueue.current;
      const next = await operation();
      if (id !== request.current) return;
      await applyView(next);
    } catch (failure) {
      if (id === request.current) setError(String(failure));
    } finally { if (id === request.current) setBusy(false); }
  }, [applyView]);

  useEffect(() => () => { ++request.current; }, []);

  useEffect(() => {
    if (!enabled || !sessionId || !view || teachingRefresh?.sessionId !== sessionId || refreshSeen.current === teachingRefresh ||
        (teachingRefresh.sourceSha256 ? teachingRefresh.sourceSha256 === view.project.source.sha256 :
          teachingRefresh.teachingRevision === view.project.teachingRevision) || busy || changed ||
        draftLoading || draftSaving || draftError || staleDraft || instructionPending || review || pptxCandidate || error) return;
    // Consume once: a later manual save can legitimately be newer than this hint.
    refreshSeen.current = teachingRefresh;
    void run(() => api.pptEditorTeachingOpen(sessionId));
  }, [enabled, sessionId, view, teachingRefresh, busy, changed, draftLoading, draftSaving,
    draftError, staleDraft, instructionPending, review, pptxCandidate, error, run]);

  useEffect(() => {
    if (!enabled || !sessionId || !view || busy || draftLoading || draftSaving || draftError || staleDraft || changed || instructionPending || review || pptxCandidate || error) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const followPage = async () => {
      if (readingContext.current) {
        timer = setTimeout(followPage, 1000);
        return;
      }
      readingContext.current = true;
      try {
        const context = await api.pptEditorGetContext();
        if (stopped) return;
        if (context.page && !context.readOnly && context.page !== view.pageNumber) {
          void run(() => api.pptEditorTeachingOpen(sessionId));
          return;
        }
        timer = setTimeout(followPage, 1000);
      } catch (failure) {
        if (!stopped) setError(String(failure));
      } finally {
        readingContext.current = false;
      }
    };
    timer = setTimeout(followPage, 1000);
    return () => { stopped = true; clearTimeout(timer); };
  }, [enabled, sessionId, view, busy, draftLoading, draftSaving, draftError, staleDraft, changed, instructionPending, review, pptxCandidate, error, run]);

  return <aside className="courseware-teaching is-tabbed" aria-label={t("panel.pptEditor.teachingTitle")}>
    <div className="courseware-teaching-tabs" role="tablist" aria-label={t("panel.pptEditor.sidebarTabs")}>
      {([
        ["narration", IconFileText], ["voice", IconMic], ["effects", IconSparkles], ["assets", IconImage], ["review", IconCheck],
      ] as const).map(([tab, Icon]) => <button key={tab} id={`teaching-tab-${tab}`} type="button" role="tab"
        aria-selected={activeTab === tab} aria-controls="teaching-tab-content" tabIndex={activeTab === tab ? 0 : -1}
        onKeyDown={event => {
          const tabs = [...event.currentTarget.parentElement!.querySelectorAll<HTMLButtonElement>('[role="tab"]:not(:disabled)')];
          const index = tabs.indexOf(event.currentTarget);
          const next = event.key === "ArrowRight" ? tabs[(index + 1) % tabs.length] : event.key === "ArrowLeft" ? tabs[(index + tabs.length - 1) % tabs.length] : event.key === "Home" ? tabs[0] : event.key === "End" ? tabs.at(-1) : undefined;
          if (next) { event.preventDefault(); next.click(); next.focus(); }
        }}
        disabled={busy && activeTab !== tab}
        onClick={() => setActiveTab(tab)}><Icon size={15} /><span>{t(`panel.pptEditor.tab_${tab}`)}</span></button>)}
    </div>
    <div className="courseware-teaching-content" id="teaching-tab-content" role="tabpanel" aria-labelledby={`teaching-tab-${activeTab}`}>
    <div hidden={activeTab !== "assets"}>
    <CoursewareImageAssets sessionId={sessionId} enabled={enabled && !working && !previewActive && !ttsActive && !assetLocksActive && !changed && !review && !pptxCandidate} onActiveChange={setImageActive} />
    </div>
    <div className="courseware-teaching-current">
    <strong>{view ? t("panel.pptEditor.teachingPage", { page: view.pageNumber }) : t("panel.pptEditor.teachingTitle")}</strong>
    <button type="button" disabled={!enabled || !sessionId || busy || changed || !!review || !!pptxCandidate}
      onClick={() => sessionId && void run(() => api.pptEditorTeachingOpen(sessionId))}>
      {t(working ? "panel.pptEditor.teachingBusy" : "panel.pptEditor.teachingCurrent")}
    </button>
    </div>
    <div hidden={activeTab !== "review"}>
    <details><summary>{t("panel.pptEditor.sidebarHelp")}</summary><p>{t("panel.pptEditor.teachingScope")}</p></details>
    <button type="button" disabled={!enabled || !sessionId || busy || draftLoading || draftSaving || !!draftError || !!review || !!pptxCandidate} onClick={async () => {
      if (!sessionId) return;
      const id = ++request.current;
      setBusy(true); setError(""); setSaved(false);
      try {
        await draftQueue.current;
        if (id !== request.current) return;
        if (draftScope.current?.failed) throw new Error("Preserve or discard the local draft before reviewing source changes");
        const next = await api.pptEditorTeachingReview(sessionId);
        if (id === request.current) setReview(next);
      }
      catch (failure) { if (id === request.current) setError(String(failure)); }
      finally { if (id === request.current) setBusy(false); }
    }}>{t("panel.pptEditor.sourceReviewStart")}</button>
    {!review && !pptxCandidate && <form onSubmit={async (event) => {
      event.preventDefault();
      if (!sessionId || !pptxCandidateId.trim()) return;
      const id = ++request.current;
      setBusy(true); setError("");
      try {
        const next = await api.pptEditorPptxCandidateReview(sessionId, pptxCandidateId.trim());
        if (id === request.current) setPptxCandidate(next);
      } catch (failure) { if (id === request.current) setError(String(failure)); }
      finally { if (id === request.current) setBusy(false); }
    }}>
      <label>{t("panel.pptEditor.pptxCandidateLookup")}
        <input value={pptxCandidateId} disabled={!enabled || busy || changed} onChange={(event) => setPptxCandidateId(event.target.value)} />
      </label>
      <button type="submit" disabled={!enabled || !sessionId || busy || changed || !pptxCandidateId.trim()}>{t("panel.pptEditor.pptxCandidateReview")}</button>
    </form>}
    {pptxCandidate && <CoursewarePptxCandidateReview key={pptxCandidate.reviewId} sessionId={sessionId} review={pptxCandidate} disabled={!enabled || busy}
      adopt={(effectBindings) => {
        const id = ++request.current;
        setBusy(true); setError("");
        void api.pptEditorPptxCandidateAdopt(pptxCandidate.reviewId, effectBindings).then(() => {
          if (id === request.current) { setPptxCandidate(null); setView(null); setActions([]); setSaved(true); }
        }).catch((failure) => { if (id === request.current) setError(String(failure)); })
          .finally(() => { if (id === request.current) setBusy(false); });
      }}
      preview={() => {
        const id = ++request.current;
        setBusy(true); setError("");
        void api.pptEditorPptxCandidatePreview(pptxCandidate.reviewId).catch((failure) => { if (id === request.current) setError(String(failure)); })
          .finally(() => { if (id === request.current) setBusy(false); });
      }}
      reject={() => {
        const id = ++request.current;
        setBusy(true); setError("");
        void api.pptEditorPptxCandidateReject(pptxCandidate.reviewId).then(() => {
          if (id === request.current) { setPptxCandidate(null); setView(null); setActions([]); }
        }).catch((failure) => { if (id === request.current) setError(String(failure)); })
          .finally(() => { if (id === request.current) setBusy(false); });
      }}
      close={() => { setPptxCandidate(null); setError(""); }} />}
    {review && <CoursewareSourceReview key={review.reviewId} review={review} disabled={!enabled || busy}
      cancel={() => { setReview(null); setView(null); setActions([]); setError(""); }}
      adopt={(bindings, effectBindings) => void run(() => api.pptEditorTeachingAdopt(review.reviewId, bindings, effectBindings))} />}
    </div>
    {!review && view && page && <>
      <div hidden={activeTab !== "review"}>
      <CoursewareTeachingHistory key={`history:${view.viewId}:${view.project.teachingRevision}`} view={view}
        disabled={!canEdit || changed || instructionPending || draftSaving || !!draftError || actions.some(action => action.type !== "audio_clip")}
        onRestore={restored => {
          if (!canEdit || changed || instructionPending || draftSaving || draftError || actions.some(action => action.type !== "audio_clip")) return;
          editActions([...restored.map(action => action.checkpointKind === "chapter_summary" ? { ...action,
            chapterId: page.pageId, context: { ...action.context as Record<string, unknown>, sourceSceneIds: [page.pageId] } } : action), ...actions]);
        }} />
      <CoursewareChatChanges key={`chat:${view.viewId}`} view={view} />
      {view.sourceChange && <div role="status">
        <strong>{t("panel.pptEditor.sourceChangeTitle")}</strong> <code>{view.sourceChange.changeGroupId.slice(0, 8)}</code>
        <p>{t(`panel.pptEditor.sourceChange${view.sourceChange.phase === "complete" ? "Complete" : view.sourceChange.phase === "superseded" ? "Superseded" : view.sourceChange.phase === "source-review" ? "SourceReview" : "Pending"}`, {
          pages: view.sourceChange.pendingPageIds.map(id => view.project.pages.findIndex(entry => entry.pageId === id) + 1).join(", "),
        })}</p>
      </div>}
      </div>
      <div hidden={activeTab !== "assets"}>
      <CoursewareAssetLocks key={`locks:${view.viewId}`} view={view} disabled={!enabled || busy || changed || draftSaving || draftLoading || !!staleDraft || page.locked}
        onActivity={setAssetLocksActive} />
      {view.project.taskType === "scene" && view.teachingObjects && <details className="courseware-scene-objects">
        <summary>{t("panel.pptEditor.sceneObjects")}</summary>
        <p>{t("panel.pptEditor.sceneObjectsReview")}</p>
        {view.teachingObjects.length === 0 ? <p>{t("panel.pptEditor.sceneObjectsEmpty")}</p> :
          <ul>{view.teachingObjects.map(object => <li key={object.objectId}>
            <strong>{object.role || object.name}</strong>
            {object.aliases.length > 0 && <span> · {object.aliases.join(" / ")}</span>}
            <p role="status">{t(object.status === "mapped" ? "panel.pptEditor.sceneObjectMapped" :
              object.status === "missing" ? "panel.pptEditor.sceneObjectMissing" :
              object.status === "content_changed" ? "panel.pptEditor.sceneObjectChanged" : "panel.pptEditor.sceneObjectMismatch")}</p>
          </li>)}</ul>}
      </details>}
      </div>
      <div hidden={activeTab !== "narration"}>
      {view.project.taskType === "import" && page.actions.length === 0 && !changed &&
        <p>本页讲解可从原 PPT 备注读取、粘贴外部讲解稿，或在主 Chat 生成新讲解。</p>}
      {view.project.taskType === "import" && page.actions.length === 0 && <button type="button"
        disabled={!canEdit || changed || !sessionId}
        onClick={async () => {
          if (!sessionId) return;
          const id = ++request.current;
          setBusy(true); setError("");
          try {
            const imported = await api.pptEditorImportNotesPreview(sessionId);
            if (id !== request.current) return;
            await applyView(imported.view);
            const next = [{ id: crypto.randomUUID(), type: "speech", text: imported.text, source: "notes" }];
            setActions(next); persistDraft(next, "");
            setSaved(false);
          } catch (failure) { if (id === request.current) setError(String(failure)); }
          finally { if (id === request.current) setBusy(false); }
        }}>读取原 PPT 备注（预览后保存）</button>}
      {view.project.taskType === "import" && page.actions.length === 0 && <button type="button"
        disabled={!canEdit || changed}
        onClick={() => {
          setSaved(false);
          const next = [{ id: crypto.randomUUID(), type: "speech", text: "", source: "external" }];
          setActions(next); persistDraft(next, narrationInstruction.text);
        }}>粘贴外部讲解稿</button>}
      <label>
        本页讲解要求（可选）
        <textarea rows={2} maxLength={4000} value={narrationInstruction.viewId === view.viewId ? narrationInstruction.text : ""} disabled={!canEdit}
          placeholder="例如：缩短讲解、改得更活泼，或加入适合本年级的鼓励语。"
          onChange={(event) => {
            setNarrationInstruction({ viewId: view.viewId, text: event.target.value });
            persistDraft(actions, event.target.value);
          }} />
      </label>
      <button type="button"
        disabled={!canEdit || changed || !sessionId}
        onClick={async () => {
          if (!sessionId || !canEdit || changed) return;
          setBusy(true); setError("");
          const instruction = narrationInstruction.viewId === view.viewId ? narrationInstruction.text.trim() : "";
          try {
            const target = JSON.stringify({ coursewareProjectId: view.project.projectId, pageId: page.pageId,
              sourceRevision: view.project.source.revision, teachingRevision: view.project.teachingRevision });
            // The instruction becomes part of Chat; only unsaved teaching should block generation.
            persistDraft(actions, "");
            await draftQueue.current;
            if (draftScope.current?.failed) throw new Error("Save or discard the local draft before generating narration");
            const accepted = await sendPrompt(`请为第 ${view.pageNumber} 页生成或重新生成讲解词并直接保存。先调用 courseware_narration_context 读取已保存课件，核对以下目标页与来源一致：${target}。如果不一致，请停止并提醒我重新读取课件，不要改其他页。读取当前页面和已有讲解，遵循项目年级、学科和语言要求，使用 courseware_narration_propose 按明确页码生成并替换本页讲解，无需候选或采纳步骤。${instruction ? `\n用户对本页讲解的要求：${instruction}` : ""}`, undefined, sessionId);
            if (accepted) setNarrationInstruction({ viewId: view.viewId, text: "" });
            else {
              persistDraft(actions, instruction);
              setError("主 Chat 暂未接受请求，请处理当前待确认事项后重试。");
            }
          } catch (failure) { persistDraft(actions, instruction); setError(String(failure)); }
          finally { setBusy(false); }
        }}>
        {page.actions.some((action) => action.type === "speech") ? "在主 Chat 重新生成本页讲解" : "在主 Chat 生成本页讲解"}
      </button>
      <details><summary>{t("panel.pptEditor.sidebarHelp")}</summary><p>{t("panel.pptEditor.teachingTimingScope")}</p></details>
      {actions.map((action, index) => action.type === "speech" && typeof action.text === "string" ?
        <div key={String(action.id)}>
          <label>
            {t("panel.pptEditor.teachingSegment", { segment: index + 1 })}
            <textarea rows={5} value={action.text} disabled={!canEdit} onChange={(event) => {
              const text = event.target.value;
              setSaved(false);
              const next = actions.map((entry, position) => position === index ? replaceNarrationText(entry, text) : entry);
              setActions(next); persistDraft(next, narrationInstruction.viewId === view.viewId ? narrationInstruction.text : "");
            }} />
          </label>
          <label>
            {t("panel.pptEditor.teachingPauseAfterMs")}
            <input type="number" min={0} max={30000} step={1} value={typeof action.pauseAfterMs === "number" ? action.pauseAfterMs : 0} disabled={!canEdit}
              onChange={(event) => {
                const pauseAfterMs = event.target.valueAsNumber;
                if (!event.target.value || !Number.isInteger(pauseAfterMs) || pauseAfterMs < 0 || pauseAfterMs > 30000) return;
                editActions(actions.map((entry, position) => position === index ? { ...entry, pauseAfterMs } : entry));
              }} />
          </label>
          <button type="button" disabled={!canEdit || actions.length >= 1000} onClick={() => {
            if (!canEdit || actions.length >= 1000) return;
            const id = crypto.randomUUID();
            editActions([...actions.slice(0, index + 1), { id, type: "interaction_checkpoint", checkpointId: id, checkpointKind: "teacher_continue" }, ...actions.slice(index + 1)]);
          }}>{t("panel.pptEditor.teachingAddCheckpoint")}</button>
        </div> : action.type === "audio_clip" && typeof action.audioAssetId === "string" ? <div key={String(action.id)} data-teaching-music-clip={String(action.id)}>
          <p>{t("panel.canvasMusic.clip", { asset: action.audioAssetId.slice(0, 20) })}</p>
          <button type="button" disabled={!canEdit || index === 0} onClick={() => {
            if (index === 0) return;
            const next = [...actions]; [next[index - 1], next[index]] = [next[index], next[index - 1]]; editActions(next);
          }}>{t("panel.canvasMusic.moveUp")}</button>
          <button type="button" disabled={!canEdit || index === actions.length - 1} onClick={() => {
            if (index === actions.length - 1) return;
            const next = [...actions]; [next[index], next[index + 1]] = [next[index + 1], next[index]]; editActions(next);
          }}>{t("panel.canvasMusic.moveDown")}</button>
          <button type="button" disabled={!canEdit} onClick={() => editActions(actions.filter((_, position) => position !== index))}>
            {t("panel.canvasMusic.removeClip")}
          </button>
        </div> : isCoursewareInteractionCheckpoint(action) ? <div key={String(action.id)}>
          <p>{t("panel.pptEditor.teachingCheckpoint")}</p>
          {action.checkpointKind === "chapter_summary" && <>
            <label>{t("panel.pptEditor.teachingQuestion")}
              <textarea rows={2} value={String(action.question)} maxLength={4000} disabled={!canEdit} onChange={event =>
                editActions(actions.map((entry, position) => position === index ? { ...entry, question: event.target.value } : entry))} />
            </label>
            <details><summary>{t("panel.pptEditor.teachingReferenceAnswer")}</summary>
              <p>{String((action.referenceAnswer as Record<string, unknown>).summary)}</p>
              <ul>{((action.referenceAnswer as { keyPoints: string[] }).keyPoints).map((point, position) => <li key={position}>{point}</li>)}</ul>
            </details>
          </>}
          <button type="button" disabled={!canEdit} onClick={() => editActions(actions.filter((_, position) => position !== index))}>
            {t("panel.pptEditor.teachingRemoveCheckpoint")}
          </button>
        </div> : <p key={String(action.id)}>{t("panel.pptEditor.teachingOtherAction", { type: String(action.type) })}</p>)}
      <button type="button" disabled={!canEdit || actions.length >= 1000} onClick={() => {
        setSaved(false);
        const next = [...actions, { id: crypto.randomUUID(), type: "speech", text: "" }];
        setActions(next); persistDraft(next, narrationInstruction.viewId === view.viewId ? narrationInstruction.text : "");
      }}>{t("panel.pptEditor.teachingAdd")}</button>
      <label className="courseware-teaching-lock">
        <input type="checkbox" checked={page.locked} disabled={!enabled || busy || changed}
          onChange={(event) => { const locked = event.target.checked; void run(() => api.pptEditorTeachingLock(view.viewId, view.project.teachingRevision, locked)); }} />
        {t("panel.pptEditor.teachingLock")}
      </label>
      <div className="courseware-teaching-actions">
        <button type="button" disabled={!canEdit || !changed || !sessionId || actions.some((action) => action.type === "speech" && (typeof action.text !== "string" || !action.text.trim()))} onClick={() => sessionId && void run(async () => {
          const id = request.current;
          const current = await api.pptEditorTeachingOpen(sessionId);
          if (id !== request.current || current.pageId !== view.pageId || JSON.stringify(current.project) !== JSON.stringify(view.project))
            throw new Error("Teaching changed; return to the draft page and resolve any source or narration changes before saving");
          const result = await api.pptEditorTeachingWrite(current.viewId, current.project.teachingRevision, actions);
          const scope = draftScope.current;
          if (scope) {
            try {
              const instruction = narrationInstruction.viewId === view.viewId ? narrationInstruction.text : "";
              await api.pptEditorTeachingDraftSet(result.viewId, scope.revision, instruction ? { actions, instruction } : null);
            } catch (failure) { setError(`${t("panel.pptEditor.teachingDraftCleanupFailed")} ${String(failure)}`); }
          }
          return result;
        })}>
          {t("panel.pptEditor.teachingSave")}
        </button>
        <button type="button" disabled={busy || draftLoading || (!changed && !instructionPending && !staleDraft && !draftError)} onClick={discardDraft}>
          {t("panel.pptEditor.teachingDiscard")}
        </button>
      </div>
      <p role="status">{t(changed ? "panel.pptEditor.teachingUnsaved" : saved ? "panel.pptEditor.teachingSaved" : "panel.pptEditor.teachingReview")}</p>
      {draftLoading && <p role="status">{t("panel.pptEditor.teachingDraftLoading")}</p>}
      {draftSaving && <p role="status">{t("panel.pptEditor.teachingDraftSaving")}</p>}
      {!draftLoading && !draftSaving && !draftError && (changed || instructionPending) && <p role="status">{t(recovered ? "panel.pptEditor.teachingDraftRecovered" : "panel.pptEditor.teachingDraftStored")}</p>}
      {staleDraft && <div role="alert">
        <p>{t("panel.pptEditor.teachingDraftStale")}</p>
        <textarea readOnly rows={5} aria-label={t("panel.pptEditor.teachingDraftCopy")} value={[
          ...staleDraft.actions.filter(action => action.type === "speech").map(action => String(action.text)), staleDraft.instruction,
        ].filter(Boolean).join("\n\n")} />
      </div>}
      {draftError && <p role="alert">{t("panel.pptEditor.teachingDraftFailed")} {draftError}</p>}
      </div>
      <div hidden={activeTab !== "effects"}>
        <CoursewareTeachingEffects key={`effects:${view.viewId}`} view={view} actions={actions} disabled={!canEdit} onChange={editActions} />
      </div>
    </>}
    {view && sessionId && <div hidden={activeTab !== "voice"}>
      <CoursewareTtsTasks key={`tts:${view.viewId}:${view.project.teachingRevision}`} view={view}
        enabled={enabled && !draftLoading && !staleDraft && !draftError && !working && !previewActive && !imageActive && !assetLocksActive && !changed && !review && !pptxCandidate}
        onActiveChange={setTtsActive} onAdopt={applyView} />
      <CoursewarePlaybackPanel key={`${view.viewId}:${view.project.teachingRevision}`} view={view} sessionId={sessionId}
        enabled={enabled && !draftLoading && !staleDraft && !draftError && !working && !ttsActive && !imageActive && !assetLocksActive && !changed && !review && !pptxCandidate} onActiveChange={setPreviewActive} />
    </div>}
    {!enabled && <p role="status">{t("panel.pptEditor.teachingSaveFirst")}</p>}
    {error && <p role="alert">{error}</p>}
    </div>
  </aside>;
}
