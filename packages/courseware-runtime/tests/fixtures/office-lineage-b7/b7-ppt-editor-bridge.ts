export type PptEditorBinding = {
  projectId: string;
  documentId: string;
  sessionId: string;
};

export type PptEditorTool = "get_presentation_text" | "replace_selection" | "add_slide_text";

export type PptEditorContext = PptEditorBinding & {
  editGeneration: number;
  kind: "slide";
  page?: number;
  pageLineage?: PptEditorPageLineageContext;
  selectedText: string;
  selectionCharacters: number;
  readOnly: boolean;
  capabilities: Array<{
    name: PptEditorTool;
    description: string;
    inputSchema: Record<string, unknown>;
    readOnly: boolean;
  }>;
};

export type PptEditorCommand = PptEditorBinding & {
  requestId: string;
  editGeneration: number;
} & (
  | { tool: "get_presentation_text"; input: { maxChars?: number } }
  | { tool: "replace_selection" | "add_slide_text"; input: { text: string } }
);

export type PptEditorCommandResult = PptEditorBinding & {
  requestId: string;
  editGeneration: number;
} & (
  | { tool: "get_presentation_text"; status: "sent" | "verified"; result: { text: string; truncated: boolean; slidesRead: number; totalSlides: number } }
  | { tool: "replace_selection"; status: "verified"; result: { replaced: true; length: number; verified: true } }
  | { tool: "add_slide_text"; status: "verified"; result: { page: number; verified: true } }
);

export function isPptEditorBinding(value: unknown): value is PptEditorBinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return ["projectId", "documentId", "sessionId"].every((key) => {
    const id = Reflect.get(value, key);
    return typeof id === "string" && id.length > 0 && id.length <= 128;
  });
}

export function assertPptEditorCommand(value: unknown): asserts value is PptEditorCommand {
  if (!isPptEditorBinding(value)) throw new Error("Invalid editor binding");
  const command = value as Partial<PptEditorCommand>;
  const input = command.input;
  if (
    typeof command.requestId !== "string" || !/^[\w-]{1,128}$/.test(command.requestId) ||
    !Number.isSafeInteger(command.editGeneration) || Number(command.editGeneration) < 1 ||
    !input || typeof input !== "object" || Array.isArray(input) ||
    Object.keys(command).some((key) => !["projectId", "documentId", "sessionId", "requestId", "editGeneration", "tool", "input"].includes(key))
  ) throw new Error("Invalid or unsupported editor command");
  if (command.tool === "get_presentation_text") {
    const maxChars = Reflect.get(input, "maxChars");
    if (Object.keys(input).some((key) => key !== "maxChars") ||
      (maxChars !== undefined && (!Number.isInteger(maxChars) || maxChars < 1 || maxChars > 8000))) {
      throw new Error("Invalid or unsupported editor command");
    }
  } else if (command.tool === "replace_selection" || command.tool === "add_slide_text") {
    const text = Reflect.get(input, "text");
    if (Object.keys(input).length !== 1 || typeof text !== "string" || !text.length || text.length > 8000 ||
      (command.tool === "add_slide_text" && !text.trim())) throw new Error("Invalid or unsupported editor command");
  } else throw new Error("Invalid or unsupported editor command");
}

export function samePptEditorBinding(a: PptEditorBinding, b: PptEditorBinding): boolean {
  return a.projectId === b.projectId && a.documentId === b.documentId && a.sessionId === b.sessionId;
}

export function assertPptEditorContext(value: unknown): asserts value is PptEditorContext {
  if (!isPptEditorBinding(value)) throw new Error("Invalid editor context binding");
  const context = value as Partial<PptEditorContext>;
  if (
    context.kind !== "slide" || !Number.isSafeInteger(context.editGeneration) || Number(context.editGeneration) < 1 ||
    (context.page !== undefined && (!Number.isSafeInteger(context.page) || context.page < 1)) ||
    typeof context.readOnly !== "boolean" || typeof context.selectedText !== "string" || context.selectedText.length > 8000 ||
    !Number.isSafeInteger(context.selectionCharacters) || Number(context.selectionCharacters) < context.selectedText.length ||
    !Array.isArray(context.capabilities) || context.capabilities.length > 3 ||
    new Set(context.capabilities.map((capability) => capability?.name)).size !== context.capabilities.length ||
    context.capabilities.some((capability) => !["get_presentation_text", "replace_selection", "add_slide_text"].includes(capability?.name) ||
      capability.readOnly !== (capability.name === "get_presentation_text") ||
      (context.readOnly && !capability.readOnly) || (capability.name === "replace_selection" && !context.selectionCharacters) ||
      typeof capability.description !== "string" || capability.description.length > 8000 ||
      !capability.inputSchema || typeof capability.inputSchema !== "object" || Array.isArray(capability.inputSchema))
  ) throw new Error("Invalid editor context");
  if (context.pageLineage !== undefined) assertPptEditorPageLineageContext(context.pageLineage);
}

export function assertPptEditorCommandResult(value: unknown): asserts value is PptEditorCommandResult {
  if (!isPptEditorBinding(value)) throw new Error("Invalid editor result binding");
  const response = value as Partial<PptEditorCommandResult>;
  if (
    typeof response.requestId !== "string" || !/^[\w-]{1,128}$/.test(response.requestId) || !Number.isSafeInteger(response.editGeneration) || Number(response.editGeneration) < 1 ||
    !["sent", "verified"].includes(String(response.status)) || !response.result
  ) throw new Error("Invalid editor result");
  if (response.tool === "get_presentation_text") {
    const result = response.result!;
    if (typeof result.text !== "string" || result.text.length > 8000 || typeof result.truncated !== "boolean" ||
      !Number.isSafeInteger(result.slidesRead) || result.slidesRead < 0 ||
      !Number.isSafeInteger(result.totalSlides) || result.totalSlides < result.slidesRead) throw new Error("Invalid editor result");
  } else if (response.tool === "replace_selection") {
    const result = response.result!;
    if (response.status !== "verified" || result.verified !== true || result.replaced !== true ||
      !Number.isSafeInteger(result.length) || result.length < 1 || result.length > 8000) throw new Error("Invalid editor result");
  } else if (response.tool === "add_slide_text") {
    const result = response.result!;
    if (response.status !== "verified" || result.verified !== true || !Number.isSafeInteger(result.page) || result.page < 1) {
      throw new Error("Invalid editor result");
    }
  } else throw new Error("Invalid editor result");
}

/** A valid response is still untrusted until it matches the dispatched command. */
export function assertPptEditorCommandResponse(command: PptEditorCommand, value: unknown): asserts value is PptEditorCommandResult {
  assertPptEditorCommandResult(value);
  if (!samePptEditorBinding(command, value) || command.requestId !== value.requestId ||
    command.editGeneration !== value.editGeneration || command.tool !== value.tool) {
    throw new Error("Editor result does not match the request");
  }
  if (command.tool === "replace_selection" && value.tool === "replace_selection" && value.result.length !== command.input.text.length) {
    throw new Error("Editor replacement length does not match the request");
  }
}

/** Session tokens are live Office object references, not durable logical page IDs. */
export type PptEditorPageLineageContext = {
  sourceSha256: string;
  openedPageTokens: string[];
  pageTokens: string[];
};

export type PptEditorPageLineageReceipt = PptEditorBinding & PptEditorPageLineageContext & {
  protocol: "deckwise-office-page-lineage/1";
  saveRequestId: string;
  outputSha256: string;
};

export function assertPptEditorPageLineageContext(value: unknown): asserts value is PptEditorPageLineageContext {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid editor page lineage");
  const context = value as Partial<PptEditorPageLineageContext>;
  const tokens = (values: unknown): values is string[] => Array.isArray(values) && values.length > 0 && values.length <= 5000 &&
    values.every((token) => typeof token === "string" && /^[\w-]{1,128}$/.test(token)) && new Set(values).size === values.length;
  if (typeof context.sourceSha256 !== "string" || !/^[a-f0-9]{64}$/.test(context.sourceSha256) ||
    !tokens(context.openedPageTokens) || !tokens(context.pageTokens)) throw new Error("Invalid editor page lineage");
}

export function assertPptEditorPageLineageReceipt(value: unknown): asserts value is PptEditorPageLineageReceipt {
  assertPptEditorPageLineageContext(value);
  if (!isPptEditorBinding(value) || Reflect.get(value, "protocol") !== "deckwise-office-page-lineage/1" ||
    typeof Reflect.get(value, "saveRequestId") !== "string" || !/^[\w-]{1,128}$/.test(Reflect.get(value, "saveRequestId")) ||
    typeof Reflect.get(value, "outputSha256") !== "string" || !/^[a-f0-9]{64}$/.test(Reflect.get(value, "outputSha256"))) {
    throw new Error("Invalid editor page lineage receipt");
  }
}

/** Host-only: receipt must come from the bound Office view, never a model/renderer payload. */
export function createPptEditorPageLineage(input: {
  receipt: unknown;
  binding: PptEditorBinding;
  saveRequestId: string;
  sourceSha256: string;
  outputSha256: string;
  sourcePages: ReadonlyArray<{ pageId: string; importPageId: string }>;
}) {
  const { receipt } = input;
  assertPptEditorPageLineageReceipt(receipt);
  if (!isPptEditorBinding(input.binding) || !samePptEditorBinding(input.binding, receipt) || receipt.saveRequestId !== input.saveRequestId ||
    receipt.sourceSha256 !== input.sourceSha256 || receipt.outputSha256 !== input.outputSha256) {
    throw new Error("Editor page lineage does not match the saved bytes/session");
  }
  const pages = input.sourcePages;
  const count = receipt.openedPageTokens.length;
  if (!Array.isArray(pages) || pages.some((page) => !page || typeof page !== "object") || pages.length !== count || new Set(pages.map((page) => page.pageId)).size !== count ||
    new Set(pages.map((page) => page.importPageId)).size !== count || pages.some((page) =>
      typeof page.pageId !== "string" || !page.pageId.length || page.pageId.length > 256 ||
      !/^page_[1-9]\d*$/.test(page.importPageId)) ||
    receipt.pageTokens.length !== count || receipt.pageTokens.some((token) => !receipt.openedPageTokens.includes(token))) {
    throw new Error("Editor page inventory changed or source mapping is incomplete; explicit identity review required");
  }
  const logicalIds = new Map(pages.map((page) => [page.importPageId, page.pageId]));
  const identities = new Map(receipt.openedPageTokens.map((token, index) => [token, logicalIds.get("page_" + (index + 1))]));
  if ([...identities.values()].some((id) => !id)) throw new Error("Source page mapping is incomplete");
  return {
    previousSourceSha256: input.sourceSha256,
    currentSourceSha256: input.outputSha256,
    pages: receipt.pageTokens.map((token, index) => ({ oldLogicalId: identities.get(token)!, importPageId: "page_" + (index + 1) })),
    copiedImportPageIds: [],
    replacements: [],
  };
}
