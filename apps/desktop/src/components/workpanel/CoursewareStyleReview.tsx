import { useEffect, useRef, useState } from "react";
import type { CoursewareStyleReview as Review } from "@pi-desktop/shared";
import { useTranslation } from "react-i18next";
import { api } from "../../lib/api";

export function CoursewareStyleReview({ sessionId, candidateId, enabled, onActiveChange }: {
  sessionId: string; candidateId: string; enabled: boolean; onActiveChange(active: boolean): void;
}) {
  const { t } = useTranslation();
  const [review, setReview] = useState<Review | null>(null), [pageIds, setPageIds] = useState<string[]>([]);
  const [confirmed, setConfirmed] = useState(false), [approved, setApproved] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const approvedRef = useRef(false);
  const sequence = useRef(0), active = useRef(onActiveChange), latest = useRef({ sessionId, candidateId, enabled });
  active.current = onActiveChange; latest.current = { sessionId, candidateId, enabled };
  const clear = () => {
    sequence.current++; setReview(null); setPageIds([]); setConfirmed(false); setApproved(false); setBusy(false); setError("");
    approvedRef.current = false;
    active.current(false); void api.pptEditorStyleClear().catch(() => {});
  };
  useEffect(() => {
    clear();
    return () => { sequence.current++; active.current(false); if (!approvedRef.current) void api.pptEditorStyleClear().catch(() => {}); };
  }, [sessionId, candidateId]);
  useEffect(() => { if (!enabled && !approvedRef.current) clear(); }, [enabled]);
  const run = async (operation: () => Promise<() => void>) => {
    if (!enabled || busy) return;
    const id = ++sequence.current; setBusy(true); setError(""); active.current(true);
    const current = () => id === sequence.current && latest.current.enabled && latest.current.sessionId === sessionId && latest.current.candidateId === candidateId;
    try { const apply = await operation(); if (current()) apply(); }
    catch (failure) { if (current()) { approvedRef.current = false; setApproved(false); setError(String(failure)); } }
    finally { if (current()) { setBusy(false); active.current(false); } }
  };
  return <section className="courseware-source-visuals" aria-label={t("panel.pptEditor.styleTitle")} aria-busy={busy}>
    <strong>{t("panel.pptEditor.styleTitle")}</strong>
    <p>{t("panel.pptEditor.styleScope")}</p>
    <button type="button" disabled={!enabled || busy} onClick={() => void run(async () => {
      setReview(null); approvedRef.current = false; setApproved(false); setConfirmed(false);
      const next = await api.pptEditorStylePrepare(sessionId, candidateId);
      return () => { setReview(next); setPageIds([next.pageId]); };
    })}>{t(busy ? "panel.pptEditor.visualPreparing" : "panel.pptEditor.stylePrepare")}</button>
    {(busy || review) && <button type="button" onClick={clear}>{t("panel.pptEditor.styleClear")}</button>}
    {review && <>
      <p>{t("panel.pptEditor.teachingPage", { page: review.pageNumber })}</p>
      <figure><figcaption>{t("panel.pptEditor.stylePreview")}</figcaption><img src={review.preview.preview} alt={t("panel.pptEditor.stylePreview")} /></figure>
      <p>{t("panel.pptEditor.styleInstruction")}</p><pre className="courseware-style-instruction">{review.instruction}</pre>
      <fieldset disabled={!enabled || busy || approved}>
        <legend>{t("panel.pptEditor.stylePages")}</legend>
        {review.pages.map(page => <label key={page.pageId}>
          <input type="checkbox" checked={pageIds.includes(page.pageId)}
            disabled={page.locked || page.pageId === review.pageId || (!pageIds.includes(page.pageId) && pageIds.length >= 20)}
            onChange={event => { setConfirmed(false); setPageIds(ids => event.target.checked ? [...ids, page.pageId] : ids.filter(id => id !== page.pageId)); }} />
          {t("panel.pptEditor.teachingPage", { page: page.pageNumber })}{page.locked && ` · ${t("panel.pptEditor.teachingLock")}`}
        </label>)}
      </fieldset>
      <label><input type="checkbox" checked={confirmed} disabled={!enabled || busy || approved || pageIds.length < 2}
        onChange={event => setConfirmed(event.target.checked)} />{t("panel.pptEditor.styleConfirm")}</label>
      <button type="button" disabled={!enabled || busy || approved || !confirmed || pageIds.length < 2} onClick={() => void run(async () => {
        const next = await api.pptEditorStyleApprove(review.reviewId, pageIds);
        return () => { setPageIds(next.pageIds); approvedRef.current = true; setApproved(true); };
      })}>{t("panel.pptEditor.styleApprove")}</button>
      {approved && <p role="status">{t("panel.pptEditor.styleApproved", { pages: review.pages.filter(page => pageIds.includes(page.pageId)).map(page => page.pageNumber).join(", ") })}</p>}
    </>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
