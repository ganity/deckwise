import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { CoursewarePptxCandidateReview } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { chatCandidateReceipts } from "../../lib/courseware-chat-candidates";
import { useAppStore } from "../../stores/app-store";
import { CoursewarePptxCandidateReview as CandidateReview } from "../workpanel/CoursewarePptxCandidateReview";

export function CoursewareChatPptxCandidates({ sessionId, disabled }: { sessionId: string; disabled: boolean }) {
  const { t } = useTranslation();
  const messages = useAppStore(state => state.messages);
  const [review, setReview] = useState<CoursewarePptxCandidateReview | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [resolved, setResolved] = useState<string[]>([]);
  const [outcome, setOutcome] = useState<"adopted" | "rejected" | null>(null);
  const active = useRef(true), inFlight = useRef(false), blocked = useRef(disabled);
  blocked.current = disabled;
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const current = () => active.current && useAppStore.getState().activeSessionId === sessionId;
  const canAct = () => current() && !blocked.current && !useAppStore.getState().runningSessions[sessionId];
  const candidates = chatCandidateReceipts(messages).filter(candidate => candidate.kind !== "page-narration" && !resolved.includes(candidate.candidateId));
  const run = async (operation: () => Promise<void>) => {
    if (!canAct() || inFlight.current) return;
    inFlight.current = true; setBusy(true); setError(""); setOutcome(null);
    try { await operation(); }
    catch (failure) { if (current()) {
      setReview(null); setError(String(failure));
      useAppStore.setState({ coursewareTeachingRefresh: { sessionId, reread: true } });
    } }
    finally { inFlight.current = false; if (current()) setBusy(false); }
  };
  const checkDraft = async () => {
    const teaching = await api.pptEditorTeachingOpen(sessionId);
    if (!canAct()) return;
    const { draft } = await api.pptEditorTeachingDraftGet(teaching.viewId);
    if (draft) throw new Error(t("coursewareWorkflow.reviewDraftFirst"));
  };
  const finish = (decision: "adopted" | "rejected") => {
    if (!current() || !review) return;
    setResolved(ids => [...ids, review.candidateId]); setReview(null); setOutcome(decision);
    useAppStore.setState({ coursewareTeachingRefresh: decision === "adopted"
      ? { sessionId, sourceSha256: review.outputSha256 } : { sessionId, reread: true } });
  };
  if (!candidates.length && !review && !outcome && !error) return null;
  return <section className="courseware-chat-pptx" aria-label={t("panel.pptEditor.pptxCandidateTitle")} aria-busy={busy}>
    {error && <p role="alert" className="courseware-workflow-error">{error}</p>}
    {outcome && <p role="status">{t(`panel.pptEditor.candidateStatus_${outcome}`)}</p>}
    {!review ? <ol>{candidates.map(candidate => <li key={candidate.candidateId}>
      <button type="button" disabled={disabled || busy} onClick={() => void run(async () => {
        await checkDraft();
        if (!canAct()) return;
        const next = await api.pptEditorPptxCandidateReview(sessionId, candidate.candidateId);
        if (canAct()) setReview(next);
      })}>{t("panel.pptEditor.pptxCandidateKind", { kind: t(`coursewareWorkflow.${candidate.kind}`) })} · {t("panel.pptEditor.pptxCandidateReview")}</button>
    </li>)}</ol> : <CandidateReview key={review.reviewId} review={review} sessionId={sessionId} disabled={disabled || busy}
      close={() => { if (current() && !inFlight.current) {
        setReview(null); setError("");
        useAppStore.setState({ coursewareTeachingRefresh: { sessionId, reread: true } });
      } }}
      preview={() => void run(async () => { await api.pptEditorPptxCandidatePreview(review.reviewId); })}
      reject={() => void run(async () => { await api.pptEditorPptxCandidateReject(review.reviewId); finish("rejected"); })}
      adopt={bindings => void run(async () => {
        await checkDraft();
        if (!canAct()) return;
        await api.pptEditorPptxCandidateAdopt(review.reviewId, bindings);
        finish("adopted");
      })} />}
  </section>;
}
