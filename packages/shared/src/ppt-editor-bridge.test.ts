import { describe, expect, it } from "vitest";
import { assertPptEditorCommand, assertPptEditorContext, assertPptEditorCommandResult, assertPptEditorCommandResponse } from "./ppt-editor-bridge.js";
import { IPC, IPC_WHITELIST } from "./protocol.js";

const owner = { projectId: "project", documentId: "document", sessionId: "session" };
const command = { ...owner, requestId: "req-1", editGeneration: 1, tool: "get_presentation_text", input: { maxChars: 100 } };
describe("PPTX editor bridge boundary", () => {
  it("accepts only bounded half-point font sizes and correlated verified results", () => {
    const request = { ...command, tool: "set_slide_font_size", input: { fontSizePt: 44.5 } };
    assertPptEditorCommand(request);
    const result = { ...owner, requestId: "req-1", editGeneration: 1, tool: "set_slide_font_size", status: "verified", result: { fontSizePt: 44.5, page: 1, verified: true } };
    expect(() => assertPptEditorCommandResponse(request, result)).not.toThrow();
    for (const size of [0, 96.5, 12.25, NaN, Infinity, "44"])
      expect(() => assertPptEditorCommand({ ...request, input: { fontSizePt: size } })).toThrow();
    expect(() => assertPptEditorCommand({ ...request, input: { fontSizePt: 44.5, script: "bad" } })).toThrow();
    for (const patch of [{ status: "sent" }, { result: { fontSizePt: 44, page: 1, verified: true } }, { result: { fontSizePt: 44.5, page: 0, verified: true } }])
      expect(() => assertPptEditorCommandResponse(request, { ...result, ...patch })).toThrow();
    const capability = { name: "set_slide_font_size", readOnly: false, description: "Size", inputSchema: {} };
    const context = { ...owner, kind: "slide", editGeneration: 1, selectedText: "text", selectionCharacters: 4, readOnly: false, capabilities: [capability] };
    expect(() => assertPptEditorContext(context)).not.toThrow();
    expect(() => assertPptEditorContext({ ...context, selectedText: "", selectionCharacters: 0 })).toThrow();
    expect(() => assertPptEditorContext({ ...context, readOnly: true })).toThrow();
  });
  it("accepts only six uppercase RGB hex digits and correlated verified results", () => {
    const request = { ...command, tool: "set_slide_text_color", input: { colorHex: "336699" } };
    assertPptEditorCommand(request);
    const result = { ...owner, requestId: "req-1", editGeneration: 1, tool: "set_slide_text_color", status: "verified", result: { colorHex: "336699", page: 1, verified: true } };
    expect(() => assertPptEditorCommandResponse(request, result)).not.toThrow();
    for (const size of ["", "#336699", "aabbcc", "12345", "AABBCCDD", 33, null])
      expect(() => assertPptEditorCommand({ ...request, input: { colorHex: size } })).toThrow();
    expect(() => assertPptEditorCommand({ ...request, input: { colorHex: "336699", script: "bad" } })).toThrow();
    for (const patch of [{ status: "sent" }, { result: { colorHex: "AABBCC", page: 1, verified: true } }, { result: { colorHex: "336699", page: 0, verified: true } }])
      expect(() => assertPptEditorCommandResponse(request, { ...result, ...patch })).toThrow();
    const capability = { name: "set_slide_text_color", readOnly: false, description: "Size", inputSchema: {} };
    const context = { ...owner, kind: "slide", editGeneration: 1, selectedText: "text", selectionCharacters: 4, readOnly: false, capabilities: [capability] };
    expect(() => assertPptEditorContext(context)).not.toThrow();
    expect(() => assertPptEditorContext({ ...context, selectedText: "", selectionCharacters: 0 })).toThrow();
    expect(() => assertPptEditorContext({ ...context, readOnly: true })).toThrow();
  });
  it("correlates results with the exact command and verified replacement length", () => {
    const request = { ...command, tool: "replace_selection", input: { text: "Hi 世界" } };
    assertPptEditorCommand(request);
    const result = { ...owner, requestId: request.requestId, editGeneration: 1, tool: "replace_selection", status: "verified", result: { replaced: true, length: 5, verified: true } };
    expect(() => assertPptEditorCommandResponse(request, result)).not.toThrow();
    for (const change of [{ sessionId: "other" }, { requestId: "other" }, { requestId: "with space" }, { editGeneration: 2 }, { result: { replaced: true, length: 4, verified: true } }]) {
      expect(() => assertPptEditorCommandResponse(request, { ...result, ...change })).toThrow();
    }
  });
  it("allows only bounded, typed commands through registered preload channels", () => {
    expect(() => assertPptEditorCommand(command)).not.toThrow();
    expect(IPC_WHITELIST.has(IPC.invoke.pptEditorGetContext)).toBe(true);
    expect(IPC_WHITELIST.has(IPC.invoke.pptEditorExecute)).toBe(true);
    for (const invalid of [null, [], { ...command, input: [] }, { ...command, tool: "execute_js" },
      { ...command, input: { maxChars: 8001 } }, { ...command, input: { script: "alert(1)" } },
      { ...command, script: "alert(1)" }, { ...command, editGeneration: 0 }, { ...command, sessionId: "" },
      { ...command, requestId: "with spaces" }]) {
      expect(() => assertPptEditorCommand(invalid)).toThrow();
    }
  });
  it("rejects malformed editor contexts and results", () => {
    const context = { ...owner, editGeneration: 1, kind: "slide", page: 1, selectedText: "hello", selectionCharacters: 5, readOnly: false, capabilities: [] };
    expect(() => assertPptEditorContext(context)).not.toThrow();
    expect(() => assertPptEditorContext({ ...context, capabilities: [{ name: "execute_js" }] })).toThrow();
    expect(() => assertPptEditorContext({ ...context, selectedText: "x".repeat(8001) })).toThrow();
    const result = { ...owner, requestId: "req-1", editGeneration: 1, tool: "get_presentation_text", status: "sent", result: { text: "hello", truncated: false, slidesRead: 1, totalSlides: 1 } };
    expect(() => assertPptEditorCommandResult(result)).not.toThrow();
    expect(() => assertPptEditorCommandResult({ ...result, result: { ...result.result, text: "x".repeat(8001) } })).toThrow();
  });
  it("allows bounded text edits and requires verified write results", () => {
    for (const tool of ["replace_selection", "add_slide_text"]) {
      expect(() => assertPptEditorCommand({ ...command, tool, input: { text: "Hello\n世界 😀" } })).not.toThrow();
      for (const input of [{ text: "" }, { text: "x".repeat(8001) }, { text: "hello", script: "alert(1)" }, { maxChars: 10 }]) {
        expect(() => assertPptEditorCommand({ ...command, tool, input })).toThrow();
      }
      const result = { ...owner, requestId: "req-1", editGeneration: 1, tool, status: "verified", result: tool === "replace_selection" ? { replaced: true, length: 5, verified: true } : { page: 1, verified: true } };
      expect(() => assertPptEditorCommandResult(result)).not.toThrow();
      expect(() => assertPptEditorCommandResult({ ...result, status: "sent" })).toThrow();
      expect(() => assertPptEditorCommandResult({ ...result, result: { ...result.result, verified: false } })).toThrow();
    }
    expect(() => assertPptEditorCommand({ ...command, tool: "replace_selection", input: { text: "  " } })).not.toThrow();
    expect(() => assertPptEditorCommand({ ...command, tool: "add_slide_text", input: { text: "  " } })).toThrow();
    const capability = { name: "replace_selection", description: "Replace text", readOnly: false, inputSchema: {} };
    const context = { ...owner, editGeneration: 1, kind: "slide", selectedText: "hello", selectionCharacters: 5, readOnly: false, capabilities: [capability] };
    expect(() => assertPptEditorContext(context)).not.toThrow();
    expect(() => assertPptEditorContext({ ...context, readOnly: true })).toThrow();
    expect(() => assertPptEditorContext({ ...context, selectedText: "", selectionCharacters: 0 })).toThrow();
    expect(() => assertPptEditorContext({ ...context, capabilities: [capability, capability] })).toThrow();
  });
});

  it("validates bounded positions, exact correlated coordinates and optional selection capability", () => {
 const request={...owner,requestId:"pos-1",editGeneration:1,tool:"set_slide_text_box_position",input:{xMm:25,yMm:35}};
 assertPptEditorCommand(request);
 const result={...request,status:"verified",result:{xMm:25,yMm:35,page:1,verified:true}};
 assertPptEditorCommandResponse(request,result);
 for(const input of [{xMm:-1,yMm:0},{xMm:NaN,yMm:0},{xMm:0,yMm:Infinity},{xMm:1001,yMm:0},{xMm:25},{xMm:25,yMm:35,script:"bad"}])expect(()=>assertPptEditorCommand({...request,input})).toThrow();
 for(const patch of [{status:"sent"},{result:{xMm:24,yMm:35,page:1,verified:true}},{result:{xMm:25,yMm:34,page:1,verified:true}},{result:{xMm:25,yMm:35,page:0,verified:true}}])expect(()=>assertPptEditorCommandResponse(request,{...result,...patch})).toThrow();
 const context={...owner,kind:"slide",editGeneration:1,page:1,selectedText:"a",selectionCharacters:1,readOnly:false,capabilities:[{name:"set_slide_text_box_position",description:"Move text box",readOnly:false,inputSchema:{}}]};
 assertPptEditorContext(context);
 for(const patch of [{selectedText:"",selectionCharacters:0},{readOnly:true}])expect(()=>assertPptEditorContext({...context,...patch})).toThrow();
 });

it("accepts only a requested project asset and validates the pinned image result", () => {
 const request={...owner,requestId:"image-1",editGeneration:3,tool:"replace_slide_image_from_asset",input:{assetId:"asset_123"}};
 assertPptEditorCommand(request);
 const result={...owner,requestId:"image-1",editGeneration:3,tool:"replace_slide_image_from_asset",status:"verified",result:{assetId:"asset_123",sha256:"a".repeat(64),page:2,verified:true}};
 assertPptEditorCommandResponse(request,result);
 for(const input of [{assetId:"../asset"},{assetId:"asset/1"},{assetId:"asset_123",url:"https://example.invalid"},{assetId:""}])expect(()=>assertPptEditorCommand({...request,input})).toThrow();
 for(const patch of [{result:{...result.result,assetId:"other"}},{result:{...result.result,sha256:"bad"}},{result:{...result.result,page:0}},{status:"sent"}])expect(()=>assertPptEditorCommandResponse(request,{...result,...patch})).toThrow();
 const capability={name:"replace_slide_image_from_asset",readOnly:false,description:"Replace reviewed image",inputSchema:{type:"object",properties:{assetId:{type:"string",enum:["asset_123","asset_456"]}},required:["assetId"],additionalProperties:false}};
 const context={...owner,kind:"slide",editGeneration:3,page:2,selectedText:"",selectionCharacters:0,readOnly:false,capabilities:[capability]};
 expect(()=>assertPptEditorContext(context)).not.toThrow();
 for(const invalid of [{...capability,inputSchema:{properties:{assetId:{enum:[]}}}},{...capability,inputSchema:{properties:{assetId:{enum:["asset_123","asset_123"]}}}},{...capability,inputSchema:{properties:{assetId:{enum:["../asset"]}}}}])expect(()=>assertPptEditorContext({...context,capabilities:[invalid]})).toThrow();
 expect(()=>assertPptEditorContext({...context,page:undefined})).toThrow();
});

it("validates bounded loaded-font capability lists, exact commands and correlated native results", () => {
  const owner={projectId:"project",documentId:"doc",sessionId:"session"};
  const capability={name:"set_slide_font_family",description:"Loaded fonts",readOnly:false,inputSchema:{properties:{fontFamily:{enum:["Arial","Courier New"]}}}};
  const context={...owner,kind:"slide",editGeneration:1,page:1,selectedText:"Hello",selectionCharacters:5,readOnly:false,capabilities:[capability]};
  expect(()=>assertPptEditorContext(context)).not.toThrow();
  for(const values of [[],["Arial","Arial"],[""],[" Arial"],["x\n"],Array.from({length:101},(_,i)=>"Font"+i)])
    expect(()=>assertPptEditorContext({...context,capabilities:[{...capability,inputSchema:{properties:{fontFamily:{enum:values}}}}]})).toThrow();
  const command={...owner,requestId:"family-1",editGeneration:1,tool:"set_slide_font_family" as const,input:{fontFamily:"Courier New"}};
  expect(()=>assertPptEditorCommand(command)).not.toThrow();
  for(const input of [{fontFamily:""},{fontFamily:"Courier New\n"},{fontFamily:"Courier New",script:"bad"}])
    expect(()=>assertPptEditorCommand({...command,input})).toThrow();
  const result={...command,status:"verified",result:{fontFamily:"Courier New",page:1,verified:true}};
  expect(()=>assertPptEditorCommandResponse(command,result)).not.toThrow();
  expect(()=>assertPptEditorCommandResponse(command,{...result,result:{...result.result,fontFamily:"Arial"}})).toThrow(/family/);
});

it('bounds native text-box dimensions and correlates both result dimensions', () => {
  const request = { ...owner, requestId: 'size-1', editGeneration: 2, tool: 'set_slide_text_box_size', input: { widthMm: 80.5, heightMm: 30 } };
  assertPptEditorCommand(request);
  const result = { ...request, status: 'verified', result: { widthMm: 80.5, heightMm: 30, page: 1, verified: true } };
  assertPptEditorCommandResponse(request, result);
  for (const input of [{ widthMm: 0, heightMm: 30 }, { widthMm: 80.5, heightMm: -1 }, { widthMm: NaN, heightMm: 30 }, { widthMm: 80, heightMm: Infinity }, { widthMm: 1001, heightMm: 30 }, { widthMm: 80 }, { widthMm: 80, heightMm: 30, script: 'bad' }])
    expect(() => assertPptEditorCommand({ ...request, input })).toThrow();
  for (const patch of [{ status: 'sent' }, { result: { ...result.result, widthMm: 80 } }, { result: { ...result.result, heightMm: 29 } }, { result: { ...result.result, page: 0 } }, { result: { ...result.result, verified: false } }])
    expect(() => assertPptEditorCommandResponse(request, { ...result, ...patch })).toThrow();
  const context = { ...owner, kind: 'slide', editGeneration: 2, page: 1, selectedText: 'a', selectionCharacters: 1, readOnly: false, capabilities: [{ name: 'set_slide_text_box_size', description: 'Resize', readOnly: false, inputSchema: {} }] };
  assertPptEditorContext(context);
  for (const patch of [{ selectedText: '', selectionCharacters: 0 }, { readOnly: true }])
    expect(() => assertPptEditorContext({ ...context, ...patch })).toThrow();
});

it('accepts finite ordinary-image resize independently of text selection and correlates its dimensions', () => {
  const request = { ...owner, requestId: 'image-size', editGeneration: 2, tool: 'set_slide_image_size', input: { widthMm: 80.5, heightMm: 30 } };
  assertPptEditorCommand(request);
  const receipt = { ...request, status: 'verified', result: { widthMm: 80.5, heightMm: 30, page: 1, verified: true } };
  assertPptEditorCommandResponse(request, receipt);
  const context = { ...owner, kind: 'slide', editGeneration: 2, page: 1, selectedText: '', selectionCharacters: 0, readOnly: false,
    capabilities: [{ name: 'set_slide_image_size', description: 'Resize image', readOnly: false, inputSchema: {} }] };
  assertPptEditorContext(context);
  for (const patch of [{ page: undefined }, { readOnly: true }, { selectedText: 'text', selectionCharacters: 4 }])
    expect(() => assertPptEditorContext({ ...context, ...patch })).toThrow();
  for (const input of [{ widthMm: 0, heightMm: 30 }, { widthMm: Infinity, heightMm: 30 }, { widthMm: 80, heightMm: NaN },
    { widthMm: 1001, heightMm: 30 }, { widthMm: 80 }, { widthMm: 80, heightMm: 30, script: 'bad' }])
    expect(() => assertPptEditorCommand({ ...request, input })).toThrow();
  for (const result of [{ ...receipt.result, widthMm: 81 }, { ...receipt.result, heightMm: 31 }, { ...receipt.result, verified: false }])
    expect(() => assertPptEditorCommandResponse(request, { ...receipt, result })).toThrow();
});

it('validates native image position independently of text selection and correlates both coordinates', () => {
  const request = { ...owner, requestId: 'image-position', editGeneration: 2, tool: 'set_slide_image_position', input: { xMm: 25.5, yMm: 35 } };
  assertPptEditorCommand(request);
  const receipt = { ...request, status: 'verified', result: { xMm: 25.5, yMm: 35, page: 1, verified: true } };
  assertPptEditorCommandResponse(request, receipt);
  const context = { ...owner, kind: 'slide', editGeneration: 2, page: 1, selectedText: '', selectionCharacters: 0, readOnly: false,
    capabilities: [{ name: 'set_slide_image_position', description: 'Move image', readOnly: false, inputSchema: {} }] };
  assertPptEditorContext(context);
  for (const patch of [{ page: undefined }, { readOnly: true }, { selectedText: 'text', selectionCharacters: 4 }])
    expect(() => assertPptEditorContext({ ...context, ...patch })).toThrow();
  for (const input of [{ xMm: -1, yMm: 35 }, { xMm: Infinity, yMm: 35 }, { xMm: 25.5, yMm: NaN },
    { xMm: 1001, yMm: 35 }, { xMm: 25.5 }, { xMm: 25.5, yMm: 35, script: 'bad' }])
    expect(() => assertPptEditorCommand({ ...request, input })).toThrow();
  for (const result of [{ ...receipt.result, xMm: 25 }, { ...receipt.result, yMm: 36 }, { ...receipt.result, page: 0 }, { ...receipt.result, verified: false }])
    expect(() => assertPptEditorCommandResponse(request, { ...receipt, result })).toThrow();
  expect(() => assertPptEditorCommandResponse(request, { ...receipt, status: 'sent' })).toThrow();
  expect(() => assertPptEditorCommandResponse(request, { ...receipt, tool: 'set_slide_text_box_position' })).toThrow();
});

it('validates finite native object animations and correlates the requested effect', () => {
  for (const effect of ['appear', 'fade']) {
    const request = { ...owner, requestId: 'native-animation', editGeneration: 2, tool: 'add_slide_object_animation', input: { effect } };
    assertPptEditorCommand(request);
    const receipt = { ...request, status: 'verified', result: { effect, page: 2, verified: true } };
    assertPptEditorCommandResponse(request, receipt);
    for (const input of [{}, { effect: 'bounce' }, { effect, duration: 300 }, { effect, script: 'bad' }])
      expect(() => assertPptEditorCommand({ ...request, input })).toThrow();
    for (const result of [{ ...receipt.result, effect: effect === 'fade' ? 'appear' : 'fade' },
      { ...receipt.result, page: 0 }, { ...receipt.result, verified: false }, { ...receipt.result, effect: 'bounce' }])
      expect(() => assertPptEditorCommandResponse(request, { ...receipt, result })).toThrow();
    expect(() => assertPptEditorCommandResponse(request, { ...receipt, status: 'sent' })).toThrow();
  }
  const context = { ...owner, kind: 'slide', editGeneration: 2, page: 2, selectedText: '', selectionCharacters: 0, readOnly: false,
    capabilities: [{ name: 'add_slide_object_animation', description: 'Append native animation', readOnly: false, inputSchema: {} }] };
  assertPptEditorContext(context);
  assertPptEditorContext({ ...context, selectedText: 'A text object', selectionCharacters: 13 });
  expect(() => assertPptEditorContext({ ...context, page: undefined })).toThrow();
  expect(() => assertPptEditorContext({ ...context, readOnly: true })).toThrow();
});

it('validates asset-bound insertion geometry, capability and exact correlated receipts',()=>{
 const input={assetId:'reviewed_png',xMm:25,yMm:35,widthMm:40,heightMm:30};
 const request={...command,tool:'insert_slide_image_from_asset',input};assertPptEditorCommand(request);
 const result={...owner,requestId:request.requestId,editGeneration:1,tool:'insert_slide_image_from_asset',status:'verified',result:{...input,sha256:'a'.repeat(64),page:2,verified:true}};
 expect(()=>assertPptEditorCommandResponse(request,result)).not.toThrow();
 for(const bad of [{...input,xMm:-1},{...input,widthMm:0},{...input,yMm:NaN},{...input,heightMm:Infinity},{...input,xMm:1001},{...input,url:'bad'},{...input,assetId:'../bad'}])
  expect(()=>assertPptEditorCommand({...request,input:bad})).toThrow();
 for(const key of ['xMm','yMm','widthMm','heightMm','assetId']){
  const missing:Record<string,unknown>={...input};delete missing[key];expect(()=>assertPptEditorCommand({...request,input:missing})).toThrow();
 }
 for(const change of [{xMm:26},{heightMm:31},{assetId:'other'},{sha256:'bad'},{page:0},{verified:false}])
  expect(()=>assertPptEditorCommandResponse(request,{...result,result:{...result.result,...change}})).toThrow();
 const capability={name:'insert_slide_image_from_asset',description:'Insert',readOnly:false,inputSchema:{properties:{assetId:{enum:['reviewed_png']}}}};
 const context={...owner,kind:'slide',editGeneration:1,page:2,selectedText:'',selectionCharacters:0,readOnly:false,capabilities:[capability]};
 expect(()=>assertPptEditorContext(context)).not.toThrow();
 for(const change of [{readOnly:true},{page:undefined},{selectedText:'x',selectionCharacters:1},{capabilities:[{...capability,inputSchema:{}}]}])
  expect(()=>assertPptEditorContext({...context,...change})).toThrow();
});

describe("fixed native fade contract", () => {
  const request = { ...owner, requestId: "fade-1", editGeneration: 1, tool: "set_slide_fade", input: {} };
  const receipt = { ...owner, requestId: "fade-1", editGeneration: 1, tool: "set_slide_fade", status: "verified", result: { page: 1, transition: "fade", durationMs: 750, verified: true, saved: false } };
  const capability = { name: "set_slide_fade", readOnly: false, description: "Host-inspected fade", inputSchema: { type: "object", properties: {}, additionalProperties: false } };
  const context = { ...owner, kind: "slide", editGeneration: 1, page: 1, selectedText: "", selectionCharacters: 0, readOnly: false, capabilities: [capability] };
  it("accepts the empty finite command, optional capability and exact unsaved receipt", () => {
    expect(() => assertPptEditorCommand(request)).not.toThrow();
    assertPptEditorCommand(request);
    expect(() => assertPptEditorCommandResponse(request, receipt)).not.toThrow();
    expect(() => assertPptEditorContext(context)).not.toThrow();
    expect(() => assertPptEditorContext({ ...context, capabilities: [] })).not.toThrow();
  });
  it.each([{ page: 2 }, { sourceHash: "private" }, { durationMs: 900 }, { transition: "push" }, { script: "bad" }])("rejects caller-controlled fade options %j", input => {
    expect(() => assertPptEditorCommand({ ...request, input })).toThrow();
  });
  it.each([{ durationMs: 900 }, { transition: "push" }, { page: 0 }, { saved: true }, { saved: undefined }, { verified: false }])("rejects wrong native fade result %j", patch => {
    expect(() => assertPptEditorCommandResult({ ...receipt, result: { ...receipt.result, ...patch } })).toThrow();
  });
  it("rejects unready contexts and effect-bearing capability schemas", () => {
    for (const patch of [{ page: undefined }, { readOnly: true }, { capabilities: [{ ...capability, inputSchema: {} }] }, { capabilities: [{ ...capability, inputSchema: { ...capability.inputSchema, properties: { durationMs: {} } } }] }])
      expect(() => assertPptEditorContext({ ...context, ...patch })).toThrow();
  });
});

it("validates explicit bold booleans, selection capability and correlated native receipts", () => {
  for (const enabled of [true, false]) {
    const request = { ...command, tool: "set_slide_text_bold" as const, input: { enabled } };
    assertPptEditorCommand(request);
    const receipt = { ...request, status: "verified", result: { enabled, page: 1, verified: true } };
    assertPptEditorCommandResponse(request, receipt);
    for (const result of [{ enabled: !enabled, page: 1, verified: true }, { enabled, page: 0, verified: true }, { enabled, page: 1, verified: false }, { enabled: "true", page: 1, verified: true }])
      expect(() => assertPptEditorCommandResponse(request, { ...receipt, result })).toThrow();
    expect(() => assertPptEditorCommandResponse(request, { ...receipt, status: "sent" })).toThrow();
  }
  for (const input of [{}, { enabled: 1 }, { enabled: "true" }, { enabled: null }, { enabled: true, script: "bad" }])
    expect(() => assertPptEditorCommand({ ...command, tool: "set_slide_text_bold", input })).toThrow();
  const context = { ...owner, kind: "slide", page: 1, editGeneration: 1, selectedText: "A", selectionCharacters: 1, readOnly: false,
    capabilities: [{ name: "set_slide_text_bold", readOnly: false, description: "Bold", inputSchema: {} }] };
  assertPptEditorContext(context);
  for (const patch of [{ readOnly: true }, { selectedText: "", selectionCharacters: 0 }])
    expect(() => assertPptEditorContext({ ...context, ...patch })).toThrow();
});
it("validates explicit italic booleans, selection capability and correlated native receipts", () => {
  for (const enabled of [true, false]) {
    const request = { ...command, tool: "set_slide_text_italic" as const, input: { enabled } };
    assertPptEditorCommand(request);
    const receipt = { ...request, status: "verified", result: { enabled, page: 1, verified: true } };
    assertPptEditorCommandResponse(request, receipt);
    for (const result of [{ enabled: !enabled, page: 1, verified: true }, { enabled, page: 0, verified: true }, { enabled, page: 1, verified: false }, { enabled: "true", page: 1, verified: true }])
      expect(() => assertPptEditorCommandResponse(request, { ...receipt, result })).toThrow();
    expect(() => assertPptEditorCommandResponse(request, { ...receipt, status: "sent" })).toThrow();
  }
  for (const input of [{}, { enabled: 1 }, { enabled: "true" }, { enabled: null }, { enabled: true, script: "bad" }])
    expect(() => assertPptEditorCommand({ ...command, tool: "set_slide_text_italic", input })).toThrow();
  const context = { ...owner, kind: "slide", page: 1, editGeneration: 1, selectedText: "A", selectionCharacters: 1, readOnly: false,
    capabilities: [{ name: "set_slide_text_italic", readOnly: false, description: "Italic", inputSchema: {} }] };
  assertPptEditorContext(context);
  for (const patch of [{ readOnly: true }, { selectedText: "", selectionCharacters: 0 }])
    expect(() => assertPptEditorContext({ ...context, ...patch })).toThrow();
});
