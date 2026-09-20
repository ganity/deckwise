import { join } from "node:path";
import { IPC, type DesktopCoursewareImportInput } from "@pi-desktop/shared";
import type { DesktopAuthSession } from "../auth-session";
import { resolveRealOpenablePath } from "../fs-panel";
import type { IpcRegistrar } from "./types";

export function registerAuthIpc(options: {
  registrar: IpcRegistrar;
  authSession: DesktopAuthSession;
  dataDir: string;
  getWorkspaceRoot: () => Promise<string | null>;
}): void {
  const { registrar, authSession, dataDir, getWorkspaceRoot } = options;
  registrar.handleWithEvent(IPC.invoke.authRestore, async (event) => {
    registrar.assertMainWindowSender(event);
    return authSession.restore();
  });
  registrar.handleWithEvent(IPC.invoke.authStartQr, async (event) => {
    registrar.assertMainWindowSender(event);
    return authSession.startQrLogin();
  });
  registrar.handleWithEvent(IPC.invoke.authPollQr, async (event, input: { ticket?: unknown }) => {
    registrar.assertMainWindowSender(event);
    return authSession.pollQrLogin(typeof input?.ticket === "string" ? input.ticket : "");
  });
  registrar.handleWithEvent(IPC.invoke.authLogout, async (event) => {
    registrar.assertMainWindowSender(event);
    return authSession.logout();
  });
  registrar.handleWithEvent(
    IPC.invoke.coursewareImport,
    async (event, input: Partial<DesktopCoursewareImportInput> = {}) => {
      registrar.assertMainWindowSender(event);
      const workspaceRoot = await getWorkspaceRoot();
      const roots = [join(dataDir, "scratch"), join(dataDir, "attachments")];
      const pptxPath = await resolveRealOpenablePath(
        String(input.pptxPath ?? ""),
        workspaceRoot,
        roots,
      );
      const lessonPlanPath = await resolveRealOpenablePath(
        String(input.lessonPlanPath ?? ""),
        workspaceRoot,
        roots,
      );
      if (!pptxPath || !lessonPlanPath) throw new Error("导入文件不在允许的课件目录中");
      return authSession.importCourseware({
        title: String(input.title ?? ""),
        grade: String(input.grade ?? ""),
        subject: String(input.subject ?? ""),
        customSubjectName: String(input.customSubjectName ?? ""),
        detailLevel:
          input.detailLevel === "quick" || input.detailLevel === "detailed"
            ? input.detailLevel
            : "normal",
        pptxPath,
        lessonPlanPath,
      });
    },
  );
}
