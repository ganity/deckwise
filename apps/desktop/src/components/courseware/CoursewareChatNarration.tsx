import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import type { UiMessage } from "@pi-desktop/shared";
import { toolResultPayload } from "../../lib/tool-presentation";
import { useAppStore } from "../../stores/app-store";

/** Only successful tool receipts can report persisted narration. */
export function savedNarrationPages(messages: UiMessage[]) {
  const pages = new Map<string, { pageNumber: number; pageId: string; teachingRevision: string }>();
  for (const message of messages) {
    if (message.role !== "tool" || !["courseware_narration_propose", "ppt_propose_page_narration"].includes(message.toolName ?? "") ||
        message.toolStatus !== "success" || message.isError || message.parentToolCallId) continue;
    try {
      const raw = toolResultPayload(message);
      const payload = typeof raw === "string" ? JSON.parse(raw) : raw;
      const results = message.toolName === "courseware_narration_propose" ? payload?.savedPages :
        payload?.kind === "page-narration" && payload.applied === true ? [{ ...payload, pageId: payload.baseline?.pageId }] : [];
      if (!Array.isArray(results)) continue;
      for (const result of results) {
        if (result?.saved !== true || !Number.isSafeInteger(result.pageNumber) || result.pageNumber < 1 ||
            typeof result.pageId !== "string" || !/^[\w.-]{1,128}$/u.test(result.pageId) ||
            typeof result.teachingRevision !== "string" || !/^[\w.-]{1,128}$/u.test(result.teachingRevision)) continue;
        pages.set(result.pageId, { pageNumber: result.pageNumber, pageId: result.pageId, teachingRevision: result.teachingRevision });
      }
    } catch { /* Incomplete output cannot prove a save. */ }
  }
  return [...pages.values()].sort((a, b) => a.pageNumber - b.pageNumber);
}

export function CoursewareChatNarration({ sessionId }: { sessionId: string; disabled: boolean }) {
  const { t } = useTranslation();
  const messages = useAppStore(state => state.messages);
  const pages = savedNarrationPages(messages);
  const savedKey = JSON.stringify(pages);
  useEffect(() => {
    if (savedKey !== "[]" && useAppStore.getState().activeSessionId === sessionId)
      useAppStore.setState({ coursewareTeachingRefresh: { sessionId, reread: true } });
  }, [sessionId, savedKey]);
  if (!pages.length) return null;
  return <section className="courseware-chat-narration" aria-label={t("panel.pptEditor.tab_narration")}>
    <p role="status">{t("panel.pptEditor.teachingSaved")}</p>
    <ol>{pages.map(page => <li key={page.pageId}>{t("panel.pptEditor.teachingPage", { page: page.pageNumber })}</li>)}</ol>
  </section>;
}
