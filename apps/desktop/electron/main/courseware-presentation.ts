import { constants, promises as fs } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { coursewarePresentationIssues, isCoursewarePresentationPages } from "@pi-desktop/shared";
import { canonicalJson } from "@pi-desktop/courseware-runtime/node";
import { readLiveSource, sourceHash } from "./courseware-source-files";
import { publishNativeGeneratedCourse } from "./courseware-native-generation";

type Host = { call<T>(method: string, args: unknown): Promise<T> };
export type PresentationReview = (input: { workspace: string; sessionId: string; path: string; sourceSha256: string;
  pages: import("@pi-desktop/shared").CoursewarePresentationPage[]; check(): void }) => Promise<void>;

/** Official exports publish complete native lessons while retaining the validated original export. */
export async function adoptPresentation(input: {
  host: Host; workspace: string; sessionId: string; args: Record<string, unknown>; check(): void; review?: PresentationReview;
}) {
  const { host, workspace, sessionId, args, check } = input;
  if (Object.keys(args).some(key => !["path", "sourceSha256", "pages", "continueTeaching"].includes(key)) ||
      typeof args.path !== "string" || typeof args.sourceSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(args.sourceSha256) ||
      args.pages !== undefined && !isCoursewarePresentationPages(args.pages) || args.continueTeaching !== undefined && typeof args.continueTeaching !== "boolean")
    throw new Error(`Invalid presentation teaching plan: ${coursewarePresentationIssues(args.pages).join("; ") || "expected path, sourceSha256, pages and optional continueTeaching only"}`);
  let pages = args.pages;
  const path = resolve(workspace, args.path);
  const bytes = await readLiveSource(workspace, path); check();
  if (sourceHash(bytes) !== args.sourceSha256) throw new Error("Exported presentation changed; read the actual source again");
  const planPath = join(dirname(dirname(path)), "presentation-plan.json");
  try {
    const file = await fs.open(planPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw new Error("Invalid saved presentation plan");
      const plan = JSON.parse(await file.readFile("utf8"));
      if (plan.version !== 1 || !isCoursewarePresentationPages(plan.pages) || pages !== undefined && canonicalJson(plan.pages) !== canonicalJson(pages))
        throw new Error("Adoption differs from presentation-plan.json; preserve the saved assessment plan");
      pages = plan.pages;
    } finally { await file.close(); }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (!isCoursewarePresentationPages(pages)) throw new Error("No saved presentation-plan.json; supply the original teaching pages");
  const presentation = { path, sourceSha256: args.sourceSha256, pages };
  check();
  return publishNativeGeneratedCourse({ host, workspace, sessionId,
    title: basename(path, ".pptx"), pptx: bytes,
    pages: pages.map((page, index) => ({ pageId: `page-${index + 1}`, title: page.teaching.objective,
      teaching: page.teaching, ...(page.quiz ? { quiz: page.quiz } : {}) })),
    requirePlaybackTiming: args.continueTeaching !== false,
    presentation, reviewPresentation: async () => {
      if (!input.review) throw new Error("Exported presentation review is unavailable");
      await input.review({ ...presentation, sessionId, workspace, check });
    },
    assertCurrent: async () => {
      check();
      if (sourceHash(await readLiveSource(workspace, path)) !== args.sourceSha256) throw new Error("Presentation source changed before adoption");
      check();
    },
  });
}
