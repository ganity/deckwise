import type { CoursewareAssetLocksView, CoursewareTeachingView } from "@pi-desktop/shared";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../lib/api";

export function CoursewareAssetLocks({ view, disabled, onActivity }: {
  view: CoursewareTeachingView; disabled: boolean; onActivity: (active: boolean) => void;
}) {
  const { t } = useTranslation();
  const [locks, setLocks] = useState<CoursewareAssetLocksView | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const request = useRef(0);
  const pending = useRef(false);
  useEffect(() => {
    request.current++; pending.current = false;
    setLocks(null); setWorking(false); setError("");
    return () => { request.current++; onActivity(false); };
  }, [view.viewId, onActivity]);

  const run = async (operation: () => Promise<CoursewareAssetLocksView>) => {
    if (disabled || pending.current) return;
    const current = ++request.current;
    pending.current = true; setWorking(true); onActivity(true); setError("");
    try {
      const next = await operation();
      if (current !== request.current) return;
      if (next.pageId !== view.pageId || next.sourceSha256 !== view.project.source.sha256)
        throw new Error(t("panel.pptEditor.assetLocksReload"));
      setLocks(next);
    } catch (failure) {
      if (current === request.current) { setLocks(null); setError(String(failure)); }
    } finally {
      if (current === request.current) { pending.current = false; setWorking(false); onActivity(false); }
    }
  };
  const set = (objectId: string, locked: boolean) => locks && run(() =>
    api.pptEditorAssetLockSet(view.viewId, view.project.teachingRevision, locks.revision, objectId, locked));
  return <details className="courseware-asset-locks">
    <summary>{t("panel.pptEditor.assetLocksTitle")}</summary>
    <p>{t("panel.pptEditor.assetLocksScope")}</p>
    <button type="button" disabled={disabled || working} onClick={() => void run(() =>
      api.pptEditorAssetLocksRead(view.viewId, view.project.teachingRevision))}>{t("panel.pptEditor.assetLocksRead")}</button>
    {error && <p role="alert">{error}</p>}
    {locks && <>
      {!locks.objects.length && <p role="status">{t("panel.pptEditor.assetLocksEmpty")}</p>}
      {locks.objects.map(object => <div key={object.objectId}>
        <label><input type="checkbox" checked={object.locked} disabled={disabled || working || (!object.eligible && !object.locked)}
          onChange={event => void set(object.objectId, event.target.checked)} />
          {t("panel.pptEditor.effectsObjectImage", { number: object.index })}</label>
        {!object.eligible && <p role="status">{t("panel.pptEditor.assetLocksUnsupported")}</p>}
      </div>)}
      {locks.staleLocks.length > 0 && <p role="status">{t("panel.pptEditor.assetLocksStale")}</p>}
      {locks.staleLocks.map(object => <div key={object.objectId}>
        <code>{object.assetSha256.slice(0, 12)}</code>{" "}
        <button type="button" disabled={disabled || working} onClick={() => void set(object.objectId, false)}>
          {t("panel.pptEditor.assetLocksRemoveStale")}</button>
      </div>)}
    </>}
  </details>;
}
