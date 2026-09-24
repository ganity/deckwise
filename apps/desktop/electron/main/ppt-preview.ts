import { execFile } from "node:child_process";
import { readFile, realpath, stat, unlink } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { resolvePptMasterSkillRoot } from "./builtin-skills";
import { bundledPythonEnvironment, resolveBundledPython } from "./python-runtime";

const execFileAsync = promisify(execFile);
const HEALTH_TIMEOUT_MS = 1_500;
const START_TIMEOUT_MS = 30_000;

type PreviewLock = { pid: number; port: number; raw: string };

export type PptPreviewState = {
  url: string;
  started: boolean;
};

export type PptPreviewRequest = {
  route: string;
  method?: "GET" | "POST" | "DELETE";
  body?: unknown;
};

const API_ROUTES = new Set([
  "GET /api/config",
  "GET /api/slides",
  "POST /api/save-all",
  "POST /api/shutdown",
]);

export function isAllowedPptPreviewRoute(route: string, method: string): boolean {
  let decoded: string;
  try { decoded = decodeURIComponent(route); } catch { return false; }
  if (decoded.includes("..") || decoded.includes("\\") || decoded.includes("?") || decoded.includes("#")) return false;
  if (API_ROUTES.has(`${method} ${decoded}`)) return true;
  const image = /^\/images\/(?:[^/]+\/)*[^/]+$/.test(decoded) && decoded.slice("/images/".length).split("/").every((part) => part !== ".");
  if (image) return method === "GET";
  const slide = decoded.match(/^\/api\/slide\/([^/]+)(?:\/(edit|undo|annotate)(?:\/([^/]+))?)?$/);
  if (!slide) return false;
  const [, , action, annotationId] = slide;
  if (!action) return method === "GET";
  if (action === "edit" || action === "undo") return method === "POST";
  if (annotationId) return method === "DELETE";
  return method === "POST";
}

function samePath(left: string, right: string): boolean {
  const a = resolve(left);
  const b = resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

async function resolveProjectPath(workspaceRoot: string, requestedPath: string): Promise<string> {
  const projectsRoot = await realpath(join(workspaceRoot, ".deckwise-ppt", "projects"));
  const requested = isAbsolute(requestedPath)
    ? requestedPath
    : join(workspaceRoot, requestedPath);
  const projectPath = await realpath(requested);
  const contained = relative(projectsRoot, projectPath);
  if (!contained || contained.startsWith("..") || isAbsolute(contained)) {
    throw new Error("SVG preview project must stay inside the DeckWise projects directory");
  }
  if (!(await stat(projectPath)).isDirectory()) {
    throw new Error("SVG preview project is not a directory");
  }
  return projectPath;
}

async function readLock(projectPath: string): Promise<PreviewLock | null> {
  try {
    const raw = await readFile(join(projectPath, "live_preview", "lock.json"), "utf8");
    const parsed = JSON.parse(raw) as { pid?: unknown; port?: unknown };
    const pid = Number(parsed.pid);
    const port = Number(parsed.port);
    if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(port) || port <= 0 || port > 65_535) {
      return null;
    }
    return { pid, port, raw };
  } catch {
    return null;
  }
}

async function probe(projectPath: string, lock: PreviewLock): Promise<string | null> {
  const url = `http://127.0.0.1:${lock.port}`;
  try {
    const response = await fetch(`${url}/api/health`, {
      cache: "no-store",
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const health = (await response.json()) as {
      service?: unknown;
      project?: unknown;
      pid?: unknown;
    };
    if (
      health.service !== "live_preview" ||
      typeof health.project !== "string" ||
      !samePath(health.project, projectPath) ||
      Number(health.pid) !== lock.pid
    ) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

async function discardUnhealthyLock(projectPath: string, lock: PreviewLock): Promise<void> {
  const path = join(projectPath, "live_preview", "lock.json");
  try {
    if ((await readFile(path, "utf8")) === lock.raw) await unlink(path);
  } catch {
    // A concurrent server start or shutdown already resolved the stale lock.
  }
}

export class PptPreviewController {
  private readonly opening = new Map<string, Promise<PptPreviewState>>();

  async open(workspaceRoot: string, requestedPath: string): Promise<PptPreviewState> {
    const projectPath = await resolveProjectPath(workspaceRoot, requestedPath);
    const active = this.opening.get(projectPath);
    if (active) return active;
    const opening = this.ensureOpen(workspaceRoot, projectPath).finally(() => {
      this.opening.delete(projectPath);
    });
    this.opening.set(projectPath, opening);
    return opening;
  }

  async request(workspaceRoot: string, requestedPath: string, input: PptPreviewRequest): Promise<unknown> {
    const projectPath = await resolveProjectPath(workspaceRoot, requestedPath);
    const route = String(input.route || "");
    const method = input.method ?? "GET";
    if (!isAllowedPptPreviewRoute(route, method)) {
      throw new Error("SVG preview route is not allowed");
    }
    if (method === "GET" && input.body !== undefined) throw new Error("GET preview requests cannot have a body");
    if (route.startsWith("/images/") && input.body !== undefined) throw new Error("Image requests cannot have a body");
    const lock = await readLock(projectPath);
    if (!lock) throw new Error("SVG preview service is unavailable");
    const baseUrl = await probe(projectPath, lock);
    if (!baseUrl) throw new Error("SVG preview service is unavailable");
    const body = input.body === undefined ? undefined : JSON.stringify(input.body);
    if (body && body.length > 512_000) throw new Error("SVG preview request is too large");
    const response = await fetch(`${baseUrl}${route}`, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body,
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    if (route.startsWith("/images/")) {
      if (!response.ok) throw new Error(`Preview image request failed (${response.status})`);
      const image = await response.arrayBuffer();
      if (image.byteLength > 10_000_000) throw new Error("Preview image is too large");
      const contentType = response.headers.get("content-type") || "application/octet-stream";
      return { dataUrl: `data:${contentType};base64,${Buffer.from(image).toString("base64")}` };
    }
    const contentType = response.headers.get("content-type") || "";
    const value = contentType.includes("application/json") ? await response.json() : await response.text();
    if (!response.ok) throw new Error((value as { error?: unknown })?.error?.toString() || `Preview request failed (${response.status})`);
    return value;
  }

  private async ensureOpen(workspaceRoot: string, projectPath: string): Promise<PptPreviewState> {
    const existing = await readLock(projectPath);
    if (existing) {
      const url = await probe(projectPath, existing);
      if (url) return { url, started: false };
      await discardUnhealthyLock(projectPath, existing);
    }

    const skillRoot = resolvePptMasterSkillRoot();
    if (!skillRoot) throw new Error("课件预览组件不可用");
    const python = resolveBundledPython() ?? (process.platform === "win32" ? "python" : "python3");
    const server = join(skillRoot, "scripts", "svg_editor", "server.py");
    await execFileAsync(
      python,
      [server, projectPath, "--live", "--daemon", "--no-browser"],
      {
        cwd: workspaceRoot,
        env: bundledPythonEnvironment(),
        timeout: START_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 1_048_576,
      },
    );

    const started = await readLock(projectPath);
    const url = started ? await probe(projectPath, started) : null;
    if (!url) throw new Error("课件页面预览启动超时");
    return { url, started: true };
  }
}
