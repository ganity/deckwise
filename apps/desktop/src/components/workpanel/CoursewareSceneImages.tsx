import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { CoursewareSceneImageQuoteView, CoursewareSceneImageView, CoursewareSceneImagePreview, CoursewareScenePlanSnapshot, CoursewareSceneImageTarget } from "@pi-desktop/shared";
import { api } from "../../lib/api";

export function CoursewareSceneImages({ sessionId, plan, enabled, onActiveChange, onGenerated }: {
  sessionId: string; plan: CoursewareScenePlanSnapshot; enabled: boolean; onActiveChange: (busy: boolean) => void;
  onGenerated: (path: string) => void;
}) {
  const { t } = useTranslation();
  const epoch = useRef(0), inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const [models, setModels] = useState<{ model: string; supportsReferenceImage?: boolean }[]>([]);
  const [model, setModel] = useState("");
  const [pageId, setPageId] = useState("");
  const [kind, setKind] = useState<CoursewareSceneImageTarget["kind"]>("visualMaster");
  const [layerName, setLayerName] = useState("");
  const [instructions, setInstructions] = useState("");
  const [rows, setRows] = useState<CoursewareSceneImageView[]>([]);
  const [quoted, setQuoted] = useState<{ intent: CoursewareSceneImageView; quote: CoursewareSceneImageQuoteView } | null>(null);
  const [referencePreview, setReferencePreview] = useState<CoursewareSceneImagePreview | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<CoursewareSceneImagePreview | null>(null);
  const [reviewed, setReviewed] = useState(false);
  const [generating, setGenerating] = useState(false);

  useEffect(() => {
    const reset = () => {
      epoch.current++; inFlight.current = false;
      setBusy(false); onActiveChange(false); setModels([]); setModel(""); setPageId("");
      setRows([]); setQuoted(null); setReferencePreview(null); setConfirmed(false); setError(null);
      setPreview(null); setReviewed(false);
      setGenerating(false);
      setKind("visualMaster"); setLayerName(""); setInstructions("");
    };
    reset();
    const unsubscribe = api.onAuthChanged(reset);
    return () => { epoch.current++; inFlight.current = false; onActiveChange(false); unsubscribe(); };
  }, [sessionId, plan.sha256, enabled, onActiveChange]);

  const put = (value: CoursewareSceneImageView) => setRows((current) =>
    [...current.filter((row) => row.intentId !== value.intentId), value]);
  const run = async (operation: (current: () => boolean) => Promise<void>) => {
    if (inFlight.current) return;
    const request = epoch.current;
    const current = () => request === epoch.current;
    inFlight.current = true; setBusy(true); onActiveChange(true); setError(null);
    try { await operation(current); }
    catch (failure) { if (current()) setError(String(failure)); }
    finally { if (current()) { inFlight.current = false; setBusy(false); onActiveChange(false); } }
  };
  const clearQuote = () => { setQuoted(null); setReferencePreview(null); setConfirmed(false); };
  const reference = rows.find(row => row.current && row.selected && row.planSha256 === plan.sha256 &&
    row.pageId === pageId && row.target.kind === "visualMaster" && row.asset);
  const referenceReady = !!reference?.asset && ["image/png", "image/jpeg"].includes(reference.asset.mimeType);
  const supported = models.some(entry => entry.model === model && entry.supportsReferenceImage === true);
  const loadModels = () => run(async current => {
    const values = await api.coursewareSceneImageModels(sessionId);
    if (!current()) return;
    setModels(values); setModel(""); clearQuote();
    if (!values.length) throw new Error(t("panel.sceneImages.noModels"));
  });
  const quote = () => run(async current => {
    clearQuote();
    const target: CoursewareSceneImageTarget = kind === "layer" ? { kind, name: layerName.trim() } : { kind };
    if (kind !== "visualMaster" && (!referenceReady || !supported)) throw new Error(t("panel.sceneImages.referenceRequired"));
    const intent = await api.coursewareSceneImagePrepare(sessionId, plan.sha256, pageId, model, target, instructions,
      kind === "visualMaster" ? undefined : reference!.intentId);
    if (!current()) return;
    put(intent);
    if (intent.phase !== "prepared") return;
    const price = await api.coursewareSceneImageQuote(sessionId, intent.intentId);
    if (!current()) return;
    if (intent.referenceImage) {
      const preview = await api.coursewareSceneImagePreview(sessionId, intent.referenceImage.intentId);
      if (!current()) return;
      if (!preview.image.current || !preview.image.selected || preview.image.asset?.sha256 !== intent.referenceImage.sha256)
        throw new Error(t("panel.sceneImages.referenceRequired"));
      setReferencePreview(preview);
    }
    setQuoted({ intent, quote: price });
  });
  const submit = () => {
    if (!enabled || !confirmed || !quoted || quoted.intent.pageId !== pageId || quoted.quote.model !== model ||
        quoted.intent.target.kind !== kind || (quoted.intent.target.kind === "layer" && quoted.intent.target.name !== layerName.trim()) ||
        (kind !== "visualMaster" && (!quoted.intent.referenceImage || !referencePreview ||
          reference?.intentId !== quoted.intent.referenceImage.intentId || reference?.asset?.sha256 !== quoted.intent.referenceImage.sha256)) ||
        Date.parse(quoted.quote.expiresAt) <= Date.now()) return;
    const saved = quoted; clearQuote();
    return run(async current => {
      try {
        const result = await api.coursewareSceneImageSubmitConfirmed(sessionId, saved.intent.intentId, saved.quote.quoteId);
        if (current()) put(result);
      } catch (failure) {
        if (current()) {
          try { const values = await api.coursewareSceneImageList(sessionId); if (current()) setRows(values); }
          catch { /* Keep the paid failure visible; explicit refresh can recover the journal. */ }
        }
        throw failure;
      }
    });
  };

  return <section className="ppt-master-scene-images" aria-label={t("panel.sceneImages.title")}>
    <strong>{t("panel.sceneImages.title")}</strong>
    <p>{t("panel.sceneImages.hint")}</p>
    {error ? <p className="ppt-master-action-error" role="alert">{error}</p> : null}
    <div className="ppt-master-actions">
      <button type="button" className="ppt-master-action" disabled={busy || !enabled} onClick={() => void loadModels()}>{t("panel.sceneImages.models")}</button>
      <button type="button" className="ppt-master-action" disabled={busy} onClick={() => void run(async current => {
        const values = await api.coursewareSceneImageList(sessionId); if (current()) {
          setRows(values); clearQuote(); setPreview(null); setReviewed(false);
        }
      })}>{t("panel.sceneImages.refresh")}</button>
    </div>
    <label>{t("panel.sceneImages.page")}
      <select value={pageId} disabled={busy || !enabled} onChange={event => { setPageId(event.target.value); clearQuote(); }}>
        <option value="">{t("panel.sceneImages.choose")}</option>
        {plan.pages.map((page, index) => <option key={page.pageId} value={page.pageId}>{index + 1}. {page.title}</option>)}
      </select>
    </label>
    <label>{t("panel.sceneImages.model")}
      <select value={model} disabled={busy || !enabled} onChange={event => { setModel(event.target.value); clearQuote(); }}>
        <option value="">{t("panel.sceneImages.choose")}</option>
        {models.map(entry => <option key={entry.model} value={entry.model}>{entry.model}</option>)}
      </select>
    </label>
    <label>{t("panel.sceneImages.target")}
      <select value={kind} disabled={busy || !enabled} onChange={event => {
        const value = event.target.value;
        if (value === "visualMaster" || value === "cleanPlate" || value === "layer") { setKind(value); clearQuote(); }
      }}>
        {["visualMaster", "cleanPlate", "layer"].map(value => <option key={value} value={value}>{t(`panel.sceneImages.${value}`)}</option>)}
      </select>
    </label>
    {kind === "layer" ? <label>{t("panel.sceneImages.layerName")}
      <input value={layerName} maxLength={80} disabled={busy || !enabled} onChange={event => { setLayerName(event.target.value); clearQuote(); }} />
    </label> : null}
    <label>{t("panel.sceneImages.instructions")}
      <textarea value={instructions} maxLength={1200} rows={3} disabled={busy || !enabled}
        onChange={event => { setInstructions(event.target.value); clearQuote(); }} />
    </label>
    {kind !== "visualMaster" ? <p role="status">{t(supported && referenceReady ? "panel.sceneImages.referenceSelected" : "panel.sceneImages.referenceRequired",
      { intent: reference?.intentId ?? "", sha256: reference?.asset?.sha256 ?? "" })}</p> : null}
    <button type="button" className="ppt-master-action" disabled={busy || !enabled || !model || !pageId || (kind === "layer" && !layerName.trim()) ||
      (kind !== "visualMaster" && (!referenceReady || !supported))}
      onClick={() => void quote()}>{t("panel.sceneImages.quote")}</button>
    {quoted ? <div className="ppt-master-scene-image-quote">
      <p>{t("panel.sceneImages.cost", { points: quoted.quote.maxPoints, expires: new Date(quoted.quote.expiresAt).toLocaleString() })}</p>
      <details><summary>{t("panel.sceneImages.prompt")}</summary><p>{quoted.intent.prompt}</p></details>
      {quoted.intent.referenceImage && referencePreview ? <div className="ppt-master-scene-image-preview">
        <img src={referencePreview.dataUrl} alt={t("panel.sceneImages.referenceAlt")} />
        <p>{t("panel.sceneImages.referenceDisclosure", { intent: quoted.intent.referenceImage.intentId, sha256: quoted.intent.referenceImage.sha256 })}</p>
      </div> : null}
      <label className="ppt-master-scene-image-confirm"><input type="checkbox" checked={confirmed} disabled={busy || !enabled}
        onChange={event => setConfirmed(event.target.checked)} />{t(quoted.intent.referenceImage ? "panel.sceneImages.confirmReference" : "panel.sceneImages.confirm")}</label>
      <button type="button" className="ppt-master-action" disabled={busy || !enabled || !confirmed || Date.parse(quoted.quote.expiresAt) <= Date.now()}
        onClick={() => void submit()}>{t("panel.sceneImages.submit")}</button>
    </div> : null}
    <p>{t("panel.sceneImages.generateHint")}</p>
    {!plan.pages.every(page => ["visualMaster", "cleanPlate", "layer"].every(kind => rows.some(row => row.current && row.selected &&
      row.planSha256 === plan.sha256 && row.pageId === page.pageId && row.target.kind === kind && row.asset))) ?
      <p role="status">{t("panel.sceneImages.generateMissing")}</p> : null}
    <button type="button" className="ppt-master-action primary" disabled={busy || !enabled || !plan.pages.every(page =>
      ["visualMaster", "cleanPlate", "layer"].every(kind => rows.some(row => row.current && row.selected && row.planSha256 === plan.sha256 &&
        row.pageId === page.pageId && row.target.kind === kind && row.asset)))} onClick={() => void run(async current => {
          setGenerating(true);
          try { const result = await api.coursewareSceneGenerate(sessionId, plan.sha256); if (current()) onGenerated(result.path); }
          finally { if (current()) setGenerating(false); }
        })}>{t(generating ? "panel.sceneImages.generating" : "panel.sceneImages.generate")}</button>
    {generating ? <button type="button" className="ppt-master-action" onClick={() => {
      const request = epoch.current;
      void api.coursewareSceneGenerateCancel(sessionId).catch(failure => { if (request === epoch.current) setError(String(failure)); });
    }}>{t("panel.sceneImages.cancelGenerate")}</button> : null}
    {rows.map(row => <div className="ppt-master-scene-page" key={row.intentId} data-scene-image-intent={row.intentId}>
      <p>{plan.pages.find(p => p.pageId === row.pageId)?.title ?? row.pageId} · {t(`panel.sceneImages.${row.target.kind}`)}{row.target.kind === "layer" ? ` · ${row.target.name}` : ""} · {row.model} · {t(`panel.sceneImages.${row.phase}`)}</p>
      {!row.current ? <p role="status">{t("panel.sceneImages.stale")}</p> : null}
      {row.selected ? <p role="status">{t(row.target.kind === "visualMaster" ? "panel.sceneImages.selected" : "panel.sceneImages.assetSelected")}</p> : null}
      {row.task ? <p role="status">{t("panel.sceneImages.task", { state: row.task.state, fee: row.task.feeState,
        reserved: row.task.reservedPoints, actual: row.task.actualPoints ?? "—" })}{row.task.errorCode ? ` · ${row.task.errorCode}` : ""}</p> : null}
      <div className="ppt-master-actions">
      <button type="button" className="ppt-master-action" disabled={busy || row.phase === "rejected"} onClick={() => void run(async current => {
        const result = await api.coursewareSceneImageStatus(sessionId, row.intentId); if (current()) put(result);
      })}>{t("panel.sceneImages.status")}</button>
      {row.asset || (row.task?.state === "ready" && row.task.feeState === "settled") ?
        <button type="button" className="ppt-master-action" disabled={busy} onClick={() => void run(async current => {
          setPreview(null); setReviewed(false);
          const result = row.asset ? await api.coursewareSceneImagePreview(sessionId, row.intentId)
            : await api.coursewareSceneImageArchive(sessionId, row.intentId);
          if (current()) { put(result.image); setPreview(result); }
        })}>{t(row.asset ? "panel.sceneImages.preview" : "panel.sceneImages.archive")}</button> : null}
      </div>
      {preview?.image.intentId === row.intentId ? <div className="ppt-master-scene-image-preview">
        <img src={preview.dataUrl} alt={t("panel.sceneImages.previewAlt", { page: plan.pages.find(p => p.pageId === row.pageId)?.title ?? row.pageId })} />
        <p>{t("panel.sceneImages.archiveHint")}</p>
        {row.target.kind !== "visualMaster" ? <p>{t(`panel.sceneImages.${row.target.kind}Review`)}</p> : null}
        {!row.selected && row.current ? <>
          <label className="ppt-master-scene-image-confirm"><input type="checkbox" checked={reviewed} disabled={busy || !enabled}
            onChange={event => setReviewed(event.target.checked)} />{t("panel.sceneImages.review")}</label>
          <button type="button" className="ppt-master-action" disabled={busy || !enabled || !reviewed}
            onClick={() => void run(async current => {
              const selected = rows.find(other => other.selected && other.planSha256 === row.planSha256 && other.pageId === row.pageId &&
                other.target.kind === row.target.kind && (row.target.kind !== "layer" ||
                  (other.target.kind === "layer" && other.target.name === row.target.name)));
              const values = await api.coursewareSceneImageAdopt(sessionId, row.intentId, selected?.intentId ?? null);
              if (current()) { setRows(values); clearQuote(); setPreview(null); setReviewed(false); }
            })}>{t(row.target.kind === "visualMaster" ? "panel.sceneImages.adopt" : "panel.sceneImages.assetAdopt")}</button>
        </> : null}
      </div> : null}
    </div>)}
  </section>;
}
