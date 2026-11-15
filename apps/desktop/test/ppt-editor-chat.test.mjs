import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import * as shared from "../../../packages/shared/dist/index.js";
import { createAuthorizedPptEditorTools } from "../../../packages/agent-runtime/dist/ppt-editor-host.js";

const source = await readFile(new URL("../electron/main/ppt-editor-chat.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
const module = { exports: {} };
new Function("require", "exports", outputText)((id) => { assert.equal(id, "@pi-desktop/shared"); return shared; }, module.exports);
const { PptEditorChatBridge } = module.exports;
function setup() {
  const binding = { projectId: "workspace", documentId: "document", sessionId: "native-1" };
  const context = { ...binding, editGeneration: 1, kind: "slide", page: 1, selectedText: "", selectionCharacters: 0, readOnly: false,
    capabilities: ["get_presentation_text", "add_slide_text"].map((name) => ({ name, description: name, inputSchema: {}, readOnly: name === "get_presentation_text" })) };
  let workspace = "/workspace", viewing = "chat-1", mode = "agent", projectPath = workspace, dispatchable = true;
  let afterRead;
  const commands = [], calls = [];
  const host = { async call(method, params) {
    calls.push([method, params]);
    if (method === "session.get") { afterRead?.(); return { session: { projectPath, mode } }; }
    if (method === "tools.abort") return { ok: true };
    assert.equal(method, "tools.execute");
    return { ok: true, content: await bridge.execute(params.sessionId, params.toolName, params.args, () => dispatchable) };
  } };
  const editor = {
    async getContext() { return structuredClone(context); },
    async execute(command) {
      commands.push(command);
      const result = command.tool === "get_presentation_text" ? { text: "First page", truncated: false, slidesRead: 1, totalSlides: 2 } : (command.tool === "set_slide_text_box_size" || command.tool === "set_slide_image_size") ? { ...command.input, page: context.page, verified: true } : command.tool === "insert_slide_image_from_asset" ? { ...command.input, sha256: "a".repeat(64), imageId: "native-image", page: context.page, verified: true } : (command.tool === "set_slide_text_bold" || command.tool === "set_slide_text_italic") ? { enabled: command.input.enabled, page: context.page, verified: true } : command.tool === "set_slide_font_size" ? { fontSizePt: command.input.fontSizePt, page: context.page, verified: true }
        : command.tool === "set_slide_font_family" ? { fontFamily: command.input.fontFamily, page: context.page, verified: true }
        : command.tool === "set_slide_text_color" ? { colorHex: command.input.colorHex, page: context.page, verified: true }
        : (command.tool === "set_slide_text_box_position" || command.tool === "set_slide_image_position" || command.tool === "add_slide_object_animation") ? { ...command.input, page: context.page, verified: true }
        : { page: context.page, verified: true };
      if (command.tool !== "get_presentation_text") context.editGeneration++;
      return { ...command, status: "verified", result };
    },
  };
  let currentHost = host;
  const bridge = new PptEditorChatBridge(editor, () => currentHost, async () => workspace, () => viewing);
  bridge.setOwner("chat-1"); bridge.setVisible(true);
  const tools = createAuthorizedPptEditorTools(host, "chat-1", binding, () => "turn-1");
  return { bridge, context, binding, host, commands, calls, tools,
    change(key) {
      if (key === "workspace") workspace = "/other";
      if (key === "session") viewing = "chat-2";
      if (key === "mode") mode = "plan";
      if (key === "persistedRoot") projectPath = "/other";
      if (key === "host") currentHost = {};
      if (key === "hidden") bridge.setVisible(false);
      if (key === "owner") bridge.setOwner("chat-2");
      if (key === "binding") context.sessionId = "native-2";
      if (key === "cancelled") dispatchable = false;
      if (key === "page") { context.page++; context.editGeneration++; }
      if (key === "readonly") context.readOnly = true;
    }, afterRead(fn) { afterRead = fn; },
  };
}

test("existing runtime tools read and edit the current native page through Host dispatch", async () => {
  const f = setup();
  assert.deepEqual(await f.bridge.capture("chat-1"), f.binding);
  const read = await f.tools[0].execute("read-1", {});
  assert.equal(read.details.response.result.text, "First page");
  const write = await f.tools[2].execute("write-1", { editGeneration: read.details.context.editGeneration, text: "Good!" });
  assert.equal(write.details.saved, false);
  assert.equal(f.commands[1].input.text, "Good!");
  assert.equal(f.calls.find(([, p]) => p.toolName === "ppt_add_slide_text")[1].toolCallId, "write-1");
  assert(f.calls.filter(([m]) => m === "tools.execute").every(([, p]) => p.sessionId === "chat-1" && p.turnId === "turn-1"));
  await assert.rejects(f.tools[2].execute("write-2", { editGeneration: 1, text: "Old" }), /context changed/);
  assert.equal(f.commands.length, 2);
});

test("session, source, mode, Host and late cancellation fences reject before native side effects", async () => {
  for (const change of ["workspace", "session", "mode", "persistedRoot", "host", "hidden", "owner", "binding", "cancelled", "page", "readonly"]) {
    const f = setup(); await f.bridge.capture("chat-1");
    const command = { ...f.binding, requestId: "command-1", editGeneration: 1, tool: "add_slide_text", input: { text: "Never written" } };
    f.change(change);
    await assert.rejects(f.bridge.execute("chat-1", "ppt_add_slide_text", command, () => change !== "cancelled"), /Chat|context|workspace|session|capability/);
    assert.equal(f.commands.length, 0, change);
  }
  const f = setup(); await f.bridge.capture("chat-1");
  f.afterRead(() => f.change("cancelled"));
  await assert.rejects(f.host.call("tools.execute", { sessionId: "chat-1", toolName: "ppt_add_slide_text", args: { ...f.binding, requestId: "late", editGeneration: 1, tool: "add_slide_text", input: { text: "late" } } }), /cancelled/);
  assert.equal(f.commands.length, 0);
});

test("unbound Chats, forged command names/paths and reopening another owner cannot edit", async () => {
  const f = setup();
  assert.equal(await f.bridge.capture("chat-2"), undefined);
  await f.bridge.capture("chat-1");
  const command = { ...f.binding, requestId: "command-1", editGeneration: 1, tool: "add_slide_text", input: { text: "Text" } };
  for (const [name, args] of [["ppt_execute_js", command], ["ppt_add_slide_text", { ...command, path: "/other" }], ["ppt_get_context", { ...f.binding, path: "/other" }]]) {
    await assert.rejects(f.bridge.execute("chat-1", name, args, () => true), /Invalid|unsupported|context/);
  }
  f.bridge.clear();
  await assert.rejects(f.bridge.execute("chat-1", "ppt_add_slide_text", command, () => true), /No PPT/);
  assert.equal(f.commands.length, 0);
});

test("denial and abort remain errors without retries or native writes", async () => {
  const f = setup(); await f.bridge.capture("chat-1");
  const call = f.host.call;
  f.host.call = async (method, params) => params.toolName === "ppt_add_slide_text"
    ? { ok: false, errorCode: "TOOL_DENIED", content: { error: "Permission denied" } } : call(method, params);
  await assert.rejects(f.tools[2].execute("denied", { editGeneration: 1, text: "No" }), /TOOL_DENIED/);
  assert.equal(f.commands.length, 0);
  const controller = new AbortController();
  f.host.call = async (method, params) => {
    if (method === "tools.execute" && params.toolName === "ppt_add_slide_text") { controller.abort(); return { ok: true, content: {} }; }
    return call(method, params);
  };
  await assert.rejects(f.tools[2].execute("abort", { editGeneration: 1, text: "No" }, controller.signal), /aborted/);
  assert(f.calls.some(([m, p]) => m === "tools.abort" && p.toolCallId === "abort"));
  assert.equal(f.commands.length, 0);
});


test("owned hidden editor allows saved-page checks but still refuses native Chat dispatch", async () => {
  const f = setup();
  await f.bridge.capture("chat-1");
  f.change("hidden");
  f.bridge.assertOwned("chat-1");
  assert.throws(() => f.bridge.assertActive("chat-1"), /no longer active/);
  await assert.rejects(f.bridge.execute("chat-1", "ppt_get_context", f.binding, () => true), /no longer active/);
  for (const change of ["owner", "session", "clear"]) {
    const next = setup();
    next.change("hidden");
    if (change === "clear") next.bridge.clear(); else next.change(change);
    assert.throws(() => next.bridge.assertOwned("chat-1"), /no longer active/);
  }
  assert.equal(f.commands.length, 0);
});

test("candidate review owner checks reject another or hidden Chat without needing a captured Agent turn", () => {
  const f = setup();
  f.bridge.assertActive("chat-1");
  assert.throws(() => f.bridge.assertActive("chat-2"), /no longer active/);
  f.change("hidden");
  assert.throws(() => f.bridge.assertActive("chat-1"), /no longer active/);
});

const nativeFormats = [
  ["set_slide_text_italic", { enabled: false }],
  ["set_slide_text_italic", { enabled: true }],
  ["set_slide_text_box_size", { widthMm: 200, heightMm: 30 }],
  ["set_slide_image_size", { widthMm: 80.5, heightMm: 30 }],
  ["set_slide_image_position", { xMm: 25.5, yMm: 35 }],
  ["add_slide_object_animation", { effect: "appear" }],
  ["add_slide_object_animation", { effect: "fade" }],
  ["insert_slide_image_from_asset", { assetId: "reviewed-png", xMm: 25, yMm: 35, widthMm: 40, heightMm: 30 }],
  ["set_slide_text_bold", { enabled: false }],
  ["set_slide_text_bold", { enabled: true }],
  ["set_slide_font_family", { fontFamily: "Courier New" }],
  ["set_slide_font_size", { fontSizePt: 24.5 }],
  ["set_slide_text_color", { colorHex: "336699" }],
  ["set_slide_text_box_position", { xMm: 25, yMm: 35 }],
];
for (const [name, input] of nativeFormats) {
  test(`authorized Chat dispatches ${name} with current binding and keeps edits unsaved`, async () => {
    const f = setup();
    f.context.selectedText = name === "insert_slide_image_from_asset" || name === "add_slide_object_animation" || (name === "set_slide_image_size" || name === "set_slide_image_position") ? "" : "Pear"; f.context.selectionCharacters = f.context.selectedText.length;
    f.context.capabilities.push({ name, description: name, inputSchema: name === "set_slide_font_family" ? { properties: { fontFamily: { enum: ["Courier New"] } } } : name === "insert_slide_image_from_asset" ? { properties: { assetId: { enum: ["reviewed-png"] } } } : {}, readOnly: false });
    await f.bridge.capture("chat-1");
    const tool = f.tools.find((item) => item.name === `ppt_${name}`);
    assert(tool, "Tool must be discoverable through the authorized runtime");
    const result = await tool.execute("format-1", { ...input, editGeneration: 1 });
    assert.equal(result.details.saved, false);
    assert.deepEqual(f.commands[0].input, input);
    assert.equal(f.commands[0].tool, name);
    const [, request] = f.calls.find(([, params]) => params.toolName === `ppt_${name}`);
    assert.equal(request.toolCallId, "format-1");
    assert.equal(request.sessionId, "chat-1");
    assert.equal(request.turnId, "turn-1");
    await assert.rejects(tool.execute("stale", { ...input, editGeneration: 1 }), /context changed/);
    assert.equal(f.commands.length, 1);
  });
  test(`Chat denies ${name} on missing capability, permission denial and late owner change`, async () => {
    const f = setup(); await f.bridge.capture("chat-1");
    const tool = f.tools.find((item) => item.name === `ppt_${name}`);
    assert(tool);
    await assert.rejects(tool.execute("missing", { ...input, editGeneration: 1 }), /unavailable/);
    f.context.selectedText = name === "insert_slide_image_from_asset" || name === "add_slide_object_animation" || (name === "set_slide_image_size" || name === "set_slide_image_position") ? "" : "Pear"; f.context.selectionCharacters = f.context.selectedText.length;
    f.context.capabilities.push({ name, description: name, inputSchema: name === "set_slide_font_family" ? { properties: { fontFamily: { enum: ["Courier New"] } } } : name === "insert_slide_image_from_asset" ? { properties: { assetId: { enum: ["reviewed-png"] } } } : {}, readOnly: false });
    const call = f.host.call;
    f.host.call = async (method, params) => params.toolName === `ppt_${name}`
      ? { ok: false, errorCode: "TOOL_DENIED", content: { error: "Permission denied" } } : call(method, params);
    await assert.rejects(tool.execute("denied", { ...input, editGeneration: 1 }), /TOOL_DENIED/);
    f.host.call = call;
    f.afterRead(() => f.change("owner"));
    await assert.rejects(tool.execute("late", { ...input, editGeneration: 1 }), /no longer active/);
    assert.equal(f.commands.length, 0);
  });
}
