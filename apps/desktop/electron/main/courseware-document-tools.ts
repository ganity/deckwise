import { resolveRealOpenablePath } from "./fs-panel";
import type { BrowserWindow } from "electron";
import type { PptEditorController } from "./ppt-editor";
import type { CoursewareNativeTools } from "./courseware-native-tools";

type Host = { call<T>(method: string, args: unknown): Promise<T> };
export type CoursewareDocumentScope = {
  sessionId: string; workspace: string; path: string; host: Host;
  assertCurrent(): Promise<void>;
};
type Background = { editor: PptEditorController; window: BrowserWindow; dispose(): void };
type Tools = Pick<CoursewareNativeTools, "execute"> & { beforeOpen?(): Promise<void> };

/** A document lease outlives Chat focus and fences native execution against UI handoff. */
export class CoursewareDocumentTools {
  private queue: Promise<unknown> = Promise.resolve();
  private background?: Background;
  private runtime?: { editor: PptEditorController; scope: CoursewareDocumentScope; tools: Tools };
  constructor(private input: {
    getHost(): Host | null;
    editor: PptEditorController;
    createBackground(): Background;
    createTools(editor: PptEditorController, scope: CoursewareDocumentScope): Tools;
  }) {}

  // One native worker bounds memory; provider jobs and scene generation do not enter this queue.
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => {});
    return result;
  }

  async transition<T>(operation: () => Promise<T>): Promise<T> {
    return this.serial(async () => { await this.releaseBackground(); return operation(); });
  }

  private async releaseBackground() {
    const worker = this.background;
    if (!worker) return;
    const document = worker.editor.documentTarget();
    if (document) await worker.editor.ensureSaved(document.workspaceRoot);
    worker.dispose();
    this.background = undefined;
    if (this.runtime?.editor === worker.editor) this.runtime = undefined;
  }

  async execute(sessionId: string, name: string, args: unknown, canDispatch: () => boolean) {
    if (!/^(courseware_narration_|courseware_media_|courseware_activity_)/u.test(name)) return;
    return this.serial(async () => {
      const host = this.input.getHost();
      if (!host) throw new Error("Courseware Host is unavailable");
      const check = () => {
        if (!canDispatch()) throw new Error("Native teaching turn ended before document dispatch");
        if (this.input.getHost() !== host) throw new Error("Courseware Host changed");
      };
      check();
      const readTarget = async () => {
        const { session } = await host.call<{ session?: { projectPath?: string; mode?: string } }>("session.get", { id: sessionId, messageLimit: 1, contentLimit: 1 });
        check();
        if (!session?.projectPath || session.mode !== "agent") throw new Error("Native teaching requires the owning Agent workspace");
        const { task } = await host.call<{ task?: { generatedPath?: string; importPath?: string; canonicalProjectId?: string } }>("courseware.task.get", { sessionId });
        check();
        if (task?.canonicalProjectId) return;
        const source = task?.generatedPath ?? task?.importPath;
        if (!source || !source.toLowerCase().endsWith(".pptx")) return;
        const path = await resolveRealOpenablePath(source, session.projectPath);
        check();
        if (!path) throw new Error("Courseware document is outside its owning workspace");
        return { workspace: session.projectPath, path };
      };
      const target = await readTarget();
      if (!target) return;
      const matches = (editor: PptEditorController) => {
        const document = editor.documentTarget();
        return document?.sourcePath === target.path && document.workspaceRoot === target.workspace;
      };
      let editor = this.input.editor;
      if (editor.documentTarget()?.sourcePath === target.path && !matches(editor))
        throw new Error("This document is already open in a different workspace; use its owning workspace before editing");
      if (!matches(editor)) {
        check();
        if (this.background && (!matches(this.background.editor) || this.runtime?.scope.sessionId !== sessionId)) await this.releaseBackground();
        this.background ??= this.input.createBackground();
        editor = this.background.editor;
      }
      const scope: CoursewareDocumentScope = { ...target, sessionId, host, assertCurrent: async () => {
        check();
        const current = await readTarget();
        if (!current || current.path !== target.path || current.workspace !== target.workspace || !matches(editor))
          throw new Error("Courseware document target changed; read fresh context");
      } };
      // Rebind the turn guard on every call, retaining candidate/media caches within the document.
      if (this.runtime?.editor === editor && this.runtime.scope.sessionId === sessionId && this.runtime.scope.path === target.path && this.runtime.scope.host === host)
        this.runtime.scope.assertCurrent = scope.assertCurrent;
      else this.runtime = { editor, scope, tools: this.input.createTools(editor, scope) };
      const { tools } = this.runtime;
      if (editor === this.background?.editor && !matches(editor)) {
        await tools.beforeOpen?.();
        await editor.open(this.background.window, target.workspace, target.path);
      }
      check();
      await editor.waitForOpen(target.workspace);
      await editor.waitForTeachingReady(target.workspace, check);
      await scope.assertCurrent();
      await editor.ensureSaved(target.workspace);
      try {
        const result = await tools.execute(sessionId, name, args, canDispatch);
        await scope.assertCurrent();
        return result;
      } finally {
        // Preserve partial native writes even if a turn is stopped after a successful dispatch.
        await editor.ensureSaved(target.workspace);
      }
    });
  }
}
