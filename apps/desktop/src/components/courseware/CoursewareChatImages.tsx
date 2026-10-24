import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { sceneAssetBlockers, type CoursewareSceneImagePreview, type CoursewareSceneImageQuoteView,
  type CoursewareSceneImageView, type CoursewareScenePlanSnapshot } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";

export function CoursewareChatImages({ sessionId, plan, disabled, refreshKey = 0, onContinue }: {
  sessionId: string; plan: CoursewareScenePlanSnapshot; disabled: boolean; refreshKey?: number; onContinue: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<CoursewareSceneImageView[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [quote, setQuote] = useState<{ image: CoursewareSceneImageView; value: CoursewareSceneImageQuoteView; reference?: CoursewareSceneImagePreview } | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [preview, setPreview] = useState<CoursewareSceneImagePreview | null>(null);
  const [reviewed, setReviewed] = useState(false);
  const [authRevision, setAuthRevision] = useState(0);
  const active = useRef(true), working = useRef(false), generation = useRef(0);
  useEffect(() => {
    active.current = true;
    const reset = () => { generation.current++; setRows([]); setQuote(null); setPreview(null); setConfirmed(false); setReviewed(false); setAuthRevision(value => value + 1); };
    const unsubscribe = api.onAuthChanged(reset);
    return () => { active.current = false; generation.current++; unsubscribe(); };
  }, []);
  useEffect(() => {
    let disposed = false;
    const epoch = generation.current;
    if (!disabled) void api.coursewareSceneImageList(sessionId).then(values => {
      if (!disposed && epoch === generation.current) { setRows(values); setError(""); }
    }).catch(failure => { if (!disposed && epoch === generation.current) setError(String(failure)); });
    return () => { disposed = true; };
  }, [sessionId, plan.sha256, disabled, refreshKey, authRevision]);
  const run = async (operation: (current: () => boolean) => Promise<void>) => {
    if (working.current || disabled || useAppStore.getState().runningSessions[sessionId]) return;
    const epoch = generation.current;
    const current = () => active.current && generation.current === epoch && useAppStore.getState().activeSessionId === sessionId;
    if (!current()) return;
    working.current = true; setBusy(true); setError("");
    try { await operation(current); }
    catch (failure) { if (current()) setError(String(failure)); }
    finally { working.current = false; if (active.current) setBusy(false); }
  };
  const blockers = sceneAssetBlockers(plan, rows);
  const blocked = disabled || busy;
  return <div className="courseware-chat-images">
    <p role="status">{t(blockers.length ? "coursewareWorkflow.assetHint" : "coursewareWorkflow.readyToBuild")}</p>
    {error && <p role="alert" className="courseware-workflow-error">{error}</p>}
    {blockers.length > 0 && <details><summary>{t("coursewareWorkflow.missing", { count: blockers.length })}</summary>
      <ul>{blockers.map((item, i) => <li key={`${item.pageId}-${item.kind}-${i}`}>{plan.pages.find(page => page.pageId === item.pageId)?.title} · {t(`coursewareWorkflow.${item.kind}`)}</li>)}</ul>
    </details>}
    {rows.filter(row => row.current && row.planSha256 === plan.sha256).map(row => <div className="courseware-chat-image-row" key={row.intentId}>
      <span>{plan.pages.find(page => page.pageId === row.pageId)?.title} · {t(`coursewareWorkflow.${row.target.kind}`)}{row.target.kind === "layer" ? ` · ${row.target.name}` : ""}
        {row.selected ? ` · ${t("coursewareWorkflow.selected")}` : ""}</span>
      {row.phase === "prepared" && <button type="button" disabled={blocked} onClick={() => void run(async current => {
        setQuote(null); setConfirmed(false); setPreview(null); setReviewed(false);
        const value = await api.coursewareSceneImageQuote(sessionId, row.intentId);
        if (!current()) return;
        const reference = row.referenceImage ? await api.coursewareSceneImagePreview(sessionId, row.referenceImage.intentId) : undefined;
        if (!current()) return;
        if (reference && (!reference.image.current || !reference.image.selected || reference.image.asset?.sha256 !== row.referenceImage?.sha256))
          throw new Error(t("coursewareWorkflow.planChanged"));
        setQuote({ image: row, value, reference });
      })}>{t("coursewareWorkflow.quote")}</button>}
      {row.phase !== "prepared" && <button type="button" disabled={blocked} onClick={() => void run(async current => {
        setPreview(null); setReviewed(false); setQuote(null); setConfirmed(false);
        const value = await api.coursewareSceneImageStatus(sessionId, row.intentId);
        if (!current()) return;
        setRows(values => values.map(item => item.intentId === row.intentId ? value : item));
        if (value.asset || value.task?.state === "ready") {
          const next = value.asset ? await api.coursewareSceneImagePreview(sessionId, row.intentId) : await api.coursewareSceneImageArchive(sessionId, row.intentId);
          if (current()) setPreview(next);
        }
      })}>{t("coursewareWorkflow.inspect")}</button>}
    </div>)}
    {quote && <div className="courseware-chat-approval">
      <p>{t("coursewareWorkflow.cost", { points: quote.value.maxPoints, model: quote.value.model, expires: new Date(quote.value.expiresAt).toLocaleString() })}</p>
      <details><summary>{t("coursewareWorkflow.prompt")}</summary><p>{quote.image.prompt}</p></details>
      {quote.reference && <><img src={quote.reference.dataUrl} alt={t("coursewareWorkflow.referenceAlt")} /><p>{t("coursewareWorkflow.referenceDisclosure")}</p></>}
      <label><input type="checkbox" checked={confirmed} disabled={blocked} onChange={event => setConfirmed(event.target.checked)} />{t("coursewareWorkflow.confirmCost")}</label>
      <button type="button" disabled={blocked || !confirmed || Date.parse(quote.value.expiresAt) <= Date.now()} onClick={() => void run(async current => {
        const saved = quote; setQuote(null); setConfirmed(false);
        try {
          const value = await api.coursewareSceneImageSubmitConfirmed(sessionId, saved.image.intentId, saved.value.quoteId);
          if (current()) setRows(values => values.map(item => item.intentId === value.intentId ? value : item));
        } catch (failure) {
          const values = await api.coursewareSceneImageList(sessionId);
          if (current()) setRows(values);
          throw failure;
        }
      })}>{t("coursewareWorkflow.submitImage")}</button>
    </div>}
    {preview && <div className="courseware-chat-approval">
      <img src={preview.dataUrl} alt={t("coursewareWorkflow.previewAlt")} />
      {!preview.image.selected && <>
        <label><input type="checkbox" checked={reviewed} disabled={blocked} onChange={event => setReviewed(event.target.checked)} />{t("coursewareWorkflow.confirmSelection")}</label>
        <button type="button" disabled={blocked || !reviewed || !preview.image.current} onClick={() => void run(async current => {
          const target = preview.image.target;
          const previous = rows.find(row => row.current && row.selected && row.pageId === preview.image.pageId && row.target.kind === target.kind &&
            (target.kind !== "layer" || row.target.kind === "layer" && row.target.name === target.name));
          const values = await api.coursewareSceneImageAdopt(sessionId, preview.image.intentId, previous?.intentId ?? null);
          if (!current()) return;
          setRows(values); setPreview(null); setReviewed(false);
          await onContinue();
        })}>{t("coursewareWorkflow.selectContinue")}</button>
      </>}
    </div>}
  </div>;
}
