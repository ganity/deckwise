import { constants, promises as fs } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { coursewarePresentationIssues, isCoursewarePresentationPages } from "@pi-desktop/shared";
import { canonicalJson, parseMaicClassroom } from "@pi-desktop/courseware-runtime/node";
import { coursewareAuthoringUrl } from "./courseware-runtime";
import { resolveRealPathForCreateWithinRoot } from "./fs-panel";

/** Draft artifacts only: the existing export gate and Host adoption still own the PPTX. */
export async function preparePresentation(input: {
  workspace: string; args: Record<string, unknown>; bodyPageLimit?: number; check(): void;
}) {
  const { args, check } = input;
  if (Object.keys(args).some(key => !["projectPath", "pages", "canvas"].includes(key)) ||
      typeof args.projectPath !== "string" || !isCoursewarePresentationPages(args.pages))
    throw new Error(`Invalid presentation preparation plan: ${coursewarePresentationIssues(args.pages).join("; ") || "expected projectPath, pages and canvas only"}. Repair these fields without replacing an interactive page with a Quiz.`);
  const canvas = args.canvas as { width?: unknown; height?: unknown } | null;
  if (!canvas || typeof canvas !== "object" || Array.isArray(canvas) || Object.keys(canvas).sort().join(",") !== "height,width" ||
      ![canvas.width, canvas.height].every(value => typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 4096))
    throw new Error("Invalid presentation canvas");
  const size = { width: Number(canvas.width), height: Number(canvas.height) };
  const root = await fs.realpath(input.workspace); check();
  const projectRelative = relative(root, resolve(root, args.projectPath));
  const project = await resolveRealPathForCreateWithinRoot(root, projectRelative); check();
  if (!project || project !== resolve(root, args.projectPath) ||
      dirname(project) !== join(root, ".deckwise-ppt/projects"))
    throw new Error("Expected one project under the current workspace .deckwise-ppt/projects");
  const stat = await fs.stat(project); check();
  if (!stat.isDirectory()) throw new Error("Initialize the official presentation project first");
  const pages = args.pages;
  if (pages.filter(page => !page.quiz && !page.teaching.question).length > (input.bodyPageLimit ?? 100))
    throw new Error("Presentation exceeds the saved body-page limit");
  const authoringUrl = coursewareAuthoringUrl();
  if (!authoringUrl) throw new Error("Installed assessment compiler is unavailable");
  const authoring = await import(/* @vite-ignore */ authoringUrl) as typeof import("@pi-desktop/courseware-runtime/authoring"); check();
  const files = pages.map(page => ({ pageNumber: page.pageNumber,
    path: `svg_output/${String(page.pageNumber).padStart(2, "0")}.svg`,
    generated: !!(page.quiz || page.teaching.question) }));
  const output: Array<{ path: string; content: string }> = [];
  for (const [index, page] of pages.entries()) {
    if (!files[index].generated) continue;
    const id = `assessment-${page.pageNumber}`, question = page.teaching.question;
    const prompt = page.quiz?.questions[0]?.question ?? question!.text;
    const english = /[a-z]/iu.test(prompt) && !/[\u4e00-\u9fff]/u.test(prompt);
    // Objectives can contain the correct answer; only neutral labels belong on learner pages.
    const title = page.quiz ? (english ? "Quiz" : "课堂练习") : (english ? "Let us talk" : "说一说");
    const scene = parseMaicClassroom({ id: "preview", stage: { id: "preview", name: "Preview", createdAt: 0, updatedAt: 0 },
      createdAt: new Date(0).toISOString(), scenes: [{ id, stageId: "preview", title,
        type: page.quiz ? "quiz" : "slide", order: index,
        content: page.quiz ?? { type: "slide", canvas: authoring.createMaicInteractionCanvas(id, title, question!.text, size.width, size.height / size.width) },
        actions: question ? [{ id: `${id}-checkpoint`, type: "interaction_checkpoint", checkpointId: `${id}-checkpoint`,
          checkpointKind: "chapter_summary", chapterId: id, chapterTitle: page.teaching.objective, question: question.text,
          referenceAnswer: question.referenceAnswer ?? { summary: page.teaching.objective, keyPoints: [] },
          ...(question.constraintPrompt ? { constraintPrompt: question.constraintPrompt } : {}),
          context: { chapterSummary: page.teaching.objective, sourceSceneIds: [id] } }] : [] }] }).scenes[0];
    output.push({ path: files[index].path, content: authoring.assessmentSvg(scene, size) });
  }
  const planPath = "presentation-plan.json";
  output.push({ path: planPath, content: canonicalJson({ version: 1, canvas: size, pages, files }) + "\n" });
  const targets: Array<{ path: string; content: string; exists: boolean }> = [];
  // Validate every existing artifact before writing any; never overwrite authored or Office content.
  for (const file of output) {
    const path = await resolveRealPathForCreateWithinRoot(root, join(projectRelative, file.path)); check();
    if (path !== join(project, file.path)) throw new Error("Presentation artifact escaped its project");
    let exists = false;
    try {
      const handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.size > 2 * 1024 * 1024 || await handle.readFile("utf8") !== file.content)
          throw new Error(`Presentation draft conflict; preserve the existing file: ${file.path}`);
        exists = true;
      } finally { await handle.close(); }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    check(); targets.push({ path, content: file.content, exists });
  }
  for (const file of targets) {
    if (file.exists) continue;
    await fs.mkdir(dirname(file.path), { recursive: true }); check();
    if (await resolveRealPathForCreateWithinRoot(root, relative(root, file.path)) !== file.path) throw new Error("Presentation artifact path changed");
    check(); await fs.writeFile(file.path, file.content, { flag: "wx" }); check();
  }
  const typographySizesPx = [...new Set(output.filter(file => file.path.endsWith(".svg")).flatMap(file =>
    [...file.content.matchAll(/font-size="([\d.]+)"/gu)].map(match => Number(match[1]))))].sort((a, b) => a - b);
  return { prepared: true, planPath: join(args.projectPath, planPath), files, typographySizesPx,
    instruction: "Author only generated:false body SVGs at these exact paths. Keep generated assessment pages unchanged; use the saved pages for adoption. Declare the returned fixed-template typography sizes as named assessment roles in design_spec.md and spec_lock.md, with Noto Sans SC as their family. Run official project/final SVG validation, open preview, and wait for explicit PPTX export authorization. No media was generated." };
}
