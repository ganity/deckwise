import { useTranslation } from "react-i18next";
import type { CoursewareTeachingView } from "@pi-desktop/shared";

const progressLabels = {
  "needs-review": "chatCandidatePending", stale: "chatCandidateStale", adopted: "chatCandidateAdopted",
  superseded: "chatCandidateChanged", rejected: "chatCandidateRejected", unknown: "chatCandidateUnknown",
  saved: "teachingSaved", "not-recorded": "chatPlanNotRecorded", "native-unsaved": "chatPlanNativeResponse",
} as const;

/** Keep original tool failures and omissions visible without an approval gate. */
export function CoursewareChatChanges({ view }: { view: CoursewareTeachingView }) {
  const { t } = useTranslation();
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
      {change.resolution && <p>{t("panel.pptEditor.chatResolutionClosed", { note: change.resolution.note })}</p>}
    </li>)}</ul>
  </details>;
}
