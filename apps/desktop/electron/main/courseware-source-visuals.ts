import { setTimeout as delay } from "node:timers/promises";
import { dirname } from "node:path";
import { BrowserWindow, type IpcMain } from "electron";
import { PptEditorController } from "./ppt-editor";

/** A fresh readonly native renderer never changes the user's owning editor. */
type SourceInput = {
  ipcMain: IpcMain; workspace: string; snapshot: { sourcePath: string; sha256: string; revision?: number };
  signal: AbortSignal; assertCurrent(): Promise<void>;
};

export async function withReadonlyCoursewareSource<T>(input: SourceInput, inspect: (editor: PptEditorController, pageCount: number) => Promise<T>) {
  const { signal, snapshot, workspace } = input;
  signal.throwIfAborted();
  const window = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
  const editor = new PptEditorController(input.ipcMain, () => {});
  const dispose = () => { editor.dispose(); if (!window.isDestroyed()) window.destroy(); };
  signal.addEventListener("abort", dispose, { once: true });
  try {
    await input.assertCurrent();
    signal.throwIfAborted();
    // Host candidate archives are outside the workspace; only Main supplies this hash-bound path.
    const state = await editor.open(window, workspace, snapshot.sourcePath, undefined, [dirname(snapshot.sourcePath)], true);
    if (state.sha256 !== snapshot.sha256 || (snapshot.revision !== undefined && state.revision !== snapshot.revision) || state.readOnly !== true || state.canSave !== false)
      throw new Error("Readonly renderer differs from the current saved PPTX");
    let context;
    const readySignal = AbortSignal.any([signal, AbortSignal.timeout(60_000)]);
    for (;;) {
      readySignal.throwIfAborted();
      try {
        const next = await editor.getContext(workspace, readySignal);
        if (next.page !== undefined && Reflect.get(next, "pageLineage")) { context = next; break; }
      } catch { readySignal.throwIfAborted(); }
      await delay(100, undefined, { signal: readySignal });
    }
    await input.assertCurrent();
    return await inspect(editor, context.pageLineage!.openedPageTokens.length);
  } finally { signal.removeEventListener("abort", dispose); dispose(); }
}

export async function renderCoursewareSourceVisuals(input: SourceInput & { page: number }) {
  const { workspace, signal, snapshot } = input;
  return withReadonlyCoursewareSource(input, async (editor, pageCount) => {
    const normal = await editor.renderSavedPagePreview(workspace, input.page, false, signal);
    await input.assertCurrent();
    const textless = await editor.renderSavedPagePreview(workspace, input.page, true, signal);
    await input.assertCurrent();
    if (normal.sourceSha256 !== snapshot.sha256 || textless.sourceSha256 !== snapshot.sha256 ||
        normal.page !== input.page || textless.page !== input.page || normal.pageToken !== textless.pageToken ||
        normal.image.width !== textless.image.width || normal.image.height !== textless.image.height || textless.nativeTextOmitted !== true)
      throw new Error("Source visual pair changed during rendering");
    return { normal, textless, pageCount };
  });
}
