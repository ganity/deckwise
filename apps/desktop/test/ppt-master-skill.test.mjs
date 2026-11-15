import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";

test("preparing an already configured PPT Master directory preserves its input", () => {
  const root = mkdtempSync(join(tmpdir(), "ppt-master-in-place-"));
  try {
    for (const directory of ["scripts", "workflows"]) mkdirSync(join(root, directory));
    for (const file of ["SKILL.md", "scripts/attribution_guard.py", "workflows/routing.md", "sentinel"])
      writeFileSync(join(root, file), "preserved");
    execFileSync(process.execPath, [fileURLToPath(new URL("../../../scripts/prepare-ppt-master.mjs", import.meta.url)), "--output", root], {
      env: { ...process.env, DECKWISE_PPT_MASTER_SKILL_ROOT: root }, stdio: "pipe",
    });
    assert.equal(readFileSync(join(root, "sentinel"), "utf8"), "preserved");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { builtinSkills, loadBuiltinSkillBody } = await import("../electron/main/builtin-skills.ts");
const { resolveCoursewareRoute } = await import("@pi-desktop/agent-runtime");
const promptSource = readFileSync(new URL("../electron/main/ipc/agent-ipc.ts", import.meta.url), "utf8");
const promptModule = {};
new Function("require", "exports", ts.transpileModule(`${promptSource}\nexports.prompt = deckWiseModelPrompt;`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText)((id) => {
  if (id === "../builtin-skills") return { loadBuiltinSkillBody };
  if (id === "@pi-desktop/agent-runtime") return { resolveCoursewareRoute };
  return {};
}, promptModule);

test("loading the ordinary generation skill includes the current official planning references", () => {
  const root = mkdtempSync(join(tmpdir(), "ppt-master-skill-"));
  const previous = process.env.DECKWISE_PPT_MASTER_SKILL_ROOT;
  try {
    for (const directory of ["scripts", "workflows", "templates"]) mkdirSync(join(root, directory));
    writeFileSync(join(root, "SKILL.md"), "---\nname: ppt-master\ndescription: Fixture\n---\nOfficial entry\n");
    writeFileSync(join(root, "scripts/attribution_guard.py"), "");
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
    writeFileSync(join(root, "workflows/generate-pptx.md"), "Official default SVG workflow v2");
    assert(loadBuiltinSkillBody("deckwise/ppt-master").body.includes("Official default SVG workflow v2"));
    rmSync(join(root, "templates/design_spec_reference.md"));
    assert.equal(loadBuiltinSkillBody("deckwise/ppt-master"), null);
    assert(!builtinSkills({ workspacePath: root }).some((item) => item.id === "deckwise/ppt-master"));
  } finally {
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
