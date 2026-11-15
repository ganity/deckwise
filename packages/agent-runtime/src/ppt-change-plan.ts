import { randomUUID } from "node:crypto";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { assertPptEditorContext, samePptEditorBinding, type PptEditorBinding } from "@pi-desktop/shared";
import { parsePptCandidateBaseline } from "./ppt-candidate-tools.js";

const plannedTools = ["ppt_replace_selection", "ppt_add_slide_text", "ppt_set_slide_font_family",
  "ppt_set_slide_font_size", "ppt_set_slide_text_color", "ppt_set_slide_text_bold", "ppt_set_slide_text_italic",
  "ppt_set_slide_text_box_position", "ppt_set_slide_text_box_size", "ppt_set_slide_image_size",
  "ppt_set_slide_image_position", "ppt_add_slide_object_animation", "ppt_replace_slide_image_from_asset",
  "ppt_insert_slide_image_from_asset", "ppt_set_slide_fade", "ppt_propose_page_narration",
  "ppt_propose_page_redo", "ppt_propose_page_fade"] as const;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** Record a current-page checklist before edits through the existing Host permission path. */
export function createPptChangePlanTool(host: { call<T>(method: string, params: unknown): Promise<T> },
  sessionId: string, editorBinding: PptEditorBinding, getTurnId: () => string | undefined): AgentTool {
  const binding = { ...editorBinding };
  const call = host.call.bind(host);
  return {
    name: "ppt_record_change_plan", label: "Record PPT change plan", executionMode: "sequential",
    description: "Before any current-page compound edit, record every requested edit as a short labelled tool step. Read fresh PPT context first. Records a checklist only; does not edit, save, generate, approve or adopt. Once per owning Chat turn, before mutations. Save/review and explicit candidate adoption remain separate. Unsupported/deck-wide scopes must be explained separately.",
    parameters: Type.Object({ editGeneration: Type.Integer({ minimum: 1 }), changes: Type.Array(Type.Object({
      label: Type.String({ minLength: 1, maxLength: 200 }),
      toolName: Type.Union(plannedTools.map(name => Type.Literal(name))),
    }, { additionalProperties: false }), { minItems: 1, maxItems: 20 }) }, { additionalProperties: false }),
    async execute(toolCallId, input, signal) {
      if (!record(input) || Object.keys(input).length !== 2 || !Number.isSafeInteger(input.editGeneration) || Number(input.editGeneration) < 1 ||
          !Array.isArray(input.changes) || !input.changes.length || input.changes.length > 20 ||
          input.changes.some(item => !record(item) || Object.keys(item).length !== 2 ||
            typeof item.label !== "string" || !item.label.trim() || item.label.length > 200 ||
            !plannedTools.some(name => name === item.toolName))) throw new Error("Invalid current-page change plan");
      const changes = structuredClone(input.changes);
      const generation = input.editGeneration;
      const turnId = getTurnId();
      if (!turnId) throw new Error("Change planning requires an active Chat turn");
      const invoke = async (name: string, args: unknown, id: string) => {
        signal?.throwIfAborted();
        if (getTurnId() !== turnId) throw new Error("Chat turn changed before recording its plan");
        const abort = () => { void call("tools.abort", { sessionId, toolCallId: id }).catch(() => undefined); };
        signal?.addEventListener("abort", abort, { once: true });
        try {
          const response = await call<{ ok: boolean; content: unknown; errorCode?: string }>("tools.execute", {
            sessionId, turnId, toolCallId: id, toolName: name, args, mode: "agent",
          });
          signal?.throwIfAborted();
          if (getTurnId() !== turnId) throw new Error("Chat turn changed; inspect the recorded plan before retrying");
          if (!response.ok) throw new Error(`${response.errorCode ?? "Change plan failed"}: inspect the current plan before retrying`);
          return structuredClone(response.content);
        } finally { signal?.removeEventListener("abort", abort); }
      };
      const raw = await invoke("ppt_get_narration_context", binding, randomUUID());
      if (!record(raw)) throw new Error("Invalid planning context");
      assertPptEditorContext(raw.editor);
      const baseline = parsePptCandidateBaseline(raw.baseline);
      if (!samePptEditorBinding(binding, baseline) || !samePptEditorBinding(binding, raw.editor) ||
          generation !== baseline.editGeneration || generation !== raw.editor.editGeneration ||
          raw.clean !== true || raw.manualLocked !== false || raw.editor.readOnly || raw.editor.page === undefined)
        throw new Error("Plan requires the current clean saved and unlocked page");
      const receipt = await invoke("ppt_record_change_plan", { baseline, pageNumber: raw.editor.page, changes }, toolCallId);
      if (!record(receipt) || Object.keys(receipt).length !== 6 || typeof receipt.changeGroupId !== "string" ||
          !/^[\w.-]{1,128}$/u.test(receipt.changeGroupId) || receipt.pageId !== baseline.pageId ||
          receipt.pageNumber !== raw.editor.page || receipt.expectedCount !== changes.length ||
          receipt.recorded !== true || receipt.applied !== false) throw new Error("Invalid plan receipt; inspect before retrying");
      return { content: [{ type: "text", text: JSON.stringify(receipt) }], details: receipt };
    },
  };
}
