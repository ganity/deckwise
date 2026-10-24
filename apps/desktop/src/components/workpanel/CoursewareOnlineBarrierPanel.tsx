import type { CoursewareOnlineBarrierView } from "@pi-desktop/shared";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../lib/api";

type Props = { ownerId: string; enabled: boolean; blocked: boolean; onHeldChange(held: boolean): void; onResumed(): void };
type Scope = Props & { mounted: boolean; busy: boolean; readRequired: boolean; view: CoursewareOnlineBarrierView | null };
type Display = { scope: Scope | null; busy: boolean; uncertain: boolean; view: CoursewareOnlineBarrierView | null; error: boolean };
const empty: Display = { scope: null, busy: false, uncertain: false, view: null, error: false };

export function CoursewareOnlineBarrierPanel(props: Props) {
  const { t } = useTranslation();
  const current = useRef<Scope | null>(null);
  if (!current.current || current.current.ownerId !== props.ownerId || current.current.enabled !== props.enabled)
    current.current = { ...props, mounted: false, busy: false, readRequired: false, view: null };
  const scope = current.current;
  Object.assign(scope, props);
  const [display, setDisplay] = useState<Display>(empty);
  const value = display.scope === scope ? display : empty;
  const active = () => current.current === scope && scope.mounted && scope.enabled;
  const operate = async (kind: "read" | "start" | "resume", view = scope.view) => {
    if (!active() || scope.busy || kind !== "read" && (scope.blocked || scope.readRequired || !view || scope.view !== view)) return;
    if (kind === "start" && !view?.canStart || kind === "resume" && view?.uncertain) return;
    scope.busy = true;
    if (kind === "start") scope.onHeldChange(true);
    setDisplay(previous => ({ ...(previous.scope === scope ? previous : empty), scope, busy: true, error: false }));
    try {
      const next = kind === "read" ? await api.coursewareOnlineBarrierRead(scope.ownerId)
        : kind === "start" ? await api.coursewareOnlineBarrierStart(view!.viewId) : await api.coursewareOnlineBarrierResume(view!.viewId);
      if (!active()) return;
      if (next.ownerId !== scope.ownerId) throw new Error("Invalid barrier owner");
      scope.view = next;
      scope.readRequired = false;
      setDisplay({ scope, busy: false, uncertain: next.uncertain, view: next, error: false });
      scope.onHeldChange(next.teachingPaused || next.uncertain);
      if (kind === "resume" && !next.teachingPaused) scope.onResumed();
    } catch {
      if (active()) {
        if (kind !== "read") scope.readRequired = true;
        setDisplay({ scope, busy: false, uncertain: kind !== "read" || scope.readRequired || !!scope.view?.uncertain, view: scope.view, error: true });
      }
    } finally { scope.busy = false; }
  };
  useEffect(() => {
    scope.mounted = true;
    setDisplay({ ...empty, scope });
    if (scope.enabled) void operate("read");
    return () => { scope.mounted = false; };
  }, [scope]);

  const view = value.view;
  return <section className="courseware-online-teaching-discard" aria-label={t("panel.onlineBarrier.title")}>
    <h3>{t("panel.onlineBarrier.title")}</h3>
    <p role="note">{t("panel.onlineBarrier.incompleteProof")}</p>
    {view && <p role="status">{t(`panel.onlineBarrier.${view.state === "idle" ? "title" : view.state}`)} {t("panel.onlineBarrier.counts", { held: view.held, total: view.total })}</p>}
    {value.busy && <p role="status">{t("panel.onlineBarrier.starting")}</p>}
    {value.error && <p role="alert">{t("panel.onlineBarrier.error")}</p>}
    {value.uncertain && <p role="alert">{t("panel.onlineBarrier.uncertain")}</p>}
    <button type="button" disabled={!props.enabled || value.busy} onClick={() => void operate("read")}>{t("panel.onlineBarrier.refresh")}</button>
    <button type="button" disabled={!props.enabled || props.blocked || scope.readRequired || value.busy || !view?.canStart || view.state !== "idle" && view.state !== "released" || view.state === "released" && view.teachingPaused}
      onClick={() => void operate("start", view)}>{t(view?.uncertain ? "panel.onlineEditing.retry" : "panel.onlineBarrier.start")}</button>
    <button type="button" disabled={!props.enabled || props.blocked || scope.readRequired || value.busy || !view || view.uncertain || !view.teachingPaused && (view.state === "idle" || view.state === "released")}
      onClick={() => void operate("resume", view)}>{t("panel.onlineBarrier.resume")}</button>
  </section>;
}
