import type { CoursewareTeachingView, CoursewareTtsModel, CoursewareTtsQuoteView, CoursewareTtsView } from "@pi-desktop/shared";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../lib/api";

/** Generation requires a fresh quote and explicit confirmation; status never submits. */
export function CoursewareTtsTasks({ view, enabled, onActiveChange, onAdopt }: {
  view: CoursewareTeachingView; enabled: boolean;
  onActiveChange: (active: boolean) => void; onAdopt: (next: CoursewareTeachingView) => void;
}) {
  const { t } = useTranslation();
  const [models, setModels] = useState<CoursewareTtsModel[]>([]);
  const [model, setModel] = useState("");
  const [voice, setVoice] = useState("");
  const [actionId, setActionId] = useState("");
  const [quote, setQuote] = useState<CoursewareTtsQuoteView | null>(null);
  const [feeConfirmed, setFeeConfirmed] = useState(false);
  const [tasks, setTasks] = useState<CoursewareTtsView[] | null>(null);
  const [archives, setArchives] = useState<Record<string, number>>({});
  const [confirmed, setConfirmed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const request = useRef(0);
  const owner = `${view.viewId}:${view.project.teachingRevision}:${view.pageId}`;
  const latest = useRef({ owner, enabled }); latest.current = { owner, enabled };
  const onActive = useRef(onActiveChange); onActive.current = onActiveChange;
  const page = view.project.pages.find((entry) => entry.pageId === view.pageId);
  useEffect(() => {
    const clear = () => { request.current++; setTasks(null); setArchives({}); setConfirmed(null);
      setModels([]); setModel(""); setVoice(""); setActionId(""); setQuote(null); setFeeConfirmed(false);
      setBusy(false); setError(""); onActive.current(false); };
    clear();
    const unsubscribe = api.onAuthChanged(clear);
    return () => { request.current++; unsubscribe(); onActive.current(false); };
  }, [owner, enabled]);

  const run = async (operation: () => Promise<() => void>) => {
    if (!enabled || busy) return;
    const id = ++request.current;
    const current = () => id === request.current && latest.current.owner === owner && latest.current.enabled;
    setBusy(true); setError(""); setConfirmed(null); onActive.current(true);
    try { const apply = await operation(); if (current()) apply(); }
    catch (failure) { if (current()) setError(String(failure)); }
    finally { if (current()) { setBusy(false); onActive.current(false); } }
  };
  const selectedModel = models.find((entry) => entry.model === model);
  const speeches = page?.actions.filter((entry) => entry.type === "speech") ?? [];
  const clearQuote = () => { setQuote(null); setFeeConfirmed(false); };
  const upsert = (next: CoursewareTtsView) => setTasks((entries) => [next, ...(entries ?? []).filter((entry) => entry.intentId !== next.intentId)]);
  return <section className="courseware-tts-tasks" aria-label={t("panel.pptEditor.ttsTasksTitle")} aria-busy={busy}>
    <strong>{t("panel.pptEditor.ttsTasksTitle")}</strong>
    <p>{t("panel.pptEditor.ttsTasksScope")}</p>
    <button type="button" disabled={!enabled || busy} onClick={() => void run(async () => {
      const next = await api.pptEditorTtsList(view.viewId, view.project.teachingRevision);
      return () => { setTasks(next.filter((entry) => entry.pageId === view.pageId)); setArchives({}); };
    })}>{t(busy ? "panel.pptEditor.ttsBusy" : "panel.pptEditor.ttsTasksLoad")}</button>
    <fieldset disabled={!enabled || busy || page?.locked}>
      <legend>{t("panel.pptEditor.ttsGenerate")}</legend>
      <button type="button" onClick={() => void run(async () => {
        const next = await api.pptEditorTtsModels(view.viewId, view.project.teachingRevision);
        return () => { setModels(next); setModel(""); setVoice(""); clearQuote();
          if (!next.length) setError(t("panel.pptEditor.ttsNoModels")); };
      })}>{t("panel.pptEditor.ttsLoadModels")}</button>
      <label>{t("panel.pptEditor.ttsSegment")}<select value={actionId} onChange={(event) => { setActionId(event.target.value); clearQuote(); }}>
        <option value="">—</option>
        {speeches.map((action, index) => <option key={String(action.id)} value={String(action.id)}>{t("panel.pptEditor.teachingSegment", { segment: index + 1 })}</option>)}
      </select></label>
      <label>{t("panel.pptEditor.ttsModel")}<select value={model} onChange={(event) => { setModel(event.target.value); setVoice(""); clearQuote(); }}>
        <option value="">—</option>
        {models.map((entry) => <option key={entry.model} value={entry.model}>{entry.model}</option>)}
      </select></label>
      <label>{t("panel.pptEditor.ttsVoiceLabel")}<select value={voice} onChange={(event) => { setVoice(event.target.value); clearQuote(); }}>
        <option value="">{selectedModel?.providerDefaultVoice ? t("panel.pptEditor.ttsDefaultVoice") : "—"}</option>
        {selectedModel?.voices.map((entry) => <option key={entry} value={entry}>{entry}</option>)}
      </select></label>
      <button type="button" disabled={!actionId || !selectedModel || (!voice && !selectedModel.providerDefaultVoice)} onClick={() => {
        clearQuote();
        void run(async () => {
          const prepared = await api.pptEditorTtsPrepare(view.viewId, view.project.teachingRevision, actionId, model, voice || null);
          const next = await api.pptEditorTtsQuote(view.viewId, view.project.teachingRevision, prepared.intentId);
          return () => { upsert(prepared); setQuote(next); };
        });
      }}>{t("panel.pptEditor.ttsGetQuote")}</button>
      {quote && <>
        <p>{t("panel.pptEditor.ttsQuote", { points: quote.maxPoints, expires: new Date(quote.expiresAt).toLocaleTimeString() })}</p>
        <label><input type="checkbox" checked={feeConfirmed} onChange={(event) => setFeeConfirmed(event.target.checked)} />{t("panel.pptEditor.ttsConfirmFee")}</label>
        <button type="button" disabled={!feeConfirmed || Date.parse(quote.expiresAt) <= Date.now()} onClick={() => {
          const confirmedQuote = quote;
          clearQuote();
          void run(async () => {
            try {
              const next = await api.pptEditorTtsSubmitConfirmed(view.viewId, view.project.teachingRevision, confirmedQuote.intentId, confirmedQuote.quoteId);
              return () => upsert(next);
            } catch (failure) {
              // A lost receipt must stay visible without creating another paid request.
              const next = await api.pptEditorTtsList(view.viewId, view.project.teachingRevision);
              return () => { setTasks(next); setError(String(failure)); };
            }
          });
        }}>{t("panel.pptEditor.ttsSubmitPaid")}</button>
      </>}
    </fieldset>
    {tasks?.length === 0 && <p role="status">{t("panel.pptEditor.ttsTasksEmpty")}</p>}
    {tasks?.map((task) => {
      const action = page?.actions.find((entry) => entry.id === task.actionId && entry.type === "speech");
      const segment = page?.actions.filter((entry) => entry.type === "speech").findIndex((entry) => entry.id === task.actionId);
      const archived = Object.hasOwn(archives, task.intentId);
      return <article key={task.intentId}>
        <strong>{action ? t("panel.pptEditor.teachingSegment", { segment: (segment ?? -1) + 1 }) : t("panel.pptEditor.ttsTargetMissing")}</strong>
        {action && <p className="courseware-tts-text">{String(action.text)}</p>}
        <p>{t("panel.pptEditor.ttsVoice", { model: task.model, voice: task.voice ?? t("panel.pptEditor.ttsDefaultVoice") })}</p>
        <p role="status">{t(`panel.pptEditor.ttsPhase.${task.phase}`)}</p>
        {!task.current && <p>{t("panel.pptEditor.ttsChanged")}</p>}
        {(task.phase === "submission-unknown" || task.task?.state === "submission_unknown") && <p>{t("panel.pptEditor.ttsUnknown")}</p>}
        {task.task && <>
          <p>{t(`panel.pptEditor.ttsRemoteState.${task.task.state}`)}</p>
          <p>{t("panel.pptEditor.ttsFees", { reserved: task.task.reservedPoints,
            actual: task.task.actualPoints ?? t("panel.pptEditor.ttsFeePending"), state: t(`panel.pptEditor.ttsFeeState.${task.task.feeState}`) })}</p>
          {task.task.errorCode && <p>{task.task.errorCode}</p>}
        </>}
        {archived && <p role="status">{t("panel.pptEditor.ttsArchived", { ms: archives[task.intentId] })}</p>}
        <div className="courseware-teaching-actions">
          <button type="button" disabled={!enabled || busy || task.phase === "rejected"} onClick={() => void run(async () => {
            const next = await api.pptEditorTtsStatus(view.viewId, view.project.teachingRevision, task.intentId);
            return () => setTasks((entries) => entries?.map((entry) => entry.intentId === task.intentId ? next : entry) ?? null);
          })}>{t("panel.pptEditor.ttsCheck")}</button>
          <button type="button" disabled={!enabled || busy || task.phase !== "submitted"} onClick={() => void run(async () => {
            const saved = await api.pptEditorTtsArchive(view.viewId, view.project.teachingRevision, task.intentId);
            return () => setArchives((entries) => ({ ...entries, [task.intentId]: saved.durationMs }));
          })}>{t("panel.pptEditor.ttsArchive")}</button>
        </div>
        {archived && <>
          <label><input type="checkbox" checked={confirmed === task.intentId} disabled={!enabled || busy || !action || page?.locked}
            onChange={(event) => setConfirmed(event.target.checked ? task.intentId : null)} />{t(Array.isArray(action?.visualCues) && action.visualCues.length > 0
              ? "panel.pptEditor.ttsConfirmCueReview" : "panel.pptEditor.ttsConfirm")}</label>
          <button type="button" disabled={!enabled || busy || !action || page?.locked || confirmed !== task.intentId}
            onClick={() => void run(async () => {
              const next = await api.pptEditorTtsAdopt(view.viewId, view.project.teachingRevision, task.intentId);
              return () => onAdopt(next);
            })}>{t("panel.pptEditor.ttsAdopt")}</button>
        </>}
      </article>;
    })}
    {error && <p role="alert">{t("panel.pptEditor.ttsFailure", { message: error })}</p>}
  </section>;
}
