import DOMPurify from "dompurify";
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  MousePointer2,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Save,
  Undo2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";

type Slide = { name: string; ok: boolean; error?: string; mtime: number; annotation_count: number };
type Annotation = { element_id: string; tag: string; annotation: string };
type SlideData = { content: string; annotations: Annotation[]; mtime: number; undo_depth: number; warnings?: { icon?: string }[] };
type Attr = { name: string; value: string };
const SKIP = new Set(["defs", "style", "title", "desc"]);

function safeSvg(content: string) {
  const sanitized = DOMPurify.sanitize(content, {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS: ["foreignObject"],
    ADD_ATTR: ["href", "xlink:href", "data-icon", "data-use-x", "data-use-y", "data-use-has-transform"],
  });
  const parsed = new DOMParser().parseFromString(sanitized, "image/svg+xml");
  const hasExternalCssResource = (value: string) => /@import\b|url\(\s*(['"]?)(?!#|data:image\/)[^)]+\1\s*\)/i.test(value);
  parsed.querySelectorAll("style").forEach((node) => {
    if (hasExternalCssResource(node.textContent ?? "")) node.remove();
  });
  parsed.querySelectorAll("*").forEach((node) => {
    for (const attr of Array.from(node.attributes)) {
      if (attr.name.toLowerCase() === "style" && hasExternalCssResource(attr.value)) node.removeAttribute(attr.name);
    }
  });
  parsed.querySelectorAll("[href], [xlink\\:href]").forEach((node) => {
    for (const name of ["href", "xlink:href"]) {
      const value = node.getAttribute(name);
      if (value && !value.startsWith("#") && !/^data:image\/(?:png|jpeg|gif|webp);base64,/i.test(value)) node.removeAttribute(name);
    }
  });
  return new XMLSerializer().serializeToString(parsed.documentElement);
}

async function inlineImages(content: string, request: <T>(route: string) => Promise<T>) {
  const parsed = new DOMParser().parseFromString(content, "image/svg+xml");
  if (parsed.querySelector("parsererror")) return content;
  const refs = [...parsed.querySelectorAll("image[href], image[xlink\\:href], use[href], use[xlink\\:href]")];
  await Promise.all(refs.map(async (node) => {
    const attr = node.hasAttribute("href") ? "href" : "xlink:href";
    const href = node.getAttribute(attr) ?? "";
    if (!href.startsWith("../images/") && !href.startsWith("images/")) return;
    const path = href.replace(/^\.\.\//, "");
    const result = await request<{ dataUrl: string }>(`/${path.split("/").map(encodeURIComponent).join("/")}`);
    node.setAttribute(attr, result.dataUrl);
  }));
  return new XMLSerializer().serializeToString(parsed.documentElement);
}

function selectionTarget(target: EventTarget | null, root: SVGSVGElement) {
  let node = target instanceof Element ? target : null;
  while (node && node !== root) {
    if (node.id && !SKIP.has(node.localName.toLowerCase())) return node as SVGElement;
    node = node.parentElement;
  }
  return null;
}

function attrsForMove(el: SVGGraphicsElement, dx: number, dy: number) {
  const matrix = el.transform.baseVal.consolidate()?.matrix;
  const parent = el.parentElement as SVGGraphicsElement | null;
  const ctm = parent?.getScreenCTM();
  let x = dx;
  let y = dy;
  if (ctm) {
    try {
      const inverse = ctm.inverse();
      x = inverse.a * dx + inverse.c * dy;
      y = inverse.b * dx + inverse.d * dy;
    } catch { /* Singular parent transforms use screen-space deltas. */ }
  }
  const current = matrix
    ? new DOMMatrix([matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f])
    : new DOMMatrix();
  const next = new DOMMatrix().translate(x, y).multiply(current);
  return `matrix(${[next.a, next.b, next.c, next.d, next.e, next.f].map((n) => Math.round(n * 1e6) / 1e6).join(",")})`;
}

function geometry(element: SVGGraphicsElement) {
  try {
    const box = element.getBBox();
    const matrix = element.getCTM();
    if (!matrix) return { x: box.x, y: box.y, width: box.width, height: box.height };
    const point = new DOMPoint(box.x, box.y).matrixTransform(matrix);
    const edge = new DOMPoint(box.x + box.width, box.y + box.height).matrixTransform(matrix);
    return { x: point.x, y: point.y, width: edge.x - point.x, height: edge.y - point.y };
  } catch { return { x: 0, y: 0, width: 0, height: 0 }; }
}

export function SvgEditorTab({
  path,
  tabId,
}: {
  path: string;
  tabId: string;
}) {
  const [slides, setSlides] = useState<Slide[]>([]);
  const [current, setCurrent] = useState("");
  const [slide, setSlide] = useState<SlideData | null>(null);
  const [selection, setSelection] = useState<string[]>([]);
  const [annotation, setAnnotation] = useState("");
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [externalChange, setExternalChange] = useState(false);
  const [saved, setSaved] = useState(false);
  const [annotationDirty, setAnnotationDirty] = useState(false);
  const [hasStagedEdits, setHasStagedEdits] = useState(false);
  const [live, setLive] = useState(false);
  const [overlap, setOverlap] = useState<{ x: number; y: number; items: SVGElement[] } | null>(null);
  const [rubber, setRubber] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(false);
  const canvasRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ x: number; y: number; moved: boolean; starts: Map<string, { element: SVGGraphicsElement; matrix: DOMMatrix; inverse: DOMMatrix }>; box?: boolean } | null>(null);
  const editQueueRef = useRef<Promise<unknown>>(Promise.resolve());
  const loadVersionRef = useRef(0);
  const suppressClickRef = useRef(false);
  const currentRef = useRef(current);
  const slideRef = useRef(slide);
  currentRef.current = current;
  slideRef.current = slide;
  const { t } = useTranslation();
  const closeTab = useAppStore((store) => store.closeWorkPanelTab);
  const request = useCallback(<T,>(route: string, method: "GET" | "POST" | "DELETE" = "GET", body?: unknown) =>
    api.pptPreviewRequest<T>(path, route, method, body), [path]);
  const index = slides.findIndex((item) => item.name === current);
  const root = canvasRef.current?.querySelector("svg") as SVGSVGElement | null;
  const selected = useMemo(() => selection.map((id) => root?.querySelector<SVGElement>(`#${CSS.escape(id)}`)).filter((el): el is SVGElement => !!el), [selection, slide]);
  const selectedBox = selected.length === 1 && selected[0] instanceof SVGGraphicsElement ? geometry(selected[0]) : null;
  const svgMarkup = useMemo(() => ({ __html: slide ? safeSvg(slide.content) : "" }), [slide?.content]);
  const loadSlides = useCallback(async (initial = false) => {
    try {
      const config = await request<{ live?: boolean }>("/api/config");
      setLive(Boolean(config.live));
      const result = await request<{ slides: Slide[] }>("/api/slides");
      setSlides(result.slides ?? []);
      const currentName = currentRef.current;
      const chosen = currentName && result.slides.some((item) => item.name === currentName)
        ? currentName
        : result.slides[0]?.name ?? "";
      if (!currentName && chosen) setCurrent(chosen);
      const active = result.slides.find((item) => item.name === currentName);
      if (active && slideRef.current && active.mtime !== slideRef.current.mtime) setExternalChange(true);
      if (initial && !chosen) setBusy(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
    }
  }, [request]);

  const loadSlide = useCallback(async (name: string) => {
    if (!name) return;
    const version = ++loadVersionRef.current;
    if (name !== currentRef.current || !slideRef.current) setBusy(true);
    setError("");
    try {
      const data = await request<SlideData>(`/api/slide/${encodeURIComponent(name)}`);
      data.content = await inlineImages(data.content, (route) => request(route));
      if (version !== loadVersionRef.current || name !== currentRef.current) return;
      setSlide(data);
      setExternalChange(false);
    } catch (cause) {
      if (version === loadVersionRef.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (version === loadVersionRef.current) setBusy(false);
    }
  }, [request]);

  useEffect(() => {
    let active = true;
    void api.pptPreviewOpen(path).then(() => { if (active) return loadSlides(true); }).catch((cause) => {
      if (active) { setError(cause instanceof Error ? cause.message : String(cause)); setBusy(false); }
    });
    return () => { active = false; };
  }, [path, loadSlides]);

  useEffect(() => {
    if (!current) return;
    void loadSlide(current);
  }, [current, loadSlide]);

  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(() => void loadSlides(), 2000);
    return () => window.clearInterval(timer);
  }, [live, loadSlides]);

  useEffect(() => {
    if (!hasStagedEdits && !annotationDirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [hasStagedEdits, annotationDirty]);

  useEffect(() => {
    if (!selection.length) return;
    const selectedElement = root?.querySelector<SVGElement>(`#${CSS.escape(selection[0]!)}`);
    if (selection.length === 1 && selectedElement) setAnnotation(slide?.annotations.find((item) => item.element_id === selectedElement.id)?.annotation ?? "");
    if (selection.length > 1) setAnnotation("");
  }, [selection, slide, root]);

  useEffect(() => {
    const svg = canvasRef.current?.querySelector("svg");
    if (!svg || !slide) return;
    svg.querySelectorAll("*").forEach((element) => {
      if (!SKIP.has(element.localName.toLowerCase())) element.classList.add("svg-editor-selectable");
      element.classList.toggle("svg-editor-selected", selection.includes((element as SVGElement).id));
      element.classList.remove("svg-editor-hovered");
      element.classList.toggle("svg-editor-annotated", slide.annotations.some((item) => item.element_id === (element as SVGElement).id));
    });
  }, [slide?.content, slide?.annotations, selection]);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement) return;
      if (event.key === "Escape") { setSelection([]); setOverlap(null); return; }
      if (event.key === "Home") { event.preventDefault(); setSelection([]); setCurrent(slides[0]?.name ?? ""); }
      if (event.key === "End") { event.preventDefault(); setSelection([]); setCurrent(slides.at(-1)?.name ?? ""); }
      if (event.key === "ArrowLeft" && !selection.length) { event.preventDefault(); setSelection([]); setCurrent(slides[Math.max(0, index - 1)]?.name ?? ""); }
      if (event.key === "ArrowRight" && !selection.length) { event.preventDefault(); setSelection([]); setCurrent(slides[Math.min(slides.length - 1, index + 1)]?.name ?? ""); }
      if (event.key === "ArrowUp" || event.key === "ArrowDown" || (event.key === "ArrowLeft" && selection.length) || (event.key === "ArrowRight" && selection.length)) {
        event.preventDefault();
        const delta = event.shiftKey ? 10 : 1;
        void moveSelected(event.key === "ArrowLeft" ? -delta : event.key === "ArrowRight" ? delta : 0, event.key === "ArrowUp" ? -delta : event.key === "ArrowDown" ? delta : 0);
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") { event.preventDefault(); void undo(); }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  });

  const selectElement = (element: SVGElement, additive: boolean) => {
    if (!element.id) return;
    setSelection((old) => additive ? old.includes(element.id) ? old.filter((id) => id !== element.id) : [...old, element.id] : [element.id]);
  };

  const onCanvasClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (suppressClickRef.current) { suppressClickRef.current = false; return; }
    const svg = canvasRef.current?.querySelector("svg") as SVGSVGElement | null;
    if (!svg) return;
    const target = selectionTarget(event.target, svg);
    if (!target) { if (!event.ctrlKey && !event.metaKey) setSelection([]); return; }
    if (event.altKey) {
      const group = target.parentElement?.closest("g[id]") as SVGElement | null;
      if (group) { selectElement(group, false); return; }
    }
    selectElement(target, event.ctrlKey || event.metaKey);
  };

  const onCanvasContextMenu = (event: React.MouseEvent<HTMLDivElement>) => {
    const svg = canvasRef.current?.querySelector("svg") as SVGSVGElement | null;
    if (!svg) return;
    const items = document.elementsFromPoint(event.clientX, event.clientY)
      .map((node) => selectionTarget(node, svg)).filter((item): item is SVGElement => !!item?.id)
      .filter((item, idx, all) => all.findIndex((candidate) => candidate.id === item.id) === idx);
    if (items.length > 1) { event.preventDefault(); setOverlap({ x: event.clientX, y: event.clientY, items }); }
  };

  const stageOnly = async (element: SVGElement, payload: { text?: string; attrs?: Record<string, string | null>; promote_tspan?: { x: string; y: string } }) => {
    const name = current;
    const operation = editQueueRef.current.then(() => request<{ undo_depth?: number }>(`/api/slide/${encodeURIComponent(name)}/edit`, "POST", { element_id: element.id, ...payload }));
    editQueueRef.current = operation.catch(() => undefined);
    try {
      const result = await operation;
      setHasStagedEdits(true);
      setSaved(false);
      if (name === currentRef.current) setSlide((old) => old ? { ...old, undo_depth: result.undo_depth ?? old.undo_depth + 1 } : old);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      void loadSlide(name);
      throw cause;
    }
  };
  const stage = async (element: SVGElement, payload: { text?: string; attrs?: Record<string, string | null>; promote_tspan?: { x: string; y: string } }) => {
    if (payload.text !== undefined) element.textContent = payload.text;
    for (const [key, value] of Object.entries(payload.attrs ?? {})) {
      if (value === null) element.removeAttribute(key); else element.setAttribute(key, value);
    }
    await stageOnly(element, payload);
    if (payload.promote_tspan) await loadSlide(current);
  };

  const moveSelected = async (dx: number, dy: number) => {
    if (!root || !slide) return;
    const nodes = selected.filter((el) => !selected.some((parent) => parent !== el && parent.contains(el)));
    for (const element of nodes) {
      const transform = attrsForMove(element as SVGGraphicsElement, dx, dy);
      element.setAttribute("transform", transform);
      await stageOnly(element, { attrs: { transform } });
    }
  };

  const undo = async () => {
    if (!current || !slide?.undo_depth) return;
    await editQueueRef.current;
    await request(`/api/slide/${encodeURIComponent(current)}/undo`, "POST", {});
    await loadSlide(current);
  };

  const save = async () => {
    if (!window.confirm(t("panel.svgEditor.saveConfirm"))) return;
    setBusy(true);
    try {
      await editQueueRef.current;
      const result = await request<{ status?: string; error?: string; files_modified?: string[] }>("/api/save-all", "POST", {});
      if (result.error) throw new Error(result.error);
      setAnnotationDirty(false); setHasStagedEdits(false); setSaved(true); await loadSlides();
    }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };

  const addAnnotation = async () => {
    const note = annotation.trim();
    if (!note || !selection.length) return;
    for (const element_id of selection) await request(`/api/slide/${encodeURIComponent(current)}/annotate`, "POST", { element_id, annotation: note });
    setAnnotationDirty(true);
    setSaved(false);
    setSlide((old) => old ? { ...old, annotations: [...old.annotations.filter((item) => !selection.includes(item.element_id)), ...selection.map((element_id) => ({ element_id, tag: "", annotation: note }))] } : old);
    setSlides((old) => old.map((item) => item.name === current ? { ...item, annotation_count: selection.length } : item));
    setAnnotation("");
  };

  const removeAnnotation = async (id: string) => {
    await request(`/api/slide/${encodeURIComponent(current)}/annotate/${encodeURIComponent(id)}`, "DELETE");
    setAnnotationDirty(true);
    setSaved(false);
    setSlide((old) => old ? { ...old, annotations: old.annotations.filter((item) => item.element_id !== id) } : old);
  };

  const changeAttribute = async (element: SVGElement, name: string, value: string) => {
    if (name.toLowerCase().startsWith("on") || name === "id" || name === "href" || name === "xlink:href") return;
    await stage(element, { attrs: { [name]: value } });
  };

  const changeGeometry = async (element: SVGGraphicsElement, key: "x" | "y" | "width" | "height", value: number) => {
    if (!Number.isFinite(value)) return;
    const box = geometry(element);
    const parent = element.parentElement as SVGGraphicsElement | null;
    const parentMatrix = parent?.getCTM();
    const currentMatrix = element.getCTM();
    if (!parentMatrix || !currentMatrix) return;
    const sx = key === "width" && box.width ? Math.max(0.001, value / box.width) : 1;
    const sy = key === "height" && box.height ? Math.max(0.001, value / box.height) : 1;
    const dx = key === "x" ? value - box.x : 0;
    const dy = key === "y" ? value - box.y : 0;
    const adjustment = new DOMMatrix().translate(dx + box.x * (1 - sx), dy + box.y * (1 - sy)).scale(sx, sy);
    const local = parentMatrix.inverse().multiply(adjustment).multiply(currentMatrix);
    await stage(element, { attrs: { transform: `matrix(${[local.a, local.b, local.c, local.d, local.e, local.f].map((n) => Math.round(n * 1e6) / 1e6).join(",")})` } });
  };

  const promoteTspan = async (element: SVGElement) => {
    const parent = element.parentElement;
    if (element.localName !== "tspan" || parent?.localName !== "text") return;
    let x = Number(parent.getAttribute("x")?.match(/-?\d+(?:\.\d+)?/)?.[0] ?? NaN);
    let y = Number(parent.getAttribute("y")?.match(/-?\d+(?:\.\d+)?/)?.[0] ?? NaN);
    for (const child of Array.from(parent.children)) {
      if (child.localName !== "tspan") continue;
      const childX = child.getAttribute("x")?.match(/-?\d+(?:\.\d+)?/)?.[0];
      const childY = child.getAttribute("y")?.match(/-?\d+(?:\.\d+)?/)?.[0];
      const dx = child.getAttribute("dx")?.match(/-?\d+(?:\.\d+)?/)?.[0];
      const dy = child.getAttribute("dy")?.match(/-?\d+(?:\.\d+)?/)?.[0];
      if (childX) x = Number(childX); else if (dx) x += Number(dx);
      if (childY) y = Number(childY); else if (dy) y += Number(dy);
      if (child === element) break;
    }
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const own = (element as SVGTSpanElement).transform.baseVal.consolidate()?.matrix;
    const sx = Number(element.getAttribute("x")?.match(/-?\d+(?:\.\d+)?/)?.[0] ?? NaN);
    const sy = Number(element.getAttribute("y")?.match(/-?\d+(?:\.\d+)?/)?.[0] ?? NaN);
    if (Number.isFinite(sx)) x = sx;
    if (Number.isFinite(sy)) y = sy;
    if (own) { x += own.e; y += own.f; }
    await stage(element, { text: element.textContent ?? "", promote_tspan: { x: String(x), y: String(y) } });
  };

  const exitPreview = async () => {
    if ((hasStagedEdits || annotationDirty) && !window.confirm(t("panel.svgEditor.exitConfirm"))) return;
    try { await request("/api/shutdown", "POST", {}); closeTab(tabId); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };

  const editableAttrs = selected.length === 1 ? Array.from(selected[0]!.attributes)
    .filter((attr: Attr) => !["class", "data-edit-target", "data-edit-annotation"].includes(attr.name)) : [];
  const dragTransform = (start: { matrix: DOMMatrix; inverse: DOMMatrix }, dx: number, dy: number) => {
    const x = start.inverse.a * dx + start.inverse.c * dy;
    const y = start.inverse.b * dx + start.inverse.d * dy;
    const next = new DOMMatrix().translate(x, y).multiply(start.matrix);
    return `matrix(${[next.a, next.b, next.c, next.d, next.e, next.f].map((n) => Math.round(n * 1e6) / 1e6).join(",")})`;
  };

  return (
    <section className={`svg-editor${leftCollapsed ? " left-collapsed" : ""}${rightCollapsed ? " right-collapsed" : ""}`} aria-label={t("panel.tabs.svgEditor")}>
      <header className="svg-editor-toolbar">
        <div className="svg-editor-title"><MousePointer2 size={15} /><span>{path.split("/").at(-1) || path}</span><span className="svg-editor-status">{busy ? t("panel.svgEditor.loading") : live ? t("panel.svgEditor.live") : t("panel.svgEditor.ready")}</span></div>
        <div className="svg-editor-actions">
          <button type="button" title={t("panel.svgEditor.undo")} aria-label={t("panel.svgEditor.undo")} disabled={!slide?.undo_depth} onClick={() => void undo()}><Undo2 size={15} /></button>
          <button type="button" className="svg-editor-save" disabled={busy || (!hasStagedEdits && !annotationDirty)} onClick={() => void save()}>{saved ? <Check size={15} /> : <Save size={15} />}{saved ? t("panel.svgEditor.saved") : t("panel.svgEditor.save")}</button>
          <button type="button" title={t("panel.svgEditor.exitPreview")} aria-label={t("panel.svgEditor.exitPreview")} onClick={() => void exitPreview()}>×</button>
        </div>
      </header>
      <div className="svg-editor-workspace">
        <aside className="svg-editor-slides" aria-label={t("panel.svgEditor.slides")}>
          <div className="svg-editor-section-head"><span>{t("panel.svgEditor.slides")}</span><span>{slides.length}</span><button type="button" className="svg-editor-collapse" title={leftCollapsed ? t("expandSidebar") : t("collapseSidebar")} aria-label={leftCollapsed ? t("expandSidebar") : t("collapseSidebar")} onClick={() => setLeftCollapsed((value) => !value)}>{leftCollapsed ? <PanelLeftOpen size={14} /> : <PanelLeftClose size={14} />}</button></div>
          <div className="svg-editor-slide-list">
            {slides.map((item) => <button key={item.name} type="button" className={item.name === current ? "active" : ""} aria-current={item.name === current ? "page" : undefined} onClick={() => { setSelection([]); setCurrent(item.name); }} title={item.error || item.name}>
              <span className="svg-editor-slide-meta"><strong><span>{item.name.replace(/\.svg$/i, "")}</span>{item.ok === false && <CircleAlert size={14} aria-hidden="true" />}</strong>{item.annotation_count > 0 && <small>{t("panel.svgEditor.annotationCount", { count: item.annotation_count })}</small>}</span>
            </button>)}
            {!slides.length && <div className="svg-editor-empty">{live ? t("panel.svgEditor.waitingSlides") : t("panel.svgEditor.noSlides")}</div>}
          </div>
        </aside>
        <main className="svg-editor-stage">
          <div className="svg-editor-nav">
            <button type="button" title={t("panel.svgEditor.previousSlide")} aria-label={t("panel.svgEditor.previousSlide")} disabled={index <= 0} onClick={() => { setSelection([]); setCurrent(slides[index - 1]?.name ?? ""); }}><ChevronLeft size={16} /></button>
            <span><b>{index >= 0 ? index + 1 : "—"}</b> / {slides.length}<i>{current}</i></span>
            <button type="button" title={t("panel.svgEditor.nextSlide")} aria-label={t("panel.svgEditor.nextSlide")} disabled={index < 0 || index >= slides.length - 1} onClick={() => { setSelection([]); setCurrent(slides[index + 1]?.name ?? ""); }}><ChevronRight size={16} /></button>
          </div>
          {externalChange && <button type="button" className="svg-editor-reload" onClick={() => void loadSlide(current)}>{t("panel.svgEditor.externalChange")}</button>}
          <div className="svg-editor-canvas-wrap" onClick={onCanvasClick} onContextMenu={onCanvasContextMenu}
            onPointerDown={(event) => {
              const root = canvasRef.current?.querySelector("svg") as SVGSVGElement | null;
              if (event.button !== 0 || !root || busy) return;
              const target = selectionTarget(event.target, root);
              if (target && selection.includes(target.id)) {
                const starts = new Map<string, { element: SVGGraphicsElement; matrix: DOMMatrix; inverse: DOMMatrix }>();
                selected.forEach((element) => {
                  if (!(element instanceof SVGGraphicsElement)) return;
                  const prior = element.transform.baseVal.consolidate()?.matrix;
                  const parent = element.parentElement as SVGGraphicsElement | null;
                  const parentScreen = parent?.getScreenCTM();
                  if (!parentScreen) return;
                  try {
                    starts.set(element.id, { element, matrix: prior ? new DOMMatrix([prior.a, prior.b, prior.c, prior.d, prior.e, prior.f]) : new DOMMatrix(), inverse: parentScreen.inverse() });
                  } catch { /* Skip elements with singular parent transforms. */ }
                });
                dragRef.current = { x: event.clientX, y: event.clientY, moved: false, starts };
              } else if (!target) {
                dragRef.current = { x: event.clientX, y: event.clientY, moved: false, starts: new Map(), box: true };
                if (!event.ctrlKey && !event.metaKey) setSelection([]);
              }
              if (dragRef.current) (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
            }}
            onPointerMove={(event) => {
              const root = canvasRef.current?.querySelector("svg") as SVGSVGElement | null;
              if (root && !dragRef.current) {
                const hover = selectionTarget(event.target, root);
                root.querySelectorAll(".svg-editor-hovered").forEach((element) => element.classList.remove("svg-editor-hovered"));
                hover?.classList.add("svg-editor-hovered");
              }
              const drag = dragRef.current;
              if (!drag || !root) return;
              const dx = event.clientX - drag.x;
              const dy = event.clientY - drag.y;
              if (Math.hypot(dx, dy) < 4 && !drag.moved) return;
              drag.moved = true;
              if (drag.box) {
                const rect = event.currentTarget.getBoundingClientRect();
                setRubber({ left: Math.min(drag.x, event.clientX) - rect.left, top: Math.min(drag.y, event.clientY) - rect.top, width: Math.abs(dx), height: Math.abs(dy) });
              } else {
                for (const start of drag.starts.values()) start.element.setAttribute("transform", dragTransform(start, dx, dy));
              }
            }}
            onPointerUp={(event) => {
              const root = canvasRef.current?.querySelector("svg") as SVGSVGElement | null;
              const drag = dragRef.current;
              if (!drag || !root) return;
              dragRef.current = null;
              suppressClickRef.current = drag.moved;
              if (!drag.moved) return;
              const dx = event.clientX - drag.x;
              const dy = event.clientY - drag.y;
              if (drag.box) {
                const bounds = { left: Math.min(drag.x, event.clientX), top: Math.min(drag.y, event.clientY), right: Math.max(drag.x, event.clientX), bottom: Math.max(drag.y, event.clientY) };
                const ids = [...(root?.querySelectorAll<SVGElement>("[id]") ?? [])].filter((element) => {
                  if (SKIP.has(element.localName.toLowerCase())) return false;
                  const rect = element.getBoundingClientRect();
                  return rect.width > 0 && rect.height > 0 && rect.left >= bounds.left && rect.right <= bounds.right && rect.top >= bounds.top && rect.bottom <= bounds.bottom;
                }).map((element) => element.id);
                setRubber(null);
                setSelection(ids);
              } else {
                void (async () => {
                for (const start of drag.starts.values()) await stageOnly(start.element, { attrs: { transform: dragTransform(start, dx, dy) } });
                })();
              }
            }}>
            {busy && <div className="svg-editor-placeholder">{t("panel.svgEditor.loading")}</div>}
            {error && <div className="svg-editor-placeholder error"><CircleAlert size={18} />{error}</div>}
            {!busy && !error && !slides.length && <div className="svg-editor-placeholder">{live ? t("panel.svgEditor.waitingSlides") : t("panel.svgEditor.noSlides")}</div>}
            {slide && <div ref={canvasRef} className="svg-editor-canvas" dangerouslySetInnerHTML={svgMarkup} />}
            {overlap && <div className="svg-editor-overlap" style={{ left: overlap.x, top: overlap.y }}><strong>{t("panel.svgEditor.chooseOverlap")}</strong>{overlap.items.map((element) => <button key={element.id} type="button" onClick={() => { selectElement(element, false); setOverlap(null); }}>{element.localName} · {element.id}</button>)}</div>}
            {rubber && <div className="svg-editor-rubber" style={rubber} />}
          </div>
          <footer className="svg-editor-footer"><span><MousePointer2 size={13} />{t("panel.svgEditor.hint")}</span><span>{t("panel.svgEditor.staged", { count: slide?.undo_depth ?? 0 })}</span></footer>
        </main>
        <aside className="svg-editor-inspector">
          <div className="svg-editor-inspector-head"><div><span>{t("panel.svgEditor.inspect")}</span><strong>{selection.length ? t("panel.svgEditor.selectedCount", { count: selection.length }) : t("panel.svgEditor.noSelection")}</strong></div><button type="button" className="svg-editor-collapse" title={rightCollapsed ? t("expandSidebar") : t("collapseSidebar")} aria-label={rightCollapsed ? t("expandSidebar") : t("collapseSidebar")} onClick={() => setRightCollapsed((value) => !value)}>{rightCollapsed ? <PanelRightOpen size={14} /> : <PanelRightClose size={14} />}</button></div>
          {!selected.length && <div className="svg-editor-inspector-empty"><MousePointer2 size={18} /><span>{t("panel.svgEditor.selectHint")}</span></div>}
          {selected.length === 1 && <div className="svg-editor-properties">
            <div className="svg-editor-element-id"><span>&lt;{selected[0]!.localName}&gt;</span><code>{selected[0]!.id}</code></div>
            {selected[0]!.parentElement?.closest("g[id]") && <button type="button" className="svg-editor-parent" onClick={() => selectElement(selected[0]!.parentElement!.closest("g[id]") as SVGElement, false)}>{t("panel.svgEditor.selectParent")}</button>}
            {selectedBox && <div className="svg-editor-geometry">{(["x", "y", "width", "height"] as const).map((key) => <label key={key} className="svg-editor-field"><span>{t(`panel.svgEditor.${key}`)}</span><input type="number" step="1" defaultValue={Math.round(selectedBox[key] * 100) / 100} onBlur={(event) => { const value = Number(event.currentTarget.value); if (value !== selectedBox[key]) void changeGeometry(selected[0] as SVGGraphicsElement, key, value); }} /></label>)}</div>}
            {(selected[0]!.localName === "text" || selected[0]!.localName === "tspan") && !selected[0]!.querySelector("tspan") && <label className="svg-editor-field"><span>{t("panel.svgEditor.text")}</span><textarea key={`${selected[0]!.id}:${selected[0]!.textContent}`} defaultValue={selected[0]!.textContent ?? ""} onBlur={(event) => { if (event.currentTarget.value !== selected[0]!.textContent) void stage(selected[0]!, { text: event.currentTarget.value }); }} /></label>}
            <h3>{t("panel.svgEditor.attributes")}</h3>
            {editableAttrs.map((attr) => <label key={attr.name} className="svg-editor-field"><span>{attr.name}</span><input key={`${selected[0]!.id}:${attr.name}:${attr.value}`} defaultValue={attr.value} onBlur={(event) => { if (event.currentTarget.value !== attr.value) void changeAttribute(selected[0]!, attr.name, event.currentTarget.value); }} /></label>)}
            {selected[0]!.localName === "tspan" && <button type="button" className="svg-editor-parent" onClick={() => void promoteTspan(selected[0]!)}>{t("panel.svgEditor.editTextSeparately")}</button>}
            {selected[0]!.localName === "text" && <div className="svg-editor-field"><span>{t("panel.svgEditor.fill")}</span><input type="color" value={selected[0]!.getAttribute("fill")?.match(/^#[0-9a-f]{6}$/i) ? selected[0]!.getAttribute("fill")! : "#222222"} onChange={(event) => void changeAttribute(selected[0]!, "fill", event.currentTarget.value)} /></div>}
          </div>}
          {selected.length > 1 && <div className="svg-editor-batch"><strong>{t("panel.svgEditor.batchStyle")}</strong>{["fill", "stroke", "opacity", "font-size", "font-family"].map((key) => <label key={key} className="svg-editor-field"><span>{key}</span><input type={key === "fill" || key === "stroke" ? "color" : "text"} aria-label={key} onBlur={(event) => { const value = event.currentTarget.value; if (value) void (async () => { for (const element of selected) { element.setAttribute(key, value); await stageOnly(element, { attrs: { [key]: value } }); } })(); }} /></label>)}</div>}
          {!!selection.length && <div className="svg-editor-annotation"><label htmlFor="svg-editor-annotation">{t("panel.svgEditor.annotation")}</label><textarea id="svg-editor-annotation" value={annotation} onChange={(event) => setAnnotation(event.currentTarget.value)} placeholder={t("panel.svgEditor.annotationPlaceholder")} /><button type="button" disabled={!annotation.trim()} onClick={() => void addAnnotation()}>{t("panel.svgEditor.addAnnotation")}</button></div>}
          <div className="svg-editor-annotations"><h3>{t("panel.svgEditor.slideAnnotations")} <span>{slide?.annotations.length ?? 0}</span></h3>{slide?.annotations.map((item) => <article key={item.element_id}><button type="button" className="svg-editor-annotation-target" onClick={() => { setSelection([item.element_id]); canvasRef.current?.querySelector<SVGElement>(`#${CSS.escape(item.element_id)}`)?.scrollIntoView({ block: "nearest" }); }}><b>{item.tag || t("panel.svgEditor.element")}</b><code>{item.element_id}</code></button><p>{item.annotation}</p><button type="button" className="svg-editor-remove-annotation" aria-label={t("panel.svgEditor.removeAnnotation")} title={t("panel.svgEditor.removeAnnotation")} onClick={() => void removeAnnotation(item.element_id)}>×</button></article>)}</div>
        </aside>
      </div>
    </section>
  );
}
