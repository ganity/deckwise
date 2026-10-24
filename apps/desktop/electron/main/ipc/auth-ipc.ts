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
  registrar.handleWithEvent(IPC.invoke.coursewareTeamProjects, async (event) => {
    registrar.assertMainWindowSender(event);
    return authSession.coursewareMedia.getTeamProjects();
  });
  registrar.handleWithEvent(IPC.invoke.coursewareTeamProjectCreate, async (event) => {
    registrar.assertMainWindowSender(event);
    return authSession.coursewareMedia.createTeamProject();
  });
  registrar.handleWithEvent(IPC.invoke.coursewareTeamMemberGrant, async (event, input: { projectId?: unknown; userId?: unknown; role?: unknown } = {}) => {
    registrar.assertMainWindowSender(event);
    const userId = typeof input.userId === "number" ? input.userId : NaN;
    if (typeof input.projectId !== "string" || !Number.isSafeInteger(userId) || typeof input.role !== "string" || !["EDITOR", "VIEWER"].includes(input.role)) throw new Error("COURSEWARE_MEDIA_INVALID_TEAM_MEMBER");
    await authSession.coursewareMedia.grantTeamMember(input.projectId, userId, input.role as "EDITOR" | "VIEWER");
    return { ok: true };
  });
  registrar.handleWithEvent(IPC.invoke.coursewareTeamMemberRevoke, async (event, input: { projectId?: unknown; userId?: unknown } = {}) => {
    registrar.assertMainWindowSender(event);
    const userId = typeof input.userId === "number" ? input.userId : NaN;
    if (typeof input.projectId !== "string" || !Number.isSafeInteger(userId)) throw new Error("COURSEWARE_MEDIA_INVALID_TEAM_MEMBER");
    await authSession.coursewareMedia.revokeTeamMember(input.projectId, userId);
    return { ok: true };
  });
  registrar.handleWithEvent(IPC.invoke.coursewareTeamMembers, async (event, input: { projectId?: unknown } = {}) => {
    registrar.assertMainWindowSender(event);
    if (typeof input.projectId !== "string") throw new Error("COURSEWARE_MEDIA_INVALID_TEAM_PROJECT");
    return authSession.coursewareMedia.getTeamMembers(input.projectId);
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
  registrar.handleWithEvent(IPC.invoke.documentParse, async (event, input: { path?: unknown } = {}) => {
    registrar.assertMainWindowSender(event);
    const workspaceRoot = await getWorkspaceRoot();
    const roots = [join(dataDir, "scratch"), join(dataDir, "attachments")];
    const path = await resolveRealOpenablePath(String(input.path ?? ""), workspaceRoot, roots);
    if (!path) throw new Error("文档不在允许的课件目录中");
    return authSession.parseDocument(path);
  });
  registrar.handleWithEvent(IPC.invoke.documentCleanup, async (event, input: { fileUrls?: unknown } = {}) => {
    registrar.assertMainWindowSender(event);
    const fileUrls = Array.isArray(input.fileUrls)
      ? input.fileUrls.filter((value): value is string => typeof value === "string")
      : [];
    await authSession.cleanupDocuments(fileUrls);
    return { ok: true };
  });
}
