import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseSkillFrontmatter } from "@pi-desktop/plugin-sdk";
import type { PluginSkillDef } from "@pi-desktop/agent-runtime";
import { resolveBundledPython } from "./python-runtime";

/**
 * Skills PI-Desktop ships itself.
 *
 * These ride the same catalog-plus-`Skill`-tool path as plugin-contributed
 * skills (D174), so a first-party skill and a third-party one are
 * indistinguishable to the model — but they need no permission grant, because
 * the host is not a plugin.
 */

/** Bundled skill teaching the plugin-development loop. */
export const PLUGIN_DEV_SKILL_FILE = "plugin-development.md";
export const PLUGIN_DEV_SKILL_ID = "pi-desktop/plugin-development";

/** DeckWise's PPT generation workflow is a host-owned skill, not a worker. */
export const PPT_MASTER_SKILL_ID = "deckwise/ppt-master";
const PPT_MASTER_SKILL_NAME = "课件生成";
const PPT_MASTER_SKILL_DESCRIPTION =
  "Generate ordinary editable PowerPoint/PPTX courseware from a topic or source materials, before Office editing.";
const PPT_MASTER_REQUIRED_FILES = [
  "SKILL.md",
  "scripts/attribution_guard.py",
  "workflows/routing.md",
] as const;

/** electron-builder copies `resources/skills` to `<resources>/skills`. */
function resolveBuiltinSkillPath(fileName: string): string | null {
  const moduleDir = typeof __dirname === "string" ? __dirname : import.meta.dirname;
  const candidates = [
    join(process.resourcesPath || "", "skills", fileName),
    join(moduleDir, "../../resources/skills", fileName),
    join(moduleDir, "../../../resources/skills", fileName),
  ];
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Resolve the complete PPT Master distribution. The skill body is only the
 * entry point; its scripts, workflows and templates must remain beside it so
 * the model can execute the documented `${SKILL_DIR}` commands.
 *
 * `DECKWISE_PPT_MASTER_SKILL_ROOT` is intentional: development and packaged
 * builds can point at the same official, unmodified distribution without
 * teaching the agent a machine-specific checkout path.
 */
export function resolvePptMasterSkillRoot(): string | null {
  const configured = process.env.DECKWISE_PPT_MASTER_SKILL_ROOT?.trim();
  // The Electron bundle provides __dirname; source-level contract tests run as
  // ESM and do not. The environment and cwd candidates still cover both.
  const moduleDir = typeof __dirname === "string" ? __dirname : process.cwd();
  const candidates = [
    configured,
    join(process.resourcesPath || "", "skills", "ppt-master"),
    join(moduleDir, "../../resources/skills/ppt-master"),
    join(moduleDir, "../../../resources/skills/ppt-master"),
    join(process.cwd(), "dist/ppt-master"),
    join(moduleDir, "../../dist/ppt-master"),
    join(process.cwd(), "../ppt-gen/vendors/ppt-master/skills/ppt-master"),
    join(process.cwd(), "../../../ppt-gen/vendors/ppt-master/skills/ppt-master"),
    join(moduleDir, "../../../../../ppt-gen/vendors/ppt-master/skills/ppt-master"),
  ].filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of candidates) {
    if (PPT_MASTER_REQUIRED_FILES.every((file) => existsSync(join(candidate, file)))) {
      return candidate;
    }
  }
  return null;
}

function readPptMasterSkill(): { root: string; raw: string; planningReference: string } | null {
  const root = resolvePptMasterSkillRoot();
  if (!root) return null;
  try {
    return {
      root,
      // Models can skip routed reads even after receiving the entry point.
      raw: ["SKILL.md", "workflows/routing.md", "workflows/generate-pptx.md"]
        .map((file) => readFileSync(join(root, file), "utf8"))
        .join("\n\n"),
      planningReference: ["design_spec_reference.md", "spec_lock_reference.md"]
        .map((file) => readFileSync(join(root, "templates", file), "utf8"))
        .join("\n\n"),
    };
  } catch {
    return null;
  }
}

function withPptMasterRuntimeContext(body: string, root: string, planningReference: string): string {
  const python = resolveBundledPython();
  return [
    "Host runtime context:",
    `- The absolute PPT Master skill directory is \`${root}\`. Use it as \`${"SKILL_DIR"}\` for every command.`,
    ...(python
      ? [`- The bundled Python executable is \`${python}\`. Use this absolute executable instead of \`python3\` or \`python\` for PPT Master scripts.`]
      : []),
    "- The host has mounted the complete official distribution; do not search for or rewrite its files.",
    "",
    body,
    "",
    "## DeckWise Host Policy",
    "Keep implementation details private in every user-facing response. Never mention Pi, PPT Master, skill ids, Python scripts, SVG services, internal tools, or workspace paths unless the user explicitly asks for technical troubleshooting. Use product language such as courseware assistant, courseware pages, page preview, and courseware editor instead.",
    "Continue through the existing automated PM flow without confirmation pauses until the editable SVG preview is ready. Only ask when required input is genuinely missing.",
    "The ordinary task uses the supplied Default Generate authority after the integrity gate. Author complete page SVGs in svg_output and export them through the official svg_to_pptx.py pipeline. Do not replace that pipeline with python-pptx, PptxGenJS, hand-written OOXML, or a scratch direct-PPTX script. If the official pipeline fails, repair that project or report it incomplete; an independently generated PPTX is not a completed ordinary task.",
    "Default Generate uses machine-readable planning files. Before authoring SVG, read templates/design_spec_reference.md and templates/spec_lock_reference.md from SKILL_DIR, write their required sections with exact English headings and keys (including design_spec.md `## IX. Content Outline` and spec_lock.md `## canvas`, `## communication`, and `## typography`), and run the official project validation. Do not translate schema headings into Chinese or replace the reference format with a summary.",
    "For generation and repairs, do not claim completion until both official checks exit 0: project_manager.py validate <project_path> for the complete planning schema and the final SVG quality checker with zero blocking errors. Re-run project validation after every planning repair; saved files alone do not establish schema validity. Run the SVG checker with --canonical-authoring --stage final --json after the last page, planning or narration edit to update validation/svg_quality_report.json. notes/total.md must cover every page when Speaker Notes is enabled. Repair failed gates before finishing; if repair fails, report the preview as incomplete. Open the actual preview in DeckWise's in-app Browser before reporting success. Chat text alone is not a saved speaker-note artifact.",
    "Before asking, inspect the user's prompt and attached documents. Never ask for information already stated or reasonably inferable from those materials.",
    "## DeckWise Document Parsing Override (mandatory)",
    "DeckWise has already uploaded and parsed every attached PDF, DOC/DOCX, PPT/PPTX, and injected the returned text under `### 资料`. Treat that text as the only source of truth. Never list or read the original binary attachment from `PI_SCRATCH_DIR`, `pasted/`, or any local path, and never run `source_to_md.py`, LibreOffice, antiword, catdoc, python-docx, or another local document converter for those attachments. Continue using the parsed `### 资料` content and the normal PPTX workflow.",
    "For initial generation, clarification is limited to at most three rounds. One `asktool` call is one clarification round and may group several tightly related missing items. After each round, reassess whether the request is sufficient and start immediately once it is; never ask extra questions merely to use the remaining rounds.",
    "Treat a discernible teaching topic or source scope as the main blocker. Grade and subject should be clarified when they materially affect the content and cannot be inferred. Page count, visual style, color palette, lesson structure, and narration detail are optional preferences: infer sensible defaults rather than blocking generation unless the materials conflict or the user explicitly asks to choose them.",
    "Keep every clarification round compact, with short questions and a small set of useful options plus the custom-answer path provided by `asktool`. If critical information is still missing after the third round, proceed with conservative assumptions and state them briefly; stop only when there is no usable topic or source content at all.",
    "Start the SVG preview using the bundled Python executable and `${SKILL_DIR}/scripts/svg_editor/server.py <project_path> --live --daemon --no-browser`. Read the actual URL from its output or live_preview/lock.json, and verify /api/health before opening it in DeckWise. svg_authoring_view.py creates an authoring IR bundle; it is not the preview server.",
    "For generated illustrations, use the official image generation script and its host-provided image backend configuration. Do not ask the user for an image API key or substitute an unrelated image service.",
    "## DeckWise Fixed-identity Reference Policy (mandatory)",
    "When the user asks to reuse the identity of characters, spacecraft, vehicles, or objects from uploaded design/model sheets, treat those sheets as reference-only inputs before planning, in both Default and Quick generation. Do not place or crop the original sheet into a slide unless the user explicitly asks to display the original. Ordinary supplied photos, screenshots, and diagrams retain their existing direct-use behavior.",
    "Plan each affected illustration as a new AI-generated output with a distinct filename. Pass the relevant original image paths through the image manifest's `reference_images` to the configured Seedream backend; merely mentioning filenames in a text prompt is not image-to-image generation. Map each reference to its subject, preserve identity-defining face, hair, clothing, proportions, colors, and spacecraft silhouette/markings, and describe the slide-specific pose, action, expression, camera, setting, and composition. Generate a single scene rather than reproducing the reference sheet's multiple views, pose grid, labels, or captions. Do not combine unrelated references in every image.",
    "Only use the newly generated output in SVG and PPTX. Visually inspect it for identity and scene fit before preview; reject copied model sheets or contact sheets. If generation fails or no reference-capable backend is available, report the affected illustration as incomplete; never substitute the original sheet or an unrelated character to claim completion.",
    "After the live preview server starts, call ToolSearch for `browser`, then call Browser with `action=navigate` and the exact loopback preview URL printed by PPT Master. Do not merely print the URL; opening the in-app Browser is part of the workflow.",
    "On the initial generation turn, stop after the editable SVG preview is ready and opened. Do not finalize or export PPTX until the user explicitly requests PPTX generation. A user request from DeckWise's `Generate PPTX` action is explicit authorization to continue the official finalization, validation, and SVG-to-PPTX export steps without another confirmation.",
    "This workflow owns generation candidates. Once Office editing starts, load deckwise/ppt-edit and use the latest PPTX and DeckWise teaching. Never supersede Office edits with an older SVG export. Unsupported native edits require a clean-copy candidate and Host review; report unavailable when that workflow is not installed.",
    "",
    "## DeckWise Workspace Boundary",
    "All generated project files and final PPTX artifacts must stay under the current DeckWise workspace. Before `project_manager.py init`, derive an absolute project base under the workspace (for example `WORKSPACE_ROOT=\"$(pwd -P)\"; PROJECTS_DIR=\"$WORKSPACE_ROOT/.deckwise-ppt/projects\"`) and pass it explicitly with `--dir \"$PROJECTS_DIR\"`. Never omit `--dir`, never use the Skill package's default `projects/` directory, and never write generated artifacts under `SKILL_DIR`.",
    "",
    "## Required planning reference (loaded from the official distribution)",
    "Apply these contracts after the integrity gate. They define the exact planning format for initial generation and repairs; preserve confirmed teaching content when repairing an existing project.",
    planningReference,
  ].join("\n");
}

/**
 * True when this workspace looks like plugin development: a plugin manifest at
 * the root, or a plugin already loaded from inside it.
 *
 * The gate matters. A plugin-authoring primer in every session would burn
 * context for the vast majority of sessions that never write a plugin; the
 * three plugin tools stay registered regardless, and calling one puts a
 * manifest in the workspace, which activates the skill on the next prompt.
 */
export function isPluginWorkspace(
  workspacePath: string | null | undefined,
  pluginPaths: string[] = [],
): boolean {
  if (!workspacePath) return false;
  const manifestPath = join(workspacePath, "manifest.json");
  if (existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (
        manifest &&
        typeof manifest === "object" &&
        typeof manifest.schemaVersion === "number" &&
        typeof manifest.main === "string"
      ) {
        return true;
      }
    } catch {
      // An unparseable manifest is not evidence either way.
    }
  }
  const prefix = workspacePath.endsWith("/") ? workspacePath : `${workspacePath}/`;
  return pluginPaths.some((path) => path === workspacePath || path.startsWith(prefix));
}

/** Front matter carries the skill's title and applicability line. */
function readBuiltinSkill(fileName: string): string | null {
  const path = resolveBuiltinSkillPath(fileName);
  if (!path) return null;
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

export type BuiltinSkillInput = {
  workspacePath?: string | null;
  /** Directories of currently loaded plugins, used to detect a dev workspace. */
  pluginPaths?: string[];
};

/**
 * Catalog entries for the built-in skills that apply to the given session, read
 * fresh so a packaged update takes effect without a restart.
 */
export function builtinSkills(input: BuiltinSkillInput): PluginSkillDef[] {
  const skills: PluginSkillDef[] = [];
  for (const name of ["ppt-edit", "ppt-import", "scene-courseware"] as const) {
    const raw = readBuiltinSkill(`${name}/SKILL.md`);
    if (!raw) continue;
    const parsed = parseSkillFrontmatter(raw);
    if (parsed.body) skills.push({ id: `deckwise/${name}`, name: parsed.name ?? name, description: parsed.description });
  }
  const pptMaster = readPptMasterSkill();
  if (pptMaster) {
    const parsed = parseSkillFrontmatter(pptMaster.raw);
    if (parsed.body) {
      skills.push({
        id: PPT_MASTER_SKILL_ID,
        name: PPT_MASTER_SKILL_NAME,
        description: PPT_MASTER_SKILL_DESCRIPTION,
      });
    }
  }
  if (!isPluginWorkspace(input.workspacePath, input.pluginPaths)) return skills;
  const raw = readBuiltinSkill(PLUGIN_DEV_SKILL_FILE);
  if (!raw?.trim()) return skills;
  const parsed = parseSkillFrontmatter(raw);
  if (!parsed.body) return skills;
  return [
    ...skills,
    {
      id: PLUGIN_DEV_SKILL_ID,
      name: parsed.name ?? "DeckWise plugin development",
      description: parsed.description,
    },
  ];
}

/**
 * Load a built-in skill body for the `Skill` tool. Returns null for any id the
 * host does not ship, which is the caller's cue to try the plugin registry.
 */
export function loadBuiltinSkillBody(
  id: string,
): { id: string; name: string; body: string } | null {
  if (id === PPT_MASTER_SKILL_ID) {
    const skill = readPptMasterSkill();
    if (!skill) return null;
    const parsed = parseSkillFrontmatter(skill.raw);
    if (!parsed.body) return null;
    return {
      id: PPT_MASTER_SKILL_ID,
      name: PPT_MASTER_SKILL_NAME,
      body: withPptMasterRuntimeContext(parsed.body, skill.root, skill.planningReference),
    };
  }
  if (["deckwise/ppt-edit", "deckwise/ppt-import", "deckwise/scene-courseware"].includes(id)) {
    const name = id.slice("deckwise/".length);
    const raw = readBuiltinSkill(`${name}/SKILL.md`);
    if (!raw) return null;
    const parsed = parseSkillFrontmatter(raw);
    return parsed.body ? { id, name: parsed.name ?? name, body: parsed.body } : null;
  }
  if (id !== PLUGIN_DEV_SKILL_ID) return null;
  const raw = readBuiltinSkill(PLUGIN_DEV_SKILL_FILE);
  if (!raw?.trim()) return null;
  const parsed = parseSkillFrontmatter(raw);
  if (!parsed.body) return null;
  return {
    id: PLUGIN_DEV_SKILL_ID,
    name: parsed.name ?? "DeckWise plugin development",
    body: parsed.body,
  };
}
