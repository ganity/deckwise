export type PptEditorBinding = {
  projectId: string;
  documentId: string;
  sessionId: string;
};

export type CoursewareSourceVisualReview = { reviewId: string; projectId: string; pageId: string; pageNumber: number; sourceSha256: string;
  original: { width: number; height: number; preview: string }; nativeTextless: { width: number; height: number; preview: string } };

export type CoursewareImageReviewView = { reviewId: string; projectId: string;
  asset: { assetId: string; sha256: string; mime: "image/png"; byteLength: number; width: number; height: number };
  preview: string; target?: { page: number; operation: "replace" | "insert" } };

export type PptEditorTool = "get_presentation_text" | "replace_selection" | "add_slide_text" | "set_slide_font_size" | "set_slide_text_bold" | "set_slide_text_italic" | "set_slide_text_color" | "set_slide_text_box_position" | "set_slide_text_box_size" | "set_slide_image_size" | "set_slide_image_position" | "replace_slide_image_from_asset" | "set_slide_font_family" | "insert_slide_image_from_asset" | "set_slide_fade" | "add_slide_object_animation";

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
  | { tool: "set_slide_fade"; input: Record<string, never> }
  | { tool: "add_slide_object_animation"; input: { effect: "appear" | "fade" } }
  | { tool: "replace_selection" | "add_slide_text"; input: { text: string } }
  | { tool: "set_slide_font_family"; input: { fontFamily: string } }
  | { tool: "set_slide_font_size"; input: { fontSizePt: number } }
  | { tool: "set_slide_text_bold" | "set_slide_text_italic"; input: { enabled: boolean } }
  | { tool: "set_slide_text_color"; input: { colorHex: string } }
  | { tool: "set_slide_text_box_position" | "set_slide_image_position"; input: { xMm: number; yMm: number } }
  | { tool: "set_slide_text_box_size" | "set_slide_image_size"; input: { widthMm: number; heightMm: number } }
  | { tool: "replace_slide_image_from_asset"; input: { assetId: string } }
  | { tool: "insert_slide_image_from_asset"; input: { assetId: string; xMm: number; yMm: number; widthMm: number; heightMm: number } }
);

export type PptEditorCommandResult = PptEditorBinding & {
  requestId: string;
  editGeneration: number;
} & (
  | { tool: "get_presentation_text"; status: "sent" | "verified"; result: { text: string; truncated: boolean; slidesRead: number; totalSlides: number } }
  | { tool: "replace_selection"; status: "verified"; result: { replaced: true; length: number; verified: true } }
  | { tool: "add_slide_text"; status: "verified"; result: { page: number; verified: true } }
  | { tool: "set_slide_fade"; status: "verified"; result: { page: number; transition: "fade"; durationMs: 750; verified: true; saved: false } }
  | { tool: "add_slide_object_animation"; status: "verified"; result: { effect: "appear" | "fade"; page: number; verified: true } }
  | { tool: "set_slide_text_box_size" | "set_slide_image_size"; status: "verified"; result: { widthMm: number; heightMm: number; page: number; verified: true } }
  | { tool: "set_slide_text_box_position" | "set_slide_image_position"; status: "verified"; result: { xMm: number; yMm: number; page: number; verified: true } }
  | { tool: "set_slide_text_color"; status: "verified"; result: { colorHex: string; page: number; verified: true } }
  | { tool: "set_slide_font_family"; status: "verified"; result: { fontFamily: string; page: number; verified: true } }
  | { tool: "set_slide_text_bold" | "set_slide_text_italic"; status: "verified"; result: { enabled: boolean; page: number; verified: true } }
  | { tool: "set_slide_font_size"; status: "verified"; result: { fontSizePt: number; page: number; verified: true } }
  | { tool: "insert_slide_image_from_asset"; status: "verified"; result: { assetId: string; sha256: string; xMm: number; yMm: number; widthMm: number; heightMm: number; page: number; verified: true } }
  | { tool: "replace_slide_image_from_asset"; status: "verified"; result: { assetId: string; sha256: string; page: number; verified: true } }
);

function validFontFamily(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && value.trim() === value && !/[\x00-\x1f\x7f]/.test(value);
}

function capabilityFontFamilies(capability: PptEditorContext["capabilities"][number]): string[] {
  const properties = Reflect.get(capability.inputSchema, "properties");
  const font = properties && typeof properties === "object" ? Reflect.get(properties, "fontFamily") : undefined;
  const values = font && typeof font === "object" ? Reflect.get(font, "enum") : undefined;
  if (!Array.isArray(values) || values.length < 1 || values.length > 100 || !values.every(validFontFamily) || new Set(values).size !== values.length) {
    throw new Error("Invalid loaded-font capability");
  }
  return values;
}

function validAssetId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

function capabilityAssetIds(capability: PptEditorContext["capabilities"][number]): string[] {
  const properties = Reflect.get(capability.inputSchema, "properties");
  const assetId = properties && typeof properties === "object" ? Reflect.get(properties, "assetId") : undefined;
  const values = assetId && typeof assetId === "object" ? Reflect.get(assetId, "enum") : undefined;
  if (!Array.isArray(values) || values.length < 1 || values.length > 100 || !values.every(validAssetId) || new Set(values).size !== values.length) {
    throw new Error("Invalid image asset capability");
  }
  return values;
}

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
  } else if (command.tool === "set_slide_fade") {
    if (Object.keys(input).length !== 0) throw new Error("Invalid or unsupported editor command");
  } else if (command.tool === "add_slide_object_animation") {
    if (Object.keys(input).length !== 1 || !["appear", "fade"].includes(Reflect.get(input, "effect")))
      throw new Error("Invalid or unsupported editor command");
  } else if (command.tool === "replace_selection" || command.tool === "add_slide_text") {
    const text = Reflect.get(input, "text");
    if (Object.keys(input).length !== 1 || typeof text !== "string" || !text.length || text.length > 8000 ||
      (command.tool === "add_slide_text" && !text.trim())) throw new Error("Invalid or unsupported editor command");
  } else if (command.tool === "set_slide_text_box_position" || command.tool === "set_slide_image_position") {
    if (Object.keys(input).length !== 2 || ![Reflect.get(input, "xMm"), Reflect.get(input, "yMm")].every(value => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1000))
      throw new Error("Invalid or unsupported editor command");
  } else if (command.tool === "set_slide_text_box_size" || command.tool === "set_slide_image_size") {
    if (Object.keys(input).length !== 2 || ![Reflect.get(input, "widthMm"), Reflect.get(input, "heightMm")].every(value => typeof value === "number" && Number.isFinite(value) && value >= 1 && value <= 1000))
      throw new Error("Invalid or unsupported editor command");
  } else if (command.tool === "set_slide_text_color") {
    if (Object.keys(input).length !== 1 || typeof Reflect.get(input, "colorHex") !== "string" || !/^[0-9A-F]{6}$/.test(Reflect.get(input, "colorHex")))
      throw new Error("Invalid or unsupported editor command");
  } else if (command.tool === "set_slide_font_family") {
    if (Object.keys(input).length !== 1 || !validFontFamily(Reflect.get(input, "fontFamily"))) throw new Error("Invalid or unsupported editor command");
  } else if (command.tool === "set_slide_text_bold" || command.tool === "set_slide_text_italic") {
    if (Object.keys(input).length !== 1 || typeof Reflect.get(input, "enabled") !== "boolean") throw new Error("Invalid or unsupported editor command");
  } else if (command.tool === "set_slide_font_size") {
    const size = Reflect.get(input, "fontSizePt");
    if (Object.keys(input).length !== 1 || typeof size !== "number" || !Number.isFinite(size) ||
      size < 1 || size > 96 || !Number.isInteger(size * 2)) throw new Error("Invalid or unsupported editor command");
  } else if (command.tool === "insert_slide_image_from_asset") {
    if (Object.keys(input).length !== 5 || Object.keys(input).some(key => !["assetId","xMm","yMm","widthMm","heightMm"].includes(key)) ||
      !validAssetId(Reflect.get(input,"assetId")) ||
      !["xMm","yMm","widthMm","heightMm"].every(key => {const v = Reflect.get(input,key); return typeof v === "number" && Number.isFinite(v) && v >= (key === "xMm" || key === "yMm" ? 0 : 1) && v <= 1000;}))
      throw new Error("Invalid or unsupported editor command");
  } else if (command.tool === "replace_slide_image_from_asset") {
    if (Object.keys(input).length !== 1 || !validAssetId(Reflect.get(input, "assetId"))) throw new Error("Invalid or unsupported editor command");
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
    !Array.isArray(context.capabilities) || context.capabilities.length > 16 ||
    new Set(context.capabilities.map((capability) => capability?.name)).size !== context.capabilities.length ||
    context.capabilities.some((capability) => !["get_presentation_text", "replace_selection", "add_slide_text", "set_slide_font_family", "set_slide_font_size", "set_slide_text_bold", "set_slide_text_italic", "set_slide_text_color", "set_slide_text_box_position", "set_slide_text_box_size", "set_slide_image_size", "set_slide_image_position", "replace_slide_image_from_asset", "insert_slide_image_from_asset", "set_slide_fade", "add_slide_object_animation"].includes(capability?.name) ||
      capability.readOnly !== (capability.name === "get_presentation_text") ||
      (context.readOnly && !capability.readOnly) || (["replace_selection", "set_slide_font_family", "set_slide_font_size", "set_slide_text_bold", "set_slide_text_italic", "set_slide_text_color", "set_slide_text_box_position", "set_slide_text_box_size"].includes(capability.name) && !context.selectionCharacters) ||
      (capability.name === "set_slide_font_family" && (context.page === undefined || capabilityFontFamilies(capability).length === 0)) ||
      (["replace_slide_image_from_asset","insert_slide_image_from_asset"].includes(capability.name) && (context.page === undefined || capabilityAssetIds(capability).length === 0)) ||
      (capability.name === "insert_slide_image_from_asset" && context.selectionCharacters !== 0) ||
      (["set_slide_image_size", "set_slide_image_position"].includes(capability.name) && (context.page === undefined || context.selectionCharacters !== 0)) ||
      (capability.name === "add_slide_object_animation" && context.page === undefined) ||
      (capability.name === "set_slide_fade" && (context.page === undefined || capability.inputSchema?.type !== "object" || capability.inputSchema?.additionalProperties !== false || !capability.inputSchema?.properties || typeof capability.inputSchema.properties !== "object" || Array.isArray(capability.inputSchema.properties) || Object.keys(capability.inputSchema.properties).length !== 0)) ||
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
  } else if (response.tool === "set_slide_fade") {
    const result = response.result!;
    if (response.status !== "verified" || result.verified !== true || result.saved !== false || result.transition !== "fade" || result.durationMs !== 750 || !Number.isSafeInteger(result.page) || result.page < 1)
      throw new Error("Invalid editor fade result");
  } else if (response.tool === "add_slide_object_animation") {
    const result = response.result!;
    if (response.status !== "verified" || result.verified !== true || !["appear", "fade"].includes(result.effect) ||
      !Number.isSafeInteger(result.page) || result.page < 1) throw new Error("Invalid editor animation result");
  } else if (response.tool === "add_slide_text") {
    const result = response.result!;
    if (response.status !== "verified" || result.verified !== true || !Number.isSafeInteger(result.page) || result.page < 1) {
      throw new Error("Invalid editor result");
    }
  } else if (response.tool === "set_slide_text_box_position" || response.tool === "set_slide_image_position") {
    const result = response.result!;
    if (response.status !== "verified" || result.verified !== true || !Number.isSafeInteger(result.page) || result.page < 1 ||
      ![result.xMm, result.yMm].every(value => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1000)) throw new Error("Invalid editor result");
  } else if (response.tool === "set_slide_text_box_size" || response.tool === "set_slide_image_size") {
    const result = response.result!;
    if (response.status !== "verified" || result.verified !== true || !Number.isSafeInteger(result.page) || result.page < 1 ||
      ![result.widthMm, result.heightMm].every(value => typeof value === "number" && Number.isFinite(value) && value >= 1 && value <= 1000)) throw new Error("Invalid editor result");
  } else if (response.tool === "set_slide_text_color") {
    const result = response.result!;
    if (response.status !== "verified" || result.verified !== true || !Number.isSafeInteger(result.page) || result.page < 1 ||
      typeof result.colorHex !== "string" || !/^[0-9A-F]{6}$/.test(result.colorHex)) throw new Error("Invalid editor result");
  } else if (response.tool === "set_slide_font_family") {
    const result = response.result!;
    if (response.status !== "verified" || result.verified !== true || !validFontFamily(result.fontFamily) || !Number.isSafeInteger(result.page) || result.page < 1) throw new Error("Invalid editor result");
  } else if (response.tool === "set_slide_text_bold" || response.tool === "set_slide_text_italic") {
    const result = response.result!;
    if (response.status !== "verified" || result.verified !== true || typeof result.enabled !== "boolean" || !Number.isSafeInteger(result.page) || result.page < 1) throw new Error("Invalid editor text formatting result");
  } else if (response.tool === "set_slide_font_size") {
    const result = response.result!;
    if (response.status !== "verified" || result.verified !== true || !Number.isSafeInteger(result.page) || result.page < 1 ||
      typeof result.fontSizePt !== "number" || !Number.isFinite(result.fontSizePt) || result.fontSizePt < 1 || result.fontSizePt > 96 || !Number.isInteger(result.fontSizePt * 2)) throw new Error("Invalid editor result");
  } else if (response.tool === "replace_slide_image_from_asset" || response.tool === "insert_slide_image_from_asset") {
    const result = response.result!;
    if (response.status !== "verified" || result.verified !== true || !validAssetId(result.assetId) ||
      typeof result.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(result.sha256) || !Number.isSafeInteger(result.page) || result.page < 1) {
      throw new Error("Invalid editor result");
    }
    if (response.tool === "insert_slide_image_from_asset" && !["xMm","yMm","widthMm","heightMm"].every(key => {
      const v = Reflect.get(response.result!,key); return typeof v === "number" && Number.isFinite(v) && v >= (key === "xMm" || key === "yMm" ? 0 : 1) && v <= 1000;
    })) throw new Error("Invalid editor result");
  } else throw new Error("Invalid editor result");
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
      typeof page.pageId !== "string" || !page.pageId.length || page.pageId.length > 256 || !/^page_[1-9]\d*$/.test(page.importPageId)) ||
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
  if (command.tool === "add_slide_object_animation" && value.tool === "add_slide_object_animation" && value.result.effect !== command.input.effect)
    throw new Error("Editor animation does not match the request");
  if ((command.tool === "set_slide_text_box_position" || command.tool === "set_slide_image_position") &&
      (value.tool === "set_slide_text_box_position" || value.tool === "set_slide_image_position") &&
      (value.result.xMm !== command.input.xMm || value.result.yMm !== command.input.yMm)) throw new Error("Editor object position does not match the request");
  if ((command.tool === "set_slide_text_box_size" || command.tool === "set_slide_image_size") &&
      (value.tool === "set_slide_text_box_size" || value.tool === "set_slide_image_size") &&
      (value.result.widthMm !== command.input.widthMm || value.result.heightMm !== command.input.heightMm)) throw new Error("Editor text box size does not match the request");
  if (command.tool === "set_slide_text_color" && value.tool === "set_slide_text_color" && value.result.colorHex !== command.input.colorHex) {
    throw new Error("Editor text color does not match the request");
  }
  if (command.tool === "insert_slide_image_from_asset" && value.tool === "insert_slide_image_from_asset" &&
    (command.input.xMm !== value.result.xMm || command.input.yMm !== value.result.yMm || command.input.widthMm !== value.result.widthMm || command.input.heightMm !== value.result.heightMm))
    throw new Error("Editor image geometry does not match the request");
  if (command.tool === "set_slide_font_family" && value.tool === "set_slide_font_family" && value.result.fontFamily !== command.input.fontFamily) {
    throw new Error("Editor font family does not match the request");
  }
  if (((command.tool === "set_slide_text_bold" && value.tool === "set_slide_text_bold") || (command.tool === "set_slide_text_italic" && value.tool === "set_slide_text_italic")) && value.result.enabled !== command.input.enabled) throw new Error("Editor text formatting result does not match the request");
  if (command.tool === "set_slide_font_size" && value.tool === "set_slide_font_size" && value.result.fontSizePt !== command.input.fontSizePt) {
    throw new Error("Editor font size does not match the request");
  }
  if (((command.tool === "replace_slide_image_from_asset" && value.tool === "replace_slide_image_from_asset") || (command.tool === "insert_slide_image_from_asset" && value.tool === "insert_slide_image_from_asset")) && value.result.assetId !== command.input.assetId) {
    throw new Error("Editor image result does not match the requested asset");
  }
}
