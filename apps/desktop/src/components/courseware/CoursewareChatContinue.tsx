import { useEffect, useRef, useState } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import type { UiMessage } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { inspectProject, referencedProject } from "../../lib/ppt-master-project";
import { toolResultPayload } from "../../lib/tool-presentation";
import { useAppStore } from "../../stores/app-store";

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
type Next = { kind: "export" | "resume"; label: string; prompt: string; identity: string };

const issueLabels: Readonly<Record<string, string>> = {
  CONTENT_REVIEW_FAILED: "repairContentReview", CONTENT_REVIEW_INVALID: "repairReviewCheck",
  AUDIO_MISSING: "repairAudio", NARRATION_MISSING: "repairNarration",
  EFFECT_MISSING: "repairEffect", EFFECT_TARGET_MISSING: "repairEffect", ANIMATION_TARGET_CONFLICT: "repairEffect",
  ATTENTION_PENDING: "repairEffect", QUESTION_MISSING: "repairQuestion", QUESTION_TYPE_MISMATCH: "repairQuestion",
  MUSIC_MISSING: "repairMusic", MUSIC_PENDING: "repairMusic", VIDEO_MISSING: "repairVideo", VIDEO_PENDING: "repairVideo",
};

function describeIssue(issue: Record<string, unknown>, pages: Record<string, unknown>[], t: TFunction) {
  const location: string[] = [];
  if (typeof issue.pageNumber === "number" && Number.isSafeInteger(issue.pageNumber) && issue.pageNumber > 0)
    location.push(t("coursewareWorkflow.repairPage", { page: issue.pageNumber }));
  const code = String(issue.code);
  const message = typeof issue.message === "string" ? issue.message.trim() : "";
  const candidates = pages.filter(p => p.pageNumber === issue.pageNumber && (!issue.pageId || p.pageId === issue.pageId));
  let segment = typeof issue.segmentNumber === "number" && Number.isSafeInteger(issue.segmentNumber) && issue.segmentNumber > 0 ? issue.segmentNumber : undefined;
  let reason = message;
  // Older speech reviews stored the action ID in their diagnostic text.
  for (const page of candidates) {
    if (!Array.isArray(page.speeches)) continue;
    const index = page.speeches.findIndex(s => record(s) && typeof s.actionId === "string" &&
      (issue.actionId ? s.actionId === issue.actionId : code === "CONTENT_REVIEW_FAILED" && message.startsWith(`Speech ${s.actionId}: `)));
    if (index < 0) continue;
    segment = index + 1;
    if (!issue.actionId) reason = message.slice(`Speech ${page.speeches[index].actionId}: `.length);
    break;
  }
  if (segment) location.push(t("coursewareWorkflow.repairSegment", { segment }));
  const actionId = !segment && typeof issue.actionId === "string" ? issue.actionId : undefined;
  const reviewFinding = code === "CONTENT_REVIEW_FAILED" || code === "CONTENT_REVIEW_INVALID";
  const label = code === "CONTENT_REVIEW_FAILED" && issue.repair === "narration" && (segment || issue.actionId || message.startsWith("Speech "))
    ? t("coursewareWorkflow.repairSpeechFinding")
    : Object.hasOwn(issueLabels, code) ? t(`coursewareWorkflow.${issueLabels[code]}`) : code;
  location.push(issue.repairable === false && !reviewFinding ? t("coursewareWorkflow.repairBlocked", { issue: label }) : label);
  const summary = location.join(" · ");
  const evidence = reviewFinding && reason ? [
    t("coursewareWorkflow.repairEvidence"), typeof issue.quote === "string" ? JSON.stringify(issue.quote.slice(0, 4000)) : "", JSON.stringify(reason.slice(0, 4000)),
  ].filter(Boolean).join(" ") : "";
  return { summary, instruction: [summary, actionId, evidence].filter(Boolean).join(" — ") };
}

async function nextAction(sessionId: string, messages: UiMessage[], t: TFunction, verify = false): Promise<Next | undefined> {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role === "user") break;
    if (message.role !== "tool" || message.parentToolCallId || message.isError || message.toolStatus !== "success") continue;
    if (message.toolName === "courseware_media_context" || message.toolName === "courseware_narration_context") {
      const status = toolResultPayload(message);
      if (!record(status) || !record(status.completion)) continue;
      if (status.completion.ready !== false ||
          !Array.isArray(status.completion.issues) || !status.completion.issues.length) return;
      const issues = status.completion.issues.filter(record).filter(i => typeof i.code === "string" && i.code);
      if (!issues.length) return;
      const pages = Array.isArray(status.pages) ? status.pages.filter(record) : [];
      const projectId = status.projectId ?? (record(status.assessmentMedia) && status.assessmentMedia.projectId);
      const revision = status.completion.teachingRevision ?? status.teachingRevision;
      const source = status.completion.sourceSha256 ?? status.sourceSha256;
      // Older display receipts sometimes cut off the page before its speech list.
      if (status._truncated && projectId && revision && source && issues.some(i => i.code === "CONTENT_REVIEW_FAILED" && !i.segmentNumber)) {
        for (let n = index - 1; n >= 0 && messages[n].role !== "user"; n--) {
          const m = messages[n];
          if (m.role !== "tool" || m.toolName !== "courseware_media_context" || m.toolStatus !== "success" || m.parentToolCallId || m.isError) continue;
          const prior = toolResultPayload(m);
          if (record(prior) && record(prior.completion) && Array.isArray(prior.pages) &&
              (prior.projectId ?? (record(prior.assessmentMedia) && prior.assessmentMedia.projectId)) === projectId &&
              (prior.completion.teachingRevision ?? prior.teachingRevision) === revision &&
              (prior.completion.sourceSha256 ?? prior.sourceSha256) === source) pages.push(...prior.pages.filter(record));
        }
      }
      const descriptions = issues.map(issue => describeIssue(issue, pages, t));
      const lines = [...new Set(descriptions.map(issue => issue.instruction))];
      const workflow = await api.coursewareWorkflowGet(sessionId);
      if (!workflow.task?.generated && !workflow.task?.imported) return;
      if (verify && status.nativeTeaching === true && useAppStore.getState().workPanelTabs.some(tab =>
          tab.kind === "ppt" && tab.resource === workflow.task?.sourcePath)) {
        const saved = await api.pptEditorTeachingOpen(sessionId);
        if (saved.project.projectId !== projectId || saved.readOnly) return;
        if (saved.project.teachingRevision !== revision || saved.project.source.sha256 !== source) return;
      }
      return { kind: "resume", identity: JSON.stringify([workflow.task.sourcePath, projectId, revision, source, issues]),
        label: lines.length === 1 ? descriptions[0].summary : t("coursewareWorkflow.repairMultiple"),
        prompt: t("coursewareWorkflow.repairPrompt", { issues: lines.join("\n") }) };
    }
    if (message.toolName === "courseware_presentation_prepare" || message.toolName === "courseware_workflow_get") {
      const path = referencedProject(messages);
      if (!path) continue;
      const workflow = await api.coursewareWorkflowGet(sessionId);
      if (workflow.task?.taskType !== "plain" || workflow.task.generated) continue;
      const project = await inspectProject(path);
      if (project.hasSvg && !project.qualityIssue && (!project.pptxPath || project.needsPptxRegeneration))
        return { kind: "export", identity: path, label: t("coursewareWorkflow.confirmExport"), prompt: t("coursewareWorkflow.confirmExportPrompt") };
      return;
    }
  }
}

export function CoursewareChatContinue({ sessionId, messages }: { sessionId: string; messages: UiMessage[] }) {
  const { t } = useTranslation();
  const [action, setAction] = useState<Next>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const sending = useRef(false);
  const receiptMessages = useRef<UiMessage[] | null>(null);
  useEffect(() => {
    receiptMessages.current = messages;
    let current = true;
    void nextAction(sessionId, messages, t).then(value => { if (current) setAction(value); }).catch(() => {});
    return () => { current = false; receiptMessages.current = null; };
  }, [sessionId, messages, t]);
  if (!action) return null;
  const active = () => receiptMessages.current === messages && useAppStore.getState().activeSessionId === sessionId &&
    !useAppStore.getState().runningSessions[sessionId];
  const send = async () => {
    if (sending.current || !active()) return;
    sending.current = true; setBusy(true); setError("");
    try {
      const current = await nextAction(sessionId, messages, t, true);
      if (!active()) return;
      if (current?.kind !== action.kind || current.identity !== action.identity || current.prompt !== action.prompt) { setAction(current); return; }
      if (!await useAppStore.getState().sendPrompt(current.prompt, undefined, sessionId)) throw new Error(t("coursewareWorkflow.sendFailed"));
      if (active()) setAction(undefined);
    } catch (cause) { if (active()) setError(String(cause)); }
    finally { sending.current = false; if (receiptMessages.current) setBusy(false); }
  };
  return <div className="courseware-workflow-actions">
    <button type="button" className="copy-btn primary" disabled={busy} onClick={() => void send()}>{action.label}</button>
    {error && <span role="alert">{error}</span>}
  </div>;
}
