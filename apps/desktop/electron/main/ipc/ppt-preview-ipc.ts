import { IPC } from "@pi-desktop/shared";
import { PptPreviewController } from "../ppt-preview";
import type { IpcRegistrar } from "./types";

export function registerPptPreviewIpc(input: {
  registrar: IpcRegistrar;
  getWorkspaceRoot: () => Promise<string | null>;
}): void {
  const { registrar, getWorkspaceRoot } = input;
  const controller = new PptPreviewController();

  registrar.handleWithEvent(
    IPC.invoke.pptPreviewOpen,
    async (event, payload: { path?: string } = {}) => {
      registrar.assertMainWindowSender(event);
      const workspaceRoot = await getWorkspaceRoot();
      const path = String(payload.path ?? "").trim();
      if (!workspaceRoot || !path) throw new Error("SVG preview project is unavailable");
      return controller.open(workspaceRoot, path);
    },
  );

  registrar.handleWithEvent(
    IPC.invoke.pptPreviewRequest,
    async (event, payload: { path?: string; route?: string; method?: "GET" | "POST" | "DELETE"; body?: unknown } = {}) => {
      registrar.assertMainWindowSender(event);
      const workspaceRoot = await getWorkspaceRoot();
      const path = String(payload.path ?? "").trim();
      if (!workspaceRoot || !path) throw new Error("SVG preview project is unavailable");
      return controller.request(workspaceRoot, path, {
        route: String(payload.route ?? ""),
        method: payload.method,
        body: payload.body,
      });
    },
  );
}
