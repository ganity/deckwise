import type { CoursewareTeachingHistoryEntry, CoursewareTeachingView } from "@pi-desktop/shared";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../lib/api";

export function CoursewareTeachingHistory({ view, disabled, onRestore }: {
  view: CoursewareTeachingView;
  disabled: boolean;
  onRestore: (actions: Array<Record<string, unknown>>) => void;
}) {
  const { t } = useTranslation();
  const context = JSON.stringify([view.viewId, view.project.projectId, view.project.source.revision,
    view.project.source.sha256, view.project.teachingRevision, view.pageId, view.pageNumber]);
  const [history, setHistory] = useState<{
    context: string; entries: CoursewareTeachingHistoryEntry[]; skippedEntryCount: number;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [selected, setSelected] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const request = useRef(0);
  const pending = useRef(false);
  const mounted = useRef(false);
  const live = useRef({ context, disabled, selected, confirmed });
  live.current = { context, disabled, selected, confirmed };
  useEffect(() => {
    mounted.current = true;
    request.current++; pending.current = false;
    setHistory(null); setLoading(false); setFailed(false); setSelected(""); setConfirmed(false);
    return () => { mounted.current = false; request.current++; };
  }, [context, disabled]);

  const load = async () => {
    if (!mounted.current || live.current.context !== context || live.current.disabled || pending.current) return;
    const current = ++request.current;
    pending.current = true; setLoading(true); setFailed(false); setHistory(null);
    setSelected(""); setConfirmed(false); live.current.confirmed = false;
    try {
      const result = await api.pptEditorTeachingHistory(view.viewId);
      if (current !== request.current || live.current.context !== context || live.current.disabled) return;
      setHistory({ context, entries: result.entries.slice(0, 20), skippedEntryCount: result.skippedEntryCount });
    } catch {
      if (current === request.current && live.current.context === context && !live.current.disabled) setFailed(true);
    } finally {
      if (current === request.current) { pending.current = false; setLoading(false); }
    }
  };
  const current = history?.context === context ? history : null;
  const entry = selected === "" ? undefined : current?.entries[Number(selected)];
  const restore = () => {
    if (!mounted.current || !entry || loading || live.current.context !== context || live.current.disabled ||
      live.current.selected !== selected || !live.current.confirmed) return;
    live.current.confirmed = false; setConfirmed(false);
    onRestore(structuredClone(entry.actions));
  };
  return <details className="courseware-teaching-history">
    <summary>{t("panel.teachingHistory.title")}</summary>
    {disabled && <p role="status">{t("panel.teachingHistory.blocked")}</p>}
    <button type="button" disabled={disabled || loading} onClick={() => void load()}>
      {t(loading ? "panel.teachingHistory.loading" : "panel.teachingHistory.load")}</button>
    {failed && <p role="alert">{t("panel.teachingHistory.failed")}</p>}
    {current && <>
      {current.skippedEntryCount > 0 && <p role="status">{t("panel.teachingHistory.skipped", { count: current.skippedEntryCount })}</p>}
      {!current.entries.length ? <p role="status">{t("panel.teachingHistory.empty")}</p> : <label>
        {t("panel.teachingHistory.preview")}
        <select disabled={disabled || loading} value={selected} onChange={event => {
          if (!mounted.current || live.current.context !== context || live.current.disabled) return;
          live.current.selected = event.target.value; live.current.confirmed = false;
          setSelected(event.target.value); setConfirmed(false);
        }}>
          <option value="">—</option>
          {current.entries.map((item, index) => <option key={`${item.teachingRevision}:${item.pageId}`} value={String(index)}>
            {t("panel.teachingHistory.entry", { page: item.pageNumber, teachingRevision: item.teachingRevision, sourceRevision: item.sourceRevision })}
          </option>)}
        </select>
      </label>}
      {entry && <>
        <ol aria-label={t("panel.teachingHistory.preview")}>
          {entry.actions.map(action => <li key={String(action.id)}>
            {action.type === "speech" ? <>
              <p style={{ whiteSpace: "pre-wrap" }}>{String(action.text)}</p>
              {typeof action.pauseAfterMs === "number" && <p>{t("panel.teachingHistory.pause", { ms: action.pauseAfterMs })}</p>}
            </> : <p>{t("panel.teachingHistory.wait")}</p>}
          </li>)}
        </ol>
        <p role="note">{t("panel.teachingHistory.warnings", { audio: entry.omittedAudioCount, cues: entry.omittedCueCount })}</p>
        <label><input type="checkbox" checked={confirmed} disabled={disabled || loading} onChange={event => {
          if (!mounted.current || live.current.context !== context || live.current.disabled || live.current.selected !== selected) return;
          live.current.confirmed = event.target.checked; setConfirmed(event.target.checked);
        }} />{t("panel.teachingHistory.confirm")}</label>
        <button type="button" disabled={disabled || loading || !confirmed} onClick={restore}>{t("panel.teachingHistory.restore")}</button>
      </>}
    </>}
  </details>;
}
