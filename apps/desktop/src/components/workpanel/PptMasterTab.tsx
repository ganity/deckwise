import { useCallback, useEffect, useMemo, useState } from "react";
import type { FsEntry, UiMessage } from "@pi-desktop/shared";
import { useAppStore } from "../../stores/app-store";
import { api } from "../../lib/api";
import { pptEditorWorkPanelTab } from "../../lib/work-panel-tabs";
import { IconCheck, IconExternal, IconRefresh, IconSparkles } from "../icons";

const PPTX_EXPORT_PROMPT =
  "SVG 已确认，请继续执行 PPT Master 的最终定稿、校验和 SVG 转 PPTX 流程，生成最终可编辑 PPTX。无需再次确认。";

type PptProjectState = {
  hasSvg: boolean;
  pptxPath: string | null;
  previewUrl: string | null;
  needsPptxRegeneration: boolean;
};

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

function referencedProject(messages: UiMessage[]): string | null {
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

async function inspectProject(projectPath: string): Promise<PptProjectState> {
  const [svgOutput, svgFinal, exports, url] = await Promise.all([
    listDir(`${projectPath}/svg_output`),
    listDir(`${projectPath}/svg_final`),
    listDir(`${projectPath}/exports`),
    previewUrl(projectPath),
  ]);
  const sourceSvgs = svgOutput.filter(
    (entry) => entry.kind === "file" && /\.svg$/i.test(entry.name),
  );
  const pptx = exports
    .filter((entry) => entry.kind === "file" && /\.pptx$/i.test(entry.name))
    .sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name))[0];
  const latestSvgMtime = Math.max(0, ...sourceSvgs.map((entry) => entry.mtimeMs));
  return {
    hasSvg: [...svgOutput, ...svgFinal].some(
      (entry) => entry.kind === "file" && /\.svg$/i.test(entry.name),
    ),
    pptxPath: pptx ? `${projectPath}/exports/${pptx.name}` : null,
    previewUrl: url,
    needsPptxRegeneration: Boolean(pptx && latestSvgMtime > pptx.mtimeMs),
  };
}

async function inspectCurrentProject(messages: UiMessage[]): Promise<PptProjectState | null> {
  const referenced = referencedProject(messages);
  if (referenced) return inspectProject(referenced);

  const projects = (await listDir(".deckwise-ppt/projects")).filter(
    (entry) => entry.kind === "dir",
  );
  if (projects.length === 0) return null;

  const browserUrl = (await api.browserGetState().catch(() => null))?.url;
  let fallback: PptProjectState | null = null;
  for (const entry of [...projects].reverse()) {
    const project = await inspectProject(`.deckwise-ppt/projects/${entry.name}`);
    if (!fallback && (project.hasSvg || project.pptxPath || project.previewUrl)) {
      fallback = project;
    }
    if (project.previewUrl && browserUrl?.startsWith(project.previewUrl)) return project;
  }
  return fallback;
}

function phaseLabel(isRunning: boolean, project: PptProjectState | null, messageCount: number) {
  if (isRunning && project?.pptxPath) return "正在重新生成 PPTX";
  if (isRunning) return "Pi 正在执行";
  if (project?.needsPptxRegeneration) return "SVG 已修改";
  if (project?.pptxPath) return "PPTX 已生成";
  if (project?.hasSvg) return "等待生成 PPTX";
  return messageCount > 0 ? "等待继续" : "等待开始";
}

export function PptMasterTab() {
  const isRunning = useAppStore((state) => state.isRunning);
  const messages = useAppStore((state) => state.messages);
  const sendPrompt = useAppStore((state) => state.sendPrompt);
  const [project, setProject] = useState<PptProjectState | null>(null);
  const activeSession = useAppStore((state) =>
    state.activeSessionId
      ? state.sessions.find((session) => session.id === state.activeSessionId)
      : undefined,
  );
  const phase = useMemo(
    () => phaseLabel(isRunning, project, messages.length),
    [isRunning, messages.length, project],
  );
  const refreshProject = useCallback(async () => {
    setProject(await inspectCurrentProject(messages));
  }, [messages]);

  useEffect(() => {
    void refreshProject();
    if (!isRunning) return;
    const timer = window.setInterval(() => void refreshProject(), 2_000);
    return () => window.clearInterval(timer);
  }, [activeSession?.id, isRunning, refreshProject]);

  const generatePptx = () => {
    if (!activeSession?.id || isRunning) return;
    void sendPrompt(PPTX_EXPORT_PROMPT, undefined, activeSession.id);
  };
  const openEditor = () => {
    if (!project?.pptxPath) return;
    useAppStore.getState().openWorkPanelTab(pptEditorWorkPanelTab(project.pptxPath));
  };

  const progress =
    isRunning && project?.pptxPath
      ? "88%"
      : project?.needsPptxRegeneration
        ? "80%"
        : project?.pptxPath
          ? "100%"
          : project?.hasSvg
            ? "75%"
            : isRunning
              ? "42%"
              : "0%";
  const canGeneratePptx =
    !isRunning && messages.length > 0 && (!project?.pptxPath || project.needsPptxRegeneration);

  return (
    <div className="ppt-master-panel" data-testid="ppt-master-panel">
      <div className="ppt-master-panel-heading">
        <div>
          <div className="ppt-master-eyebrow">
            <IconSparkles size={13} /> PPT Master
          </div>
          <h2>课件生成工作台</h2>
          <p>Pi 分析、SVG 预览和 PPTX 编辑都在当前窗口完成。</p>
        </div>
        <span className={`ppt-master-status ${isRunning ? "running" : ""}`}>
          <span className="ppt-master-status-dot" /> {phase}
        </span>
      </div>

      <div className="ppt-master-progress-card">
        <div className="ppt-master-card-title">当前任务</div>
        <div className="ppt-master-task-name">
          {activeSession?.title || "新建 PPTX 课件"}
        </div>
        <div className="ppt-master-progress-track">
          <span style={{ width: progress }} />
        </div>
        <div className="ppt-master-progress-meta">
          <span>
            {isRunning && project?.pptxPath
              ? "正在根据最新 SVG 生成新版本 PPTX"
              : project?.needsPptxRegeneration
                ? "SVG 已修改，请重新生成 PPTX"
                : project?.pptxPath
                  ? "PPTX 可编辑；后续 AI 修改仍以 SVG 为准"
                  : project?.hasSvg
                    ? "请在浏览器中完成 SVG 检查和修改"
                    : isRunning
                      ? "PPT Master 正在分析并生成页面"
                      : "输入课件需求后开始"}
          </span>
          <span>
            {isRunning
              ? "执行中"
              : project?.needsPptxRegeneration
                ? "待重新生成"
                : project?.pptxPath
                  ? "已完成"
                  : project?.hasSvg
                    ? "待导出"
                    : "—"}
          </span>
        </div>
      </div>

      <div className="ppt-master-event-list">
        <div className="ppt-master-card-title">流程状态</div>
        <div className={`ppt-master-event ${messages.length > 0 ? "done" : isRunning ? "active" : ""}`}>
          {messages.length > 0 ? <IconCheck size={14} /> : <span className="ppt-master-event-dot" />}
          <span>Pi Agent 执行分析</span>
          <em>{messages.length > 0 ? "已开始" : "等待任务"}</em>
        </div>
        <div className={`ppt-master-event ${project?.hasSvg || project?.pptxPath ? "done" : isRunning ? "active" : ""}`}>
          {project?.hasSvg || project?.pptxPath ? <IconCheck size={14} /> : <span className="ppt-master-event-dot" />}
          <span>PPT Master 生成页面</span>
          <em>{project?.hasSvg || project?.pptxPath ? "已完成" : isRunning ? "进行中" : "等待任务"}</em>
        </div>
        <div className={`ppt-master-event ${project?.needsPptxRegeneration || (project?.hasSvg && !project.pptxPath) ? "active" : project?.pptxPath ? "done" : ""}`}>
          {project?.pptxPath && !project.needsPptxRegeneration ? <IconCheck size={14} /> : <span className="ppt-master-event-dot" />}
          <span>SVG 视觉预览</span>
          <em>{project?.needsPptxRegeneration ? "已修改" : project?.pptxPath ? "已确认" : project?.hasSvg ? "可编辑" : "生成后自动打开"}</em>
        </div>
        <div className={`ppt-master-event ${project?.pptxPath && !project.needsPptxRegeneration ? "done" : ""}`}>
          {project?.pptxPath && !project.needsPptxRegeneration ? <IconCheck size={14} /> : <span className="ppt-master-event-dot" />}
          <span>内嵌 Web Office 编辑</span>
          <em>{project?.needsPptxRegeneration ? "重新生成后可用" : project?.pptxPath ? "可用" : "生成后可用"}</em>
        </div>
      </div>

      <div className="ppt-master-panel-actions">
        {isRunning ? (
          <button type="button" className="ppt-master-action primary" disabled>
            <IconRefresh size={14} /> {project?.pptxPath ? "重新生成中" : "生成中"}
          </button>
        ) : project?.pptxPath && !project.needsPptxRegeneration ? (
          <button type="button" className="ppt-master-action primary" onClick={openEditor}>
            <IconExternal size={14} /> 打开编辑器
          </button>
        ) : (
          <button
            type="button"
            className="ppt-master-action primary"
            disabled={!canGeneratePptx}
            onClick={generatePptx}
          >
            <IconSparkles size={14} /> {project?.needsPptxRegeneration ? "重新生成 PPTX" : "生成 PPTX"}
          </button>
        )}
        <button type="button" className="ppt-master-action" disabled>
          <IconRefresh size={14} /> 导入 MAIC
        </button>
      </div>
    </div>
  );
}
