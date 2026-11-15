import { useRef, useState, type PointerEvent } from "react";
import { useTranslation } from "react-i18next";
import { ZoomIn, ZoomOut, X } from "lucide-react";
import {
  MEDIA_CANVAS_KINDS, addMediaCanvasDraft, editMediaCanvasDraft, moveMediaCanvasDraft,
  removeMediaCanvasDraft, setMediaCanvasViewport, zoomMediaCanvasViewport,
  type MediaCanvasDocument, type MediaCanvasReference, type MediaCanvasChatRequest,
} from "../../lib/courseware-media-canvas";
import "../../styles/courseware-media-canvas.css";

export type CoursewareMediaCanvasProps = {
  document: MediaCanvasDocument;
  onChange(document: MediaCanvasDocument): void;
  saveState: "saved" | "saving" | "error";
  saveError?: string;
  disabled?: boolean;
  references?: MediaCanvasReference[];
  onEditInChat?(request: MediaCanvasChatRequest): Promise<void>;
};

export function CoursewareMediaCanvas({ document, onChange, saveState, saveError, disabled = false, references = [], onEditInChat }: CoursewareMediaCanvasProps) {
  const { t } = useTranslation();
  const [selection, setSelection] = useState<{ projectId: string; id: string } | null>(null);
  const [instruction, setInstruction] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const current = useRef(document); current.current = document;
  const chatSequence = useRef(0);
  const drag = useRef<{ pointerId: number; projectId: string; id?: string; startX: number; startY: number; x: number; y: number; zoom: number } | null>(null);
  const selected = selection?.projectId === document.projectId ? document.drafts.find(draft => draft.id === selection.id) : undefined;
  const blocked = disabled || sending;
  const publish = (next: MediaCanvasDocument) => { if (!disabled) { current.current = next; onChange(next); } };
  const begin = (event: PointerEvent<HTMLElement>, id?: string) => {
    if (blocked || event.button !== 0) return;
    if (!id && event.target !== event.currentTarget) return;
    event.preventDefault(); event.stopPropagation(); event.currentTarget.setPointerCapture(event.pointerId);
    const draft = id ? current.current.drafts.find(item => item.id === id) : undefined;
    if (id && !draft) return;
    setSelection(id ? { projectId: document.projectId, id } : null); setInstruction(""); setError("");
    drag.current = { pointerId: event.pointerId, projectId: document.projectId, id, startX: event.clientX, startY: event.clientY,
      x: draft?.x ?? document.viewport.x, y: draft?.y ?? document.viewport.y, zoom: document.viewport.zoom };
  };
  const move = (event: PointerEvent<HTMLElement>) => {
    const target = drag.current, latest = current.current;
    if (!target || target.pointerId !== event.pointerId || target.projectId !== latest.projectId || blocked) return;
    const dx = event.clientX - target.startX, dy = event.clientY - target.startY;
    const bound = (value: number) => Math.max(-100_000, Math.min(100_000, value));
    if (target.id) {
      if (latest.drafts.some(draft => draft.id === target.id)) publish(moveMediaCanvasDraft(latest, target.id, bound(target.x + dx / target.zoom), bound(target.y + dy / target.zoom)));
    } else publish(setMediaCanvasViewport(latest, { ...latest.viewport, x: bound(target.x + dx), y: bound(target.y + dy) }));
  };
  const end = () => { drag.current = null; };
  const edit = (patch: Parameters<typeof editMediaCanvasDraft>[3]) => {
    if (!selected || blocked) return;
    publish(editMediaCanvasDraft(current.current, selected.id, selected.revision, patch));
  };
  const zoom = (factor: number, x = 0, y = 0) => {
    if (!blocked) publish(setMediaCanvasViewport(current.current, zoomMediaCanvasViewport(current.current.viewport, current.current.viewport.zoom * factor, x, y)));
  };
  return <section className="courseware-media-canvas" aria-label={t("panel.mediaCanvas.title")}>
    <header className="courseware-media-canvas-toolbar">
      <strong>{t("panel.mediaCanvas.title")}</strong>
      {MEDIA_CANVAS_KINDS.map(kind => <button type="button" key={kind} disabled={blocked || document.drafts.length >= 100} onClick={() => {
        const id = crypto.randomUUID();
        publish(addMediaCanvasDraft(current.current, id, kind, t(`panel.mediaCanvas.${kind}`)));
        setSelection({ projectId: document.projectId, id }); setInstruction("");
      }}>{t(`panel.mediaCanvas.add${kind[0].toUpperCase()}${kind.slice(1)}`)}</button>)}
      <button type="button" disabled={blocked || document.viewport.zoom <= 0.2} title={t("panel.mediaCanvas.zoomOut")} aria-label={t("panel.mediaCanvas.zoomOut")} onClick={() => zoom(1 / 1.2)}><ZoomOut size={16} /></button>
      <output aria-label={t("panel.mediaCanvas.zoom")}>{Math.round(document.viewport.zoom * 100)}%</output>
      <button type="button" disabled={blocked || document.viewport.zoom >= 3} title={t("panel.mediaCanvas.zoomIn")} aria-label={t("panel.mediaCanvas.zoomIn")} onClick={() => zoom(1.2)}><ZoomIn size={16} /></button>
      <button type="button" disabled={blocked} onClick={() => publish(setMediaCanvasViewport(current.current, { x: 24, y: 24, zoom: 1 }))}>{t("panel.mediaCanvas.resetView")}</button>
    </header>
    <p className="courseware-media-canvas-hint">{t("panel.mediaCanvas.draftHint")}</p>
    <p role={saveState === "error" ? "alert" : "status"}>{t(`panel.mediaCanvas.${saveState}`)} {saveState === "error" ? saveError : ""}</p>
    <div className="courseware-media-canvas-body">
      <div className="courseware-media-canvas-viewport" role="group" aria-label={t("panel.mediaCanvas.board")} tabIndex={0}
        onPointerDown={event => begin(event)} onPointerMove={move} onPointerUp={end} onPointerCancel={end} onLostPointerCapture={end}
        onWheel={event => {
          if (blocked || !event.ctrlKey) return;
          event.preventDefault();
          const bounds = event.currentTarget.getBoundingClientRect();
          zoom(event.deltaY < 0 ? 1.1 : 1 / 1.1, event.clientX - bounds.left, event.clientY - bounds.top);
        }}>
        <div className="courseware-media-canvas-plane" style={{ transform: `translate(${document.viewport.x}px, ${document.viewport.y}px) scale(${document.viewport.zoom})` }}>
          {document.drafts.map(draft => <button type="button" key={draft.id} className="courseware-media-canvas-draft"
            aria-pressed={selected?.id === draft.id} disabled={blocked} style={{ left: draft.x, top: draft.y }}
            onFocus={() => { setSelection({ projectId: document.projectId, id: draft.id }); setInstruction(""); }}
            onPointerDown={event => begin(event, draft.id)} onPointerMove={move} onPointerUp={end} onPointerCancel={end} onLostPointerCapture={end}
            onClick={() => setSelection({ projectId: document.projectId, id: draft.id })}
            onKeyDown={event => {
              const delta = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
              if (!delta || blocked) return;
              event.preventDefault();
              const step = event.shiftKey ? 20 : 5;
              publish(moveMediaCanvasDraft(current.current, draft.id, Math.max(-100_000, Math.min(100_000, draft.x + delta[0] * step)), Math.max(-100_000, Math.min(100_000, draft.y + delta[1] * step))));
            }}>
            <span>{t(`panel.mediaCanvas.${draft.kind}`)}</span><strong>{draft.title}</strong>
            <span>{draft.prompt || t("panel.mediaCanvas.emptyPrompt")}</span>
            <small>{t("panel.mediaCanvas.referenceCount", { count: draft.references.length })}</small>
          </button>)}
        </div>
      </div>
      <aside className="courseware-media-canvas-properties" aria-label={t("panel.mediaCanvas.properties")}>
        {selected ? <>
          <label>{t("panel.mediaCanvas.name")}<input value={selected.title} maxLength={160} disabled={blocked}
            onChange={event => { if (event.target.value.trim()) edit({ title: event.target.value }); }} /></label>
          <label>{t(selected.kind === "music" ? "panel.canvasMusic.lyrics" : "panel.mediaCanvas.prompt")}<textarea value={selected.prompt} maxLength={16_000} rows={7} disabled={blocked}
            onChange={event => edit({ prompt: event.target.value })} /></label>
          <label>{t("panel.mediaCanvas.reference")}<select value="" disabled={blocked || selected.references.length >= 16} onChange={event => {
            const reference = references.find(item => item.assetId === event.target.value);
            if (reference && !selected.references.some(item => item.assetId === reference.assetId)) edit({ references: [...selected.references, reference] });
          }}><option value="">{t("panel.mediaCanvas.chooseReference")}</option>
            {references.filter(reference => !selected.references.some(item => item.assetId === reference.assetId)).map(reference => <option key={reference.assetId} value={reference.assetId}>{reference.label}</option>)}
          </select></label>
          <ul>{selected.references.map(reference => <li key={reference.assetId}>{reference.label} <button type="button" disabled={blocked}
            title={t("panel.mediaCanvas.removeReference", { name: reference.label })} aria-label={t("panel.mediaCanvas.removeReference", { name: reference.label })} onClick={() => edit({ references: selected.references.filter(item => item.assetId !== reference.assetId) })}><X size={14} /></button></li>)}</ul>
          <label>{t("panel.mediaCanvas.chatInstruction")}<textarea rows={3} disabled={blocked || !onEditInChat} value={instruction}
            onChange={event => setInstruction(event.target.value)} /></label>
          <button type="button" disabled={blocked || !onEditInChat || !instruction.trim() || saveState !== "saved"} onClick={async () => {
            if (blocked || !onEditInChat || !instruction.trim() || saveState !== "saved") return;
            const request = ++chatSequence.current, projectId = document.projectId, draftId = selected.id;
            setSending(true); setError("");
            try {
              await onEditInChat({ projectId, draftId, expectedRevision: selected.revision, instruction: instruction.trim() });
              if (request === chatSequence.current && current.current.projectId === projectId) setInstruction("");
            } catch (failure) { if (request === chatSequence.current && current.current.projectId === projectId) setError(String(failure)); }
            finally { if (request === chatSequence.current) setSending(false); }
          }}>{t("panel.mediaCanvas.editInChat")}</button>
          <button type="button" disabled={blocked} onClick={() => { publish(removeMediaCanvasDraft(current.current, selected.id)); setSelection(null); }}>{t("panel.mediaCanvas.removeDraft")}</button>
        </> : <p>{t("panel.mediaCanvas.selectHint")}</p>}
        {error && <p role="alert">{error}</p>}
      </aside>
    </div>
  </section>;
}
