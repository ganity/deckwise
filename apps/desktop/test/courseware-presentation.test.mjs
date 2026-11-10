import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, readFile, writeFile, rm, utimes, readdir, symlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import test from "node:test";
import ts from "typescript";
import * as shared from "@pi-desktop/shared";
import * as agent from "@pi-desktop/agent-runtime";
import * as runtime from "@pi-desktop/courseware-runtime/node";
import * as authoring from "../../../packages/courseware-runtime/dist/authoring.mjs";
import { Host } from "../../../scripts/e2e/host.mjs";

const require = createRequire(import.meta.url);
const JSZip = require("../../../packages/agent-runtime/node_modules/jszip");
const cache = new Map([["@pi-desktop/shared", shared], ["@pi-desktop/agent-runtime", agent], ["@pi-desktop/courseware-runtime/node", runtime],
  [new URL("../../../packages/courseware-runtime/dist/authoring.mjs", import.meta.url).href, authoring],
  ["./courseware-runtime", { coursewareAuthoringUrl: () => new URL("../../../packages/courseware-runtime/dist/authoring.mjs", import.meta.url).href }]]);
function load(name) {
  if (cache.has(name)) return cache.get(name);
  if (!name.startsWith("./")) return require(name);
  const file = new URL(`../electron/main/${name.slice(2)}.ts`, import.meta.url);
  const exports = {}; cache.set(name, exports);
  const code = ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
  new Function("require", "exports", code)(load, exports); return exports;
}
const { CoursewareChatWorkflow } = load("./courseware-chat-workflow");
const { CoursewareSavedNarration } = load("./courseware-saved-narration");
const { CoursewareAssessmentMedia } = load("./courseware-assessment-media");
const { readNativeTeachingPackage } = load("./courseware-native-package");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const teaching = { pageType: "slide", phase: "explore", objective: "Name the family", durationSeconds: 30, requiredObjects: ["father"] };
const pages = [
  { pageNumber: 1, teaching: { ...teaching, requiredEffects: ["highlight", "animation"] } },
  { pageNumber: 2, teaching: { ...teaching, pageType: "quiz", requiredObjects: [] }, quiz: { type: "quiz", questions: [{ id: "family", type: "single", question: "Who is this?", options: ["father", "mother", "brother", "sister"].map((label, i) => ({ value: "ABCD"[i], label })), answer: ["A"] }] } },
  { pageNumber: 3, teaching: { ...teaching, pageType: "interactive", requiredObjects: [], question: { text: "Introduce your family.", response: { kind: "discussion", options: [], answerIndices: [] }, referenceAnswer: { summary: "This is my family.", keyPoints: ["family"] } } } },
];

async function fixture(t, fixed = false) {
  const dir = await mkdtemp(join(tmpdir(), "presentation-teaching-"));
  const workspace = join(dir, "workspace"), data = join(dir, "data"), project = join(workspace, ".deckwise-ppt/projects/family");
  for (const folder of ["exports", "notes", "svg_output", "validation"]) await mkdir(join(project, folder), { recursive: true });
  await mkdir(join(data, "plugins/market"), { recursive: true });
  await writeFile(join(data, "plugins/market/catalog.json"), JSON.stringify({ schemaVersion: 2, providerId: "official", plugins: [] }));
  const slides = ["father", "Who is this?", "Introduce your family."].map((content, i) => ({
    version: 1, slideId: `slide-${i}`, sourceHash: `sha256:${"a".repeat(64)}`, canvas: { width: 1280, height: 720 },
    visualMasterAssetId: authoring.assessmentBackground.id, cleanPlateAssetId: authoring.assessmentBackground.id,
    elements: [{ id: `question-${i}`, type: "native_text", bboxPx: [80, 80, 900, 200], zIndex: 1, content, style: { fontFace: "Arial", fontSizePt: 28, color: "#111827" } }],
  }));
  const compiled = await authoring.compileScenesToPptx(slides, { [authoring.assessmentBackground.id]: authoring.assessmentBackground.bytes });
  const zip = await JSZip.loadAsync(compiled.pptx);
  const p = "http://schemas.openxmlformats.org/presentationml/2006/main", a = "http://schemas.openxmlformats.org/drawingml/2006/main";
  for (let i = 1; i <= 3; i++) {
    if (i > 1) { if (!fixed) await writeFile(join(project, `svg_output/page-${i}.svg`), "<svg/>"); continue; }
    const rel = `ppt/slides/_rels/slide${i}.xml.rels`;
    zip.file(rel, (await zip.file(rel).async("string")).replace(/<Relationship\b[^>]*Type="[^"]*\/notesSlide"[^>]*\/>/g, "").replace("</Relationships>", `<Relationship Id="notes" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide${i}.xml"/></Relationships>`));
    zip.file(`ppt/notesSlides/notesSlide${i}.xml`, `<p:notes xmlns:p="${p}" xmlns:a="${a}"><p:cSld><p:spTree><p:sp><p:nvSpPr><p:cNvPr id="1" name="Notes"/><p:cNvSpPr/><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>Look at father. Say father.</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:notes>`);
    if (!fixed) await writeFile(join(project, `svg_output/page-${i}.svg`), "<svg/>");
  }
  for (const file of ["design_spec.md", "spec_lock.md", "notes/total.md"]) await writeFile(join(project, file), "Validated fixture planning and notes");
  await writeFile(join(project, "validation/svg_quality_report.json"), JSON.stringify({ stage: "final", summary: { errors: 0 } }));
  const path = join(project, "exports/family.pptx"), bytes = await zip.generateAsync({ type: "nodebuffer" }); await writeFile(path, bytes);
  let host = new Host(process.env.DECKWISE_E2E_WORKFLOW_HOST, data); await host.start();
  t.after(async () => { await host.stop(); await rm(dir, { recursive: true, force: true }); });
  const sessionId = (await host.call("session.create", { projectPath: workspace, mode: "agent" })).session.id;
  await host.call("courseware.task.set", { sessionId, taskType: "plain", educationContext: { bodyPageLimit: 1 } });
  const workflow = new CoursewareChatWorkflow(() => host, () => sessionId, {}, {});
  const args = { path, sourceSha256: hash(bytes), pages: structuredClone(pages), continueTeaching: true };
  return { host, workspace, project, workflow, sessionId, args, restart: async () => { await host.stop(); host = new Host(process.env.DECKWISE_E2E_WORKFLOW_HOST, data); await host.start(); return host; } };
}

test("ordinary preparation generates fixed assessments and preserves body/source/manual files", { skip: !process.env.DECKWISE_E2E_WORKFLOW_HOST, timeout: 90000 }, async t => {
  const f = await fixture(t, true);
  const args = { projectPath: ".deckwise-ppt/projects/family", canvas: { width: 1280, height: 720 }, pages: structuredClone(pages) };
  args.pages[2].teaching.question.text = "举起你的相册，指着一位家人说 This is my family! 再用英文介绍这位家人的称呼，和旁边的小朋友分享。";
  const source = await readFile(f.args.path);
  const result = await f.workflow.execute(f.sessionId, "courseware_presentation_prepare", args, () => true);
  assert.equal(result.prepared, true);
  assert.deepEqual(result.files.map(file => file.generated), [false, true, true]);
  assert.deepEqual(await readdir(join(f.project, "svg_output")), ["02.svg", "03.svg"]);
  const quiz = await readFile(join(f.project, "svg_output/02.svg"), "utf8");
  const interaction = await readFile(join(f.project, "svg_output/03.svg"), "utf8");
  assert(quiz.includes("Who is this?"));
  assert(interaction.includes('id="assessment-3_question"'));
  assert(!interaction.includes("This is my family.</tspan>"));
  assert(!quiz.includes("<image") && !interaction.includes("<animate"));
  assert.deepEqual((await readFile(f.args.path)), source);
  assert.deepEqual((await f.workflow.execute(f.sessionId, "courseware_presentation_prepare", args, () => true)).files, result.files);
  assert.deepEqual((await f.workflow.execute(f.sessionId, "courseware_presentation_prepare", { ...args, projectPath: f.project }, () => true)).files, result.files);
  const reordered = { ...args, pages: args.pages.map(page => ({ teaching: page.teaching, ...(page.quiz ? { quiz: page.quiz } : {}), pageNumber: page.pageNumber })) };
  assert.deepEqual((await f.workflow.execute(f.sessionId, "courseware_presentation_prepare", reordered, () => true)).files, result.files);
  const changed = structuredClone(args); changed.pages[1].quiz.questions[0].question = "Different question";
  await assert.rejects(f.workflow.execute(f.sessionId, "courseware_presentation_prepare", changed, () => true), /draft conflict/);
  assert.equal(await readFile(join(f.project, "svg_output/02.svg"), "utf8"), quiz);
  await assert.rejects(f.workflow.execute(f.sessionId, "courseware_presentation_prepare", { ...args, projectPath: "../outside" }, () => true), /workspace/);
  await assert.rejects(f.workflow.execute(f.sessionId, "courseware_presentation_prepare", args, () => false), /cancelled|ended/);
  const invalid = structuredClone(args); invalid.pages[1].quiz.questions[0].answer = ["DNE"];
  await assert.rejects(f.workflow.execute(f.sessionId, "courseware_presentation_prepare", invalid, () => true));
  const escaped = join(f.workspace, ".deckwise-ppt/projects/escape");
  await symlink(f.project, escaped, "dir");
  await assert.rejects(f.workflow.execute(f.sessionId, "courseware_presentation_prepare", { ...args, projectPath: ".deckwise-ppt/projects/escape" }, () => true), /workspace/);
  await writeFile(join(f.project, "svg_output/03.svg"), "Teacher edited SVG");
  await assert.rejects(f.workflow.execute(f.sessionId, "courseware_presentation_prepare", args, () => true), /draft conflict/);
  assert.equal(await readFile(join(f.project, "svg_output/03.svg"), "utf8"), "Teacher edited SVG");
  const localized = join(f.workspace, ".deckwise-ppt/projects/家人.v1_20261108");
  await mkdir(localized);
  assert.equal((await f.workflow.execute(f.sessionId, "courseware_presentation_prepare", { ...args, projectPath: localized }, () => true)).prepared, true);
});

test("fixed assessment SVGs pass official validation/export and bind real exported question text", {
  skip: !process.env.DECKWISE_E2E_WORKFLOW_HOST || !process.env.DECKWISE_PPT_MASTER_SKILL_ROOT, timeout: 120000,
}, async t => {
  const f = await fixture(t, true), root = process.env.DECKWISE_PPT_MASTER_SKILL_ROOT;
  const planned = structuredClone(pages);
  planned[2].teaching.question.text = "举起你的相册，指着一位家人说 This is my family! 再用英文介绍这位家人的称呼，和旁边的小朋友分享。";
  const fixtureRoot = new URL("../../../scripts/e2e/fixtures/ordinary-courseware/", import.meta.url);
  const assessmentOutline =
    "\n#### Slide 02 - Quiz\n\n- **Audience move**: Answer a family question.\n- **Relationships**: Independent assessment.\n- **Composition**: Shared fixed Quiz layout.\n- **Title**: Name family\n- **Core message**: Who is this?\n- **Content**: Who is this?\n- **Speaker note**: Assessment question only.\n\n#### Slide 03 - Interaction\n\n- **Audience move**: Introduce family.\n- **Relationships**: Independent response.\n- **Composition**: Shared fixed interaction layout.\n- **Title**: Introduce family\n- **Core message**: Share with classmates.\n- **Content**: Introduce your family.\n- **Speaker note**: Assessment question only.\n";
  const design = (await readFile(new URL("design_spec.md", fixtureRoot), "utf8")).replaceAll("Arial", "Noto Sans SC")
    .replace("| Page Count | 1 |", "| Page Count | 3 |")
    .replace("| Custom Animations | disabled", "| Custom Animations | enabled")
    .replace("## X. Speaker Notes Requirements", `${assessmentOutline}\n## X. Speaker Notes Requirements`);
  const lock = (await readFile(new URL("spec_lock.md", fixtureRoot), "utf8")).replaceAll("Arial", "Noto Sans SC").replace("- P01: anchor", "- P01: anchor\n- P02: anchor\n- P03: anchor");
  await writeFile(join(f.project, "design_spec.md"), design);
  await writeFile(join(f.project, "spec_lock.md"), lock);
  const body = (await readFile(new URL("svg_output/01_circle.svg", fixtureRoot), "utf8")).replaceAll("Arial", "Noto Sans SC");
  const prepared = await f.workflow.execute(f.sessionId, "courseware_presentation_prepare", {
    projectPath: ".deckwise-ppt/projects/family", canvas: { width: 1280, height: 720 }, pages: planned,
  }, () => true);
  const roles = prepared.typographySizesPx.map((size, index) => `- assessment_${index}: ${size}`).join("\n");
  await writeFile(join(f.project, "spec_lock.md"), lock.replace("## icons", `${roles}\n\n## icons`));
  await writeFile(join(f.project, "design_spec.md"), design.replace("## V. Layout Principles", `${prepared.typographySizesPx.map((size, index) => `| Assessment ${index} | ${size} |`).join("\n")}\n\nFixed assessment typography uses Noto Sans SC for the shared student-facing template.\n\n## V. Layout Principles`));
  await writeFile(join(f.project, "svg_output/01.svg"), body);
  await writeFile(join(f.project, "animations.json"), JSON.stringify({ version: 1, slides: { "01": { groups: {
    hero: { effect: "entrance_fade", order: 1, duration: 0.4 },
    body: { effect: "entrance_fade", order: 2, duration: 0.4 },
    "title-group": { effect: "none" },
  } } } }));
  for (const page of ["01", "02", "03"]) await writeFile(join(f.project, `notes/${page}.md`), page === "01" ? "Look at the circle. It has no corners." : "Assessment question only.");
  await writeFile(join(f.project, "notes/total.md"), "# 01\nLook at the circle. It has no corners.\n\n# 02\nAssessment question only.\n\n# 03\nAssessment question only.\n");
  for (const [script, args] of [
    ["project_manager.py", ["validate", f.project]],
    ["svg_quality_checker.py", [f.project, "--canonical-authoring", "--stage", "final", "--json"]],
    ["animation_config.py", ["validate", f.project]],
    ["svg_to_pptx.py", [f.project, "-s", "output", "-o", f.args.path, "-t", "none"]],
  ]) {
    const result = spawnSync(process.env.DECKWISE_PYTHON || "python3", [join(root, "scripts", script), ...args], { encoding: "utf8", timeout: 60000, maxBuffer: 8 * 1024 * 1024 });
    assert.equal(result.status, 0, `${script}: ${result.stdout}\n${result.stderr}`);
  }
  const bytes = await readFile(f.args.path);
  const exported = await JSZip.loadAsync(bytes);
  const nativeBody = await exported.file("ppt/slides/slide1.xml").async("string");
  assert.match(nativeBody, /<p:timing\b/, "Native timing must exist in the actual official export");
  for (const page of [2, 3]) assert.doesNotMatch(await exported.file(`ppt/slides/slide${page}.xml`).async("string"), /<p:timing\b/);
  const wrongPlan = structuredClone(planned);
  wrongPlan[2].teaching.question.text = "A replacement question";
  await assert.rejects(f.workflow.execute(f.sessionId, "courseware_presentation_adopt", {
    ...f.args, sourceSha256: hash(bytes), pages: wrongPlan,
  }, () => true), /differs from presentation-plan/);
  const planPath = join(f.project, "presentation-plan.json");
  await utimes(planPath, new Date(Date.now() + 60_000), new Date(Date.now() + 60_000));
  await assert.rejects(f.workflow.execute(f.sessionId, "courseware_presentation_adopt", {
    ...f.args, sourceSha256: hash(bytes), pages: planned,
  }, () => true), /changed after validation/);
  assert.equal((await f.host.call("courseware.task.get", { sessionId: f.sessionId })).task.generatedPath, undefined);
  await utimes(planPath, new Date(0), new Date(0));
  const receipt = await f.workflow.execute(f.sessionId, "courseware_presentation_adopt", { ...f.args, sourceSha256: hash(bytes), pages: planned }, () => true);
  const native = await readNativeTeachingPackage(await readFile(receipt.path));
  assert.equal(native.pages.length, 3);
  assert.equal(native.pages[1].actions.find(a => a.type === "interaction_checkpoint").response.kind, "single");
  assert.equal(native.pages[2].actions.find(a => a.type === "interaction_checkpoint").question, planned[2].teaching.question.text);
  const generated = await JSZip.loadAsync(await readFile(receipt.path));
  assert.equal(await generated.file("ppt/slides/slide1.xml").async("string"), nativeBody);
  assert.equal(prepared.files.filter(file => file.generated).length, 2);
  await assert.rejects(f.workflow.execute(f.sessionId, "courseware_presentation_prepare", {
    projectPath: ".deckwise-ppt/projects/family", canvas: { width: 1280, height: 720 }, pages: planned,
  }, () => true), /saved teaching/);
});

test("ordinary export publishes complete native teaching and saved generation survives restart", { skip: !process.env.DECKWISE_E2E_WORKFLOW_HOST, timeout: 90000 }, async t => {
  const f = await fixture(t);
  const original = await readFile(f.args.path);
  const result = await f.workflow.execute(f.sessionId, "courseware_presentation_adopt", f.args, () => true);
  assert.equal(result.generated, true); assert.equal(result.nativeTeaching, true);
  assert.notEqual(result.path, f.args.path, "Original validated export is preserved");
  assert.deepEqual(await readFile(f.args.path), original);
  const bytes = await readFile(result.path), native = await readNativeTeachingPackage(bytes);
  assert.equal(native.pages.length, 3);
  assert.equal(native.pages[0].actions.some(a => a.type === "speech"), false, "PPT Master notes must remain evidence until structured narration is generated");
  assert.match(await (await JSZip.loadAsync(bytes)).file("ppt/notesSlides/notesSlide1.xml").async("string"), /Look at father\. Say father\./);
  assert.deepEqual(native.pages[1].actions[1].response, { kind: "single", options: ["father", "mother", "brother", "sister"], answerIndices: [0] });
  assert.deepEqual(native.pages[2].actions[1].response, pages[2].teaching.question.response);
  assert.deepEqual(native.pages[2].actions[1].referenceAnswer, pages[2].teaching.question.referenceAnswer);
  assert.equal((await f.workflow.execute(f.sessionId, "courseware_presentation_adopt", f.args, () => true)).path, result.path);

  // Drive the adopted document through the real native narration coordinator.
  const project = structuredClone(result.project);
  const view = () => ({ nativeTeaching: true, viewId: "native.page-1", pageId: "page-1", pageNumber: 1,
    project: structuredClone(project), teaching: pages[0].teaching,
    teachingRequirements: pages.map((p, i) => ({ pageId: `page-${i + 1}`, teaching: p.teaching })) });
  const route = async (operation, args) => {
    if (operation === "narration-visual") {
      const png = Buffer.alloc(24); png.writeUInt32BE(0x89504e47); png.writeUInt32BE(1280, 16); png.writeUInt32BE(720, 20);
      return { value: { dataUrl: "data:image/png;base64," + png.toString("base64") } };
    }
    if (operation === "write") { project.pages[0].actions = structuredClone(args.actions); project.teachingRevision += "-authored"; }
    else assert.equal(operation, "open");
    return { value: view() };
  };
  const target = native.identity.pages[0].objects[0].logicalId;
  const teachingBridge = { native: async (operation, args) => operation === "narration-context" ? { value: {
    view: view(), text: "father", editor: { projectId: "workspace", documentId: "ppt", sessionId: f.sessionId, editGeneration: 1, readOnly: false },
    evidence: { notes: "Look at father. Say father.", visualSummary: "father", objects: [{ objectId: target, name: "father", aliases: ["father"], kind: "text", text: "father", bbox: [80, 80, 900, 200] }] },
  } } : route(operation, args) };
  const { CoursewareCandidateCoordinator } = load("./courseware-candidates");
  const { CoursewareNativeTools } = load("./courseware-native-tools");
  const segments = ["Look at father.", "Say father."];
  const candidates = new CoursewareCandidateCoordinator(teachingBridge, async ({ messages, system }) => {
    const data = JSON.parse(messages[0].content);
    if (data.outline) {
      assert.equal(data.outline[0].notes, "Look at father. Say father.");
      return { text: JSON.stringify({ goal: "Teach father", pages: data.requestedPageNumbers.map(pageNumber => ({ pageNumber, purpose: "Name father", bridge: "Practice next", focus: "father" })) }), modelKey: "local/test" };
    }
    assert.equal(data.evidence.notes, "Look at father. Say father.");
    assert.match(system, /split when the focus changes/);
    assert.match(system, /omit interaction blocks and teacher_continue waits/);
    return { text: JSON.stringify({ blocks: segments.map(text => ({ type: "speech", text, attention: { type: "highlight", objectIds: [target], animation: "pulse" } })) }), modelKey: "local/test" };
  }, undefined, async () => ({ modelKey: "local/test" }));
  const tools = new CoursewareNativeTools(teachingBridge, candidates, {}, route, () => f.sessionId);
  const context = () => tools.execute(f.sessionId, "courseware_narration_context", {}, () => true);
  assert.equal((await context()).value.pages[0].narrationReady, false);
  assert((await context()).value.completion.issues.some(i => i.code === "NARRATION_MISSING" && i.pageNumber === 1));
  await tools.execute(f.sessionId, "courseware_narration_propose", { sourceSha256: project.source.sha256, pageNumbers: [1], instruction: "Explain each teaching move separately" }, () => true);
  assert.deepEqual(project.pages[0].actions.filter(a => a.type === "speech").map(a => a.text), segments);
  assert.equal((await context()).value.pages[0].narrationReady, true);

  await assert.rejects(f.host.call("courseware.project.context", { sessionId: f.sessionId, projectId: native.documentId }), /not found|NOT_FOUND/i);
  const restarted = await f.restart();
  assert.equal((await restarted.call("courseware.task.get", { sessionId: f.sessionId })).task.generatedPath, result.path);
  assert.deepEqual((await readNativeTeachingPackage(await readFile(result.path))).pages, native.pages);
});

test("ordinary handoff rejects stale validation, wrong page budgets and changed source without attachment", { skip: !process.env.DECKWISE_E2E_WORKFLOW_HOST, timeout: 90000 }, async t => {
  const f = await fixture(t);
  const report = join(f.project, "validation/svg_quality_report.json");
  const animations = join(f.project, "animations.json");
  await writeFile(animations, JSON.stringify({ version: 1, slides: {} }));
  await utimes(animations, new Date(Date.now() + 60_000), new Date(Date.now() + 60_000));
  await assert.rejects(f.workflow.execute(f.sessionId, "courseware_presentation_adopt", f.args, () => true), /changed after/);
  await utimes(animations, new Date(0), new Date(0));
  await utimes(report, new Date(0), new Date(0));
  await assert.rejects(f.workflow.execute(f.sessionId, "courseware_presentation_adopt", f.args, () => true), /validation|changed after/);
  assert.equal((await f.host.call("courseware.task.get", { sessionId: f.sessionId })).task.generatedPath, undefined);
  await assert.rejects(f.workflow.execute(f.sessionId, "courseware_presentation_adopt", { ...f.args, sourceSha256: "f".repeat(64) }, () => true), /changed/);
  await assert.rejects(f.workflow.execute(f.sessionId, "courseware_presentation_adopt", { ...f.args, pages: f.args.pages.slice(0, 2) }, () => true), /physical.*pages/);
  await utimes(report, new Date(), new Date());
  const overBudget = structuredClone(f.args);
  overBudget.pages[2].teaching = { ...teaching };
  await assert.rejects(f.workflow.execute(f.sessionId, "courseware_presentation_adopt", overBudget, () => true), /page limit|page budget/);
  const wrongQuestion = structuredClone(f.args);
  wrongQuestion.pages[2].teaching.question.text = "A question absent from this page.";
  await assert.rejects(f.workflow.execute(f.sessionId, "courseware_presentation_adopt", wrongQuestion, () => true), /exact interaction question/);
  assert.equal((await f.host.call("courseware.task.get", { sessionId: f.sessionId })).task.generatedPath, undefined);
  await assert.rejects(f.workflow.execute(f.sessionId, "courseware_presentation_adopt", f.args, () => false), /cancelled|ended/);
});
