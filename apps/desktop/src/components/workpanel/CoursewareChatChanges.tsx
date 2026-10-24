import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { CoursewareTeachingView } from "@pi-desktop/shared";

const progressLabels = {
  "needs-review": "chatCandidatePending", stale: "chatCandidateStale", adopted: "chatCandidateAdopted",
  superseded: "chatCandidateChanged", rejected: "chatCandidateRejected", unknown: "chatCandidateUnknown",
  "not-recorded": "chatPlanNotRecorded", "native-unsaved": "chatPlanNativeResponse",
} as const;

/** Human disposition keeps the original tool failures and omissions visible. */
export function CoursewareChatChanges({ view, disabled, resolve }: {
  view: CoursewareTeachingView;
  disabled: boolean;
  resolve: (request: { changeGroupId: string; receiptSha256: string; note: string }) => void;
}) {
  const { t } = useTranslation();
  const [review, setReview] = useState({ id: "", note: "", checked: false });
  if (!view.chatChanges?.length) return null;
  return <details className="courseware-chat-changes">
    <summary>{t("panel.pptEditor.chatChangesTitle")}</summary>
    <p>{t("panel.pptEditor.chatChangesHelp")}</p>
    <ul>{view.chatChanges.map(change => <li key={change.changeGroupId}>
      <code>{change.changeGroupId.slice(0, 8)}</code>{" "}
      {t("panel.pptEditor.chatChangesCounts", { acknowledged: change.acknowledged, uncertain: change.uncertain, pending: change.pending })}
      {change.plan && <>
        <p>{t("panel.pptEditor.chatPlanPage", { page: change.plan.pageNumber })}</p>
        <ol>{change.plan.items.map((item, index) => <li key={index}>
          {item.label}{" · "}{t(`panel.pptEditor.${progressLabels[item.status]}`)}
        </li>)}</ol>
      </>}
      {change.candidates?.map((candidate, index) => <p key={`${candidate.candidateId}:${index}`}>
        <code>{candidate.candidateId}</code>{" · "}{t(`panel.pptEditor.${progressLabels[candidate.status]}`)}
      </p>)}
      {change.resolution ? <p>{t("panel.pptEditor.chatResolutionClosed", { note: change.resolution.note })}</p> : change.plan && change.receiptSha256 && <>
        <p>{t("panel.pptEditor.chatResolutionHelp")}</p>
        {review.id !== change.changeGroupId ? <button type="button" disabled={disabled ||
          (change.plan.pageId !== view.pageId && (view.project.pages.some(page => page.pageId === change.plan!.pageId) ||
            view.project.pages.some(page => page.reviewState !== "ready")))}
          onClick={() => setReview({ id: change.changeGroupId, note: "", checked: false })}>
          {t("panel.pptEditor.chatResolutionReview")}
        </button> : <>
          <label>{t("panel.pptEditor.chatResolutionNote")}
            <textarea rows={2} maxLength={500} value={review.note} disabled={disabled}
              onChange={event => setReview({ ...review, note: event.target.value, checked: false })} />
          </label>
          <label><input type="checkbox" checked={review.checked} disabled={disabled}
            onChange={event => setReview({ ...review, checked: event.target.checked })} />
            {t("panel.pptEditor.chatResolutionCheck")}
          </label>
          <button type="button" disabled={disabled || !review.checked || !review.note.trim()}
            onClick={() => resolve({ changeGroupId: change.changeGroupId, receiptSha256: change.receiptSha256!, note: review.note.trim() })}>
            {t("panel.pptEditor.chatResolutionConfirm")}
          </button>
        </>}
      </>}
    </li>)}</ul>
  </details>;
}
