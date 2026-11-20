import { IPC } from "@pi-desktop/shared";
import { PptPreviewController } from "../ppt-preview";
import type { IpcRegistrar } from "./types";

export function registerPptPreviewIpc(input: {
  registrar: IpcRegistrar;
  getWorkspaceRoot: (sessionId: string) => Promise<string | null>;
}): void {
  const { registrar, getWorkspaceRoot } = input;
  const controller = new PptPreviewController();

  registrar.handleWithEvent(
    IPC.invoke.pptPreviewOpen,
    async (event, payload: { path?: string; sessionId?: string; requireSlide?: boolean } = {}) => {
      registrar.assertMainWindowSender(event);
      const sessionId = payload.sessionId?.trim();
      const workspaceRoot = sessionId ? await getWorkspaceRoot(sessionId) : null;
      const path = payload.path?.trim();
      if (!workspaceRoot || !path) throw new Error("SVG preview project is unavailable");
      try {
        const preview = await controller.open(workspaceRoot, path);
        if (payload.requireSlide) {
          const { slides } = await controller.request(workspaceRoot, path, { route: "/api/slides" }) as { slides: { ok: boolean }[] };
          if (!slides.some(slide => slide.ok)) return null;
        }
        return preview;
      } catch (error) {
        if (payload.requireSlide && (error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
  );

  registrar.handleWithEvent(
    IPC.invoke.pptPreviewRequest,
    async (event, payload: { path?: string; sessionId?: string; route?: string; method?: "GET" | "POST" | "DELETE"; body?: unknown } = {}) => {
      registrar.assertMainWindowSender(event);
      const sessionId = payload.sessionId?.trim();
      const workspaceRoot = sessionId ? await getWorkspaceRoot(sessionId) : null;
      const path = payload.path?.trim();
      if (!workspaceRoot || !path) throw new Error("SVG preview project is unavailable");
      return controller.request(workspaceRoot, path, {
        route: String(payload.route ?? ""),
        method: payload.method,
        body: payload.body,
      });
    },
  );
}
