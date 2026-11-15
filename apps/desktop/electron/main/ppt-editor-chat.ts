import { assertPptEditorCommand, assertPptEditorContext, samePptEditorBinding, type PptEditorBinding, type PptEditorContext } from "@pi-desktop/shared";

type Host = { call<T>(method: string, params: unknown): Promise<T> };
type Editor = {
  getContext(workspace: string | null): Promise<PptEditorContext>;
  execute(command: unknown, workspace: string | null, canDispatch?: () => boolean): Promise<unknown>;
};
type Capture = { binding: PptEditorBinding; host: Host };

/** Main owns editor/session association; tools cannot select a workspace or document. */
export class PptEditorChatBridge {
  nativeFade?: { context(sessionId: string, context: PptEditorContext, canDispatch: () => boolean): Promise<PptEditorContext>; execute(sessionId: string, command: unknown, canDispatch: () => boolean): Promise<unknown>; clear(): void };
  candidates?: (sessionId: string, toolName: string, args: unknown, canDispatch: () => boolean) => Promise<unknown>;
  private owner: string | null = null;
  private visible = false;
  private captures = new Map<string, Capture>();

  constructor(private editor: Editor, private getHost: () => Host | null,
    private getWorkspace: () => Promise<string | null>, private getViewingSession: () => string | null) {}

  clear(): void { this.nativeFade?.clear(); this.owner = null; this.captures.clear(); }
  setOwner(sessionId: string): void { this.clear(); this.owner = sessionId; }
  setVisible(visible: boolean): void { this.visible = visible; if (!visible) this.nativeFade?.clear(); }

  async capture(sessionId: string): Promise<PptEditorBinding | undefined> {
    this.nativeFade?.clear();
    this.captures.delete(sessionId);
    if (!this.visible || this.owner !== sessionId || this.getViewingSession() !== sessionId) return undefined;
    const host = this.getHost();
    if (!host) throw new Error("Host is unavailable");
    const workspace = await this.workspace(sessionId, host);
    const context = await this.editor.getContext(workspace);
    assertPptEditorContext(context);
    this.assertOwner(sessionId, host);
    const binding = { projectId: context.projectId, documentId: context.documentId, sessionId: context.sessionId };
    this.captures.set(sessionId, { binding, host });
    return binding;
  }

  async execute(sessionId: string, toolName: string, args: unknown, canDispatch: () => boolean): Promise<unknown> {
    args = structuredClone(args);
    const captured = this.captures.get(sessionId);
    if (!captured) throw new Error("No PPT editor is bound to this Chat; send a new prompt after opening it");
    this.assertOwner(sessionId, captured.host);
    if (!canDispatch()) throw new Error("Chat turn was cancelled or ended");
    const workspace = await this.workspace(sessionId, captured.host);
    const context = await this.editor.getContext(workspace);
    assertPptEditorContext(context);
    if (!samePptEditorBinding(captured.binding, context)) throw new Error("PPT editor session changed; send a new prompt");
    if (["ppt_get_narration_context", "ppt_propose_page_narration", "ppt_propose_page_fade", "ppt_propose_page_redo", "ppt_propose_page_style_batch"].includes(toolName)) {
      if (!this.candidates) throw new Error("Candidate generation is unavailable");
      if (toolName === "ppt_get_narration_context" && (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).length !== 3 || !samePptEditorBinding(captured.binding, args as PptEditorBinding))) throw new Error("Invalid narration context request");
      return this.candidates(sessionId, toolName, args, () => {
        try { this.assertOwner(sessionId, captured.host); return this.captures.get(sessionId) === captured && canDispatch(); } catch { return false; }
      });
    }
    if (toolName === "ppt_get_context") {
      if (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).length !== 3 ||
          Object.keys(args).some((key) => !["projectId", "documentId", "sessionId"].includes(key)) ||
          !samePptEditorBinding(captured.binding, args as PptEditorBinding)) throw new Error("Invalid PPT context request");
      this.assertOwner(sessionId, captured.host);
      if (!canDispatch()) throw new Error("Chat turn was cancelled or ended");
      if (!this.nativeFade) return context;
      const reviewed = await this.nativeFade.context(sessionId, context, () => {
        try { this.assertOwner(sessionId, captured.host); return this.captures.get(sessionId) === captured && canDispatch(); } catch { return false; }
      });
      assertPptEditorContext(reviewed);
      this.assertOwner(sessionId, captured.host);
      if (!samePptEditorBinding(captured.binding, reviewed) || this.captures.get(sessionId) !== captured || !canDispatch()) throw new Error("Native fade context or Chat changed");
      return reviewed;
    }
    assertPptEditorCommand(args);
    if (!samePptEditorBinding(captured.binding, args) || toolName !== `ppt_${args.tool}` ||
        args.editGeneration !== context.editGeneration || (context.readOnly && args.tool !== "get_presentation_text") ||
        !context.capabilities.some((capability) => capability.name === args.tool)) throw new Error("PPT context or capability changed; read fresh context");
    this.assertOwner(sessionId, captured.host);
    if (this.captures.get(sessionId) !== captured || !canDispatch()) throw new Error("Chat turn was cancelled or editor changed");
    if (args.tool === "set_slide_fade") {
      if (!this.nativeFade) throw new Error("Native fade inspection is unavailable");
      return this.nativeFade.execute(sessionId, args, () => {
        try { this.assertOwner(sessionId, captured.host); return this.captures.get(sessionId) === captured && canDispatch(); } catch { return false; }
      });
    }
    // No await between the final turn/owner check and native dispatch.
    return this.editor.execute(args, workspace, () => {
      try { this.assertOwner(sessionId, captured.host); return this.captures.get(sessionId) === captured && canDispatch(); }
      catch { return false; }
    });
  }

  assertActive(sessionId: string): void {
    const host = this.getHost();
    if (!host) throw new Error("Host is unavailable");
    this.assertOwner(sessionId, host);
  }

  assertOwned(sessionId: string): void {
    const host = this.getHost();
    if (!host) throw new Error("Host is unavailable");
    this.assertOwner(sessionId, host, false);
  }

  private assertOwner(sessionId: string, host: Host, requireVisible = true): void {
    if (requireVisible && !this.visible || this.owner !== sessionId || this.getViewingSession() !== sessionId || this.getHost() !== host) {
      throw new Error("PPT editor is no longer active in this Chat");
    }
  }

  private async workspace(sessionId: string, host: Host): Promise<string> {
    const { session } = await host.call<{ session?: { projectPath?: string; mode?: string } }>("session.get", { id: sessionId });
    const workspace = await this.getWorkspace();
    if (!workspace || session?.projectPath !== workspace || session.mode !== "agent") throw new Error("Chat workspace or mode does not match the editor");
    this.assertOwner(sessionId, host);
    return workspace;
  }
}
