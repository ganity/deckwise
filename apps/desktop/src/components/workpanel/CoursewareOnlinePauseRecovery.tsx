import type { CoursewareOnlinePauseView } from "@pi-desktop/shared";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../lib/api";

type Props = {
  ownerId: string;
  enabled: boolean;
  blocked: boolean;
  onHeldChange(held: boolean): void;
  onResumed(): void;
};
type Scope = Props & { mounted: boolean; busy: boolean; view: CoursewareOnlinePauseView | null };
type Display = { scope: Scope | null; checked: boolean; busy: boolean; view: CoursewareOnlinePauseView | null; error: string };
const empty = { scope: null, checked: false, busy: false, view: null, error: "" } satisfies Display;

/** Recover an existing teaching pause; native PPT editing has its own lifecycle. */
export function CoursewareOnlinePauseRecovery(props: Props) {
  const { t } = useTranslation();
  const current = useRef<Scope | null>(null);
  if (!current.current || current.current.ownerId !== props.ownerId || current.current.enabled !== props.enabled)
    current.current = { ...props, mounted: false, busy: false, view: null };
  const scope = current.current;
  Object.assign(scope, props);
  const [display, setDisplay] = useState<Display>(empty);
  const value = display.scope === scope ? display : empty;
  const active = () => current.current === scope && scope.mounted && scope.enabled;

  const check = async () => {
    if (!active() || scope.busy) return;
    scope.busy = true;
    setDisplay(previous => ({ ...(previous.scope === scope ? previous : empty), scope, busy: true, error: "" }));
    try {
      const next = await api.coursewareOnlinePauseRead(scope.ownerId);
      if (!active()) return;
      if (next && next.ownerId !== scope.ownerId) throw new Error("Invalid pause owner");
      scope.view = next;
      setDisplay({ scope, checked: true, busy: false, view: next, error: "" });
      scope.onHeldChange(!!next);
    } catch {
      if (active()) setDisplay({ scope, checked: true, busy: false, view: scope.view, error: "pauseRecoverFailed" });
    } finally { scope.busy = false; }
  };

  const resume = async (view: CoursewareOnlinePauseView | null) => {
    if (!active() || scope.busy || scope.blocked || !view || scope.view !== view) return;
    scope.busy = true;
    setDisplay({ scope, checked: true, busy: true, view, error: "" });
    try {
      await api.coursewareOnlinePauseResume(view.viewId);
      if (!active() || scope.view !== view) return;
      scope.view = null;
      setDisplay({ scope, checked: true, busy: false, view: null, error: "" });
      scope.onHeldChange(false);
      scope.onResumed();
    } catch {
      // Keep the exact view for an explicit retry if the resume response was lost.
      if (active()) setDisplay({ scope, checked: true, busy: false, view, error: "pauseResumeFailed" });
    } finally { scope.busy = false; }
  };

  useEffect(() => {
    scope.mounted = true;
    scope.onHeldChange(false);
    setDisplay({ ...empty, scope });
    if (scope.enabled) void check();
    return () => {
      scope.mounted = false;
      scope.onHeldChange(false);
    };
  }, [scope]);

  return <section className="courseware-online-teaching-discard" aria-label={t("panel.onlineTeaching.pauseRecoveryTitle")}>
    <h3>{t("panel.onlineTeaching.pauseRecoveryTitle")}</h3>
    {value.busy && <p role="status">{t("panel.onlineTeaching.pauseChecking")}</p>}
    {value.error && <p role="alert">{t(`panel.onlineTeaching.${value.error}`)}</p>}
    {value.view ? <>
      <p>{t("panel.onlineTeaching.pauseHeld", { revision: value.view.teachingRevision, epoch: value.view.sessionEpoch })}</p>
      <p role="note">{t("panel.onlineTeaching.pauseScope")}</p>
      {props.blocked && <p role="note">{t("panel.onlineTeaching.pauseBlocked")}</p>}
      <button type="button" disabled={!props.enabled || value.busy || props.blocked}
        onClick={() => void resume(value.view)}>{t("panel.onlineTeaching.pauseResume")}</button>
    </> : value.checked && !value.error && <p role="status">{t("panel.onlineTeaching.pauseNotHeld")}</p>}
    <button type="button" disabled={!props.enabled || value.busy} onClick={() => void check()}>{t("panel.onlineTeaching.pauseCheck")}</button>
  </section>;
}
