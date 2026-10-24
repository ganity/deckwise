import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { CoursewareCanvasMusicView, CoursewareCanvasMusicQuoteView, CoursewareCanvasMusicPreview,
  CoursewareCanvasMusicModels, CoursewareTeachingView, MediaCanvasDocument, MediaCanvasDraft } from "@pi-desktop/shared";
import { api } from "../../lib/api";

const draftKey = (draft?: MediaCanvasDraft) => JSON.stringify(draft ? [draft.id, draft.revision, draft.title, draft.prompt,
  draft.references.map(value => [value.assetId, value.revision, value.label])] : null);
const isPrivateAudio = (value: string) => /^data:audio\/mpeg;base64,[a-z\d+/]+={0,2}$/iu.test(value);

export function CoursewareCanvasMusic({ sessionId, revision, document, disabled }: {
  sessionId: string; revision: string | null; document: MediaCanvasDocument; disabled: boolean;
}) {
  const { t } = useTranslation();
  const privateScope = JSON.stringify([sessionId, document.projectId]);
  const [models, setModels] = useState<CoursewareCanvasMusicModels>({ generation: [], export: [] });
  const [model, setModel] = useState("");
  const [exportModel, setExportModel] = useState("");
  const [draftId, setDraftId] = useState("");
  const [tags, setTags] = useState("");
  const [negativeTags, setNegativeTags] = useState("");
  const [instrumental, setInstrumental] = useState(false);
  const [rows, setRows] = useState<{ scope: string; values: CoursewareCanvasMusicView[] }>({ scope: privateScope, values: [] });
  const [quoted, setQuoted] = useState<{ scope: string; intent: CoursewareCanvasMusicView; quote: CoursewareCanvasMusicQuoteView } | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [previews, setPreviews] = useState<{ scope: string; values: Record<string, CoursewareCanvasMusicPreview> }>({ scope: privateScope, values: {} });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [adoption, setAdoption] = useState<{ scope: string; intentId: string; view: CoursewareTeachingView } | null>(null);
  const [adopted, setAdopted] = useState<{ scope: string; pageNumber: number } | null>(null);
  const epoch = useRef(0), inFlight = useRef(false), activeScope = useRef("");
  const draft = document.drafts.find(value => value.id === draftId && value.kind === "music");
  const scope = JSON.stringify([privateScope, revision, disabled, draftKey(draft), model, exportModel, tags, negativeTags, instrumental]);
  activeScope.current = scope;
  const values = rows.scope === privateScope ? rows.values : [];
  const audio = previews.scope === privateScope ? previews.values : {};
  const clearQuote = () => { setQuoted(null); setConfirmed(false); };
  useEffect(() => {
    const clear = () => {
      epoch.current++; inFlight.current = false; setBusy(false); setModels({ generation: [], export: [] });
      setModel(""); setExportModel(""); setDraftId(""); setTags(""); setNegativeTags(""); setInstrumental(false);
      setRows({ scope: privateScope, values: [] }); setPreviews({ scope: privateScope, values: {} }); clearQuote(); setError(""); setAdoption(null); setAdopted(null);
    };
    clear(); const unsubscribe = api.onAuthChanged(clear);
    return () => { epoch.current++; inFlight.current = false; unsubscribe(); };
  }, [privateScope]);
  useEffect(() => { epoch.current++; inFlight.current = false; setBusy(false); clearQuote(); setAdoption(null); setAdopted(null); }, [scope]);
  const put = (value: CoursewareCanvasMusicView) => setRows(previous => ({ scope: privateScope,
    values: [...(previous.scope === privateScope ? previous.values : []).filter(row => row.intentId !== value.intentId), value] }));
  const run = async (operation: (current: () => boolean) => Promise<void>) => {
    if (inFlight.current) return;
    const request = epoch.current, captured = scope;
    const current = () => request === epoch.current && captured === activeScope.current;
    inFlight.current = true; setBusy(true); setError("");
    try { await operation(current); }
    catch (failure) { if (current()) setError(String(failure)); }
    finally { if (current()) { inFlight.current = false; setBusy(false); } }
  };
  const unknown = values.some(row => row.operation === "music" && row.draft.id === draftId && row.phase === "submission-unknown");
  const canPrepare = !disabled && revision !== null && !!draft && draft.title.length <= 100 &&
    draft.prompt.length <= 4000 && (instrumental || !!draft.prompt.trim()) && draft.references.length === 0 &&
    models.generation.some(value => value.model === model) && !unknown;
  const live = values.find(value => value.intentId === quoted?.intent.intentId);
  const validQuote = quoted?.scope === scope && live?.phase === "prepared" && quoted.intent.phase === "prepared" &&
    quoted.quote.intentId === live.intentId && quoted.quote.model === live.model &&
    Number.isFinite(Date.parse(quoted.quote.expiresAt)) && Date.parse(quoted.quote.expiresAt) > Date.now() &&
    (live.operation === "music-export" || live.current && !unknown && draftKey(live.draft) === draftKey(draft));
  const getQuote = async (intent: CoursewareCanvasMusicView, current: () => boolean) => {
    put(intent);
    if (intent.phase !== "prepared") return;
    const quote = intent.operation === "music" ? await api.coursewareCanvasMusicQuote(sessionId, intent.intentId)
      : await api.coursewareCanvasMusicExportQuote(sessionId, intent.intentId);
    if (!current()) return;
    if (quote.intentId !== intent.intentId || quote.model !== intent.model) throw new Error(t("panel.canvasMusic.invalidQuote"));
    setQuoted({ scope, intent, quote });
  };
  const prepare = () => {
    if (!canPrepare || !draft || revision === null) return;
    clearQuote();
    return run(async current => {
      const intent = await api.coursewareCanvasMusicPrepare({ sessionId, intentId: crypto.randomUUID(), draftId,
        expectedRevision: revision, expectedDraftRevision: draft.revision, model,
        music: { title: draft.title, tags, negativeTags, instrumental } });
      if (current()) await getQuote(intent, current);
    });
  };
  const exportCandidate = (row: CoursewareCanvasMusicView, candidateId: string) => {
    if (disabled || row.operation !== "music" ||
      !row.candidates.some(candidate => candidate.candidateId === candidateId && candidate.exportable) ||
      !models.export.some(value => value.model === exportModel) ||
      values.some(value => value.operation === "music-export" && value.sourceIntentId === row.intentId &&
        value.candidateId === candidateId && value.phase === "submission-unknown")) return;
    clearQuote();
    return run(async current => {
      const intent = await api.coursewareCanvasMusicExportPrepare({ sessionId, intentId: row.intentId,
        exportIntentId: crypto.randomUUID(), candidateId, model: exportModel });
      if (current()) await getQuote(intent, current);
    });
  };
  const submit = () => {
    if (disabled || !confirmed || !validQuote || !quoted) return;
    const saved = quoted; clearQuote();
    return run(async current => {
      put({ ...saved.intent, phase: "submission-unknown" });
      try {
        const value = saved.intent.operation === "music" ? await api.coursewareCanvasMusicSubmitConfirmed(sessionId, saved.intent.intentId, saved.quote.quoteId)
          : await api.coursewareCanvasMusicExportSubmitConfirmed(sessionId, saved.intent.intentId, saved.quote.quoteId);
        if (current()) put(value);
      } catch (failure) {
        if (current()) {
          try { const next = await api.coursewareCanvasMusicList(sessionId); if (current()) setRows({ scope: privateScope, values: next }); }
          catch { /* Retain the uncertain attempt until its durable journal can be read. */ }
        }
        throw failure;
      }
    });
  };
  const listen = (row: CoursewareCanvasMusicView, candidateId?: string) => run(async current => {
    const value = candidateId ? await api.coursewareCanvasMusicPreview(sessionId, row.intentId, candidateId)
      : await api.coursewareCanvasMusicExportArchive(sessionId, row.intentId);
    if (!current()) return;
    if (value.intentId !== row.intentId || value.candidateId !== candidateId || value.asset.mimeType !== "audio/mpeg" || !isPrivateAudio(value.dataUrl))
      throw new Error(t("panel.canvasMusic.invalidPreview"));
    if (!candidateId && row.operation === "music-export") put({ ...row, asset: value.asset });
    setPreviews(previous => ({ scope: privateScope, values: { ...(previous.scope === privateScope ? previous.values : {}),
      [candidateId ?? row.intentId]: value } }));
  });
  const status = (row: CoursewareCanvasMusicView) => run(async current => {
    const value = row.operation === "music" ? await api.coursewareCanvasMusicStatus(sessionId, row.intentId)
      : await api.coursewareCanvasMusicExportStatus(sessionId, row.intentId);
    if (current()) put(value);
  });
  const reviewAdoption = (row: CoursewareCanvasMusicView) => {
    if (disabled || row.operation !== "music-export" || !(row.asset || audio[row.intentId]?.asset)) return;
    setAdoption(null); setAdopted(null);
    return run(async current => {
      const view = await api.pptEditorTeachingOpen(sessionId);
      if (!current()) return;
      const target = view.project.pages.find(page => page.pageId === view.pageId);
      if (!target || target.locked || !view.viewId || !Number.isSafeInteger(view.pageNumber) || view.pageNumber < 1)
        throw new Error(t("panel.canvasMusic.adoptInvalid"));
      setAdoption({ scope, intentId: row.intentId, view: structuredClone(view) });
    });
  };
  const adopt = () => {
    if (disabled || !adoption || adoption.scope !== scope) return;
    const reviewed = adoption; setAdoption(null);
    return run(async current => {
      const next = await api.coursewareCanvasMusicAdopt({ sessionId, intentId: reviewed.intentId,
        viewId: reviewed.view.viewId, expectedTeachingRevision: reviewed.view.project.teachingRevision });
      if (!current()) return;
      if (next.project.projectId !== reviewed.view.project.projectId || next.pageId !== reviewed.view.pageId ||
          next.pageNumber !== reviewed.view.pageNumber) throw new Error(t("panel.canvasMusic.adoptInvalid"));
      setAdopted({ scope, pageNumber: next.pageNumber });
    });
  };
  const player = (key: string) => audio[key] && <div className="courseware-canvas-music-audio">
    <audio controls preload="none" src={audio[key].dataUrl} aria-label={t("panel.canvasMusic.audio")} />
    <button type="button" onClick={() => setPreviews(previous => {
      const next = { ...previous.values }; delete next[key]; return { ...previous, values: next };
    })}>{t("panel.canvasMusic.closeAudio")}</button>
  </div>;
  return <section className="ppt-master-scene-images courseware-canvas-music" aria-label={t("panel.canvasMusic.title")}>
    <strong>{t("panel.canvasMusic.title")}</strong><p>{t("panel.canvasMusic.hint")}</p>
    {error && <p role="alert" className="ppt-master-action-error">{error}</p>}
    {adopted?.scope === scope && <p role="status">{t("panel.canvasMusic.adopted", { page: adopted.pageNumber })}</p>}
    <div className="ppt-master-actions">
      <button type="button" disabled={busy || disabled} onClick={() => void run(async current => {
        const next = await api.coursewareCanvasMusicModels(sessionId);
        if (!current()) return;
        setModels(next); setModel(""); setExportModel(""); clearQuote();
        if (!next.generation.length) throw new Error(t("panel.canvasMusic.noModels"));
      })}>{t("panel.canvasMusic.models")}</button>
      <button type="button" disabled={busy} onClick={() => void run(async current => {
        const next = await api.coursewareCanvasMusicList(sessionId);
        if (current()) { setRows({ scope: privateScope, values: next }); clearQuote(); }
      })}>{t("panel.canvasMusic.refresh")}</button>
    </div>
    <label>{t("panel.canvasMusic.draft")}<select value={draftId} disabled={busy || disabled} onChange={event => setDraftId(event.target.value)}>
      <option value="">{t("panel.canvasMusic.choose")}</option>
      {document.drafts.filter(value => value.kind === "music").map(value => <option key={value.id} value={value.id}>{value.title}</option>)}
    </select></label>
    <label>{t("panel.canvasMusic.model")}<select value={model} disabled={busy || disabled} onChange={event => setModel(event.target.value)}>
      <option value="">{t("panel.canvasMusic.choose")}</option>
      {models.generation.map(value => <option key={value.model} value={value.model}>{value.model}</option>)}
    </select></label>
    {draft && <>
      <p>{t("panel.canvasMusic.savedTitle", { title: draft.title })}</p>
      <label>{t("panel.canvasMusic.lyrics")}<textarea readOnly rows={4} value={draft.prompt} /></label>
      <p>{t("panel.canvasMusic.editHint")}</p>
      <label>{t("panel.canvasMusic.tags")}<input value={tags} maxLength={1000} disabled={busy || disabled} onChange={event => setTags(event.target.value)} /></label>
      <label>{t("panel.canvasMusic.negativeTags")}<input value={negativeTags} maxLength={1000} disabled={busy || disabled} onChange={event => setNegativeTags(event.target.value)} /></label>
      <label className="courseware-canvas-music-check"><input type="checkbox" checked={instrumental} disabled={busy || disabled}
        onChange={event => setInstrumental(event.target.checked)} />{t("panel.canvasMusic.instrumental")}</label>
      {(draft.title.length > 100 || draft.prompt.length > 4000 || draft.references.length > 0) && <p role="status">{t("panel.canvasMusic.limits")}</p>}
    </>}
    {unknown && <p role="status">{t("panel.canvasMusic.unknown")}</p>}
    <button type="button" disabled={busy || !canPrepare} onClick={() => void prepare()}>{t("panel.canvasMusic.quote")}</button>
    <label>{t("panel.canvasMusic.exportModel")}<select value={exportModel} disabled={busy || disabled} onChange={event => setExportModel(event.target.value)}>
      <option value="">{t("panel.canvasMusic.choose")}</option>
      {models.export.map(value => <option key={value.model} value={value.model}>{value.model}</option>)}
    </select></label>
    {quoted && validQuote && <div className="ppt-master-scene-image-quote">
      <strong>{t(quoted.intent.operation === "music" ? "panel.canvasMusic.generationQuote" : "panel.canvasMusic.exportQuote")}</strong>
      <p>{t("panel.canvasMusic.cost", { model: quoted.quote.model, points: quoted.quote.maxPoints,
        expires: new Date(quoted.quote.expiresAt).toLocaleString() })}</p>
      {quoted.intent.operation === "music" ? <>
        <p>{quoted.intent.music?.title} · {quoted.intent.music?.tags} · {quoted.intent.music?.negativeTags}</p>
        <p>{t(quoted.intent.music?.instrumental ? "panel.canvasMusic.instrumental" : "panel.canvasMusic.vocal")}</p>
        <textarea readOnly rows={4} aria-label={t("panel.canvasMusic.lyrics")} value={quoted.intent.draft.prompt} />
      </> : <p>{t("panel.canvasMusic.exportCandidate", { candidate: quoted.intent.candidateId })}</p>}
      <label className="courseware-canvas-music-check"><input type="checkbox" checked={confirmed} disabled={busy || disabled}
        onChange={event => setConfirmed(event.target.checked)} />{t(quoted.intent.operation === "music" ? "panel.canvasMusic.confirm" : "panel.canvasMusic.exportConfirm")}</label>
      <button type="button" disabled={busy || disabled || !confirmed || !validQuote} onClick={() => void submit()}>
        {t(quoted.intent.operation === "music" ? "panel.canvasMusic.submit" : "panel.canvasMusic.exportSubmit")}</button>
    </div>}
    {values.filter(row => row.operation === "music").map(row => <article className="ppt-master-scene-page" key={row.intentId} data-canvas-music-intent={row.intentId}>
      <strong>{row.music?.title ?? row.draft.title} · {row.model}</strong><p>{t(`panel.canvasMusic.${row.phase}`)}</p>
      {!row.current && <p role="status">{t("panel.canvasMusic.stale")}</p>}
      <details><summary>{t("panel.canvasMusic.snapshot")}</summary>
        <p>{row.intentId} · {row.music?.tags} · {row.music?.negativeTags}</p>
        <textarea readOnly rows={4} aria-label={t("panel.canvasMusic.lyrics")} value={row.draft.prompt} />
      </details>
      {row.task && <p role="status">{t("panel.canvasMusic.task", { state: row.task.state, fee: row.task.feeState,
        reserved: row.task.reservedPoints, actual: row.task.actualPoints ?? "—" })}{row.task.errorCode ? ` · ${row.task.errorCode}` : ""}</p>}
      {row.phase === "submission-unknown" && <p role="status">{t("panel.canvasMusic.unknown")}</p>}
      <button type="button" disabled={busy || row.phase === "rejected"} onClick={() => void status(row)}>{t("panel.canvasMusic.status")}</button>
      <ol>{row.candidates.map(candidate => <li key={candidate.candidateId} data-music-candidate={candidate.candidateId}>
        <p>{t("panel.canvasMusic.candidate", { order: candidate.order + 1, state: candidate.state,
          duration: candidate.durationMs === undefined ? "—" : Math.round(candidate.durationMs / 1000) })}</p>
        <button type="button" disabled={busy || !row.previews.some(value => value.candidateId === candidate.candidateId) &&
          (row.task?.state !== "ready" || candidate.state !== "completed")}
          onClick={() => void listen(row, candidate.candidateId)}>{t("panel.canvasMusic.listen")}</button>
        {player(candidate.candidateId)}
        <button type="button" disabled={busy || disabled || !candidate.exportable || !exportModel ||
          values.some(value => value.operation === "music-export" && value.sourceIntentId === row.intentId &&
            value.candidateId === candidate.candidateId && value.phase === "submission-unknown")}
          onClick={() => void exportCandidate(row, candidate.candidateId)}>{t("panel.canvasMusic.prepareExport")}</button>
        {values.filter(value => value.operation === "music-export" && value.sourceIntentId === row.intentId && value.candidateId === candidate.candidateId).map(value =>
          <div key={value.intentId} data-music-export-intent={value.intentId}>
            <p>{t("panel.canvasMusic.exportState", { model: value.model, phase: t(`panel.canvasMusic.${value.phase}`), state: value.task?.state ?? "—" })}</p>
            {value.phase === "submission-unknown" && <p role="status">{t("panel.canvasMusic.unknown")}</p>}
            <button type="button" disabled={busy || value.phase === "rejected"} onClick={() => void status(value)}>{t("panel.canvasMusic.status")}</button>
            <button type="button" disabled={busy || !value.asset && (value.task?.state !== "ready" || value.task.feeState !== "settled")}
              onClick={() => void listen(value)}>{t("panel.canvasMusic.archive")}</button>
            {player(value.intentId)}
            <button type="button" disabled={busy || disabled || !(value.asset || audio[value.intentId]?.asset)}
              onClick={() => void reviewAdoption(value)}>{t("panel.canvasMusic.adoptReview")}</button>
            {adoption?.scope === scope && adoption.intentId === value.intentId && <div className="ppt-master-scene-image-quote">
              <p>{t("panel.canvasMusic.adoptTarget", { title: adoption.view.project.title, page: adoption.view.pageNumber })}</p>
              <p>{t("panel.canvasMusic.adoptScope")}</p>
              <button type="button" disabled={busy || disabled} onClick={() => void adopt()}>{t("panel.canvasMusic.adoptConfirm")}</button>
              <button type="button" disabled={busy} onClick={() => setAdoption(null)}>{t("panel.canvasMusic.adoptCancel")}</button>
            </div>}
          </div>)}
      </li>)}</ol>
    </article>)}
  </section>;
}
