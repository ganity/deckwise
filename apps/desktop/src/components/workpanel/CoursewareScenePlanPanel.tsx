import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { CoursewareScenePlanSnapshot } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
import { IconRefresh, IconSparkles } from "../icons";
import { CoursewareSceneImages } from "./CoursewareSceneImages";

export function CoursewareScenePlanPanel({ sessionId, settingsChanged, onGenerated }: {
  sessionId: string; settingsChanged: boolean; onGenerated: (path: string) => void;
}) {
  const { t } = useTranslation();
  const isRunning = useAppStore((state) => state.isRunning);
  const [plan, setPlan] = useState<CoursewareScenePlanSnapshot | null>(null);
  const [brief, setBrief] = useState("");
  const [instructions, setInstructions] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [sending, setSending] = useState(false);
  const [approving, setApproving] = useState(false);
  const [mediaBusy, setMediaBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    let active = true;
    let latest = 0;
    const load = async () => {
      const request = ++latest;
      setReading(true);
      try {
        const result = await api.coursewareScenePlanRead(sessionId);
        if (active && request === latest) { setPlan(result.plan); setError(null); }
      } catch (failure) {
        if (active && request === latest) { setPlan(null); setError(String(failure)); }
      } finally { if (active && request === latest) setReading(false); }
    };
    void load();
    const timer = isRunning ? window.setInterval(() => void load(), 2000) : undefined;
    return () => { active = false; if (timer !== undefined) window.clearInterval(timer); };
  }, [sessionId, isRunning, refresh]);

  useEffect(() => { setInstructions({}); }, [plan?.sha256]);

  const send = async (instruction: string, pageId?: string) => {
    const store = useAppStore.getState();
    if (store.activeSessionId !== sessionId || store.isRunning || sending || approving || mediaBusy || settingsChanged || !instruction.trim()) return;
    setSending(true);
    setError(null);
    try {
      const pageIndex = plan?.pages.findIndex((page) => page.pageId === pageId) ?? -1;
      if (pageId && pageIndex < 0) throw new Error(t("panel.scenePlan.requestFailed"));
      const prompt = [
        plan ? `请调整场景式课件《${plan.title}》的教学规划。` : "请制定场景式课件的教学规划，包括页面文字、画面安排和逐页讲解词。",
        ...(pageId && plan ? [`只修改第 ${pageIndex + 1} 页《${plan.pages[pageIndex].title}》，保留其他页面及顺序。请先核对最新规划；目标页已变化时先说明，不覆盖其他页面。`] : []),
        `我的要求：${instruction.trim()}`,
        "请保存规划并说明调整的教学安排，这一步先不生成素材或课件。",
      ].join("\n");
      const accepted = await store.sendPrompt(prompt, undefined, sessionId);
      if (!accepted) throw new Error(t("panel.scenePlan.requestFailed"));
      if (useAppStore.getState().activeSessionId === sessionId) {
        if (pageId) setInstructions((current) => ({ ...current, [pageId]: "" }));
        else setBrief("");
      }
    } catch (failure) { setError(String(failure)); }
    finally { setSending(false); }
  };

  const approve = async () => {
    const store = useAppStore.getState();
    if (!plan || store.activeSessionId !== sessionId || store.isRunning || sending || approving || mediaBusy || settingsChanged) return;
    setApproving(true);
    setError(null);
    try {
      const result = await api.coursewareScenePlanApprove(sessionId, plan.sha256);
      if (useAppStore.getState().activeSessionId === sessionId) setPlan(result.plan);
    } catch (failure) {
      if (useAppStore.getState().activeSessionId === sessionId) setError(String(failure));
    } finally { setApproving(false); }
  };

  const disabled = isRunning || sending || approving || settingsChanged;
  const approved = plan !== null && plan.sha256 === plan.approvedSha256;
  return <section className="ppt-master-scene-plan" aria-label={t("panel.scenePlan.title")}>
    <div className="ppt-master-section-head">
      <strong>{t("panel.scenePlan.title")}</strong>
      <button type="button" className="ppt-master-action" title={t("panel.scenePlan.refresh")} aria-label={t("panel.scenePlan.refresh")}
        disabled={reading || approving || mediaBusy} onClick={() => setRefresh((value) => value + 1)}><IconRefresh size={14} /></button>
    </div>
    {isRunning ? <p role="status">{t("panel.scenePlan.working")}</p> : null}
    {error ? <p className="ppt-master-action-error" role="alert">{error}</p> : null}
    {!plan && !error && !reading ? <p>{t("panel.scenePlan.empty")}</p> : null}
    {plan ? <>
      <h3>{plan.title}</h3>
      <p role="status">{t(approved ? "panel.scenePlan.approved" : plan.approvedSha256 ? "panel.scenePlan.approvalStale" : "panel.scenePlan.approvalHint")}</p>
      <button type="button" className="ppt-master-action" disabled={disabled || mediaBusy || reading || approved}
        onClick={() => void approve()}>{t("panel.scenePlan.approve")}</button>
      {plan.pages.map((page, index) => <details className="ppt-master-scene-page" key={page.pageId}>
        <summary>{index + 1}. {page.title}</summary>
        <dl>
          <dt>{t("panel.scenePlan.visibleText")}</dt><dd>{page.visibleText.join("\n")}</dd>
          <dt>{t("panel.scenePlan.visualIntent")}</dt><dd>{page.visualIntent}</dd>
          <dt>{t("panel.scenePlan.narration")}</dt><dd>{page.narration}</dd>
        </dl>
        <label>{t("panel.scenePlan.pageInstruction")}
          <textarea value={instructions[page.pageId] ?? ""} maxLength={4000} rows={2} disabled={disabled || mediaBusy}
            onChange={(event) => setInstructions((current) => ({ ...current, [page.pageId]: event.target.value }))} />
        </label>
        <button type="button" className="ppt-master-action" disabled={disabled || mediaBusy || !instructions[page.pageId]?.trim()}
          onClick={() => void send(instructions[page.pageId] ?? "", page.pageId)}>{t("panel.scenePlan.revisePage")}</button>
      </details>)}
    </> : null}
    <label>{t("panel.scenePlan.brief")}
      <textarea value={brief} maxLength={8000} rows={3} disabled={disabled || mediaBusy} onChange={(event) => setBrief(event.target.value)} />
    </label>
    <button type="button" className="ppt-master-action primary" disabled={disabled || mediaBusy || !brief.trim()}
      onClick={() => void send(brief)}><IconSparkles size={14} />{t(plan ? "panel.scenePlan.revise" : "panel.scenePlan.generate")}</button>
    {plan ? <CoursewareSceneImages sessionId={sessionId} plan={plan} enabled={approved && !disabled}
      onActiveChange={setMediaBusy} onGenerated={onGenerated} /> : null}
  </section>;
}
