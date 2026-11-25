import type { CoursewareOnlineSourceDecisions, CoursewareOnlineSourceReviewResult, CoursewareOnlineSourceReviewView } from "@pi-desktop/shared";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../lib/api";
import { CoursewareOnlineBarrierPanel } from "./CoursewareOnlineBarrierPanel";
import { CoursewareOnlinePauseRecovery } from "./CoursewareOnlinePauseRecovery";
import { CoursewareOnlineSourceReview } from "./CoursewareOnlineSourceReview";
import { CoursewarePlaybackPanel } from "./CoursewarePlaybackPanel";
import { useAppStore } from "../../stores/app-store";

type OnlineState = Awaited<ReturnType<typeof api.coursewareOnlineState>>;
type SourceOperation = { ownerId: string; sessionId: string; busy: boolean; reviewed?: boolean; view?: CoursewareOnlineSourceReviewView };
type SourceDisplay = { operation: SourceOperation; error: "failed" | "requiresPause" | null; result?: CoursewareOnlineSourceReviewResult };

/** Native sync notifications are not server archive receipts. */
export function CoursewareOnlineEditor({ projectId, onClose, manageTeachingPause = false }: { projectId: string; onClose(): void; manageTeachingPause?: boolean }) {
  const { t } = useTranslation();
  const sessionId = useAppStore(state => state.activeSessionId);
  const currentSession = useRef(sessionId); currentSession.current = sessionId;
  const surface = useRef<HTMLDivElement>(null);
  const active = useRef<{ ownerId: string } | null>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<OnlineState["status"]>("opening");
  const [unavailable, setUnavailable] = useState(false);
  const [failureKey, setFailureKey] = useState<"error" | "inactive" | "readOnly" | "accessChanged">("error");
  const [ownerId, setOwnerId] = useState<string | null>(null);
  const [nativePaused, setNativePaused] = useState(false);
  const sourceAllowed = useRef(false);
  sourceAllowed.current = manageTeachingPause && !unavailable && ["ready", "sync-pending", "sync-reported"].includes(status);
  const sourceOperation = useRef<SourceOperation | null>(null);
  const [sourceDisplay, setSourceDisplay] = useState<SourceDisplay | null>(null);
  const currentSource = (operation: SourceOperation) => sourceOperation.current === operation &&
    active.current?.ownerId === operation.ownerId && currentSession.current === operation.sessionId;
  const clearSource = () => {
    const operation = sourceOperation.current; sourceOperation.current = null;
    if (operation?.view) {
      const viewId = operation.view.viewId;
      void api.coursewareFixedCancel().then(() => api.coursewareOnlineSourceClear({ viewId })).catch(() => {});
    }
  };
  const cancelSource = async (operation: SourceOperation) => {
    if (!currentSource(operation) || operation.busy) return;
    operation.busy = true; setSourceDisplay(previous => previous && { ...previous });
    try {
      await api.coursewareFixedCancel();
      if (!currentSource(operation)) return;
      if (operation.view) await api.coursewareOnlineSourceClear({ viewId: operation.view.viewId });
      if (!currentSource(operation)) return;
      await api.coursewareOnlineSetVisible(operation.ownerId, true);
      if (!currentSource(operation)) return;
      sourceOperation.current = null; setSourceDisplay(null);
    } catch {
      if (currentSource(operation)) { operation.busy = false; setSourceDisplay({ operation, error: "failed" }); }
    }
  };
  const beginSource = async () => {
    const current = active.current;
    if (!current || current.ownerId !== ownerId || !sessionId || currentSession.current !== sessionId || !sourceAllowed.current || sourceOperation.current ||
        unavailable || !["ready", "sync-pending", "sync-reported"].includes(status)) return;
    const operation: SourceOperation = { ownerId: current.ownerId, sessionId, busy: true };
    sourceOperation.current = operation; setSourceDisplay({ operation, error: null });
    let requiresPause = false;
    try {
      await api.coursewareOnlineSetVisible(operation.ownerId, false);
      if (!currentSource(operation)) return;
      const barrier = await api.coursewareOnlineBarrierRead(operation.ownerId);
      if (!currentSource(operation)) return;
      if (!barrier.teachingPaused || barrier.state !== "held" || barrier.uncertain) { requiresPause = true; throw new Error("Review requires held pause"); }
      const view = await api.coursewareOnlineSourceBegin({ ownerId: operation.ownerId, sessionId: operation.sessionId });
      if (!currentSource(operation) || view.ownerId !== operation.ownerId) {
        void api.coursewareOnlineSourceClear({ viewId: view.viewId }).catch(() => {});
        if (currentSource(operation)) throw new Error("Invalid review owner");
        return;
      }
      operation.view = view;
      operation.busy = false; setSourceDisplay({ operation, error: null });
    } catch {
      if (currentSource(operation)) { operation.busy = false; setSourceDisplay({ operation, error: requiresPause ? "requiresPause" : "failed" }); }
    }
  };
  const resolveSource = async (operation: SourceOperation, decisions: CoursewareOnlineSourceDecisions) => {
    if (!currentSource(operation) || operation.busy || operation.reviewed || !operation.view) return;
    operation.busy = true; setSourceDisplay({ operation, error: null });
    try {
      const result = await api.coursewareOnlineSourceResolve({ viewId: operation.view.viewId, decisions });
      if (!currentSource(operation)) return;
      if (result.ownerId !== operation.ownerId || result.viewId !== operation.view.viewId || result.status !== "reviewed" ||
          !Number.isInteger(result.readyPages) || result.readyPages < 0 || result.readyPages > result.totalPages ||
          result.totalPages !== operation.view.targetPages.length) throw new Error("Invalid review result");
      operation.busy = false; operation.reviewed = true; setSourceDisplay({ operation, error: null, result });
    } catch {
      if (currentSource(operation)) { operation.busy = false; setSourceDisplay({ operation, error: "failed" }); }
    }
  };
  const previewSource = async (operation: SourceOperation, side: "original" | "target", id: string) => {
    if (!currentSource(operation) || operation.busy || operation.reviewed || !operation.view) throw new Error("Review changed");
    const page = side === "original" ? operation.view.previousPages.find(value => value.pageId === id)?.pageNumber
      : operation.view.targetPages.find(value => value.importPageId === id)?.pageNumber;
    if (page === undefined) throw new Error("Review changed");
    const value = await api.coursewareOnlineSourcePreview({ viewId: operation.view.viewId, side, page });
    if (!currentSource(operation)) throw new Error("Review changed");
    return value.image;
  };

  const leave = (kind: "back" | "retry") => {
    clearSource(); setSourceDisplay(null);
    if (kind === "back") { close.current(); return; }
    if (!active.current) return;
    active.current = null;
    setStatus("opening");
    setAttempt(value => value + 1);
  };

  useEffect(() => {
    clearSource(); setSourceDisplay(null);
    const current = { ownerId: crypto.randomUUID() };
    active.current = current;
    setOwnerId(current.ownerId);
    setNativePaused(false);
    setStatus("opening");
    setUnavailable(false);
    setFailureKey("error");
    let accessEnded = false;
    const accept = (next: OnlineState) => {
      if (accessEnded || active.current !== current || next.ownerId !== current.ownerId || next.projectId !== projectId) return;
      if (next.status === "error" && ["COURSEWARE_ONLINE_READ_ONLY", "COURSEWARE_ONLINE_ACCESS_CHANGED", "COURSEWARE_ONLINE_SESSION_INACTIVE"]
        .includes(next.errorCode ?? "")) {
        accessEnded = true;
        sourceAllowed.current = false;
        clearSource(); setSourceDisplay(null);
        setOwnerId(null);
        setNativePaused(false);
      }
      setUnavailable(!next.available);
      setFailureKey(next.errorCode === "PLATFORM_46200" || next.errorCode === "COURSEWARE_ONLINE_PLATFORM_46200" || next.errorCode === "COURSEWARE_ONLINE_SESSION_INACTIVE" ? "inactive"
        : next.errorCode === "COURSEWARE_ONLINE_READ_ONLY" ? "readOnly"
          : next.errorCode === "COURSEWARE_ONLINE_ACCESS_CHANGED" ? "accessChanged" : "error");
      setStatus(next.status === "closed" ? "error" : next.status);
      if (next.available && next.status !== "closed" && next.status !== "error") {
        void api.coursewareOnlineSetVisible(current.ownerId, !sourceOperation.current).catch(() => {});
      }
    };
    const unsubscribe = api.onCoursewareOnlineState(accept);
    const unsubscribeAuth = api.onAuthChanged(() => {
      if (active.current !== current) return;
      clearSource();
      active.current = null;
      void api.coursewareOnlineClose(current.ownerId).catch(() => {});
      close.current();
    });
    void api.coursewareOnlineOpen(current.ownerId, projectId).then(next => {
      if (active.current !== current) return;
      if (!next.available) { setUnavailable(true); setStatus("error"); return; }
      accept(next);
    }, () => {
      if (active.current === current) setStatus("error");
    });
    return () => {
      clearSource();
      if (active.current === current) active.current = null;
      unsubscribe();
      unsubscribeAuth();
      void api.coursewareOnlineSetVisible(current.ownerId, false).catch(() => {});
      void api.coursewareOnlineClose(current.ownerId).catch(() => {});
    };
  }, [projectId, attempt]);

  useEffect(() => {
    const host = surface.current;
    const current = active.current;
    if (!host || !current) return;
    let frame = 0;
    const report = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (active.current !== current) return;
        const { x, y, width, height } = host.getBoundingClientRect();
        void api.coursewareOnlineSetBounds(current.ownerId, { x, y, width, height }).catch(() => {});
      });
    };
    const observer = new ResizeObserver(report);
    observer.observe(host);
    window.addEventListener("resize", report);
    report();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", report);
      cancelAnimationFrame(frame);
    };
  }, [projectId, attempt]);

  useEffect(() => {
    if (sourceOperation.current && sourceOperation.current.sessionId !== sessionId) {
      clearSource(); setSourceDisplay(null);
      if (active.current) void api.coursewareOnlineSetVisible(active.current.ownerId, true).catch(() => {});
    }
  }, [sessionId]);
  const source = sourceDisplay && currentSource(sourceDisplay.operation) ? sourceDisplay : null;

  const statusKey = status === "sync-pending" ? "syncPending" : status === "sync-reported" ? "syncReported"
    : status === "ready" ? "ready" : status === "opening" ? "opening" : "error";
  return <section className="ppt-editor-tab courseware-online-editor" style={{ display: "flex", flexDirection: "column" }} aria-label={t("panel.onlineEditing.title")}>
    <header className="ppt-editor-toolbar" style={{ flexShrink: 0 }}>
      <div className="ppt-editor-document">
        <strong>{t("panel.onlineEditing.title")}</strong>
        <span role="status" title={t(`panel.onlineEditing.${statusKey}`)}>{t(`panel.onlineEditing.${statusKey}`)}</span>
      </div>
      {status === "error" && !unavailable && <button type="button" onClick={() => leave("retry")}>{t("panel.onlineEditing.retry")}</button>}
      <button type="button" onClick={() => leave("back")}>{t("panel.onlineEditing.back")}</button>
    </header>
    {(status === "error" || unavailable) && <p role="alert">{t(unavailable ? "panel.onlineEditing.unavailable" : `panel.onlineEditing.${failureKey}`)}</p>}
    {manageTeachingPause && !source && <div className="courseware-online-teaching-discard">
      <p role="note">{t("panel.onlineSource.savedScope")}</p>
      <button type="button" disabled={!sessionId || !ownerId || unavailable ||
        !["ready", "sync-pending", "sync-reported"].includes(status)} onClick={() => void beginSource()}>{t("panel.onlineSource.begin")}</button>
    </div>}
    {source && <div className="courseware-source-review" style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 12, marginTop: 0 }}>
      <p role="note">{t("panel.onlineSource.savedScope")}</p>
      {source.operation.busy && <p role="status">{t("panel.onlineSource.working")}</p>}
      {source.error && <p role="alert">{t(`panel.onlineSource.${source.error}`)}</p>}
      {source.result ? <>
        <p role="status">{t("panel.onlineSource.reviewed", { ready: source.result.readyPages, total: source.result.totalPages })}</p>
        <CoursewarePlaybackPanel key={`${source.result.viewId}:${source.operation.sessionId}`} sessionId={source.operation.sessionId}
          onlineSource={{ viewId: source.result.viewId, ownerId: source.result.ownerId, teamProjectId: projectId,
            readyPages: source.result.readyPages, totalPages: source.result.totalPages }}
          enabled={!source.operation.busy && sourceAllowed.current} onActiveChange={() => {}} />
        <button type="button" disabled={source.operation.busy} onClick={() => void cancelSource(source.operation)}>{t("panel.onlineSource.returnToEditor")}</button>
      </> : source.operation.view ? <CoursewareOnlineSourceReview view={source.operation.view} disabled={source.operation.busy}
        onConfirm={decisions => void resolveSource(source.operation, decisions)} onCancel={() => void cancelSource(source.operation)}
        onPreview={id => previewSource(source.operation, "target", id)} onOriginalPreview={id => previewSource(source.operation, "original", id)} />
        : <button type="button" disabled={source.operation.busy} onClick={() => void cancelSource(source.operation)}>{t("panel.pptEditor.sourceReviewCancel")}</button>}
    </div>}
    <div className="ppt-editor-body" style={{ flex: 1, display: source ? "none" : undefined }}>
      <div className="ppt-editor-surface" ref={surface} />
      {ownerId && manageTeachingPause && !source && <aside className="courseware-teaching">
        <CoursewareOnlineBarrierPanel key={ownerId} ownerId={ownerId}
          enabled={!unavailable && status !== "opening"} blocked={false}
          onHeldChange={setNativePaused} onResumed={() => setNativePaused(false)} />
        <CoursewareOnlinePauseRecovery key={`pause:${ownerId}`} ownerId={ownerId}
          enabled={["ready", "sync-pending", "sync-reported"].includes(status)}
          blocked={nativePaused} onHeldChange={() => {}} onResumed={() => {}} />
      </aside>}
    </div>
  </section>;
}
