import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  assertPptEditorContext, isPptEditorBinding, samePptEditorBinding,
  type PptEditorBinding, type PptEditorContext,
} from "@pi-desktop/shared";

export type PptCandidateKind = "page-pptx" | "page-narration" | "page-fade" | "page-style-batch";
export type PptCandidateBaseline = PptEditorBinding & {
  editGeneration: number;
  coursewareProjectId: string;
  pageId: string;
  sourceRevision: string;
  sourceSha256: string;
  teachingRevision: string;
  contentSha256: string;
};
export type PptCandidateContext = {
  editor: PptEditorContext;
  baseline: PptCandidateBaseline;
  clean: boolean;
  manualLocked: boolean;
  capabilities: PptCandidateKind[];
  styleBatch?: { reviewId: string; pageIds: string[] };
};
export type PptCandidateReceipt = {
  candidateId: string;
  kind: PptCandidateKind;
  baseline: PptCandidateBaseline;
  outputSha256?: string;
  targetPageIds?: string[];
  reviewState: "needs-review";
  applied: false;
};
/** Host owns source bytes, identity mapping, authorized generation and pending candidate storage. */
export interface PptCandidateToolHost {
  binding: PptEditorBinding;
  getContext(signal?: AbortSignal): Promise<unknown>;
  propose(request: { kind: PptCandidateKind; baseline: PptCandidateBaseline; instruction?: string; styleBatch?: PptCandidateContext["styleBatch"] }, signal?: AbortSignal): Promise<unknown>;
}

const kinds: PptCandidateKind[] = ["page-pptx", "page-narration", "page-fade", "page-style-batch"];
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const id = (value: unknown): value is string => typeof value === "string" && /^[\w.-]{1,128}$/u.test(value);
const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f\d]{64}$/iu.test(value);
const baselineKeys = ["projectId", "documentId", "sessionId", "editGeneration", "coursewareProjectId", "pageId", "sourceRevision", "sourceSha256", "teachingRevision", "contentSha256"] as const;

function baseline(value: unknown): PptCandidateBaseline {
  if (!record(value)) throw new Error("Invalid candidate baseline");
  const { editGeneration, coursewareProjectId, pageId, sourceRevision, sourceSha256, teachingRevision, contentSha256 } = value;
  if (!isPptEditorBinding(value) || Object.keys(value).length !== baselineKeys.length ||
    Object.keys(value).some((key) => !baselineKeys.some((name) => name === key)) ||
    typeof editGeneration !== "number" || !Number.isSafeInteger(editGeneration) || editGeneration < 1 ||
    !id(coursewareProjectId) || !id(pageId) || !id(sourceRevision) || !id(teachingRevision) || !hash(sourceSha256) || !hash(contentSha256)) {
    throw new Error("Invalid candidate baseline");
  }
  return { projectId: value.projectId, documentId: value.documentId, sessionId: value.sessionId,
    editGeneration, coursewareProjectId, pageId, sourceRevision, teachingRevision, sourceSha256: sourceSha256.toLowerCase(), contentSha256: contentSha256.toLowerCase() };
}

export { baseline as parsePptCandidateBaseline };

function sameBaseline(a: PptCandidateBaseline, b: PptCandidateBaseline) {
  return baselineKeys.every((key) => a[key] === b[key]);
}

export function registerPptCandidateTools(api: Pick<ExtensionAPI, "registerTool">, host: PptCandidateToolHost): void {
  for (const tool of createPptCandidateTools(host)) api.registerTool(tool);
}

/** Independent proposals for the existing Chat; never execute native edits, adopt or save. */
export function createPptCandidateTools(host: PptCandidateToolHost): AgentTool[] {
  const binding = { ...host.binding };
  const getContext = host.getContext.bind(host);
  const propose = host.propose.bind(host);
  const context = async (signal?: AbortSignal): Promise<PptCandidateContext> => {
    signal?.throwIfAborted();
    const raw = await getContext(signal);
    signal?.throwIfAborted();
    if (!record(raw)) throw new Error("Invalid candidate context");
    assertPptEditorContext(raw.editor);
    const current = baseline(raw.baseline);
    if (!samePptEditorBinding(binding, raw.editor) || !samePptEditorBinding(binding, current) || raw.editor.editGeneration !== current.editGeneration) {
      throw new Error("Candidate editor session changed; read fresh context");
    }
    if (typeof raw.clean !== "boolean" || typeof raw.manualLocked !== "boolean" || !Array.isArray(raw.capabilities) ||
      raw.capabilities.length > kinds.length || new Set(raw.capabilities).size !== raw.capabilities.length ||
      raw.capabilities.some((kind) => !kinds.includes(kind))) throw new Error("Invalid candidate context");
    if (raw.editor.readOnly || raw.manualLocked || !raw.clean || raw.editor.page === undefined) {
      throw new Error("Candidate unavailable: save the latest document and resolve read-only, page identity or manual lock first");
    }
    const scope = raw.styleBatch;
    const batch = raw.capabilities.includes("page-style-batch");
    if (batch !== Object.hasOwn(raw, "styleBatch") || (batch && (!record(scope) || Object.keys(scope).length !== 2 ||
        !id(scope.reviewId) || !Array.isArray(scope.pageIds) || scope.pageIds.length < 2 || scope.pageIds.length > 20 ||
        new Set(scope.pageIds).size !== scope.pageIds.length || scope.pageIds.some(pageId => !id(pageId)) || !scope.pageIds.includes(current.pageId))))
      throw new Error("Invalid confirmed style scope");
    return { editor: structuredClone(raw.editor), baseline: current, clean: raw.clean, manualLocked: raw.manualLocked, capabilities: [...raw.capabilities],
      ...(batch ? { styleBatch: structuredClone(scope) as NonNullable<PptCandidateContext["styleBatch"]> } : {}) };
  };
  const generation = Type.Integer({ minimum: 1, description: "editGeneration from the latest native PPT text/context result; read again after a change." });
  const instruction = Type.String({ minLength: 1, maxLength: 8000 });
  const tools = [
    { kind: "page-pptx", name: "ppt_propose_page_redo", description: "Create a review candidate for the current logical page from the latest clean PPTX copy. Rebuilds target objects; review mapping and teaching. Does not edit, adopt or save the open document." },
    { kind: "page-narration", name: "ppt_propose_page_narration", description: "Propose replacement narration for the current logical page using its teaching policy. Waits are structured; no answer assessment or ready audio is claimed. Does not adopt or save." },
    { kind: "page-fade", name: "ppt_propose_page_fade", description: "Propose one medium smooth fade on the current logical page using a clean PPTX copy. Preserves page objects. No arbitrary transition or object animation. Does not adopt or save." },
    { kind: "page-style-batch", name: "ppt_propose_page_style_batch", description: "Create one pending style batch using only the representative, original instruction and exact 2–20 unlocked pages explicitly reviewed in the existing sidebar. Supply only the latest edit generation. Cannot choose scope, change instructions, adopt or save." },
  ] as const;
  return tools.map(({ kind, name, description }) => {
    const batch = kind === "page-style-batch", needsInstruction = kind !== "page-fade" && !batch;
    return {
      name, label: name, description, executionMode: "sequential",
      parameters: Type.Object(needsInstruction ? { editGeneration: generation, instruction } : { editGeneration: generation }, { additionalProperties: false }),
      async execute(_toolCallId, input, signal) {
        if (!record(input) || Object.keys(input).some((key) => !["editGeneration", ...(needsInstruction ? ["instruction"] : [])].includes(key)) ||
          !Number.isSafeInteger(input.editGeneration) || Number(input.editGeneration) < 1 ||
          (needsInstruction && (typeof input.instruction !== "string" || !input.instruction.trim() || input.instruction.length > 8000))) {
          throw new Error("Invalid candidate tool input");
        }
        const requestedGeneration = input.editGeneration;
        const requestedInstruction = input.instruction;
        const before = await context(signal);
        if (requestedGeneration !== before.baseline.editGeneration) throw new Error("Editor context changed; read and review the current page before proposing");
        if (!before.capabilities.includes(kind)) throw new Error(`Candidate capability unavailable: ${kind}`);
        const expected = { ...before.baseline };
        const scope = batch ? structuredClone(before.styleBatch) : undefined;
        const request = { kind, baseline: { ...expected }, ...(needsInstruction ? { instruction: requestedInstruction as string } : {}),
          ...(batch ? { styleBatch: structuredClone(scope) } : {}) };
        const raw = structuredClone(await propose(request, signal));
        signal?.throwIfAborted();
        if (!record(raw) || !id(raw.candidateId) || raw.kind !== kind || raw.reviewState !== "needs-review" || raw.applied !== false ||
          Object.keys(raw).some((key) => !["candidateId", "kind", "baseline", "outputSha256", "reviewState", "applied", ...(batch ? ["targetPageIds"] : [])].includes(key)) ||
          (kind === "page-narration" ? Object.hasOwn(raw, "outputSha256") : !hash(raw.outputSha256)) || !sameBaseline(expected, baseline(raw.baseline)) ||
          (batch && JSON.stringify(raw.targetPageIds) !== JSON.stringify(scope?.pageIds))) {
          throw new Error("Invalid or mismatched candidate receipt; inspect pending candidates before retrying");
        }
        const after = await context(signal);
        if (!sameBaseline(expected, after.baseline) || !after.capabilities.includes(kind) || (batch && JSON.stringify(after.styleBatch) !== JSON.stringify(scope))) throw new Error("Candidate baseline changed while generating; do not adopt the late result");
        const receipt: PptCandidateReceipt = { candidateId: raw.candidateId, kind, baseline: expected, reviewState: "needs-review", applied: false,
          ...(kind === "page-narration" ? {} : { outputSha256: (raw.outputSha256 as string).toLowerCase() }),
          ...(batch ? { targetPageIds: [...scope!.pageIds] } : {}) };
        const details = { ...receipt, saved: false as const, ...(kind === "page-narration" ? { audioReady: false as const } : {}) };
        return { content: [{ type: "text", text: JSON.stringify(details) }], details };
      },
    };
  });
}
