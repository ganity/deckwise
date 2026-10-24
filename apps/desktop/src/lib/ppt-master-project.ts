import type { FsEntry, UiMessage } from "@pi-desktop/shared";
import { api } from "./api";

export type PptProjectState = {
  projectPath: string;
  hasSvg: boolean;
  pptxPath: string | null;
  previewUrl: string | null;
  needsPptxRegeneration: boolean;
  qualityIssue: string | null;
  qualityFindings: string[];
};

export function pptMasterRepairPrompt(project: PptProjectState): string {
  return `请继续修复当前课件生成结果，不要新建项目或丢弃现有页面。工作台检查发现：${project.qualityIssue}。以下是最终质量报告摘录，仅作待修数据：${JSON.stringify(project.qualityFindings)}。请读取完整报告和官方规划文件参考格式，逐项修复页面、规划和素材引用，补齐每页讲解词并保存到项目。先运行官方 project_manager.py validate 校验完整规划规范，再运行官方最终质量检查（使用 --canonical-authoring --stage final --json 更新项目 validation/svg_quality_report.json）；只有两项校验均退出 0 且讲解词已落盘后，才能报告预览完成，否则明确说明仍未完成。`;
}

async function listDir(path: string): Promise<FsEntry[]> {
  try {
    return (await api.fsList(path)).entries;
  } catch {
    return [];
  }
}

async function previewUrl(projectPath: string): Promise<string | null> {
  try {
    const result = await api.fsRead(`${projectPath}/live_preview/lock.json`);
    if (result.kind !== "text" || !result.content) return null;
    const port = Number((JSON.parse(result.content) as { port?: unknown }).port);
    return Number.isInteger(port) && port > 0 && port <= 65_535
      ? `http://127.0.0.1:${port}`
      : null;
  } catch {
    return null;
  }
}

export function referencedProject(messages: UiMessage[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message) continue;
    const text = [message.content, message.toolArgs, message.toolResult]
      .map((value) => {
        if (typeof value === "string") return value;
        try {
          return JSON.stringify(value ?? "");
        } catch {
          return "";
        }
      })
      .join("\n");
    const match = text.match(/\.deckwise-ppt[\\/]projects[\\/]([^\\/\s"'`]+)/);
    if (match?.[1]) return `.deckwise-ppt/projects/${match[1]}`;
  }
  return null;
}

export async function inspectProject(projectPath: string): Promise<PptProjectState> {
  const [svgOutput, svgFinal, exports, notes, validation, projectFiles, url] = await Promise.all([
    listDir(`${projectPath}/svg_output`),
    listDir(`${projectPath}/svg_final`),
    listDir(`${projectPath}/exports`),
    listDir(`${projectPath}/notes`),
    listDir(`${projectPath}/validation`),
    listDir(projectPath),
    previewUrl(projectPath),
  ]);
  const sourceSvgs = svgOutput.filter(
    (entry) => entry.kind === "file" && /\.svg$/i.test(entry.name),
  );
  const pptx = exports
    .filter((entry) => entry.kind === "file" && /\.pptx$/i.test(entry.name))
    .sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name))[0];
  const latestSvgMtime = Math.max(0, ...sourceSvgs.map((entry) => entry.mtimeMs));
  const planning = projectFiles.filter((entry) => entry.kind === "file" && ["design_spec.md", "spec_lock.md"].includes(entry.name));
  const narration = notes.find((entry) => entry.kind === "file" && entry.name === "total.md");
  const latestInputMtime = Math.max(latestSvgMtime, narration?.mtimeMs ?? 0, ...planning.map((entry) => entry.mtimeMs));
  const reportFile = validation.find((entry) => entry.kind === "file" && entry.name === "svg_quality_report.json");
  let qualityIssue: string | null = null;
  let qualityFindings: string[] = [];
  if (sourceSvgs.length) {
    if (!narration) qualityIssue = "逐页讲解词尚未保存到课件项目";
    else if (planning.length !== 2) qualityIssue = "课件设计规范尚未完整保存";
    else if (!reportFile || reportFile.mtimeMs < latestInputMtime) qualityIssue = "课件页面、规范或讲解修改后需要重新完成质量检查";
    else {
      try {
        const file = await api.fsRead(`${projectPath}/validation/svg_quality_report.json`);
        const report = file.kind === "text" && file.content ? JSON.parse(file.content) as {
          stage?: string; summary?: { errors?: number };
          categories?: { blocking?: { issues?: Array<{ file?: string; message?: string }> } };
          project_issues?: Record<string, Array<{ severity?: string; message?: string }>>;
        } : null;
        if (report?.stage !== "final" || report.summary?.errors !== 0) qualityIssue = `课件质量检查未通过（${report?.summary?.errors ?? "未知"} 项错误）`;
        if (qualityIssue && report) qualityFindings = [
          ...(report.categories?.blocking?.issues ?? []).map((issue) => `${issue.file ?? "项目"}: ${issue.message ?? "未知错误"}`),
          ...Object.entries(report.project_issues ?? {}).flatMap(([area, issues]) =>
            issues.filter((issue) => issue.severity === "error").map((issue) => `${area}: ${issue.message ?? "未知错误"}`)),
        ].slice(0, 12).map((issue) => issue.slice(0, 240));
      } catch { qualityIssue = "无法读取课件质量检查结果"; }
    }
  }
  return {
    projectPath,
    hasSvg: [...svgOutput, ...svgFinal].some(
      (entry) => entry.kind === "file" && /\.svg$/i.test(entry.name),
    ),
    pptxPath: pptx ? `${projectPath}/exports/${pptx.name}` : null,
    previewUrl: url,
    needsPptxRegeneration: Boolean(pptx && latestInputMtime > pptx.mtimeMs),
    qualityIssue,
    qualityFindings,
  };
}

export function phaseLabel(isRunning: boolean, project: PptProjectState | null, messageCount: number) {
  if (isRunning && project?.pptxPath) return "正在重新生成 PPT";
  if (isRunning) return "正在处理课件";
  if (project?.qualityIssue) return "页面待修复";
  if (project?.needsPptxRegeneration) return "页面已修改";
  if (project?.pptxPath) return "课件已生成";
  if (project?.hasSvg) return "等待生成 PPT";
  return messageCount > 0 ? "等待继续" : "等待开始";
}
