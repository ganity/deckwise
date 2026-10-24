import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
import { createMediaCanvasDocument, parseMediaCanvasDocument, type MediaCanvasDocument, type MediaCanvasChatRequest, type MediaCanvasReference } from "../../lib/courseware-media-canvas";
import { CoursewareMediaCanvas } from "./CoursewareMediaCanvas";
import { CoursewareCanvasImages } from "./CoursewareCanvasImages";
import { CoursewareCanvasMusic } from "./CoursewareCanvasMusic";

type LocalDraft = {
  sessionId: string;
  projectId: string;
  revision: string | null;
  document: MediaCanvasDocument;
  serial: number;
  savedSerial: number;
  error: string;
  queue: Promise<void>;
};

// Retain failed, unsaved edits across tab/session switches until explicit discard.
const retained = new Map<string, LocalDraft>();

export function CoursewareMediaCanvasTab({ sessionId }: { sessionId?: string }) {
  const { t } = useTranslation();
  const isRunning = useAppStore(state => state.isRunning);
  const [, repaint] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [discardConfirmed, setDiscardConfirmed] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [references, setReferences] = useState<{ sessionId: string; values: MediaCanvasReference[] } | null>(null);
  const [referencesLoading, setReferencesLoading] = useState(false);
  const [referencesError, setReferencesError] = useState("");
  const scope = useRef<LocalDraft | null>(null);
  const mounted = useRef(false);
  const activeSession = useRef(sessionId); activeSession.current = sessionId;
  const request = useRef(0);
  const referenceRequest = useRef(0);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    referenceRequest.current++; setReferences(null); setReferencesLoading(false); setReferencesError("");
    const unsubscribe = api.onAuthChanged(() => {
      referenceRequest.current++; setReferences(null); setReferencesLoading(false); setReferencesError("");
    });
    return () => { referenceRequest.current++; unsubscribe(); };
  }, [sessionId]);

  useEffect(() => {
    const id = ++request.current;
    const existing = sessionId ? retained.get(sessionId) : undefined;
    scope.current = existing ?? null;
    setError(""); setDiscardConfirmed(false);
    if (!sessionId || isRunning || existing && (existing.error || existing.serial !== existing.savedSerial)) {
      setLoading(false); repaint(value => value + 1); return;
    }
    setLoading(true);
    void api.coursewareMediaCanvasGet(sessionId).then(result => {
      if (!mounted.current || id !== request.current || activeSession.current !== sessionId) return;
      const document = result.document ? parseMediaCanvasDocument(result.document, result.projectId) : createMediaCanvasDocument(result.projectId);
      const next: LocalDraft = { sessionId, projectId: result.projectId, revision: result.revision, document,
        serial: 0, savedSerial: 0, error: "", queue: Promise.resolve() };
      retained.set(sessionId, next); scope.current = next; repaint(value => value + 1);
    }).catch(failure => {
      if (mounted.current && id === request.current) setError(String(failure));
    }).finally(() => { if (mounted.current && id === request.current) setLoading(false); });
  }, [sessionId, isRunning, refresh]);

  const notify = (draft: LocalDraft) => {
    if (mounted.current && scope.current === draft) repaint(value => value + 1);
  };
  const save = (document: MediaCanvasDocument) => {
    const draft = scope.current;
    if (!draft || !sessionId || isRunning || loading || draft.error || document.projectId !== draft.projectId) return;
    draft.document = document;
    const serial = ++draft.serial;
    notify(draft);
    draft.queue = draft.queue.then(async () => {
      if (serial !== draft.serial || draft.error) return;
      try {
        const result = await api.coursewareMediaCanvasSet(sessionId, draft.revision, document);
        if (result.projectId !== draft.projectId || !result.document || result.revision === null) throw new Error("Invalid canvas save response");
        parseMediaCanvasDocument(result.document, draft.projectId);
        draft.revision = result.revision; draft.savedSerial = serial;
      } catch (failure) { draft.error = String(failure); }
      finally { notify(draft); }
    });
  };
  const editInChat = async (change: MediaCanvasChatRequest) => {
    const draft = scope.current, store = useAppStore.getState();
    if (!sessionId || !draft || draft.error || draft.serial !== draft.savedSerial || loading ||
      store.activeSessionId !== sessionId || store.isRunning || change.projectId !== draft.projectId ||
      !draft.document.drafts.some(item => item.id === change.draftId && item.revision === change.expectedRevision)) {
      throw new Error(t("panel.mediaCanvas.chatUnavailable"));
    }
    const accepted = await store.sendPrompt([
      "Update the existing media canvas draft using courseware_canvas_get and courseware_canvas_edit tools.",
      `Project: ${change.projectId}; draft: ${change.draftId}; expected draft revision: ${change.expectedRevision}.`,
      `Requested change: ${change.instruction}`,
      "Read the latest saved draft first. If the draft revision changed, explain the conflict instead of overwriting it.",
      "Change only the selected draft prompt, name or references. Do not generate media, call paid suppliers, or change slides.",
    ].join("\n"), undefined, sessionId);
    if (!accepted) throw new Error(t("panel.mediaCanvas.chatUnavailable"));
  };
  const local = scope.current?.sessionId === sessionId ? scope.current : null;
  const unsaved = !!local && local.serial !== local.savedSerial;
  const failed = !!local?.error;
  return <div className="courseware-media-canvas-tab">
    {!sessionId && <p>{t("panel.mediaCanvas.sessionRequired")}</p>}
    {loading && <p role="status">{t("panel.mediaCanvas.loading")}</p>}
    {error && <p role="alert">{error}</p>}
    {sessionId && <button type="button" disabled={loading || isRunning || unsaved || failed} onClick={() => setRefresh(value => value + 1)}>{t("panel.mediaCanvas.reload")}</button>}
    {sessionId && <button type="button" disabled={loading || isRunning || referencesLoading} onClick={async () => {
      const id = ++referenceRequest.current;
      setReferences(null); setReferencesLoading(true); setReferencesError("");
      try {
        const [images, candidates] = await Promise.all([
          api.coursewareSceneImageList(sessionId), api.coursewareCanvasImageList(sessionId),
        ]);
        if (!mounted.current || id !== referenceRequest.current || activeSession.current !== sessionId) return;
        setReferences({ sessionId, values: [
          ...images.filter(image => image.current && image.selected && image.asset).map(image => ({
            assetId: image.intentId, revision: image.asset!.sha256, label: `${image.pageId} · ${image.target.kind === "layer" ? image.target.name : image.target.kind}`,
          })),
          ...candidates.filter(image => image.phase === "submitted" && image.asset && ["image/png", "image/jpeg"].includes(image.asset.mimeType)).map(image => ({
            assetId: `canvas-image:${image.intentId}`, revision: image.asset!.sha256,
            label: `${image.draft.title} · ${image.asset!.sha256.slice(0, 12)}`,
          })),
        ] });
      } catch (failure) { if (mounted.current && id === referenceRequest.current) setReferencesError(String(failure)); }
      finally { if (mounted.current && id === referenceRequest.current) setReferencesLoading(false); }
    }}>{t("panel.mediaCanvas.loadReferences")}</button>}
    {referencesLoading && <p role="status">{t("panel.mediaCanvas.loadingReferences")}</p>}
    {referencesError && <p role="alert">{referencesError}</p>}
    {references && references.sessionId === sessionId && references.values.length === 0 && <p>{t("panel.mediaCanvas.noReferences")}</p>}
    {local && <CoursewareMediaCanvas document={local.document} onChange={save} saveState={failed ? "error" : unsaved ? "saving" : "saved"}
      saveError={local.error} disabled={loading || isRunning || failed} references={references && references.sessionId === sessionId ? references.values : []} onEditInChat={editInChat} />}
    {local && sessionId && <CoursewareCanvasImages sessionId={sessionId} revision={local.revision} document={local.document}
      disabled={loading || isRunning || failed || unsaved} />}
    {local && sessionId && <CoursewareCanvasMusic sessionId={sessionId} revision={local.revision} document={local.document}
      disabled={loading || isRunning || failed || unsaved} />}
    {local && failed && <section aria-label={t("panel.mediaCanvas.recovery")}>
      <p>{t("panel.mediaCanvas.recoveryHint")}</p>
      <textarea aria-label={t("panel.mediaCanvas.copyDraft")} readOnly rows={5} value={JSON.stringify(local.document, null, 2)} />
      <button type="button" disabled={loading || isRunning} onClick={() => {
        local.error = ""; save(local.document);
      }}>{t("panel.mediaCanvas.retrySave")}</button>
      <label><input type="checkbox" checked={discardConfirmed} onChange={event => setDiscardConfirmed(event.target.checked)} />{t("panel.mediaCanvas.confirmDiscard")}</label>
      <button type="button" disabled={!discardConfirmed || loading || isRunning} onClick={() => {
        if (!sessionId || !discardConfirmed) return;
        retained.delete(sessionId); scope.current = null; setDiscardConfirmed(false); setRefresh(value => value + 1);
      }}>{t("panel.mediaCanvas.discardReload")}</button>
    </section>}
  </div>;
}
