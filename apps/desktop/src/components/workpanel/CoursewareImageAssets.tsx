import { useEffect, useRef, useState } from "react";
import type { CoursewareCanvasImageView, CoursewareImageReviewView } from "@pi-desktop/shared";
import { useTranslation } from "react-i18next";
import { api } from "../../lib/api";

export function CoursewareImageAssets({ sessionId, enabled, onActiveChange }: {
  sessionId?: string; enabled: boolean; onActiveChange(active: boolean): void;
}) {
  const { t } = useTranslation();
  const [source, setSource] = useState<"team" | "canvas">("team");
  const [projectId, setProjectId] = useState("");
  const [assetId, setAssetId] = useState("");
  const [candidates, setCandidates] = useState<CoursewareCanvasImageView[]>([]);
  const [intentId, setIntentId] = useState("");
  const [operation, setOperation] = useState<"replace" | "insert">("replace");
  const [review, setReview] = useState<CoursewareImageReviewView | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [approved, setApproved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const sequence = useRef(0), inFlight = useRef(false);
  const active = useRef(onActiveChange); active.current = onActiveChange;
  const scope = JSON.stringify([sessionId, enabled, source, projectId, assetId, intentId, operation]);
  const latest = useRef(scope); latest.current = scope;
  const clear = () => {
    sequence.current++; inFlight.current = false;
    setReview(null); setConfirmed(false); setApproved(false); setBusy(false); setError(""); active.current(false);
    void api.pptEditorImageClear().catch(() => {});
  };
  useEffect(() => {
    const reset = () => {
      clear(); setSource("team"); setProjectId(""); setAssetId(""); setCandidates([]); setIntentId(""); setOperation("replace");
    };
    reset();
    const unsubscribe = api.onAuthChanged(reset);
    return () => { sequence.current++; inFlight.current = false; unsubscribe(); active.current(false); void api.pptEditorImageClear().catch(() => {}); };
  }, [sessionId]);
  useEffect(clear, [enabled]);
  const run = async (operation: () => Promise<() => void>) => {
    if (!enabled || !sessionId || inFlight.current) return;
    const id = ++sequence.current;
    inFlight.current = true; setBusy(true); setError(""); active.current(true);
    const current = () => id === sequence.current && latest.current === scope;
    try { const apply = await operation(); if (current()) apply(); }
    catch (failure) { if (current()) setError(String(failure)); }
    finally { if (current()) { inFlight.current = false; setBusy(false); active.current(false); } }
  };
  const candidate = candidates.find(value => value.intentId === intentId && value.asset);
  const canPreview = enabled && !!sessionId && !busy && (source === "team" ? !!projectId.trim() && !!assetId.trim() : !!candidate);
  return <section className="courseware-image-assets" aria-label={t("panel.pptEditor.imageTitle")} aria-busy={busy}>
    <strong>{t("panel.pptEditor.imageTitle")}</strong>
    <label>{t("panel.pptEditor.imageSource")}<select value={source} disabled={!enabled || busy} onChange={event => {
      const value = event.target.value;
      if (value === "team" || value === "canvas") { clear(); setSource(value); }
    }}>
      <option value="team">{t("panel.pptEditor.imageSourceTeam")}</option>
      <option value="canvas">{t("panel.pptEditor.imageSourceCanvas")}</option>
    </select></label>
    {source === "canvas" && <>
      <button type="button" disabled={!enabled || !sessionId || busy} onClick={() => {
        clear();
        void run(async () => {
          const values = await api.coursewareCanvasImageList(sessionId!);
          return () => { setCandidates(values.filter(value => value.asset)); setIntentId(""); };
        });
      }}>{t("panel.pptEditor.imageCanvasRefresh")}</button>
      <label>{t("panel.pptEditor.imageCanvasCandidate")}<select value={intentId} disabled={!enabled || busy} onChange={event => {
        clear(); setIntentId(event.target.value);
      }}>
        <option value="">{t("panel.pptEditor.imageCanvasChoose")}</option>
        {candidates.map(value => <option key={value.intentId} value={value.intentId}>{value.draft.title} · {value.intentId}</option>)}
      </select></label>
      <label>{t("panel.pptEditor.imageCanvasOperation")}<select value={operation} disabled={!enabled || busy} onChange={event => {
        const value = event.target.value;
        if (value === "replace" || value === "insert") { clear(); setOperation(value); }
      }}>
        <option value="replace">{t("panel.pptEditor.imageCanvasReplace")}</option>
        <option value="insert">{t("panel.pptEditor.imageCanvasInsert")}</option>
      </select></label>
      {candidate && <div>
        <strong>{candidate.draft.title}</strong>
        <pre>{candidate.draft.prompt}</pre>
        <p>{candidate.model} · {candidate.asset!.width} × {candidate.asset!.height}</p>
      </div>}
      <p>{t("panel.pptEditor.imageCanvasHint")}</p>
    </>}
    <form onSubmit={event => {
      event.preventDefault();
      if (!canPreview) return;
      void run(async () => {
        setReview(null); setConfirmed(false); setApproved(false);
        const next = source === "canvas"
          ? await api.pptEditorCanvasImagePrepare(sessionId!, intentId, operation)
          : await api.pptEditorImagePrepare(sessionId!, projectId.trim(), assetId.trim());
        if (source === "canvas" && (!next.target || next.target.operation !== operation || !Number.isSafeInteger(next.target.page) || next.target.page < 1))
          throw new Error(t("panel.pptEditor.imageCanvasTargetRequired"));
        return () => setReview(next);
      });
    }}>
      {source === "team" && <>
        <label>{t("panel.pptEditor.imageProject")}<input value={projectId} disabled={!enabled || busy} onChange={event => {
          clear(); setProjectId(event.target.value);
        }} /></label>
        <label>{t("panel.pptEditor.imageAsset")}<input value={assetId} disabled={!enabled || busy} onChange={event => {
          clear(); setAssetId(event.target.value);
        }} /></label>
      </>}
      <button type="submit" disabled={!canPreview}>{t("panel.pptEditor.imagePreview")}</button>
    </form>
    {review && <>
      <img src={review.preview} alt={t(source === "canvas" ? "panel.pptEditor.imageCanvasPreviewAlt" : "panel.pptEditor.imagePreviewAlt")} />
      <p>{review.asset.width} × {review.asset.height} · {Math.ceil(review.asset.byteLength / 1024)} KB</p>
      {source === "canvas" && review.target && <p>{t("panel.pptEditor.imageCanvasTarget", { page: review.target.page,
        operation: t(review.target.operation === "replace" ? "panel.pptEditor.imageCanvasReplace" : "panel.pptEditor.imageCanvasInsert") })}</p>}
      <label><input type="checkbox" checked={confirmed} disabled={!enabled || busy || approved} onChange={event => setConfirmed(event.target.checked)} />{t("panel.pptEditor.imageConfirm")}</label>
      <button type="button" disabled={!enabled || busy || !confirmed || approved} onClick={() => {
        if (!confirmed || approved) return;
        void run(async () => {
          await api.pptEditorImageApprove(review.reviewId);
          return () => setApproved(true);
        });
      }}>{t("panel.pptEditor.imageApprove")}</button>
      {approved && <p role="status">{t(source === "canvas" ? "panel.pptEditor.imageCanvasApproved" : "panel.pptEditor.imageApproved", { assetId: review.asset.assetId })}</p>}
    </>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
