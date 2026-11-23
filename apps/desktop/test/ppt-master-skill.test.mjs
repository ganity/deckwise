import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";
import ts from "typescript";


register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const baselineRoot = mkdtempSync(join(tmpdir(), "ppt-master-baseline-"));
const initialSkillRoot = process.env.DECKWISE_PPT_MASTER_SKILL_ROOT;
for (const directory of ["scripts", "scripts/svg_editor", "workflows", "templates"]) mkdirSync(join(baselineRoot, directory));
for (const file of ["scripts/attribution_guard.py", "scripts/project_manager.py", "scripts/svg_quality_checker.py", "scripts/svg_to_pptx.py", "scripts/svg_editor/server.py", "workflows/routing.md", "workflows/generate-pptx.md", "templates/design_spec_reference.md", "templates/spec_lock_reference.md"])
  writeFileSync(join(baselineRoot, file), "Fixture resource");
writeFileSync(join(baselineRoot, "SKILL.md"), "---\nname: ppt-master\ndescription: Fixture\n---\nFixture entry\n");
process.env.DECKWISE_PPT_MASTER_SKILL_ROOT = baselineRoot;
after(() => {
  if (initialSkillRoot === undefined) delete process.env.DECKWISE_PPT_MASTER_SKILL_ROOT;
  else process.env.DECKWISE_PPT_MASTER_SKILL_ROOT = initialSkillRoot;
  rmSync(baselineRoot, { recursive: true, force: true });
});
const { builtinSkills, loadBuiltinSkillBody, pptMasterSkillUnavailableReason } = await import("../electron/main/builtin-skills.ts");
const { resolveCoursewareRoute } = await import("@pi-desktop/agent-runtime");
const promptSource = readFileSync(new URL("../electron/main/ipc/agent-ipc.ts", import.meta.url), "utf8");
const promptModule = {};
new Function("require", "exports", ts.transpileModule(`${promptSource}\nexports.prompt = deckWiseModelPrompt;`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText)((id) => {
  if (id === "../builtin-skills") return { loadBuiltinSkillBody, pptMasterSkillUnavailableReason };
  if (id === "@pi-desktop/agent-runtime") return { resolveCoursewareRoute };
  if (id === "../courseware-scene-plan") return { sceneCoursePlanRelativePath: () => ".deckwise-ppt/scenes/plan.json", sceneCourseTeachingPolicy: () => "Scene teaching policy" };
  return {};
}, promptModule);

test("preparing an already configured PPT Master directory preserves its input", () => {
  const root = mkdtempSync(join(tmpdir(), "ppt-master-in-place-"));
  try {
    for (const directory of ["scripts", "scripts/svg_editor", "workflows", "templates"]) mkdirSync(join(root, directory));
    for (const file of ["SKILL.md", "scripts/attribution_guard.py", "workflows/routing.md", "scripts/project_manager.py", "scripts/svg_quality_checker.py", "scripts/svg_to_pptx.py", "scripts/svg_editor/server.py", "workflows/generate-pptx.md", "templates/design_spec_reference.md", "templates/spec_lock_reference.md", "sentinel"])
      writeFileSync(join(root, file), "preserved");
    execFileSync(process.execPath, [fileURLToPath(new URL("../../../scripts/prepare-ppt-master.mjs", import.meta.url)), "--output", root], {
      env: { ...process.env, DECKWISE_PPT_MASTER_SKILL_ROOT: root }, stdio: "pipe",
    });
    assert.equal(readFileSync(join(root, "sentinel"), "utf8"), "preserved");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("all three entry paths retain the saved school stage and their own approval boundary", () => {
  const imported = loadBuiltinSkillBody("deckwise/ppt-import")?.body;
  const edit = loadBuiltinSkillBody("deckwise/ppt-edit")?.body;
  assert(imported?.includes("When the imported-course Start request asks to fill missing narration"));
  assert(!imported.includes("Offer original speaker notes, external narration"));
  assert(edit?.includes("Scene requires its plan review and first-image style confirmation"));
  assert(edit.includes("import proceeds from its saved source"));
  for (const schoolStage of ["kindergarten", "primary", "junior_high", "senior_high"]) {
    const settings = { schoolStage, subject: "math" };
    for (const taskType of ["plain", "scene", "import"]) {
      const prompt = promptModule.prompt("Teach fractions", false, taskType, settings, "chat");
      assert(prompt.includes(`"schoolStage":"${schoolStage}"`), `${taskType}: ${schoolStage}`);
      assert(prompt.includes("ordinary generation, scene generation and PPT import"), taskType);
      assert(prompt.includes("junior high and senior high"), taskType);
      if (taskType === "scene") assert(prompt.includes("Scene teaching policy"));
      if (taskType === "import") assert(prompt.includes('id "deckwise/ppt-import"'));
    }
  }
});

test("loading the ordinary generation skill includes the current official planning references", () => {
  const root = mkdtempSync(join(tmpdir(), "ppt-master-skill-"));
  const previous = process.env.DECKWISE_PPT_MASTER_SKILL_ROOT;
  const previousCwd = process.cwd();
  try {
    process.chdir(root);
    for (const directory of ["scripts", "scripts/svg_editor", "workflows", "templates"]) mkdirSync(join(root, directory));
    writeFileSync(join(root, "SKILL.md"), "---\nname: ppt-master\ndescription: Fixture\n---\nOfficial entry\n");
    writeFileSync(join(root, "scripts/attribution_guard.py"), "");
    for (const file of ["scripts/project_manager.py", "scripts/svg_quality_checker.py", "scripts/svg_to_pptx.py", "scripts/svg_editor/server.py"])
      writeFileSync(join(root, file), "");
    writeFileSync(join(root, "workflows/routing.md"), "");
    writeFileSync(join(root, "workflows/generate-pptx.md"), "Official default SVG workflow v1");
    writeFileSync(join(root, "templates/design_spec_reference.md"), "Official design contract v1");
    writeFileSync(join(root, "templates/spec_lock_reference.md"), "Official lock contract v1");
    process.env.DECKWISE_PPT_MASTER_SKILL_ROOT = root;
    const skill = loadBuiltinSkillBody("deckwise/ppt-master");
    assert(skill);
    for (const text of ["Official entry", "Official default SVG workflow v1", "Official design contract v1", "Official lock contract v1", "scripts/svg_editor/server.py", "--canonical-authoring --stage final --json", "project_manager.py validate <project_path>"]) {
      assert(skill.body.includes(text), text);
    }
    for (const request of ["Generate three pages", "Repair the current project"]) {
      const prompt = promptModule.prompt(request, false, "plain");
      assert(prompt.includes("Official design contract v1"));
      assert(prompt.includes("Official lock contract v1"));
      assert(prompt.includes("Official default SVG workflow v1"));
      assert(prompt.includes("Do not replace that pipeline with python-pptx"));
      assert(prompt.includes("another Skill call is unnecessary"));
      assert(prompt.endsWith(`User request:\n${request}`));
    }
    for (const task of ["plain", "scene", "import"]) {
      const prompt = promptModule.prompt("Edit the current page", true, task);
      assert(!prompt.includes("Official design contract v1"));
      assert(!prompt.includes("Official default SVG workflow v1"));
      assert(prompt.includes('id "deckwise/ppt-edit"'));
    }
    writeFileSync(join(root, "templates/spec_lock_reference.md"), "Official lock contract v2");
    assert(loadBuiltinSkillBody("deckwise/ppt-master").body.includes("Official lock contract v2"));
    assert(!loadBuiltinSkillBody("deckwise/ppt-master").body.includes("Official lock contract v1"));
    rmSync(join(root, "workflows/generate-pptx.md"));
    assert.equal(loadBuiltinSkillBody("deckwise/ppt-master"), null);
    assert.throws(() => promptModule.prompt("Generate three pages", false, "plain"), (error) =>
      error.errorCode === "PPT_MASTER_SKILL_UNAVAILABLE" && error.message.includes("workflows/generate-pptx.md"));
    writeFileSync(join(root, "workflows/generate-pptx.md"), "Official default SVG workflow v2");
    assert(loadBuiltinSkillBody("deckwise/ppt-master").body.includes("Official default SVG workflow v2"));
    rmSync(join(root, "templates/design_spec_reference.md"));
    assert.equal(loadBuiltinSkillBody("deckwise/ppt-master"), null);
    assert.throws(() => promptModule.prompt("Generate three pages", false, "plain"), (error) =>
      error.errorCode === "PPT_MASTER_SKILL_UNAVAILABLE" && error.message.includes("templates/design_spec_reference.md"));
    assert(!builtinSkills({ workspacePath: root }).some((item) => item.id === "deckwise/ppt-master"));
    writeFileSync(join(root, "templates/design_spec_reference.md"), "Official design contract v2");
    rmSync(join(root, "scripts/svg_to_pptx.py"));
    assert(!builtinSkills({ workspacePath: root }).some((item) => item.id === "deckwise/ppt-master"));
    assert.throws(() => promptModule.prompt("Generate three pages", false, "plain"), (error) =>
      error.errorCode === "PPT_MASTER_SKILL_UNAVAILABLE" && error.message.includes("scripts/svg_to_pptx.py"));
    const savedPrompt = promptModule.prompt("Continue narration", false, "plain", { schoolStage: "primary" }, "chat", null, true);
    assert(savedPrompt.includes('id "deckwise/ppt-edit"'));
    assert(savedPrompt.includes("A PPTX source is already saved"));
    assert(!savedPrompt.includes("Before the first export"));
    assert(!savedPrompt.includes("Official default SVG workflow"));
  } finally {
    process.chdir(previousCwd);
    if (previous === undefined) delete process.env.DECKWISE_PPT_MASTER_SKILL_ROOT;
    else process.env.DECKWISE_PPT_MASTER_SKILL_ROOT = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("canvas draft revisions remain available before and during native Office editing", () => {
  const prompt = promptModule.prompt("Revise the selected image draft", false, "plain");
  assert.match(prompt, /revise an existing media draft on the current canvas/);
  assert.match(prompt, /courseware_canvas_get to read it and courseware_canvas_edit to update only the requested draft fields/);

  for (const task of ["plain", "scene", "import"]) {
    const nativePrompt = promptModule.prompt("Revise the selected image draft", true, task);
    assert.match(nativePrompt, /courseware_canvas_get to read it and courseware_canvas_edit to update only the requested draft fields/);
    assert.match(nativePrompt, /This saves draft metadata only; it never generates media or edits slides/);
    assert.match(nativePrompt, /For PPTX requests, activate PPT tools with ToolSearch/);
    assert.match(nativePrompt, /Canvas draft requests remain separate and use courseware_canvas_get\/edit/);
  }
});

test("native teaching routes stay available without Office selection capabilities or a plan attachment", () => {
  for (const task of ["plain", "scene", "import"]) {
    const prompt = promptModule.prompt("Add a short answer and spotlight", true, task);
    assert.match(prompt, /Office selection capabilities do not limit these teaching operations/);
    assert.match(prompt, /inline activity requirements can be mapped as lessonPlan.text\/units without a plan attachment/);
  }
});


test("narration skills require small visible calls rather than one full-deck tool call", async () => {
  for (const name of ["ppt-edit","ppt-import"]) {
    const skill = readFileSync(new URL(`../resources/skills/${name}/SKILL.md`,import.meta.url),"utf8");
    assert.match(skill,/at most 5 unfinished pages per call/);
    assert.doesNotMatch(skill,/every user-authorized page in one call/);
  }
});
