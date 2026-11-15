import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { CoursewareCanvasImagePreview, CoursewareCanvasImageReferencePreview, CoursewareCanvasImageQuoteView, CoursewareCanvasImageView, MediaCanvasDocument, MediaCanvasDraft } from "@pi-desktop/shared";
import { api } from "../../lib/api";

const isPrivateImage = (dataUrl: string) => /^data:image\/(?:png|jpeg|webp);base64,[a-z\d+/]+={0,2}$/iu.test(dataUrl);
// Host serialization may reorder object keys; compare the exact field values instead.
const draftKey = (draft?: MediaCanvasDraft) => JSON.stringify(draft ? [draft.id, draft.revision, draft.kind, draft.title, draft.prompt,
  draft.references.map(reference => [reference.assetId, reference.revision, reference.label]), draft.x, draft.y] : null);

export function CoursewareCanvasImages({ sessionId, revision, document, disabled }: {
  sessionId: string; revision: string | null; document: MediaCanvasDocument; disabled: boolean;
}) {
  const { t } = useTranslation();
  const privateScope = JSON.stringify([sessionId, document.projectId]);
  const epoch = useRef(0), inFlight = useRef(false), activeScope = useRef("");
  const [busy, setBusy] = useState(false);
  const [models, setModels] = useState<{ model: string; supportsReferenceImage?: boolean }[]>([]);
  const [model, setModel] = useState("");
  const [draftId, setDraftId] = useState("");
  const [rows, setRows] = useState<{ scope: string; values: CoursewareCanvasImageView[] }>({ scope: privateScope, values: [] });
  const [quoted, setQuoted] = useState<{ intent: CoursewareCanvasImageView; quote: CoursewareCanvasImageQuoteView; scope: string } | null>(null);
  const [referencePreview, setReferencePreview] = useState<CoursewareCanvasImageReferencePreview | null>(null);
  const [preview, setPreview] = useState<{ scope: string; value: CoursewareCanvasImagePreview } | null>(null);
  const [comparisons, setComparisons] = useState<{ scope: string; values: CoursewareCanvasImagePreview[] }>({ scope: privateScope, values: [] });
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState("");
  const draft = document.drafts.find(value => value.id === draftId && value.kind === "image");
  const scope = JSON.stringify([sessionId, document.projectId, revision, disabled, draftId, draftKey(draft), model]);
  activeScope.current = scope;
  const visibleRows = rows.scope === privateScope ? rows.values : [];
  const visiblePreview = preview?.scope === privateScope ? preview.value : null;
  const visibleComparisons = comparisons.scope === privateScope ? comparisons.values : [];
  const clearQuote = () => { setQuoted(null); setReferencePreview(null); setConfirmed(false); };

  useEffect(() => {
    const clear = () => {
      epoch.current++; inFlight.current = false; setBusy(false);
      setModels([]); setModel(""); setDraftId(""); setRows({ scope: privateScope, values: [] }); clearQuote(); setError("");
      setPreview(null); setComparisons({ scope: privateScope, values: [] });
    };
    clear();
    const unsubscribe = api.onAuthChanged(clear);
    return () => { epoch.current++; inFlight.current = false; unsubscribe(); };
  }, [sessionId, document.projectId]);
  useEffect(() => {
    epoch.current++; inFlight.current = false; setBusy(false); clearQuote();
  }, [scope]);

  const put = (value: CoursewareCanvasImageView) => setRows(previous => ({ scope: privateScope,
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
  const unknown = visibleRows.some(row => row.draft.id === draftId && row.phase === "submission-unknown");
  const canPrepare = !disabled && revision !== null && !!draft?.prompt.trim() && draft.prompt.length <= 4000 &&
    draft.references.length <= 1 && !!model && !unknown &&
    models.some(entry => entry.model === model && (!draft.references.length || entry.supportsReferenceImage === true));
  const liveIntent = visibleRows.find(row => row.intentId === quoted?.intent.intentId);
  const reference = quoted?.intent.draft.references[0];
  const referenceReady = !!reference && !!referencePreview && referencePreview.intentId === quoted?.intent.intentId &&
    referencePreview.reference.assetId === reference.assetId && referencePreview.reference.revision === reference.revision &&
    referencePreview.reference.label === reference.label && isPrivateImage(referencePreview.dataUrl);
  const validQuote = !unknown && quoted?.scope === scope && liveIntent?.current && liveIntent.phase === "prepared" &&
    quoted.intent.current && quoted.intent.phase === "prepared" &&
    quoted.quote.intentId === quoted.intent.intentId && draftKey(quoted.intent.draft) === draftKey(draft) &&
    (!quoted.intent.draft.references.length || referenceReady) && quoted.quote.model === model &&
    Number.isFinite(Date.parse(quoted.quote.expiresAt)) && Date.parse(quoted.quote.expiresAt) > Date.now();
  const prepare = () => {
    if (!canPrepare || !draft || revision === null) return;
    clearQuote();
    return run(async current => {
      const intent = await api.coursewareCanvasImagePrepare({ sessionId, intentId: crypto.randomUUID(), draftId,
        expectedRevision: revision, expectedDraftRevision: draft.revision, model });
      if (!current()) return;
      put(intent);
      if (intent.phase !== "prepared") return;
      const quote = await api.coursewareCanvasImageQuote(sessionId, intent.intentId);
      if (!current()) return;
      if (quote.intentId !== intent.intentId || quote.model !== model) throw new Error(t("panel.canvasImages.invalidQuote"));
      const reference = intent.draft.references[0];
      if (reference) {
        const result = await api.coursewareCanvasImageReferencePreview(sessionId, intent.intentId);
        if (!current()) return;
        if (result.intentId !== intent.intentId || result.reference.assetId !== reference.assetId ||
          result.reference.revision !== reference.revision || result.reference.label !== reference.label || !isPrivateImage(result.dataUrl))
          throw new Error(t("panel.canvasImages.invalidReference"));
        setReferencePreview(result);
      }
      setQuoted({ intent, quote, scope });
    });
  };
  const submit = () => {
    if (disabled || !confirmed || !validQuote || !quoted) return;
    const saved = quoted; clearQuote();
    return run(async current => {
      // An uncertain dispatch stays status-only even when journal refresh also fails.
      put({ ...saved.intent, phase: "submission-unknown" });
      try {
        const value = await api.coursewareCanvasImageSubmitConfirmed(sessionId, saved.intent.intentId, saved.quote.quoteId);
        if (current()) put(value);
      } catch (failure) {
        if (current()) {
          try {
            const values = await api.coursewareCanvasImageList(sessionId);
            if (current()) setRows({ scope: privateScope, values });
          } catch { /* Keep the original submission failure visible; refresh recovers the journal. */ }
        }
        throw failure;
      }
    });
  };
  const checkPreview = (result: CoursewareCanvasImagePreview, row: CoursewareCanvasImageView) => {
    if (result.image.intentId !== row.intentId || result.image.model !== row.model ||
      draftKey(result.image.draft) !== draftKey(row.draft) || !result.image.asset ||
      row.asset && result.image.asset.sha256 !== row.asset.sha256 || !isPrivateImage(result.dataUrl) ||
      !result.dataUrl.startsWith(`data:${result.image.asset.mimeType};base64,`))
      throw new Error(t("panel.canvasImages.invalidPreview"));
  };
  const showPreview = (row: CoursewareCanvasImageView) => run(async current => {
    setPreview(null);
    const result = row.asset ? await api.coursewareCanvasImagePreview(sessionId, row.intentId)
      : await api.coursewareCanvasImageArchive(sessionId, row.intentId);
    if (!current()) return;
    checkPreview(result, row); put(result.image); setPreview({ scope: privateScope, value: result });
  });
  const toggleComparison = (row: CoursewareCanvasImageView) => {
    if (busy || !row.asset) return;
    if (visibleComparisons.some(value => value.image.intentId === row.intentId)) {
      setComparisons({ scope: privateScope, values: visibleComparisons.filter(value => value.image.intentId !== row.intentId) }); return;
    }
    if (visibleComparisons.length >= 2) return;
    return run(async current => {
      const result = await api.coursewareCanvasImagePreview(sessionId, row.intentId);
      if (!current()) return;
      checkPreview(result, row); put(result.image);
      setComparisons(previous => {
        const values = previous.scope === privateScope ? previous.values : [];
        return values.length >= 2 || values.some(value => value.image.intentId === row.intentId) ? previous
          : { scope: privateScope, values: [...values, result] };
      });
    });
  };

  return <section className="ppt-master-scene-images" aria-label={t("panel.canvasImages.title")}>
    <strong>{t("panel.canvasImages.title")}</strong>
    <p>{t("panel.canvasImages.hint")}</p>
    {error && <p role="alert" className="ppt-master-action-error">{error}</p>}
    <div className="ppt-master-actions">
      <button type="button" className="ppt-master-action" disabled={busy || disabled} onClick={() => void run(async current => {
        const values = await api.coursewareCanvasImageModels(sessionId);
        if (current()) {
          setModels(values); setModel(""); clearQuote();
          if (!values.length) throw new Error(t("panel.canvasImages.noModels"));
        }
      })}>{t("panel.canvasImages.models")}</button>
      <button type="button" className="ppt-master-action" disabled={busy} onClick={() => void run(async current => {
        const values = await api.coursewareCanvasImageList(sessionId);
        if (current()) { setRows({ scope: privateScope, values }); clearQuote(); }
      })}>{t("panel.canvasImages.refresh")}</button>
    </div>
    <label>{t("panel.canvasImages.draft")}
      <select value={draftId} disabled={busy || disabled} onChange={event => { setDraftId(event.target.value); clearQuote(); }}>
        <option value="">{t("panel.canvasImages.choose")}</option>
        {document.drafts.filter(value => value.kind === "image").map(value => <option key={value.id} value={value.id}>{value.title}</option>)}
      </select>
    </label>
    <label>{t("panel.canvasImages.model")}
      <select value={model} disabled={busy || disabled} onChange={event => { setModel(event.target.value); clearQuote(); }}>
        <option value="">{t("panel.canvasImages.choose")}</option>
        {models.map(value => <option key={value.model} value={value.model}>{value.model}</option>)}
      </select>
    </label>
    {draft && <details open><summary>{t("panel.canvasImages.prompt")}</summary>
      <textarea readOnly rows={4} aria-label={t("panel.canvasImages.prompt")} value={draft.prompt} />
      {draft.references.map(reference => <p key={reference.assetId}>{reference.label} · {reference.assetId} · {reference.revision}</p>)}
      {draft.references.length > 0 && <p>{t("panel.canvasImages.referenceHint")}</p>}
      {(draft.prompt.length > 4000 || draft.references.length > 1) && <p role="status">{t("panel.canvasImages.limits")}</p>}
      {draft.references.length === 1 && model && !models.some(entry => entry.model === model && entry.supportsReferenceImage === true) &&
        <p role="status">{t("panel.canvasImages.referenceUnsupported")}</p>}
    </details>}
    {unknown && <p role="status">{t("panel.canvasImages.unknown")}</p>}
    <button type="button" className="ppt-master-action" disabled={busy || !canPrepare} onClick={() => void prepare()}>{t("panel.canvasImages.quote")}</button>
    {quoted && validQuote && <div className="ppt-master-scene-image-quote">
      <p>{t("panel.canvasImages.cost", { model: quoted.quote.model, points: quoted.quote.maxPoints,
        chars: quoted.quote.maxChars, expires: new Date(quoted.quote.expiresAt).toLocaleString() })}</p>
      <textarea readOnly rows={4} aria-label={t("panel.canvasImages.prompt")} value={quoted.intent.draft.prompt} />
      {quoted.intent.draft.references.map(reference => <p key={reference.assetId}>{reference.label} · {reference.assetId} · {reference.revision}</p>)}
      {referenceReady && referencePreview && <div className="ppt-master-scene-image-preview">
        <img src={referencePreview.dataUrl} alt={t("panel.canvasImages.referencePreviewAlt")} />
        <p>{t("panel.canvasImages.referenceDisclosure", { asset: referencePreview.reference.assetId, hash: referencePreview.reference.revision })}</p>
      </div>}
      <label className="ppt-master-scene-image-confirm"><input type="checkbox" checked={confirmed} disabled={busy || disabled}
        onChange={event => setConfirmed(event.target.checked)} />{t(quoted.intent.draft.references.length ? "panel.canvasImages.confirmReference" : "panel.canvasImages.confirm")}</label>
      <button type="button" className="ppt-master-action" disabled={busy || disabled || !confirmed || !validQuote}
        onClick={() => void submit()}>{t("panel.canvasImages.submit")}</button>
    </div>}
    {visibleRows.map(row => <div className="ppt-master-scene-page" key={row.intentId} data-canvas-image-intent={row.intentId}>
      <p>{row.draft.title} · {row.model} · {t(`panel.canvasImages.${row.phase}`)}</p>
      {!row.current && <p role="status">{t("panel.canvasImages.stale")}</p>}
      {row.phase === "submission-unknown" && <p role="status">{t("panel.canvasImages.unknown")}</p>}
      <details><summary>{t("panel.canvasImages.snapshot")}</summary>
        <p>{t("panel.canvasImages.identity", { intent: row.intentId, draft: row.draft.id, revision: row.draft.revision })}</p>
        <textarea readOnly rows={4} aria-label={t("panel.canvasImages.prompt")} value={row.draft.prompt} />
        {row.draft.references.map(reference => <p key={reference.assetId}>{reference.label} · {reference.assetId} · {reference.revision}</p>)}
      </details>
      {row.task && <p role="status">{t("panel.canvasImages.task", { state: row.task.state, fee: row.task.feeState,
        reserved: row.task.reservedPoints, actual: row.task.actualPoints ?? "—" })}{row.task.errorCode ? ` · ${row.task.errorCode}` : ""}</p>}
      <button type="button" className="ppt-master-action" disabled={busy || row.phase === "rejected"} onClick={() => void run(async current => {
        const value = await api.coursewareCanvasImageStatus(sessionId, row.intentId); if (current()) put(value);
      })}>{t("panel.canvasImages.status")}</button>
      {(row.asset || row.phase === "submitted") && <button type="button" className="ppt-master-action"
        disabled={busy || !row.asset && (row.task?.state !== "ready" || row.task.feeState !== "settled")}
        onClick={() => void showPreview(row)}>{t(row.asset ? "panel.canvasImages.preview" : "panel.canvasImages.archive")}</button>}
      {row.asset && <button type="button" className="ppt-master-action" disabled={busy}
        onClick={() => void run(async current => {
          setPreview(null);
          const result = await api.coursewareCanvasImageRestore(sessionId, row.intentId);
          if (!current()) return;
          checkPreview(result, row); put(result.image); setPreview({ scope: privateScope, value: result });
        })}>{t("panel.canvasImages.restore")}</button>}
      {row.phase === "submitted" && !row.asset && <p>{t("panel.canvasImages.archiveWait")}</p>}
      {row.asset && <label className="ppt-master-scene-image-confirm"><input type="checkbox"
        checked={visibleComparisons.some(value => value.image.intentId === row.intentId)}
        disabled={busy || visibleComparisons.length >= 2 && !visibleComparisons.some(value => value.image.intentId === row.intentId)}
        onChange={() => void toggleComparison(row)} />{t("panel.canvasImages.compareCandidate", { title: row.draft.title })}</label>}
      {visiblePreview?.image.intentId === row.intentId && <div className="ppt-master-scene-image-preview">
        <img src={visiblePreview.dataUrl} alt={t("panel.canvasImages.previewAlt", { title: visiblePreview.image.draft.title })} />
        <p>{t("panel.canvasImages.assetDetails", visiblePreview.image.asset!)}</p>
        <button type="button" className="ppt-master-action" onClick={() => setPreview(null)}>{t("panel.canvasImages.closePreview")}</button>
      </div>}
    </div>)}
    {visibleComparisons.length > 0 && <section aria-label={t("panel.canvasImages.comparison")}>
      <strong>{t("panel.canvasImages.comparison")}</strong>
      <p>{t("panel.canvasImages.comparisonHint")}</p>
      <div className="ppt-master-actions">{visibleComparisons.map(value => <article key={value.image.intentId}
        className="ppt-master-scene-image-preview" style={{ flex: "1 1 0" }} data-canvas-image-comparison={value.image.intentId}>
        <strong>{value.image.draft.title} · {value.image.model}</strong>
        <img src={value.dataUrl} alt={t("panel.canvasImages.previewAlt", { title: value.image.draft.title })} />
        <p>{t("panel.canvasImages.identity", { intent: value.image.intentId, draft: value.image.draft.id, revision: value.image.draft.revision })}</p>
        <textarea readOnly rows={4} aria-label={t("panel.canvasImages.prompt")} value={value.image.draft.prompt} />
        {value.image.draft.references.map(reference => <p key={reference.assetId}>{reference.label} · {reference.assetId} · {reference.revision}</p>)}
        <p>{t("panel.canvasImages.assetDetails", value.image.asset!)}</p>
        <button type="button" className="ppt-master-action" disabled={busy} onClick={() => void toggleComparison(value.image)}>
          {t("panel.canvasImages.removeComparison", { title: value.image.draft.title })}</button>
      </article>)}</div>
    </section>}
  </section>;
}
