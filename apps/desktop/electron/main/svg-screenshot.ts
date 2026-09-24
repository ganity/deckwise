import type { BrowserWindow, WebContents } from "electron";
import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";

type Screenshot = { mimeType: string; data: string };
type ActiveSvg = { markup: string; projectPath: string; sessionId: string } | null;

const MAX_SVG_BYTES = 10_000_000;
const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp",
};

function rendererCall<T>(contents: WebContents, fn: (...args: any[]) => T, ...args: unknown[]): Promise<T> {
  return contents.executeJavaScript(`(${fn.toString()})(...${JSON.stringify(args)})`) as Promise<T>;
}

function activeSvg(): ActiveSvg {
  const editor = document.querySelector<HTMLElement>(".work-panel-tabpane .svg-editor[data-project-path][data-session-id]");
  const svg = editor?.querySelector(".svg-editor-canvas svg");
  if (!editor || !svg || !editor.getClientRects().length) return null;
  return { markup: svg.outerHTML, projectPath: editor.dataset.projectPath ?? "", sessionId: editor.dataset.sessionId ?? "" };
}

function imageRefs(markup: string): string[] {
  const doc = new DOMParser().parseFromString(markup, "image/svg+xml");
  if (doc.querySelector("parsererror")) throw new Error("Invalid SVG");
  return [...new Set([...doc.querySelectorAll("image")].map((image) =>
    image.getAttribute("href") ?? image.getAttribute("xlink:href") ?? "",
  ).filter((href) => href && !href.startsWith("data:") && !href.startsWith("#")))];
}

async function livePreviewSvg(): Promise<string | null> {
  const content = document.getElementById("svg-content");
  const svg = content?.querySelector("svg");
  if (!svg || content?.style.display === "none" || !document.querySelector("#slide-list .slide-item.active")) return null;
  const copy = svg.cloneNode(true) as SVGSVGElement;
  const images = [...copy.querySelectorAll("image[href], image[xlink\\:href]")];
  let totalBytes = 0;
  for (const image of images) {
    const attr = image.hasAttribute("href") ? "href" : "xlink:href";
    const href = image.getAttribute(attr) ?? "";
    if (!href || href.startsWith("data:") || href.startsWith("#")) continue;
    const url = new URL(href, location.href);
    if (url.origin !== location.origin || !url.pathname.startsWith("/images/")) throw new Error("Preview image is outside the local image route");
    const response = await fetch(url.href, { credentials: "omit", signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new Error(`Preview image request failed (${response.status})`);
    const blob = await response.blob();
    totalBytes += blob.size;
    if (!/^image\/(?:png|jpeg|gif|webp)$/.test(blob.type) || totalBytes > 20_000_000) throw new Error("Unsupported preview image");
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
    image.setAttribute(attr, dataUrl);
  }
  return copy.outerHTML;
}

export async function screenshotLivePreview(contents: WebContents): Promise<Screenshot | null> {
  const href = contents.getURL();
  if (!/^http:\/\/(?:127\.0\.0\.1|localhost):\d+\//.test(href)) return null;
  const url = new URL(href);
  if (!["/", "/index.html"].includes(url.pathname)) return null;
  const markup = await rendererCall(contents, livePreviewSvg);
  return markup ? rendererCall(contents, renderSvg, markup, {}) : null;
}

async function renderSvg(markup: string, images: Record<string, string>): Promise<Screenshot> {
  const doc = new DOMParser().parseFromString(markup, "image/svg+xml");
  if (doc.querySelector("parsererror") || doc.documentElement.localName !== "svg") throw new Error("Invalid SVG");
  const svg = doc.documentElement;
  svg.querySelectorAll("script, foreignObject").forEach((node) => node.remove());
  const externalCss = (value: string) => /@import\b|url\(\s*(['"]?)(?!#|data:image\/)[^)]+\1\s*\)/i.test(value);
  svg.querySelectorAll("style").forEach((node) => { if (externalCss(node.textContent ?? "")) node.remove(); });
  svg.querySelectorAll("*").forEach((node) => {
    for (const attribute of [...node.attributes]) {
      if (/^on/i.test(attribute.name)) node.removeAttribute(attribute.name);
      if (externalCss(attribute.value)) node.removeAttribute(attribute.name);
      if (/^(href|xlink:href)$/i.test(attribute.name)) {
        const value = attribute.value;
        if (images[value]) node.setAttribute(attribute.name, images[value]);
        else if (!value.startsWith("#") && !/^data:image\/(?:png|jpeg|gif|webp);base64,/i.test(value)) node.removeAttribute(attribute.name);
      }
    }
  });
  const viewBox = svg.getAttribute("viewBox")?.trim().split(/[\s,]+/).map(Number);
  const width = viewBox?.length === 4 && viewBox[2]! > 0 ? viewBox[2]! : Number.parseFloat(svg.getAttribute("width") ?? "");
  const height = viewBox?.length === 4 && viewBox[3]! > 0 ? viewBox[3]! : Number.parseFloat(svg.getAttribute("height") ?? "");
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) throw new Error("SVG has no dimensions");
  const canvas = document.createElement("canvas");
  canvas.width = 1920;
  canvas.height = Math.min(2160, Math.max(1, Math.round(1920 * height / width)));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas is unavailable");
  context.fillStyle = "#fff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  const blobUrl = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(svg)], { type: "image/svg+xml" }));
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("SVG render timed out")), 10_000);
      image.onload = () => { clearTimeout(timer); resolve(); };
      image.onerror = () => { clearTimeout(timer); reject(new Error("SVG render failed")); };
      image.src = blobUrl;
    });
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return { mimeType: "image/png", data: canvas.toDataURL("image/png").split(",")[1]! };
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}

async function containedPath(root: string, requested: string): Promise<string> {
  const base = await realpath(root);
  const target = await realpath(isAbsolute(requested) ? requested : resolve(base, requested));
  const within = relative(base, target);
  if (!within || within === ".." || within.startsWith(`..${sep}`) || isAbsolute(within)) {
    throw new Error("SVG path must stay inside the workspace");
  }
  return target;
}

export async function screenshotSvg(window: BrowserWindow, workspaceRoot: string, path?: string, sessionId?: string): Promise<Screenshot | null> {
  let markup: string;
  let file: string | null = null;
  if (path) {
    file = await containedPath(workspaceRoot, path);
    const fileStat = await stat(file);
    if (extname(file).toLowerCase() !== ".svg" || !fileStat.isFile()) throw new Error("Screenshot path must be an SVG file");
    if (fileStat.size > MAX_SVG_BYTES) throw new Error("SVG is too large");
    markup = await readFile(file, "utf8");
  } else {
    const active = await rendererCall(window.webContents, activeSvg);
    if (!active || !sessionId || active.sessionId !== sessionId) return null;
    await containedPath(workspaceRoot, active.projectPath);
    markup = active.markup;
  }
  if (Buffer.byteLength(markup) > MAX_SVG_BYTES) throw new Error("SVG is too large");
  const images: Record<string, string> = {};
  let imageBytes = 0;
  for (const href of await rendererCall(window.webContents, imageRefs, markup)) {
    if (!file) throw new Error(`SVG image is not embedded: ${href}`);
    const imagePath = await containedPath(workspaceRoot, resolve(dirname(file), href));
    const mimeType = IMAGE_TYPES[extname(imagePath).toLowerCase()];
    const imageStat = await stat(imagePath);
    imageBytes += imageStat.size;
    if (!mimeType || !imageStat.isFile() || imageBytes > 20_000_000) {
      throw new Error("Unsupported SVG image");
    }
    images[href] = `data:${mimeType};base64,${(await readFile(imagePath)).toString("base64")}`;
  }
  return rendererCall(window.webContents, renderSvg, markup, images);
}
