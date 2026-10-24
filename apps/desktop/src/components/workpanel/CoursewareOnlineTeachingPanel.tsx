import { replaceNarrationText, type CoursewareOnlineTeachingView } from "@pi-desktop/shared";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../lib/api";
import { CoursewareOnlinePauseRecovery } from "./CoursewareOnlinePauseRecovery";
import { CoursewareOnlineBarrierPanel } from "./CoursewareOnlineBarrierPanel";

type Actions = Array<Record<string, unknown>>;
const same = (left: Actions, right: Actions) => JSON.stringify(left) === JSON.stringify(right);
const pageActions = (view: CoursewareOnlineTeachingView) => view.project.pages.find(page => page.pageId === view.pageId)!.actions;
const sameBaseline = (left: CoursewareOnlineTeachingView, right: CoursewareOnlineTeachingView) =>
  left.mappingRevision === right.mappingRevision && left.project.projectId === right.project.projectId &&
  JSON.stringify(left.project.source) === JSON.stringify(right.project.source) && JSON.stringify(left.project.pages.find(page => page.pageId === left.pageId)) ===
    JSON.stringify(right.project.pages.find(page => page.pageId === right.pageId));
const failureKey = (failure: unknown) => /CONFLICT|CHANGED|46603|46201|46202/u.test(String(failure)) ? "conflict" : "failed";
const validActions = (actions: Actions) => actions.every(action => action.type !== "speech" || (typeof action.text === "string" &&
  action.text.trim().length > 0 && action.text.length <= 2500 && (action.pauseAfterMs === undefined ||
    (Number.isInteger(action.pauseAfterMs) && Number(action.pauseAfterMs) >= 0 && Number(action.pauseAfterMs) <= 30000))));

/** These are uploaded-source logical pages, never an inferred live Docs selection. */
export function CoursewareOnlineTeachingPanel({ ownerId, enabled, barrierEnabled = enabled, onDirtyChange, onPendingSaveChange, managePause = false }: {
  ownerId: string; enabled: boolean; barrierEnabled?: boolean; onDirtyChange(dirty: boolean): void; onPendingSaveChange?(pending: boolean): void; managePause?: boolean;
}) {
  const { t } = useTranslation();
  const [view, setView] = useState<CoursewareOnlineTeachingView | null>(null);
  const [actions, setActions] = useState<Actions>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [leaseLost, setLeaseLost] = useState(false);
  const [saved, setSaved] = useState(false);
  const [pendingPage, setPendingPage] = useState<{ pageId?: string } | null>(null);
  const [pendingSave, setPendingSave] = useState(false);
  const [teachingPaused, setTeachingPaused] = useState(false);
  const [nativePaused, setNativePaused] = useState(false);
  const writesPaused = teachingPaused || nativePaused;
  const uncertainSave = useRef(false);
  const current = useRef(view);
  const draft = useRef(actions);
  const working = useRef(false);
  const generation = useRef(0);
  const mountedOwner = useRef<string | null>(ownerId);
  const available = useRef(enabled);
  available.current = enabled;
  const paused = useRef(writesPaused);
  paused.current = writesPaused;
  const dirtyCallback = useRef(onDirtyChange);
  dirtyCallback.current = onDirtyChange;
  const pendingCallback = useRef(onPendingSaveChange);
  pendingCallback.current = onPendingSaveChange;
  const dirty = !!view && !same(actions, pageActions(view));
  const leased = !!view?.leaseExpiresAtEpochMillis && !leaseLost && view.leaseExpiresAtEpochMillis > Date.now();
  const canEdit = enabled && leased && !busy && !pendingSave && !writesPaused && !view?.project.pages.find(page => page.pageId === view.pageId)?.locked;
  const valid = validActions(actions);

  const change = (next: Actions) => {
    if (!canEdit || paused.current || uncertainSave.current || !available.current || mountedOwner.current !== ownerId || current.current !== view || working.current ||
      !view?.leaseExpiresAtEpochMillis || view.leaseExpiresAtEpochMillis <= Date.now()) return;
    draft.current = next; setActions(next); setSaved(false);
    dirtyCallback.current(!!view && !same(next, pageActions(view)));
  };
  const accept = (next: CoursewareOnlineTeachingView | null, replaceDraft: boolean) => {
    if (next && (next.ownerId !== ownerId || !next.project.pages.some(page => page.pageId === next.pageId))) throw new Error("Invalid teaching view");
    current.current = next; setView(next); setLeaseLost(false);
    if (replaceDraft) {
      draft.current = next ? structuredClone(pageActions(next)) : [];
      setActions(draft.current); dirtyCallback.current(false);
    }
  };
  const load = async (pageId?: string, discard = false) => {
    if (!available.current || mountedOwner.current !== ownerId || current.current !== view || working.current || uncertainSave.current) return;
    if (!discard && current.current && !same(draft.current, pageActions(current.current))) { setPendingPage({ pageId }); return; }
    const request = ++generation.current;
    working.current = true; setBusy(true); setError(""); setSaved(false); setPendingPage(null);
    try {
      const previous = current.current;
      if (previous?.leaseExpiresAtEpochMillis) await api.coursewareOnlineTeachingRelease(previous.viewId);
      if (generation.current !== request) return;
      const next = await api.coursewareOnlineTeachingRead(ownerId, pageId);
      if (generation.current !== request) return;
      accept(next, true); setLoaded(true);
    } catch (failure) {
      if (generation.current === request) { setError(failureKey(failure)); setLoaded(true); }
    } finally {
      if (generation.current === request) { working.current = false; setBusy(false); }
    }
  };
  const operate = async (kind: "acquire" | "renew" | "save" | "release") => {
    const previous = current.current;
    if (!available.current || mountedOwner.current !== ownerId || !previous || previous !== view || working.current ||
      (uncertainSave.current && kind !== "save") ||
      (kind === "acquire" && paused.current) ||
      (kind === "acquire" && previous.project.pages.find(page => page.pageId === previous.pageId)?.locked) ||
      (kind === "save" && !uncertainSave.current && (!canEdit || !validActions(draft.current) || same(draft.current, pageActions(previous)) ||
        !previous.leaseExpiresAtEpochMillis || previous.leaseExpiresAtEpochMillis <= Date.now()))) return;
    const request = generation.current;
    working.current = true; setBusy(true); setError(""); setSaved(false);
    try {
      const next = kind === "acquire" ? await api.coursewareOnlineTeachingAcquire(previous.viewId)
        : kind === "renew" ? await api.coursewareOnlineTeachingRenew(previous.viewId)
        : kind === "release" ? await api.coursewareOnlineTeachingRelease(previous.viewId)
        : await api.coursewareOnlineTeachingSave(previous.viewId, structuredClone(draft.current));
      if (generation.current !== request || current.current !== previous) return;
      if (next.ownerId !== ownerId || next.pageId !== previous.pageId) throw new Error("Invalid teaching view");
      // A remote read or lease response must never replace a local draft.
      if (kind !== "save" && !sameBaseline(previous, next)) throw new Error("TEACHING_CONFLICT");
      accept(next, kind === "save");
      if (kind === "save") { uncertainSave.current = false; setPendingSave(false); pendingCallback.current?.(false); setSaved(true); }
    } catch (failure) {
      if (generation.current === request && current.current === previous) {
        if (kind === "save" && String(failure).includes("COURSEWARE_ONLINE_TEACHING_PENDING_WRITE")) {
          uncertainSave.current = true; setPendingSave(true); pendingCallback.current?.(true); setError("pendingSave");
        } else {
          uncertainSave.current = false; setPendingSave(false); pendingCallback.current?.(false); setError(failureKey(failure));
          if (kind === "renew" || kind === "save") setLeaseLost(true);
        }
      }
    } finally {
      if (generation.current === request) { working.current = false; setBusy(false); }
    }
  };

  useEffect(() => {
    mountedOwner.current = ownerId;
    void load();
    return () => {
      mountedOwner.current = null;
      generation.current++;
      const previous = current.current;
      if (previous?.leaseExpiresAtEpochMillis) void api.coursewareOnlineTeachingRelease(previous.viewId).catch(() => {});
      dirtyCallback.current(false);
      pendingCallback.current?.(false);
    };
  }, [ownerId]);

  useEffect(() => {
    if (enabled && !loaded && !working.current) void load();
  }, [enabled, loaded]);

  useEffect(() => {
    if (!enabled || !view?.leaseExpiresAtEpochMillis || leaseLost || pendingSave) return;
    const remaining = view.leaseExpiresAtEpochMillis - Date.now();
    if (remaining <= 0) { setLeaseLost(true); setError("expired"); return; }
    const expiry = setTimeout(() => { if (current.current === view && !uncertainSave.current) { setLeaseLost(true); setError("expired"); } }, remaining);
    const renewal = setInterval(() => { if (!working.current) void operate("renew"); }, 20_000);
    return () => { clearTimeout(expiry); clearInterval(renewal); };
  }, [enabled, view, leaseLost, pendingSave]);

  return <aside className="courseware-teaching courseware-online-teaching" aria-label={t("panel.onlineTeaching.title")}>
    <h3>{t("panel.onlineTeaching.title")}</h3>
    {managePause && <CoursewareOnlineBarrierPanel ownerId={ownerId} enabled={barrierEnabled}
      blocked={dirty || pendingSave || busy} onHeldChange={value => { if (value) paused.current = true; setNativePaused(value); }} onResumed={() => { setTeachingPaused(false); void load(view?.pageId); }} />}
    {managePause && <CoursewareOnlinePauseRecovery ownerId={ownerId} enabled={enabled}
      blocked={dirty || pendingSave || busy || nativePaused} onHeldChange={setTeachingPaused} onResumed={() => { void load(view?.pageId); }} />}
    <p role="note">{t("panel.onlineTeaching.pageScope")}</p>
    {!enabled && <p role="status">{t("panel.onlineTeaching.disconnected")}</p>}
    <button type="button" disabled={!enabled || busy || pendingSave} onClick={() => void load(view?.pageId)}>{t("panel.onlineTeaching.refresh")}</button>
    {busy && <p role="status">{t("panel.onlineTeaching.working")}</p>}
    {error && <p role="alert">{t(`panel.onlineTeaching.${error}`)}</p>}
    {saved && <p role="status">{t("panel.onlineTeaching.saved")}</p>}
    {loaded && !view && !error && <p>{t("panel.onlineTeaching.empty")}</p>}
    {view && <>
      <label>{t("panel.onlineTeaching.page")}
        <select value={view.pageId} disabled={!enabled || busy || pendingSave} onChange={event => void load(event.target.value)}>
          {view.project.pages.map((page, index) => <option key={page.pageId} value={page.pageId}>{t("panel.onlineTeaching.pageOption", { page: index + 1 })}</option>)}
        </select>
      </label>
      <p role="status">{t(leased ? "panel.onlineTeaching.editing" : "panel.onlineTeaching.readOnly")}</p>
      {view.project.pages.find(page => page.pageId === view.pageId)?.locked && <p>{t("panel.onlineTeaching.locked")}</p>}
      <div className="courseware-teaching-actions">
        <button type="button" disabled={!enabled || busy || pendingSave || leased || writesPaused || view.project.pages.find(page => page.pageId === view.pageId)?.locked}
          onClick={() => void operate("acquire")}>{t("panel.onlineTeaching.edit")}</button>
        <button type="button" disabled={pendingSave ? !enabled || busy : !canEdit || !dirty || !valid} onClick={() => void operate("save")}>{t(pendingSave ? "panel.onlineTeaching.resumeSave" : "panel.onlineTeaching.save")}</button>
        <button type="button" disabled={!enabled || busy || pendingSave || !leased} onClick={() => void operate("release")}>{t("panel.onlineTeaching.release")}</button>
      </div>
      {dirty && <p role="note">{t("panel.onlineTeaching.unsaved")}</p>}
      {actions.map((action, index) => action.type === "speech" && typeof action.text === "string" ? <div key={String(action.id)}>
        <label>{t("panel.pptEditor.teachingSegment", { segment: index + 1 })}
          <textarea rows={5} maxLength={2500} disabled={!canEdit} value={action.text}
            onChange={event => change(actions.map((entry, position) => position === index ? replaceNarrationText(entry, event.target.value) : entry))} />
        </label>
        <label>{t("panel.pptEditor.teachingPauseAfterMs")}
          <input type="number" min={0} max={30000} step={1} disabled={!canEdit} value={typeof action.pauseAfterMs === "number" ? action.pauseAfterMs : 0}
            onChange={event => {
              const pause = event.target.valueAsNumber;
              if (!event.target.value || !Number.isInteger(pause) || pause < 0 || pause > 30000) return;
              change(actions.map((entry, position) => position === index ? { ...entry, pauseAfterMs: pause } : entry));
            }} />
        </label>
        <button type="button" disabled={!canEdit} onClick={() => change(actions.filter((_, position) => position !== index))}>{t("panel.onlineTeaching.removeSpeech")}</button>
      </div> : <p key={String(action.id)}>{t("panel.onlineTeaching.preservedAction", { type: String(action.type) })}</p>)}
      <button type="button" disabled={!canEdit || actions.length >= 1000} onClick={() => change([...actions, { id: crypto.randomUUID(), type: "speech", text: "" }])}>
        {t("panel.onlineTeaching.addSpeech")}
      </button>
      <p role="note">{t("panel.onlineTeaching.textScope")}</p>
    </>}
    {pendingPage && <div className="courseware-online-teaching-discard" role="group" aria-label={t("panel.onlineTeaching.discardTitle")}>
      <p>{t("panel.onlineTeaching.discardPrompt")}</p>
      <button type="button" disabled={busy} onClick={() => setPendingPage(null)}>{t("panel.onlineTeaching.keepDraft")}</button>
      <button type="button" disabled={busy || !enabled || pendingSave} onClick={() => void load(pendingPage.pageId, true)}>{t("panel.onlineTeaching.discardDraft")}</button>
    </div>}
  </aside>;
}
