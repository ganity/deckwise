import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../src/lib/ppt-master-project.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(`${source}\nexports.inspectProject = inspectProject; exports.phaseLabel = phaseLabel;`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const entry = (name, mtimeMs = 10) => ({ name, kind: "file", mtimeMs });

function fixture() {
  const directories = {
    project: [entry("presentation-plan.json"), entry("animations.json"), entry("design_spec.md"), entry("spec_lock.md")],
    "project/svg_output": [entry("P01.svg")],
    "project/svg_final": [],
    "project/exports": [entry("lesson.pptx", 30)],
    "project/notes": [entry("total.md")],
    "project/validation": [entry("svg_quality_report.json", 20)],
  };
  let report = { stage: "final", summary: { errors: 0 } };
  const exports = {};
  new Function("require", "exports", compiled)((id) => {
    if (id === "./api") return { api: {
      fsList: async (path) => ({ entries: directories[path] ?? [] }),
      fsRead: async (path) => {
        assert.equal(path, "project/validation/svg_quality_report.json");
        return { kind: "text", content: JSON.stringify(report) };
      },
    } };
    // No component is mounted: only the real filesystem inspection is invoked.
    return {};
  }, exports);
  return { directories, inspect: () => exports.inspectProject("project"), referencedProject: exports.referencedProject,
    phase: exports.phaseLabel, setReport: (value) => { report = value; } };
}

test("a persisted source owns the SVG project after chat history is compacted or contains another project", () => {
  const f = fixture();
  assert.equal(f.referencedProject([], "/workspace/.deckwise-ppt/projects/family/exports/family.pptx"), ".deckwise-ppt/projects/family");
  assert.equal(f.referencedProject([{ content: ".deckwise-ppt/projects/other/P01.svg" }], "/workspace/.deckwise-ppt/projects/family/exports/family.pptx"), ".deckwise-ppt/projects/family");
  assert.equal(f.referencedProject([{ content: ".deckwise-ppt/projects/other/P01.svg" }]), ".deckwise-ppt/projects/other");
});

test("a current final report accepts the saved pages, planning and narration", async () => {
  const f = fixture();
  const result = await f.inspect();
  assert.equal(result.qualityIssue, null);
  assert.equal(result.needsPptxRegeneration, false);
  assert.equal(f.phase(false, result, 1), "课件已生成");
});

for (const [directory, name] of [
  ["project", "design_spec.md"], ["project", "spec_lock.md"],
  ["project", "presentation-plan.json"],
  ["project", "animations.json"],
  ["project/notes", "total.md"], ["project/svg_output", "P01.svg"],
]) {
  test(`changing ${name} invalidates both the report and the exported PPTX`, async () => {
    const f = fixture();
    f.directories[directory].find((file) => file.name === name).mtimeMs = 40;
    const result = await f.inspect();
    assert.match(result.qualityIssue, /重新完成质量检查/);
    assert.equal(result.needsPptxRegeneration, true);
    assert.equal(f.phase(false, result, 1), "页面待修复");
    f.directories["project/validation"][0].mtimeMs = 50;
    assert.equal((await f.inspect()).qualityIssue, null);
    assert.equal((await f.inspect()).needsPptxRegeneration, true);
  });
}

test("missing planning or narration cannot reuse an older passing report", async () => {
  for (const directory of ["project", "project/notes"]) {
    const f = fixture();
    f.directories[directory].pop();
    assert.notEqual((await f.inspect()).qualityIssue, null);
  }
});

test("failed final validation retains bounded repair diagnostics", async () => {
  const f = fixture();
  f.setReport({ stage: "final", summary: { errors: 1 }, categories: {
    blocking: { issues: Array.from({ length: 15 }, () => ({ file: "P01.svg", message: "x".repeat(500) })) },
  } });
  const result = await f.inspect();
  assert.match(result.qualityIssue, /1 项错误/);
  assert.equal(result.qualityFindings.length, 12);
  assert(result.qualityFindings.every((message) => message.length <= 240));
  assert.equal(f.phase(false, result, 1), "页面待修复");
});

test("a preliminary or unreadable report cannot enable export", async () => {
  for (const report of [{ stage: "early", summary: { errors: 0 } }, null]) {
    const f = fixture();
    f.setReport(report);
    assert.notEqual((await f.inspect()).qualityIssue, null);
  }
});
