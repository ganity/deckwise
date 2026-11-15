import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { CoursewareDeliveryView } from "@pi-desktop/shared";
import { api } from "../../lib/api";

export function CoursewareDeliveryActions({ sessionId, title, disabled }: { sessionId: string; title: string; disabled: boolean }) {
  const { t } = useTranslation();
  const [conflictRevision, setConflictRevision] = useState<string | null>(null);
  const [state, setState] = useState<CoursewareDeliveryView | null>(null);
  const [busy, setBusy] = useState(false), [message, setMessage] = useState("");
  const mounted = useRef(true), running = useRef(false), epoch = useRef(0);
  useEffect(() => {
    mounted.current = true;
    const reset = () => { epoch.current++; setState(null); setMessage(""); setConflictRevision(null); };
    const detach = api.onAuthChanged(reset);
    return () => { mounted.current = false; epoch.current++; detach(); };
  }, [sessionId]);
  const run = async (action: "sync" | "publish", expectedCloudRevisionId?: string, reviewId?: string) => {
    if (running.current || disabled) return;
    running.current = true; setBusy(true); setMessage("");
    const generation = epoch.current;
    try {
      // Always read fresh state; editor and other platform clients may have changed the draft.
      const latest = await api.coursewareDelivery("state", sessionId);
      if (!mounted.current || generation !== epoch.current) return;
      setState(latest);
      if (action === "publish" && latest.pendingAction !== "publish" && (latest.dirty || !latest.synced)) {
        setMessage(t("coursewareDelivery.syncRequired")); return;
      }
      if (action === "sync" && latest.cloudRevisionId && latest.cloudRevisionId !== latest.revisionId && !expectedCloudRevisionId) {
        setConflictRevision(latest.cloudRevisionId); setMessage(t("coursewareDelivery.conflict")); return;
      }
      const result = await api.coursewareDelivery(action, sessionId, action === "sync" ? title : undefined, expectedCloudRevisionId, reviewId);
      if (mounted.current && generation === epoch.current) {
        if (!result.review) setConflictRevision(null);
        setState(result);
        setMessage(t(result.review ? "coursewareDelivery.reviewHint" : result.dirty ? "coursewareDelivery.changed" : action === "sync" ? "coursewareDelivery.synced" : "coursewareDelivery.published"));
      }
    } catch (error) {
      if (mounted.current && generation === epoch.current) {
        const detail = String(error);
        console.error("Courseware delivery failed", error);
        setMessage(t(detail.includes("SYNC_REQUIRED") ? "coursewareDelivery.syncRequired" : detail.includes("CONFLICT") ? "coursewareDelivery.conflict"
          : detail.includes("narration audio") ? "coursewareDelivery.audioRequired" : detail.includes("CONTENT_ERROR") || detail.includes("no equivalent") || detail.includes("not fully synchronized") ? "coursewareDelivery.unsupported" : "coursewareDelivery.failed"));
      }
    } finally { running.current = false; if (mounted.current) setBusy(false); }
  };
  return <div className="courseware-delivery-actions">
    <button type="button" disabled={disabled || busy} onClick={() => void run("sync")}>{t(busy ? "coursewareDelivery.working" : "coursewareDelivery.sync")}</button>
    <button type="button" disabled={disabled || busy} onClick={() => void run("publish")}>{t("coursewareDelivery.publish")}</button>
    {state?.courseId && <small>{t("coursewareDelivery.bound", { id: state.courseId, version: state.version ?? 0 })}</small>}
    {message && <span role="status">{message}</span>}
    {state?.review && <div role="alert">
      <ul>{state.review.diagnostics.map((item, index) => <li key={index}>{item.message}</li>)}</ul>
      <button type="button" disabled={busy || disabled} onClick={() => void run("sync", conflictRevision ?? undefined, state.review?.id)}>{t("coursewareDelivery.approveWarnings")}</button>
    </div>}
    {conflictRevision && <div role="alert">
      {t("coursewareDelivery.overwriteHint")}
      <button type="button" disabled={busy || disabled} onClick={() => void run("sync", conflictRevision)}>{t("coursewareDelivery.overwrite")}</button>
      <button type="button" disabled={busy} onClick={() => setConflictRevision(null)}>{t("coursewareDelivery.cancel")}</button>
    </div>}
  </div>;
}
