import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { resolveRealOpenablePath, resolveRealPathForCreateWithinRoot } from "./fs-panel";
import { MAX_OFFICE_BYTES, validateOfficeBytes } from "./office-file";

export async function importCoursewarePptx(workspace: string, selectedPath: string): Promise<string> {
  // Keep lexical containment checks on the same canonical spelling as created paths.
  // Windows picker/workspace paths can contain 8.3 aliases or directory junctions.
  const workspaceRoot = await fs.realpath(workspace);
  if (extname(selectedPath).toLowerCase() !== ".pptx") throw new Error("请选择 PPTX 文件");
  const source = await fs.stat(selectedPath);
  if (!source.isFile() || !source.size || source.size > MAX_OFFICE_BYTES) throw new Error("PPTX 文件大小无效");
  const bytes = validateOfficeBytes(await fs.readFile(selectedPath), "pptx");
  const leaf = basename(selectedPath).replace(/[^\p{L}\p{N}._-]+/gu, "_");
  const relative = join(".deckwise-ppt", "imports", `${randomUUID()}-${leaf}`);
  const target = await resolveRealPathForCreateWithinRoot(workspaceRoot, relative);
  if (!target) throw new Error("课件导入目录不在当前工作区");
  await fs.mkdir(dirname(target), { recursive: true });
  if (await resolveRealPathForCreateWithinRoot(workspaceRoot, relative) !== target) throw new Error("课件导入目录已变化");
  await fs.writeFile(target, bytes, { flag: "wx" });
  if (await resolveRealOpenablePath(target, workspaceRoot) !== target) throw new Error("导入后的课件不在当前工作区");
  return target;
}
