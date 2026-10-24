import type { CoursewareNarrationReview as Review } from "@pi-desktop/shared";
import { useState } from "react";
import { useTranslation } from "react-i18next";

export function CoursewareNarrationReview({ review, disabled, open, decide, close }: {
  review: Review | null;
  disabled: boolean;
  open: (candidateId: string) => void;
  decide: (decision: "adopt" | "reject") => void;
  close: () => void;
}) {
  const { t } = useTranslation();
  const [candidateId, setCandidateId] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const current = review?.teaching.project.pages.find((page) => page.pageId === review.teaching.pageId);
  return <section className="courseware-narration-review" aria-label={t("panel.pptEditor.candidateTitle")}>
    {!review ? <form onSubmit={(event) => { event.preventDefault(); open(candidateId.trim()); }}>
      <label>{t("panel.pptEditor.candidateId")}
        <input value={candidateId} maxLength={128} disabled={disabled} onChange={(event) => setCandidateId(event.target.value)} />
      </label>
      <button type="submit" disabled={disabled || !/^[\w.-]{1,128}$/u.test(candidateId.trim())}>{t("panel.pptEditor.candidateOpen")}</button>
    </form> : <>
      <strong>{t("panel.pptEditor.candidateTitle")}</strong>
      <p>{t("panel.pptEditor.teachingPage", { page: review.teaching.pageNumber })}</p>
      <p role="status">{t(`panel.pptEditor.candidateStatus_${review.status}`)}</p>
      <details open><summary>{t("panel.pptEditor.candidateBefore")}</summary>
        {current?.actions.filter((action) => action.type === "speech").map((action) => <p key={String(action.id)}>{String(action.text)}</p>)}
      </details>
      <strong>{t("panel.pptEditor.candidateAfter")}</strong>
      {!review.actions.length && <p>{t("panel.pptEditor.candidateEmpty")}</p>}
      {review.actions.map((action) => <div key={String(action.id)}>
        {action.type === "interaction_checkpoint" && action.checkpointKind === "teacher_continue"
          ? <p>{t("panel.pptEditor.candidateTeacherContinue")}</p>
          : <p>{String(action.text)}</p>}
        {typeof action.pauseAfterMs === "number" && <p>{t("panel.pptEditor.candidatePause", { ms: action.pauseAfterMs })}</p>}
      </div>)}
      <p>{t("panel.pptEditor.candidateNoAudio")}</p>
      {review.stale && review.status === "needs-review" && <p role="alert">{t("panel.pptEditor.candidateStale")}</p>}
      {review.status === "needs-review" && <>
        <label><input type="checkbox" checked={confirmed} disabled={disabled || review.stale}
          onChange={(event) => setConfirmed(event.target.checked)} />{t("panel.pptEditor.candidateConfirm")}</label>
        <div className="courseware-teaching-actions">
          <button type="button" disabled={disabled || review.stale || !confirmed} onClick={() => decide("adopt")}>{t("panel.pptEditor.candidateAdopt")}</button>
          <button type="button" disabled={disabled} onClick={() => decide("reject")}>{t("panel.pptEditor.candidateReject")}</button>
        </div>
      </>}
      <button type="button" disabled={disabled} onClick={close}>{t("panel.pptEditor.candidateClose")}</button>
    </>}
  </section>;
}
