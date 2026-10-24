import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { CoursewareNarrationReview, UiMessage } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { toolResultPayload } from "../../lib/tool-presentation";
import { useAppStore } from "../../stores/app-store";
import { CoursewareNarrationReview as NarrationReview } from "../workpanel/CoursewareNarrationReview";

/** Transcript receipts are entrances only; Main reads and validates the saved candidate. */
export function narrationCandidates(messages: UiMessage[]): string[] {
  const ids = new Set<string>();
  for (const message of [...messages].reverse()) {
    if (message.role !== "tool" || message.toolName !== "ppt_propose_page_narration" ||
        message.toolStatus !== "success" || message.isError || message.parentToolCallId) continue;
    try {
      const raw = toolResultPayload(message);
      const result = typeof raw === "string" ? JSON.parse(raw) : raw;
      if (result?.kind === "page-narration" && result.reviewState === "needs-review" &&
          result.applied === false && result.saved === false && typeof result.baseline?.sessionId === "string" &&
          /^[\w.-]{1,128}$/u.test(result.baseline.sessionId) &&
          typeof result.candidateId === "string" && /^[\w.-]{1,128}$/u.test(result.candidateId)) ids.add(result.candidateId);
    } catch { /* Incomplete or malformed tool output is not a candidate entrance. */ }
  }
  return [...ids];
}

export function CoursewareChatNarration({ sessionId, disabled }: { sessionId: string; disabled: boolean }) {
  const { t } = useTranslation();
  const messages = useAppStore(state => state.messages);
  const candidates = narrationCandidates(messages);
  const [review, setReview] = useState<CoursewareNarrationReview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [outcome, setOutcome] = useState<"adopted" | "rejected" | null>(null);
  const active = useRef(true), inFlight = useRef(false);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const current = () => active.current && useAppStore.getState().activeSessionId === sessionId;
  const run = async (operation: () => Promise<void>) => {
    if (!current() || disabled || inFlight.current || useAppStore.getState().runningSessions[sessionId]) return;
    inFlight.current = true; setBusy(true); setError(""); setOutcome(null);
    try { await operation(); }
    catch (failure) { if (current()) { setError(String(failure)); setReview(null); } }
    finally { inFlight.current = false; if (current()) setBusy(false); }
  };
  const checkDraft = async (value: CoursewareNarrationReview) => {
    const { draft } = await api.pptEditorTeachingDraftGet(value.teaching.viewId);
    if (draft) throw new Error(t("coursewareWorkflow.reviewDraftFirst"));
  };
  if (!candidates.length && !review) return null;
  return <section className="courseware-chat-narration" aria-label={t("panel.pptEditor.candidateTitle")} aria-busy={busy}>
    {error && <p role="alert" className="courseware-workflow-error">{error}</p>}
    {outcome && <p role="status">{t(`panel.pptEditor.candidateStatus_${outcome}`)}</p>}
    {!review ? <ol>{candidates.map(candidateId => <li key={candidateId}>
      <button type="button" disabled={disabled || busy} onClick={() => void run(async () => {
        const next = await api.pptEditorNarrationReview(sessionId, candidateId);
        if (!current()) return;
        await checkDraft(next);
        if (current()) setReview(next);
      })}>{t("panel.pptEditor.candidateTitle")} · {t("panel.pptEditor.candidateOpen")}</button>
    </li>)}</ol> : <NarrationReview key={review.reviewId} review={review} disabled={disabled || busy}
      open={() => {}}
      close={() => { if (!busy) { setReview(null); setError(""); } }}
      decide={decision => void run(async () => {
        await checkDraft(review);
        if (!current() || useAppStore.getState().runningSessions[sessionId]) return;
        const next = await api.pptEditorNarrationDecide(review.reviewId, decision);
        if (current()) {
          setReview(null); setOutcome(decision === "adopt" ? "adopted" : "rejected");
          if (decision === "adopt") useAppStore.setState({ coursewareTeachingRefresh: {
            sessionId, teachingRevision: next.project.teachingRevision,
          } });
        }
      })} />}
  </section>;
}
