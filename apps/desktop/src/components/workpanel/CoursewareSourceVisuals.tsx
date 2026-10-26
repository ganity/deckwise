import { useEffect, useRef, useState } from "react";
import type { CoursewareSourceVisualReview } from "@pi-desktop/shared";
import { useTranslation } from "react-i18next";
import { api } from "../../lib/api";

export function CoursewareSourceVisuals({ sessionId, enabled, disabled = false, onActiveChange }: {
  sessionId?: string; enabled: boolean; disabled?: boolean; onActiveChange(active: boolean): void;
}) {
  const { t } = useTranslation();
  const [review, setReview] = useState<CoursewareSourceVisualReview | null>(null);
  const [confirmed, setConfirmed] = useState(false), [approved, setApproved] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const inFlight = useRef(false), mounted = useRef(true);
  const sequence = useRef(0), active = useRef(onActiveChange);
  active.current = onActiveChange;
  const latest = useRef({ sessionId, enabled, disabled }); latest.current = { sessionId, enabled, disabled };
  const clear = () => {
    sequence.current++; inFlight.current = false; setReview(null); setConfirmed(false); setApproved(false); setBusy(false); setError("");
    active.current(false); void api.pptEditorVisualClear().catch(() => {});
  };
  useEffect(() => {
    mounted.current = true; clear();
    return () => { mounted.current = false; sequence.current++; active.current(false); void api.pptEditorVisualClear().catch(() => {}); };
  }, [sessionId, enabled]);
  const run = async (operation: (current: () => boolean) => Promise<() => void>) => {
    if (!mounted.current || !latest.current.enabled || latest.current.disabled || latest.current.sessionId !== sessionId || !sessionId || inFlight.current) return;
    inFlight.current = true;
    const id = ++sequence.current; setBusy(true); setError(""); active.current(true);
    const current = () => mounted.current && id === sequence.current && latest.current.enabled && latest.current.sessionId === sessionId;
    try { const apply = await operation(current); if (current()) apply(); }
    catch (failure) { if (current()) { setReview(null); setConfirmed(false); setApproved(false); setError(String(failure)); } }
    finally { if (current()) { inFlight.current = false; setBusy(false); active.current(false); } }
  };
  return <section className="courseware-source-visuals" aria-label={t("panel.pptEditor.visualTitle")} aria-busy={busy}>
    <strong>{t("panel.pptEditor.visualTitle")}</strong>
    <p>{t("panel.pptEditor.visualScope")}</p>
    <button type="button" disabled={!enabled || disabled || !sessionId || busy} onClick={() => void run(async current => {
      setReview(null); setConfirmed(false); setApproved(false);
      await api.pptEditorVisualClear();
      if (!current()) return () => {};
      const teaching = await api.pptEditorTeachingOpen(sessionId!);
      const { draft } = await api.pptEditorTeachingDraftGet(teaching.viewId);
      if (draft) throw new Error(t("coursewareWorkflow.reviewDraftFirst"));
      if (!current() || latest.current.disabled) return () => {};
      const next = await api.pptEditorVisualPrepare(sessionId!);
      return () => setReview(next);
    })}>{t(busy ? "panel.pptEditor.visualPreparing" : "panel.pptEditor.visualPrepare")}</button>
    {(busy || review) && <button type="button" disabled={disabled} onClick={clear}>{t("panel.pptEditor.visualClear")}</button>}
    {review && <>
      <p>{t("panel.pptEditor.teachingPage", { page: review.pageNumber })}</p>
      <figure><figcaption>{t("panel.pptEditor.visualOriginal")}</figcaption><img src={review.original.preview} alt={t("panel.pptEditor.visualOriginal")} /></figure>
      <figure><figcaption>{t("panel.pptEditor.visualTextless")}</figcaption><img src={review.nativeTextless.preview} alt={t("panel.pptEditor.visualTextless")} /></figure>
      <p>{t("panel.pptEditor.visualWarning")}</p>
      <label><input type="checkbox" checked={confirmed} disabled={!enabled || disabled || busy || approved} onChange={event => setConfirmed(event.target.checked)} />{t("panel.pptEditor.visualConfirm")}</label>
      <button type="button" disabled={!enabled || disabled || busy || !confirmed || approved} onClick={() => void run(async () => {
        await api.pptEditorVisualApprove(review.reviewId);
        return () => setApproved(true);
      })}>{t("panel.pptEditor.visualApprove")}</button>
      {approved && <p role="status">{t("panel.pptEditor.visualApproved")}</p>}
    </>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
