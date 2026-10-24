import { describe, expect, it, vi } from "vitest";
import type { PptEditorCommand, PptEditorContext } from "@pi-desktop/shared";
import { createPptEditorTools, registerPptEditorTools } from "./ppt-editor-tools.js";

const binding = { projectId: "project", documentId: "document", sessionId: "session" };
function setup() {
  let current: PptEditorContext = {
    ...binding, kind: "slide", editGeneration: 1, page: 1, selectedText: "old", selectionCharacters: 3,
    readOnly: false, capabilities: ["get_presentation_text", "replace_selection", "add_slide_text"].map(name => ({
      name: name as PptEditorContext["capabilities"][number]["name"], description: name,
      readOnly: name === "get_presentation_text", inputSchema: {},
    })),
  };
  const getContext = vi.fn(async () => current);
  const execute = vi.fn(async (command: PptEditorCommand) => {
    current = { ...current, editGeneration: current.editGeneration + 1 };
    return { ...command, status: command.tool === "get_presentation_text" ? "sent" : "verified", result:
      command.tool === "get_presentation_text" ? { text: "old", truncated: false, slidesRead: 1, totalSlides: 2 } :
      command.tool === "replace_selection" ? { replaced: true, length: command.input.text.length, verified: true } :
      command.tool === "replace_slide_image_from_asset" ? { assetId: command.input.assetId, sha256: "a".repeat(64), imageId: "host-private-image-token", page: 1, verified: true } :
      { page: 1, verified: true },
    };
  });
  const tools = createPptEditorTools({ binding, getContext, execute });
  return { tools, execute, getContext, change: (patch: Partial<PptEditorContext>) => { current = { ...current, ...patch }; } };
}

describe("existing Chat native PPT tool module", () => {
  it("registers the sixteen finite sequential tools through the existing extension API", () => {
    const state = setup();
    const registerTool = vi.fn();
    registerPptEditorTools({ registerTool }, { binding, getContext: state.getContext, execute: state.execute });
    expect(registerTool.mock.calls.map(([tool]) => [tool.name, tool.executionMode])).toEqual([
      ["ppt_get_presentation_text", "sequential"], ["ppt_replace_selection", "sequential"], ["ppt_add_slide_text", "sequential"],
      ["ppt_set_slide_font_size", "sequential"], ["ppt_set_slide_text_color", "sequential"], ["ppt_set_slide_text_box_position", "sequential"],
      ["ppt_replace_slide_image_from_asset", "sequential"], ["ppt_set_slide_font_family", "sequential"], ["ppt_set_slide_text_box_size", "sequential"], ["ppt_insert_slide_image_from_asset", "sequential"], ["ppt_set_slide_text_bold", "sequential"], ["ppt_set_slide_text_italic", "sequential"], ["ppt_set_slide_fade", "sequential"],
      ["ppt_set_slide_image_size", "sequential"], ["ppt_set_slide_image_position", "sequential"], ["ppt_add_slide_object_animation", "sequential"],
    ]);
  });
  it("reads, exposes fresh context, edits and checks correlated native readback without claiming a save", async () => {
    const { tools, execute } = setup();
    expect(tools.map(t => t.name)).toEqual(["ppt_get_presentation_text", "ppt_replace_selection", "ppt_add_slide_text", "ppt_set_slide_font_size", "ppt_set_slide_text_color", "ppt_set_slide_text_box_position", "ppt_replace_slide_image_from_asset", "ppt_set_slide_font_family", "ppt_set_slide_text_box_size", "ppt_insert_slide_image_from_asset", "ppt_set_slide_text_bold", "ppt_set_slide_text_italic", "ppt_set_slide_fade", "ppt_set_slide_image_size", "ppt_set_slide_image_position", "ppt_add_slide_object_animation"]);
    const read = await tools[0]!.execute("model-read", {});
    expect(read.details).toMatchObject({ context: { editGeneration: 2, selectedText: "old" }, saved: false });
    const written = await tools[1]!.execute("model-write", { editGeneration: 2, text: "new 世界" });
    expect(written.details).toMatchObject({ response: { status: "verified", result: { length: 6 } }, context: { editGeneration: 3 }, saved: false });
    expect(execute.mock.calls[1]![0]).toMatchObject({ ...binding, editGeneration: 2, tool: "replace_selection", input: { text: "new 世界" } });
  });
  it("keeps host-only page lineage out of model tool results", async () => {
    const state = setup();
    state.change({ pageLineage: { sourceSha256: "a".repeat(64), openedPageTokens: ["private-page-token"], pageTokens: ["private-page-token"] } });
    const read = await state.tools[0]!.execute("read", {});
    expect(read.details).toMatchObject({ context: { page: 1, editGeneration: 2 } });
    expect(JSON.stringify(read)).not.toContain("private-page-token");
    expect(JSON.stringify(read)).not.toContain("pageLineage");
    expect((await state.getContext()).pageLineage).toBeDefined();
  });
  it("supports font size only when advertised, with exact result size/page and fresh generation", async () => {
    const state = setup();
    const font = state.tools[3]!;
    await expect(font.execute("font", { fontSizePt: 44.5, editGeneration: 1 })).rejects.toThrow(/unavailable/);
    expect(state.execute).not.toHaveBeenCalled();
    state.change({ capabilities: [{ name: "set_slide_font_size", description: "Size", readOnly: false, inputSchema: {} }] });
    state.execute.mockImplementationOnce(async c => ({ ...c, status: "verified", result: { fontSizePt: 44.5, page: 1, verified: true } }));
    await expect(font.execute("font", { fontSizePt: 44.5, editGeneration: 1 })).resolves.toMatchObject({ details: { saved: false, response: { result: { fontSizePt: 44.5 } } } });
    for (const input of [{ fontSizePt: 12.25, editGeneration: 1 }, { fontSizePt: 44, editGeneration: 0 }, { fontSizePt: 44, editGeneration: 1, script: "bad" }])
      await expect(font.execute("font", input)).rejects.toThrow();
    for (const result of [{ fontSizePt: 44, page: 1, verified: true }, { fontSizePt: 44.5, page: 2, verified: true }]) {
      state.execute.mockImplementationOnce(async c => ({ ...c, status: "verified", result }));
      await expect(font.execute("font", { fontSizePt: 44.5, editGeneration: 1 })).rejects.toThrow();
    }
    expect(state.execute).toHaveBeenCalledTimes(3);
  });
  it("supports text color only when advertised, with exact result size/page and fresh generation", async () => {
    const state = setup();
    const font = state.tools[4]!;
    await expect(font.execute("font", { colorHex: "336699", editGeneration: 1 })).rejects.toThrow(/unavailable/);
    expect(state.execute).not.toHaveBeenCalled();
    state.change({ capabilities: [{ name: "set_slide_text_color", description: "Size", readOnly: false, inputSchema: {} }] });
    state.execute.mockImplementationOnce(async c => ({ ...c, status: "verified", result: { colorHex: "336699", page: 1, verified: true } }));
    await expect(font.execute("font", { colorHex: "336699", editGeneration: 1 })).resolves.toMatchObject({ details: { saved: false, response: { result: { colorHex: "336699" } } } });
    for (const input of [{ colorHex: "#336699", editGeneration: 1 }, { colorHex: "AABBCC", editGeneration: 0 }, { colorHex: "AABBCC", editGeneration: 1, script: "bad" }])
      await expect(font.execute("font", input)).rejects.toThrow();
    for (const result of [{ colorHex: "AABBCC", page: 1, verified: true }, { colorHex: "336699", page: 2, verified: true }]) {
      state.execute.mockImplementationOnce(async c => ({ ...c, status: "verified", result }));
      await expect(font.execute("font", { colorHex: "336699", editGeneration: 1 })).rejects.toThrow();
    }
    expect(state.execute).toHaveBeenCalledTimes(3);
  });
  it("rejects stale selection/page/document, read-only and missing capability before dispatch", async () => {
    for (const patch of [
      { editGeneration: 2, page: 2 }, { sessionId: "other" },
      { readOnly: true, capabilities: [] }, { capabilities: [] },
    ]) {
      const state = setup(); state.change(patch);
      await expect(state.tools[1]!.execute("w", { editGeneration: 1, text: "x" })).rejects.toThrow();
      expect(state.execute).not.toHaveBeenCalled();
    }
    const missingPage = setup(); missingPage.change({ page: undefined });
    await expect(missingPage.tools[2]!.execute("w", { editGeneration: 1, text: "x" })).rejects.toThrow(/page/);
    expect(missingPage.execute).not.toHaveBeenCalled();
  });
  it("rejects unknown inputs, bad responses and wrong native page without retrying", async () => {
    const state = setup();
    await expect(state.tools[2]!.execute("w", { editGeneration: 1, text: "x", script: "evil" })).rejects.toThrow();
    state.execute.mockImplementationOnce(async c => ({ ...c, requestId: "other", status: "verified", result: { page: 1, verified: true } }));
    await expect(state.tools[2]!.execute("w", { editGeneration: 1, text: "x" })).rejects.toThrow(/match/);
    state.execute.mockImplementationOnce(async c => ({ ...c, status: "verified", result: { page: 2, verified: true } }));
    await expect(state.tools[2]!.execute("w", { editGeneration: 1, text: "x" })).rejects.toThrow(/unexpected page/);
    expect(state.execute).toHaveBeenCalledTimes(2);
  });
  it("preserves save-in-progress rejection and cancellation at both sides of dispatch", async () => {
    const state = setup();
    state.getContext.mockRejectedValueOnce(new Error("save is in progress"));
    await expect(state.tools[0]!.execute("r", {})).rejects.toThrow(/save/);
    const abort = new AbortController(); abort.abort();
    await expect(state.tools[0]!.execute("r", {}, abort.signal)).rejects.toThrow();
    expect(state.execute).not.toHaveBeenCalled();
    const later = new AbortController();
    state.execute.mockImplementationOnce(async c => { later.abort(); return { ...c, status: "verified", result: { page: 1, verified: true } }; });
    await expect(state.tools[2]!.execute("w", { editGeneration: 1, text: "x" }, later.signal)).rejects.toThrow();
    expect(state.execute).toHaveBeenCalledTimes(1);
  });
});

it("dispatches optional selected text-box positions only with fresh capability and correlated page/coordinates", async () => {
 const state=setup();const move=state.tools[5]!;
 await expect(move.execute("pos",{xMm:25,yMm:35,editGeneration:1})).rejects.toThrow(/unavailable/);
 state.change({capabilities:[{name:"set_slide_text_box_position",description:"Move text box",readOnly:false,inputSchema:{}}]});
 state.execute.mockImplementationOnce(async c=>({...c,status:"verified",result:{xMm:25,yMm:35,page:1,verified:true}}));
 await expect(move.execute("pos",{xMm:25,yMm:35,editGeneration:1})).resolves.toMatchObject({details:{saved:false,response:{result:{xMm:25,yMm:35}}}});
 for(const input of [{xMm:-1,yMm:35,editGeneration:1},{xMm:25,yMm:35,editGeneration:0},{xMm:25,yMm:35,editGeneration:1,script:"bad"}])await expect(move.execute("pos",input)).rejects.toThrow();
 for(const result of [{xMm:24,yMm:35,page:1,verified:true},{xMm:25,yMm:34,page:1,verified:true},{xMm:25,yMm:35,page:2,verified:true}]){
 state.execute.mockImplementationOnce(async c=>({...c,status:"verified",result}));await expect(move.execute("pos",{xMm:25,yMm:35,editGeneration:1})).rejects.toThrow();
 }
 expect(state.execute).toHaveBeenCalledTimes(4);
});

it("replaces only the latest capability-authorized asset and hides Office object IDs", async () => {
 const state=setup();const replace=state.tools[6]!;
 await expect(replace.execute("image",{assetId:"asset_123",editGeneration:1})).rejects.toThrow(/unavailable/);
 expect(state.execute).not.toHaveBeenCalled();
 const imageCapability={name:"replace_slide_image_from_asset" as const,description:"Replace reviewed image",readOnly:false,inputSchema:{type:"object",properties:{assetId:{type:"string",enum:["asset_123","asset_456"]}},required:["assetId"],additionalProperties:false}};
 state.change({capabilities:[imageCapability]});
 const applied=await replace.execute("image",{assetId:"asset_123",editGeneration:1});
 expect(applied.details).toMatchObject({saved:false,response:{tool:"replace_slide_image_from_asset",result:{assetId:"asset_123",sha256:"a".repeat(64),page:1,verified:true}}});
 expect(JSON.stringify(applied)).not.toContain("host-private-image-token");
 expect(state.execute.mock.calls[0]![0]).toMatchObject({...binding,tool:"replace_slide_image_from_asset",editGeneration:1,input:{assetId:"asset_123"}});
 await expect(replace.execute("image",{assetId:"other_asset",editGeneration:1})).rejects.toThrow(/authorized/);
 for(const input of [{assetId:"../asset",editGeneration:1},{assetId:"asset_456",editGeneration:0},{assetId:"asset_123",editGeneration:1,url:"https://example.invalid"}])await expect(replace.execute("image",input)).rejects.toThrow();
 state.change({editGeneration:2});
 state.execute.mockImplementationOnce(async c=>({...c,status:"verified",result:{assetId:"asset_456",sha256:"a".repeat(64),imageId:"host-private-image-token",page:1,verified:true}}));
 await expect(replace.execute("image",{assetId:"asset_123",editGeneration:2})).rejects.toThrow(/requested asset/);
 expect(state.execute).toHaveBeenCalledTimes(2);
});

it("dispatches loaded font families only from the latest enum and correlates exact family/page", async () => {
  const state=setup(),font=state.tools.find(t=>t.name==="ppt_set_slide_font_family")!;
  const input={fontFamily:"Courier New",editGeneration:1};
  await expect(font.execute("family",input)).rejects.toThrow(/unavailable/);
  state.change({capabilities:[{name:"set_slide_font_family",description:"Loaded font",readOnly:false,inputSchema:{properties:{fontFamily:{enum:["Arial","Courier New"]}}}}]});
  for(const patch of [{fontFamily:"Unknown"},{editGeneration:0},{fontFamily:"Courier New",script:"bad"}])
    await expect(font.execute("family",{...input,...patch})).rejects.toThrow();
  expect(state.execute).not.toHaveBeenCalled();
  state.execute.mockImplementationOnce(async c=>({...c,status:"verified",result:{fontFamily:"Courier New",page:1,verified:true}}));
  await expect(font.execute("family",input)).resolves.toMatchObject({details:{saved:false,response:{result:{fontFamily:"Courier New"}}}});
  for(const result of [{fontFamily:"Arial",page:1,verified:true},{fontFamily:"Courier New",page:2,verified:true}]) {
    state.execute.mockImplementationOnce(async c=>({...c,status:"verified",result}));
    await expect(font.execute("family",input)).rejects.toThrow();
  }
  state.change({capabilities:[{name:"set_slide_font_family",description:"Loaded font",readOnly:false,inputSchema:{properties:{fontFamily:{enum:["Arial"]}}}}]});
  await expect(font.execute("family",input)).rejects.toThrow(/loaded-font/);
  expect(state.execute).toHaveBeenCalledTimes(3);
});

it.each(['set_slide_text_box_size', 'set_slide_image_size'] as const)('dispatches %s only with a fresh capability and exact correlated dimensions', async name => {
  const state = setup(); const resize = state.tools.find(t => t.name === `ppt_${name}`)!;
  if (name === 'set_slide_image_size') state.change({ selectedText: '', selectionCharacters: 0, capabilities: [] });
  const input = { widthMm: 80.5, heightMm: 30, editGeneration: 1 };
  await expect(resize.execute('size', input)).rejects.toThrow(/unavailable/);
  state.change({ capabilities: [{ name, description: 'Resize', readOnly: false, inputSchema: {} }] });
  await expect(resize.execute('stale', { ...input, editGeneration: 2 })).rejects.toThrow(/changed/);
  expect(state.execute).not.toHaveBeenCalled();
  for (const result of [
    { widthMm: 80, heightMm: 30, page: 1, verified: true },
    { widthMm: 80.5, heightMm: 29, page: 1, verified: true },
    { widthMm: 80.5, heightMm: 30, page: 2, verified: true },
  ]) {
    state.execute.mockImplementationOnce(async command => ({ ...command, status: 'verified', result }));
    await expect(resize.execute('wrong', input)).rejects.toThrow(/match|unexpected page/);
  }
  state.execute.mockImplementationOnce(async command => ({ ...command, status: 'verified', result: { widthMm: 80.5, heightMm: 30, page: 1, verified: true } }));
  await expect(resize.execute('size', input)).resolves.toMatchObject({ details: { saved: false, response: { tool: name, result: { widthMm: 80.5, heightMm: 30 } } } });
  expect(state.execute.mock.calls.at(-1)?.[0]).toMatchObject({ ...binding, tool: name, input: { widthMm: 80.5, heightMm: 30 } });
  state.change({ page: undefined });
  await expect(resize.execute('no-page', input)).rejects.toThrow(/page|context/);
  state.change({ readOnly: true, capabilities: [] });
  await expect(resize.execute('readonly', input)).rejects.toThrow();
});

const nativeRequests = [
  { name: 'get_presentation_text', input: { maxChars: 20 }, changed: { maxChars: 200 } },
  { name: 'replace_selection', input: { text: 'approved', editGeneration: 1 }, changed: { text: 'substituted', editGeneration: 2 } },
  { name: 'add_slide_text', input: { text: 'approved', editGeneration: 1 }, changed: { text: 'substituted', editGeneration: 2 } },
  { name: 'set_slide_text_bold', input: { enabled: true, editGeneration: 1 }, changed: { enabled: false, editGeneration: 2 } },
  { name: 'set_slide_text_italic', input: { enabled: true, editGeneration: 1 }, changed: { enabled: false, editGeneration: 2 } },
  { name: 'set_slide_font_size', input: { fontSizePt: 24, editGeneration: 1 }, changed: { fontSizePt: 48, editGeneration: 2 } },
  { name: 'set_slide_text_color', input: { colorHex: '112233', editGeneration: 1 }, changed: { colorHex: '445566', editGeneration: 2 } },
  { name: 'add_slide_object_animation', input: { effect: 'fade', editGeneration: 1 }, changed: { effect: 'appear', editGeneration: 2 } },
  { name: 'set_slide_image_position', input: { xMm: 25.5, yMm: 35, editGeneration: 1 }, changed: { xMm: 50, yMm: 60, editGeneration: 2 } },
  { name: 'set_slide_text_box_position', input: { xMm: 25, yMm: 35, editGeneration: 1 }, changed: { xMm: 50, yMm: 60, editGeneration: 2 } },
  { name: 'replace_slide_image_from_asset', input: { assetId: 'asset_123', editGeneration: 1 }, changed: { assetId: 'asset_456', editGeneration: 2 } },
  { name: 'set_slide_font_family', input: { fontFamily: 'Arial', editGeneration: 1 }, changed: { fontFamily: 'Courier New', editGeneration: 2 } },
  { name: 'set_slide_text_box_size', input: { widthMm: 80.5, heightMm: 30, editGeneration: 1 }, changed: { widthMm: 90, heightMm: 40, editGeneration: 2 } },
  { name: 'set_slide_image_size', input: { widthMm: 80.5, heightMm: 30, editGeneration: 1 }, changed: { widthMm: 90, heightMm: 40, editGeneration: 2 } },
] as const;

it.each(nativeRequests)('retains the original $name parameters during context I/O', async ({ name, input, changed }) => {
  const state = setup();
  const current = await state.getContext();
  const properties = name === 'replace_slide_image_from_asset' ? { assetId: { enum: ['asset_123', 'asset_456'] } }
    : name === 'set_slide_font_family' ? { fontFamily: { enum: ['Arial', 'Courier New'] } } : {};
  const context = { ...current, ...((name === 'set_slide_image_size' || name === 'set_slide_image_position') ? { selectedText: '', selectionCharacters: 0 } : {}), capabilities: [{ name, description: name, readOnly: name === 'get_presentation_text', inputSchema: { properties } }] };
  let release!: (value: unknown) => void;
  const waiting = new Promise<unknown>(resolve => { release = resolve; });
  const getContext = vi.fn(async (): Promise<unknown> => context).mockImplementationOnce(() => waiting);
  const execute = vi.fn(async (command: PptEditorCommand) => ({ ...command,
    status: name === 'get_presentation_text' ? 'sent' : 'verified',
    result: name === 'get_presentation_text' ? { text: 'old', truncated: false, slidesRead: 1, totalSlides: 2 }
      : name === 'replace_selection' ? { replaced: true, length: 8, verified: true }
      : name === 'add_slide_text' ? { page: 1, verified: true }
      : { ...command.input, ...(name === 'replace_slide_image_from_asset' ? { sha256: 'a'.repeat(64), imageId: 'private-image' } : {}), page: 1, verified: true },
  }));
  const tool = createPptEditorTools({ binding, getContext, execute }).find(t => t.name === `ppt_${name}`)!;
  const mutable = { ...input };
  const pending = tool.execute('request', mutable);
  expect(getContext).toHaveBeenCalledTimes(1);
  Object.assign(mutable, changed);
  release(context);
  await pending;
  const expected = Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'editGeneration'));
  expect(execute).toHaveBeenCalledTimes(1);
  expect(execute.mock.calls[0]?.[0]).toMatchObject({ ...binding, tool: name, editGeneration: 1, input: expected });
});

it('does not repair an originally stale generation by mutating the input during context I/O', async () => {
  const state = setup(); const current = await state.getContext();
  let release!: (value: PptEditorContext) => void;
  const waiting = new Promise<PptEditorContext>(resolve => { release = resolve; });
  state.getContext.mockImplementationOnce(() => waiting);
  const input = { text: 'approved', editGeneration: 2 };
  const pending = state.tools[1]!.execute('stale', input);
  input.editGeneration = 1;
  release(current);
  await expect(pending).rejects.toThrow(/changed/);
  expect(state.execute).not.toHaveBeenCalled();
});

it.each(['getContext', 'execute'] as const)('retains the authorized Host %s method and receiver during I/O', async method => {
  const state = setup(); const current = await state.getContext();
  let release!: (value: unknown) => void;
  const waiting = new Promise<unknown>(resolve => { release = resolve; });
  const signal = new AbortController().signal;
  const getContext = vi.fn().mockImplementationOnce(() => waiting).mockResolvedValue(current);
  const execute = vi.fn(async (command: PptEditorCommand) => ({ ...command, status: 'verified', result: { replaced: true, length: 8, verified: true } }));
  const host = {
    binding: { ...binding },
    getContext(this: unknown, value?: AbortSignal) { expect(this).toBe(host); expect(value).toBe(signal); return getContext(); },
    execute(this: unknown, command: PptEditorCommand, value?: AbortSignal) { expect(this).toBe(host); expect(value).toBe(signal); return execute(command); },
  };
  const tool = createPptEditorTools(host)[1]!;
  const pending = tool.execute('request', { text: 'approved', editGeneration: 1 }, signal);
  const substitute = vi.fn(() => { throw new Error('Substituted Host callback'); });
  host[method] = substitute;
  host.binding.sessionId = 'substituted';
  release(current);
  await expect(pending).resolves.toMatchObject({ details: { saved: false, context: { sessionId: binding.sessionId } } });
  expect(substitute).not.toHaveBeenCalled();
  expect(getContext).toHaveBeenCalledTimes(2);
  expect(execute).toHaveBeenCalledTimes(1);
});

it('rejects a Host-mutated request rather than correlating against substituted text', async () => {
  const state = setup();
  state.execute.mockImplementationOnce(async command => {
    if (command.tool !== 'replace_selection') throw new Error('Wrong fixture tool');
    command.input.text = 'unreviewed';
    return { ...command, status: 'verified', result: { replaced: true, length: 10, verified: true } };
  });
  await expect(state.tools[1]!.execute('request', { text: 'approved', editGeneration: 1 })).rejects.toThrow(/match|length/);
  expect(state.execute).toHaveBeenCalledTimes(1);
});

it('retains the dispatched page when the Host context object changes during native execution', async () => {
  const state = setup(); const current = await state.getContext();
  state.execute.mockImplementationOnce(async command => {
    current.page = 2;
    return { ...command, status: 'verified', result: { page: 2, verified: true } };
  });
  await expect(state.tools[2]!.execute('request', { text: 'approved', editGeneration: 1 })).rejects.toThrow(/unexpected page/);
  expect(state.execute).toHaveBeenCalledTimes(1);
});

it('retains the validated native receipt across the final asynchronous context read', async () => {
  const state = setup(); const current = await state.getContext();
  const receipt = { ...binding, requestId: 'unused', editGeneration: 1, tool: 'replace_selection', status: 'verified', result: { replaced: true, length: 8, verified: true } };
  state.execute.mockImplementationOnce(async command => Object.assign(receipt, command));
  state.getContext.mockResolvedValueOnce(current).mockImplementationOnce(async () => {
    receipt.sessionId = 'substituted'; receipt.result.length = 100;
    return current;
  });
  await expect(state.tools[1]!.execute('request', { text: 'approved', editGeneration: 1 })).resolves.toMatchObject({
    details: { response: { sessionId: binding.sessionId, result: { length: 8 } }, saved: false },
  });
});

function insertionFixture() {
 const state=setup();
 state.change({selectedText:'',selectionCharacters:0,page:1,capabilities:[{name:'insert_slide_image_from_asset',description:'Insert',readOnly:false,inputSchema:{properties:{assetId:{enum:['reviewed_png']}}}}]});
 state.execute.mockImplementation(async command=>{
  if(command.tool!=='insert_slide_image_from_asset')throw new Error('Wrong tool');
  return {...command,status:'verified',result:{...command.input,sha256:'a'.repeat(64),page:1,verified:true,imageId:'host-private-id',path:'/host/private'}};
 });
 const tool=state.tools.find(t=>t.name==='ppt_insert_slide_image_from_asset')!;
 return {...state,tool,input:{assetId:'reviewed_png',xMm:25,yMm:35,widthMm:40,heightMm:30,editGeneration:1}};
}
it('inserts only an authorized capability asset with exact geometry, keeping native identity private',async()=>{
 const s=insertionFixture();const result=await s.tool.execute('insert',s.input);
 expect(s.execute.mock.calls[0]?.[0]).toMatchObject({tool:'insert_slide_image_from_asset',input:{assetId:'reviewed_png',xMm:25,yMm:35,widthMm:40,heightMm:30}});
 expect(result.details).toMatchObject({saved:false,response:{result:{assetId:'reviewed_png',xMm:25,widthMm:40}}});
 expect(JSON.stringify(result)).not.toContain('host-private-id');expect(JSON.stringify(result)).not.toContain('/host/private');
});
it.each(['capability','asset','generation','readonly','page','geometry','extra'])( 'refuses insertion %s before dispatch',async change=>{
 const s=insertionFixture();
 if(change==='capability')s.change({capabilities:[]});
 if(change==='asset')s.input.assetId='other';
 if(change==='generation')s.input.editGeneration=2;
 if(change==='readonly')s.change({readOnly:true,capabilities:[]});
 if(change==='page')s.change({page:undefined});
 if(change==='geometry')s.input.widthMm=NaN;
 if(change==='extra')Reflect.set(s.input,'url','bad');
 await expect(s.tool.execute('insert',s.input)).rejects.toThrow();expect(s.execute).not.toHaveBeenCalled();
});
it.each(['geometry','page','asset','identity'])( 'rejects uncertain insertion %s without retry',async change=>{
 const s=insertionFixture();s.execute.mockImplementationOnce(async command=>{
  if(command.tool!=='insert_slide_image_from_asset')throw new Error('Wrong tool');
  return {...command,...(change==='identity'?{requestId:'wrong'}:{}),status:'verified',result:{...command.input,...(change==='geometry'?{widthMm:41}:{}),...(change==='asset'?{assetId:'other'}:{}),sha256:'a'.repeat(64),imageId:'native',page:change==='page'?2:1,verified:true}};
 });
 await expect(s.tool.execute('insert',s.input)).rejects.toThrow();expect(s.execute).toHaveBeenCalledTimes(1);
});
it('pins insertion asset and geometry before the first context read',async()=>{
 const s=insertionFixture(),current=await s.getContext();let release!:(value:PptEditorContext)=>void;
 s.getContext.mockImplementationOnce(()=>new Promise(resolve=>{release=resolve;}));
 const pending=s.tool.execute('insert',s.input);s.input.assetId='substituted';s.input.xMm=100;s.input.editGeneration=2;
 release(current);await expect(pending).resolves.toMatchObject({details:{response:{result:{assetId:'reviewed_png',xMm:25}}}});
});

describe("Host-inspected fixed fade Agent tool", () => {
  function fixture() {
    const state = setup();
    state.change({ selectedText: "", selectionCharacters: 0, capabilities: [{ name: "set_slide_fade", description: "Fade", readOnly: false, inputSchema: { type: "object", properties: {}, additionalProperties: false } }] });
    state.execute.mockImplementation(async command => ({ ...command, status: "verified", result: { page: 1, transition: "fade", durationMs: 750, verified: true, saved: false, sourceHash: "host-private-source", slideHash: "host-private-slide" } }));
    const tool = state.tools.find(tool => tool.name === "ppt_set_slide_fade")!;
    return { ...state, tool };
  }
  it("uses current capability and correlated page; proof stays out of model inputs/results", async () => {
    const s = fixture();
    const result = await s.tool.execute("fade", { editGeneration: 1 });
    expect(s.execute).toHaveBeenCalledOnce();
    expect(s.execute.mock.calls[0]![0]).toMatchObject({ tool: "set_slide_fade", editGeneration: 1, input: {} });
    expect(result.details).toMatchObject({ saved: false, response: { result: { page: 1, transition: "fade", durationMs: 750, saved: false } } });
    expect(JSON.stringify(result)).not.toContain("host-private");
    expect(JSON.stringify(s.tool.parameters)).not.toContain("sourceHash");
  });
  it.each([{ editGeneration: 0 }, { editGeneration: 2 }, { editGeneration: 1, page: 2 }, { editGeneration: 1, durationMs: 900 }, { editGeneration: 1, sourceHash: "private" }])("rejects stale or model-controlled arguments %j", async input => {
    const s = fixture(); await expect(s.tool.execute("fade", input)).rejects.toThrow(); expect(s.execute).not.toHaveBeenCalled();
  });
  it.each([{ capabilities: [] }, { page: undefined }, { readOnly: true, capabilities: [] }, { sessionId: "other" }])("rejects unavailable or switched contexts %j", async patch => {
    const s = fixture(); s.change(patch); await expect(s.tool.execute("fade", { editGeneration: 1 })).rejects.toThrow(); expect(s.execute).not.toHaveBeenCalled();
  });
  it.each([{ page: 2 }, { durationMs: 900 }, { transition: "push" }, { saved: true }])("rejects wrong native receipt without retry %j", async patch => {
    const s = fixture(); s.execute.mockImplementationOnce(async command => ({ ...command, status: "verified", result: { page: 1, transition: "fade", durationMs: 750, verified: true, saved: false, ...patch } }));
    await expect(s.tool.execute("fade", { editGeneration: 1 })).rejects.toThrow(); expect(s.execute).toHaveBeenCalledOnce();
  });
});

it("sets and clears bold only through the fresh selected native capability without saving", async () => {
  const state = setup();
  const tool = state.tools.find(t => t.name === "ppt_set_slide_text_bold")!;
  const input = { enabled: false, editGeneration: 1 };
  await expect(tool.execute("bold", input)).rejects.toThrow(/unavailable/);
  const capability = { name: "set_slide_text_bold" as const, readOnly: false, description: "Bold", inputSchema: {} };
  state.change({ capabilities: [capability] });
  for (const enabled of [true, false]) {
    state.execute.mockImplementationOnce(async c => ({ ...c, status: "verified", result: { enabled, page: 1, verified: true } }));
    await expect(tool.execute("bold", { ...input, enabled })).resolves.toMatchObject({ details: { saved: false, response: { result: { enabled, page: 1, verified: true } } } });
  }
  for (const bad of [{ ...input, enabled: "false" }, { ...input, enabled: 0 }, { ...input, editGeneration: 0 }, { ...input, script: "bad" }])
    await expect(tool.execute("bold", bad)).rejects.toThrow();
  for (const result of [{ enabled: true, page: 1, verified: true }, { enabled: false, page: 2, verified: true }]) {
    state.execute.mockImplementationOnce(async c => ({ ...c, status: "verified", result }));
    await expect(tool.execute("bold", input)).rejects.toThrow();
  }
  state.change({ page: undefined });
  await expect(tool.execute("bold", input)).rejects.toThrow(/page/);
  state.change({ page: 1, selectedText: "", selectionCharacters: 0 });
  await expect(tool.execute("bold", input)).rejects.toThrow();
  state.change({ selectedText: "old", selectionCharacters: 3, readOnly: true });
  await expect(tool.execute("bold", input)).rejects.toThrow();
  expect(state.execute).toHaveBeenCalledTimes(4);
});
it("sets and clears italic only through the fresh selected native capability without saving", async () => {
  const state = setup();
  const tool = state.tools.find(t => t.name === "ppt_set_slide_text_italic")!;
  const input = { enabled: false, editGeneration: 1 };
  await expect(tool.execute("italic", input)).rejects.toThrow(/unavailable/);
  const capability = { name: "set_slide_text_italic" as const, readOnly: false, description: "Italic", inputSchema: {} };
  state.change({ capabilities: [capability] });
  for (const enabled of [true, false]) {
    state.execute.mockImplementationOnce(async c => ({ ...c, status: "verified", result: { enabled, page: 1, verified: true } }));
    await expect(tool.execute("italic", { ...input, enabled })).resolves.toMatchObject({ details: { saved: false, response: { result: { enabled, page: 1, verified: true } } } });
  }
  for (const bad of [{ ...input, enabled: "false" }, { ...input, enabled: 0 }, { ...input, editGeneration: 0 }, { ...input, script: "bad" }])
    await expect(tool.execute("italic", bad)).rejects.toThrow();
  for (const result of [{ enabled: true, page: 1, verified: true }, { enabled: false, page: 2, verified: true }]) {
    state.execute.mockImplementationOnce(async c => ({ ...c, status: "verified", result }));
    await expect(tool.execute("italic", input)).rejects.toThrow();
  }
  state.change({ page: undefined });
  await expect(tool.execute("italic", input)).rejects.toThrow(/page/);
  state.change({ page: 1, selectedText: "", selectionCharacters: 0 });
  await expect(tool.execute("italic", input)).rejects.toThrow();
  state.change({ selectedText: "old", selectionCharacters: 3, readOnly: true });
  await expect(tool.execute("italic", input)).rejects.toThrow();
  expect(state.execute).toHaveBeenCalledTimes(4);
});


it('moves a selected ordinary image only with fresh generation, capability and correlated coordinates/page', async () => {
  const state = setup(), move = state.tools.find(tool => tool.name === 'ppt_set_slide_image_position')!;
  const input = { xMm: 25.5, yMm: 35, editGeneration: 1 };
  await expect(move.execute('unavailable', input)).rejects.toThrow(/unavailable/);
  state.change({ selectedText: '', selectionCharacters: 0, capabilities: [{ name: 'set_slide_image_position', description: 'Move ordinary image', readOnly: false, inputSchema: {} }] });
  for (const patch of [{ xMm: -1 }, { yMm: Infinity }, { xMm: 1001 }, { editGeneration: 0 }, { script: 'bad' }])
    await expect(move.execute('invalid', { ...input, ...patch })).rejects.toThrow();
  expect(state.execute).not.toHaveBeenCalled();
  for (const result of [{ xMm: 26, yMm: 35, page: 1, verified: true }, { xMm: 25.5, yMm: 36, page: 1, verified: true }, { xMm: 25.5, yMm: 35, page: 2, verified: true }]) {
    state.execute.mockImplementationOnce(async command => ({ ...command, status: 'verified', result }));
    await expect(move.execute('mismatch', input)).rejects.toThrow();
  }
  state.execute.mockImplementationOnce(async command => ({ ...command, status: 'verified', result: { xMm: 25.5, yMm: 35, page: 1, verified: true } }));
  await expect(move.execute('position', input)).resolves.toMatchObject({ details: { saved: false, response: { tool: 'set_slide_image_position', result: { xMm: 25.5, yMm: 35 } } } });
  state.change({ page: undefined });
  await expect(move.execute('no-page', input)).rejects.toThrow();
  state.change({ page: 1, readOnly: true, capabilities: [] });
  await expect(move.execute('readonly', input)).rejects.toThrow();
  expect(state.execute).toHaveBeenCalledTimes(4);
});


it.each(['appear', 'fade'] as const)('appends native %s only through fresh capability and exact effect/page receipt', async effect => {
 const state = setup(), tool = state.tools.find(t => t.name === 'ppt_add_slide_object_animation')!;
 const input = { effect, editGeneration: 1 };
 await expect(tool.execute('missing', input)).rejects.toThrow(/unavailable/);
 state.change({ capabilities: [{ name: 'add_slide_object_animation', description: 'Native entrance', readOnly: false, inputSchema: {} }] });
 for (const patch of [{ effect: 'fly' }, { duration: 500 }, { editGeneration: 0 }, { targetId: 'arbitrary-object' }])
   await expect(tool.execute('invalid', { ...input, ...patch })).rejects.toThrow();
 expect(state.execute).not.toHaveBeenCalled();
 for (const result of [{ effect: effect === 'appear' ? 'fade' : 'appear', page: 1, verified: true }, { effect, page: 2, verified: true }]) {
   state.execute.mockImplementationOnce(async command => ({ ...command, status: 'verified', result }));
   await expect(tool.execute('mismatch', input)).rejects.toThrow();
 }
 state.execute.mockImplementationOnce(async command => ({ ...command, status: 'verified', result: { effect, page: 1, verified: true } }));
 await expect(tool.execute('append', input)).resolves.toMatchObject({ details: { saved: false, response: { result: { effect, page: 1, verified: true } } } });
 state.change({ page: undefined }); await expect(tool.execute('missing-page', input)).rejects.toThrow();
 state.change({ page: 1, readOnly: true, capabilities: [] }); await expect(tool.execute('readonly', input)).rejects.toThrow();
 expect(state.execute).toHaveBeenCalledTimes(3);
});
