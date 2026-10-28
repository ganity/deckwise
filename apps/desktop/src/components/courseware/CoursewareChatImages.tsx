import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { sceneAssetBlockers, type CoursewareSceneImagePreview,
  type CoursewareSceneImageView, type CoursewareScenePlanSnapshot } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
import { CoursewareSceneThumbnail } from "./CoursewareSceneThumbnail";

export function CoursewareChatImages({ sessionId, plan, disabled, refreshKey = 0, onContinue }: {
  sessionId: string; plan: CoursewareScenePlanSnapshot; disabled: boolean; refreshKey?: number; onContinue: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<CoursewareSceneImageView[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<CoursewareSceneImagePreview | null>(null);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [pageId, setPageId] = useState(plan.pages[0].pageId);
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(false);
  const [previewError, setPreviewError] = useState("");
  const [listError, setListError] = useState("");
  const [authRevision, setAuthRevision] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const panel = useRef<HTMLElement>(null);
  const active = useRef(true), working = useRef(false), generation = useRef(0);
  const current = () => active.current && useAppStore.getState().activeSessionId === sessionId;
  useEffect(() => {
    if (!panel.current) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width < 540) setLeftCollapsed(true);
      if (entry.contentRect.width < 360) setRightCollapsed(true);
    });
    observer.observe(panel.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    active.current = true;
    const unsubscribe = api.onAuthChanged(() => {
      generation.current++; setRows([]); setPreview(null); setFocusedId(null); setError(""); setPreviewError("");
      working.current = false; setBusy(false); setAuthRevision(value => value + 1);
    });
    return () => { active.current = false; generation.current++; unsubscribe(); };
  }, []);
  useEffect(() => {
    let disposed = false, loading = false;
    const epoch = generation.current;
    const valid = () => !disposed && epoch === generation.current && current();
    const load = async () => {
      if (loading || !valid()) return;
      loading = true;
      try {
        const values = (await api.coursewareSceneImageList(sessionId)).filter(row => row.current && row.planSha256 === plan.sha256);
        for (let index = 0; index < values.length; index++) {
          if (!valid()) return;
          const row = values[index];
          if (!row.asset && !["prepared", "rejected"].includes(row.phase))
            values[index] = await api.coursewareSceneImageStatus(sessionId, row.intentId);
        }
        if (valid()) { setRows(values); setListError(""); }
      } catch (failure) { if (valid()) setListError(String(failure)); }
      finally { loading = false; }
    };
    void load();
    const timer = window.setInterval(() => void load(), 3000);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [sessionId, plan.sha256, refreshKey, refresh, authRevision]);
  const focusedPage = plan.pages.find(page => page.pageId === pageId) ?? plan.pages[0];
  const pageRows = rows.filter(row => row.pageId === focusedPage.pageId);
  const masterFor = (values: CoursewareSceneImageView[]) => {
    const masters = values.filter(row => row.target.kind === "visualMaster");
    return masters.find(row => row.selected) ?? masters.filter(row => row.asset).at(-1) ?? masters.at(-1);
  };
  const focused = pageRows.find(row => row.intentId === focusedId) ?? masterFor(pageRows) ?? pageRows[0];
  const shownPreview = preview?.image.intentId === focused?.intentId &&
    (!focused?.asset || preview?.image.asset?.sha256 === focused.asset.sha256) ? preview : null;
  const previewReady = !!focused && (!!focused.asset || focused.task?.state === "ready" && focused.task.feeState === "settled");
  useEffect(() => {
    let disposed = false;
    const epoch = generation.current;
    setPreview(null); setPreviewError("");
    if (focused && previewReady) {
      const request = focused.asset ? api.coursewareSceneImagePreview(sessionId, focused.intentId) : api.coursewareSceneImageArchive(sessionId, focused.intentId);
      void request.then(value => {
        if (!disposed && epoch === generation.current && current()) setPreview(value);
      }).catch(failure => { if (!disposed && epoch === generation.current && current()) setPreviewError(String(failure)); });
    }
    return () => { disposed = true; };
  }, [sessionId, plan.sha256, focused?.intentId, focused?.asset?.sha256, previewReady, refresh, authRevision]);
  const run = async (operation: (valid: () => boolean) => Promise<void>) => {
    if (working.current || disabled || useAppStore.getState().runningSessions[sessionId] || !current()) return;
    const epoch = generation.current;
    const valid = () => current() && generation.current === epoch;
    working.current = true; setBusy(true); setError("");
    try { await operation(valid); }
    catch (failure) { if (valid()) setError(String(failure)); }
    finally { if (valid()) { working.current = false; setBusy(false); setRefresh(value => value + 1); } }
  };
  const status = (row: CoursewareSceneImageView) => t(`coursewareWorkflow.imageState.${row.selected ? "selected" : row.asset ? "ready" : row.task?.state ?? row.phase}`);
  const blockers = sceneAssetBlockers(plan, rows);
  const blocked = disabled || busy;
  const cover = masterFor(rows.filter(row => row.pageId === plan.pages[0].pageId));
  const styleSelected = !!cover?.selected;
  const styleReady = !!cover && (!!cover.asset || cover.task?.state === "ready" && cover.task.feeState === "settled");
  const isCover = focused?.pageId === plan.pages[0].pageId && focused.target.kind === "visualMaster";
  const index = plan.pages.indexOf(focusedPage);
  const choosePage = (id: string) => { setPageId(id); setFocusedId(null); setError(""); };
  const hint = disabled ? "sceneRunning" : !styleSelected ? styleReady ? "sceneStyleReview" :
    !cover || cover.phase === "prepared" ? "sceneNeedsGeneration" : "sceneCoverPending" : blockers.length ? "scenePaused" : "readyToBuild";
  return <section className={`courseware-scene-preview${leftCollapsed ? " left-collapsed" : ""}${rightCollapsed ? " right-collapsed" : ""}`}
    ref={panel} aria-label={t("coursewareWorkflow.imagePreview")}>
    <header className="courseware-scene-toolbar">
      <strong>{t("coursewareWorkflow.imagePreview")}</strong>
      <button type="button" className="courseware-scene-icon" aria-label={t("coursewareWorkflow.imagePages")} aria-expanded={!leftCollapsed}
        title={t("coursewareWorkflow.imagePages")} onClick={() => {
          setLeftCollapsed(value => !value);
          if (leftCollapsed && panel.current && panel.current.clientWidth < 540) setRightCollapsed(true);
        }}>{leftCollapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}</button>
      <button type="button" className="courseware-scene-icon" aria-label={t("coursewareWorkflow.imageDetails")} aria-expanded={!rightCollapsed}
        title={t("coursewareWorkflow.imageDetails")} onClick={() => {
          setRightCollapsed(value => !value);
          if (rightCollapsed && panel.current && panel.current.clientWidth < 540) setLeftCollapsed(true);
        }}>{rightCollapsed ? <PanelRightOpen size={16} /> : <PanelRightClose size={16} />}</button>
      <button type="button" className="courseware-scene-icon" aria-label={t("coursewareWorkflow.refresh")}
        onClick={() => setRefresh(value => value + 1)}><RefreshCw size={15} /></button>
    </header>
    <div className="courseware-scene-workspace">
      <nav className="courseware-scene-pages" aria-label={t("coursewareWorkflow.imagePages")}>
        <div className="courseware-scene-section-heading">{t("coursewareWorkflow.pages", { count: plan.pages.length })}</div>
        {plan.pages.map((page, pageIndex) => {
          const master = masterFor(rows.filter(row => row.pageId === page.pageId));
          return <button type="button" key={page.pageId} data-scene-page={page.pageId}
            aria-current={page.pageId === focusedPage.pageId ? "page" : undefined} onClick={() => choosePage(page.pageId)}>
            <CoursewareSceneThumbnail key={`${master?.intentId}-${authRevision}`} sessionId={sessionId} image={master} pageNumber={pageIndex + 1} />
            <span className="courseware-scene-page-title">{pageIndex + 1}. {page.title}</span>
            <small>{master ? status(master) : t("coursewareWorkflow.imageNotPrepared")}</small>
          </button>;
        })}
      </nav>
      <main className="courseware-scene-main">
        <div className="courseware-scene-nav">
          <button type="button" className="courseware-scene-icon" disabled={index === 0} aria-label={t("coursewareWorkflow.previousPage")}
            onClick={() => choosePage(plan.pages[index - 1].pageId)}><ChevronLeft size={16} /></button>
          <span><b>{index + 1}</b> / {plan.pages.length}</span>
          <button type="button" className="courseware-scene-icon" disabled={index === plan.pages.length - 1} aria-label={t("coursewareWorkflow.nextPage")}
            onClick={() => choosePage(plan.pages[index + 1].pageId)}><ChevronRight size={16} /></button>
        </div>
        <div className="courseware-scene-canvas">
          <div className="courseware-scene-preview-stage" aria-busy={previewReady && !shownPreview && !previewError}>
            {shownPreview ? <img src={shownPreview.dataUrl} alt={t("coursewareWorkflow.previewAlt")} onError={() => {
              setPreview(null); setPreviewError(t("coursewareWorkflow.previewLoadFailed"));
            }} /> : <div className="courseware-scene-placeholder">
              <p role="status">{previewError ? t("coursewareWorkflow.previewLoadFailed") : previewReady ? t("coursewareWorkflow.loadingPreview") :
                focused ? status(focused) : t("coursewareWorkflow.imageNotPrepared")}</p>
              {previewError && <button type="button" onClick={() => setRefresh(value => value + 1)}>{t("coursewareWorkflow.retryPreview")}</button>}
            </div>}
          </div>
          <strong className="courseware-scene-canvas-title">{focusedPage.title}</strong>
          {focused && <small>{t(`coursewareWorkflow.${focused.target.kind}`)}{focused.target.kind === "layer" ? ` · ${focused.target.name}` : ""}</small>}
        </div>
        <footer className="courseware-scene-progress">
          <p role="status">{t(`coursewareWorkflow.${hint}`)}</p>
          {!styleSelected && focusedPage.pageId !== plan.pages[0].pageId && <button type="button" onClick={() => choosePage(plan.pages[0].pageId)}>
            {t("coursewareWorkflow.openCover")}</button>}
          <small>{t(blockers.length ? "coursewareWorkflow.assetProgress" : "coursewareWorkflow.readyToBuild", { count: rows.filter(row => row.selected).length })}</small>
        </footer>
      </main>
      <aside className="courseware-scene-inspector" aria-label={t("coursewareWorkflow.imageDetails")}>
        <div className="courseware-scene-section-heading">{t("coursewareWorkflow.imageDetails")}</div>
        <div className="courseware-scene-inspector-content">
          {(error || listError || previewError) && <p role="alert" className="courseware-workflow-error">{
            /COURSEWARE_SCENE_IMAGE_MODEL_UNAVAILABLE/.test(error) ? t("coursewareWorkflow.imageModelUnavailable") : error || listError || previewError}</p>}
          <div className="courseware-scene-assets" role="group" aria-label={t("coursewareWorkflow.pageAssets")}>
            {pageRows.map(row => <button type="button" key={row.intentId} aria-pressed={row.intentId === focused?.intentId}
              data-scene-image-intent={row.intentId} onClick={() => setFocusedId(row.intentId)}>
              <span>{t(`coursewareWorkflow.${row.target.kind}`)}{row.target.kind === "layer" ? ` · ${row.target.name}` : ""}</span>
              <small role="status">{status(row)}</small>
            </button>)}
          </div>
          {focused?.task?.errorCode && <p role="alert">{focused.task.errorCode}</p>}
          {focused?.target.kind !== "layer" && <section className="courseware-scene-preview-text" aria-label={t("coursewareWorkflow.pageText")}>
            <strong>{t("coursewareWorkflow.pageText")}</strong>
            {focusedPage.visibleText.map((text, textIndex) => <p key={textIndex}>{text}</p>)}
            <small>{t("coursewareWorkflow.pageTextHint")}</small>
          </section>}
          <details className="courseware-scene-intent"><summary>{t("panel.scenePlan.visualIntent")}</summary><p>{focusedPage.visualIntent}</p></details>
          {plan.visualBible && <details className="courseware-scene-intent"><summary>{t("coursewareWorkflow.visualBible")}</summary>
            {Object.values(plan.visualBible).map((text, textIndex) => <p key={textIndex}>{text}</p>)}
          </details>}
        </div>
        <div className="courseware-scene-actions">
          {focused?.phase === "prepared" && <button type="button" className="courseware-scene-primary" disabled={blocked || !styleSelected && !isCover}
            onClick={() => void run(async valid => {
              await api.coursewareSceneImageGenerate(sessionId, focused.intentId);
              if (valid()) await onContinue();
            })}>{t("coursewareWorkflow.submitImage")}</button>}
          {shownPreview && focused && isCover && !focused.selected && <button type="button" className="courseware-scene-primary"
            disabled={blocked || !shownPreview.image.current || !styleSelected && !isCover} onClick={() => void run(async valid => {
              const target = shownPreview.image.target;
              const previous = rows.find(row => row.selected && row.pageId === shownPreview.image.pageId && row.target.kind === target.kind &&
                (target.kind !== "layer" || row.target.kind === "layer" && row.target.name === target.name));
              const values = await api.coursewareSceneImageAdopt(sessionId, shownPreview.image.intentId, previous?.intentId ?? null);
              if (!valid()) return;
              setRows(values); await onContinue();
            })}>{t("coursewareWorkflow.confirmStyle")}</button>}
          {!disabled && (!styleReady || styleSelected) && <button type="button" disabled={blocked}
            onClick={() => void run(async valid => { if (valid()) await onContinue(); })}>{t("coursewareWorkflow.continue")}</button>}
        </div>
      </aside>
    </div>
  </section>;
}
