import { useEffect, useRef, useState } from "react";
import type { CoursewareSourceVisualReview } from "@pi-desktop/shared";
import { useTranslation } from "react-i18next";
import { api } from "../../lib/api";

export function CoursewareSourceVisuals({ sessionId, enabled, onActiveChange }: {
  sessionId?: string; enabled: boolean; onActiveChange(active: boolean): void;
}) {
  const { t } = useTranslation();
  const [review, setReview] = useState<CoursewareSourceVisualReview | null>(null);
  const [confirmed, setConfirmed] = useState(false), [approved, setApproved] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const sequence = useRef(0), active = useRef(onActiveChange);
  active.current = onActiveChange;
  const latest = useRef({ sessionId, enabled }); latest.current = { sessionId, enabled };
  const clear = () => {
    sequence.current++; setReview(null); setConfirmed(false); setApproved(false); setBusy(false); setError("");
    active.current(false); void api.pptEditorVisualClear().catch(() => {});
  };
  useEffect(() => {
    clear();
    return () => { sequence.current++; active.current(false); void api.pptEditorVisualClear().catch(() => {}); };
  }, [sessionId, enabled]);
  const run = async (operation: () => Promise<() => void>) => {
    if (!enabled || !sessionId || busy) return;
    const id = ++sequence.current; setBusy(true); setError(""); active.current(true);
    const current = () => id === sequence.current && latest.current.enabled && latest.current.sessionId === sessionId;
    try { const apply = await operation(); if (current()) apply(); }
    catch (failure) { if (current()) { setReview(null); setConfirmed(false); setApproved(false); setError(String(failure)); } }
    finally { if (current()) { setBusy(false); active.current(false); } }
  };
  return <section className="courseware-source-visuals" aria-label={t("panel.pptEditor.visualTitle")} aria-busy={busy}>
    <strong>{t("panel.pptEditor.visualTitle")}</strong>
    <p>{t("panel.pptEditor.visualScope")}</p>
    <button type="button" disabled={!enabled || !sessionId || busy} onClick={() => void run(async () => {
      setReview(null); setConfirmed(false); setApproved(false);
      const next = await api.pptEditorVisualPrepare(sessionId!);
      return () => setReview(next);
    })}>{t(busy ? "panel.pptEditor.visualPreparing" : "panel.pptEditor.visualPrepare")}</button>
    {(busy || review) && <button type="button" onClick={clear}>{t("panel.pptEditor.visualClear")}</button>}
    {review && <>
      <p>{t("panel.pptEditor.teachingPage", { page: review.pageNumber })}</p>
      <figure><figcaption>{t("panel.pptEditor.visualOriginal")}</figcaption><img src={review.original.preview} alt={t("panel.pptEditor.visualOriginal")} /></figure>
      <figure><figcaption>{t("panel.pptEditor.visualTextless")}</figcaption><img src={review.nativeTextless.preview} alt={t("panel.pptEditor.visualTextless")} /></figure>
      <p>{t("panel.pptEditor.visualWarning")}</p>
      <label><input type="checkbox" checked={confirmed} disabled={!enabled || busy || approved} onChange={event => setConfirmed(event.target.checked)} />{t("panel.pptEditor.visualConfirm")}</label>
      <button type="button" disabled={!enabled || busy || !confirmed || approved} onClick={() => void run(async () => {
        await api.pptEditorVisualApprove(review.reviewId);
        return () => setApproved(true);
      })}>{t("panel.pptEditor.visualApprove")}</button>
      {approved && <p role="status">{t("panel.pptEditor.visualApproved")}</p>}
    </>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
