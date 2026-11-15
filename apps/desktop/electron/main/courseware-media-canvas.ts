import type { MediaCanvasView } from "@pi-desktop/shared";

type Host = { call<T>(method: string, params: unknown): Promise<T> };
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** Conversation drafts exist before a PPTX; Host owns their workspace and CAS. */
export class CoursewareMediaCanvasCoordinator {
  constructor(private getHost: () => Host | null, private getViewingSessionId: () => string | null,
    private getWorkspaceRoot: () => Promise<string | null>) {}

  async run(sessionId: string, method: "get" | "set" | "editDraft", args: unknown, canDispatch: () => boolean = () => true): Promise<MediaCanvasView> {
    const fields = method === "get" ? [] : method === "set" ? ["expectedRevision", "document"] : ["expectedRevision", "draftId", "expectedDraftRevision", "patch"];
    if (!record(args) || Object.keys(args).length !== fields.length || fields.some(field => !Object.hasOwn(args, field)) ||
        !/^[A-Za-z0-9_-]{1,128}$/u.test(sessionId)) throw new Error("Invalid media canvas request");
    const payload = structuredClone(args), host = this.getHost();
    const assertCurrent = () => {
      if (!host || this.getHost() !== host || this.getViewingSessionId() !== sessionId || !canDispatch())
        throw new Error("Media canvas conversation changed or turn ended");
    };
    assertCurrent();
    const workspace = await this.getWorkspaceRoot(); assertCurrent();
    if (!host) throw new Error("Host is unavailable");
    const { session } = await host.call<{ session?: { projectPath?: string; mode?: string } }>("session.get", { id: sessionId });
    assertCurrent();
    if (!workspace || session?.projectPath !== workspace || (method !== "get" && session.mode !== "agent"))
      throw new Error("Media canvas workspace or mode changed");
    if (await this.getWorkspaceRoot() !== workspace) throw new Error("Media canvas workspace changed");
    assertCurrent();
    const projectId = `canvas:${sessionId}`;
    const result = await host.call<Omit<MediaCanvasView, "projectId">>(`courseware.mediaCanvas.${method}`, { sessionId, projectId, ...payload });
    assertCurrent();
    if (!record(result) || !Object.hasOwn(result, "revision") || !Object.hasOwn(result, "document") ||
        !(result.revision === null || typeof result.revision === "string") ||
        (result.document !== null && result.document.projectId !== projectId)) throw new Error("Invalid saved media canvas");
    return { ...result, projectId };
  }

  async execute(sessionId: string, name: string, args: unknown, canDispatch: () => boolean): Promise<MediaCanvasView> {
    if (name === "courseware_canvas_get") return this.run(sessionId, "get", args, canDispatch);
    if (name === "courseware_canvas_edit") return this.run(sessionId, "editDraft", args, canDispatch);
    throw new Error("Unsupported media canvas tool");
  }
}
