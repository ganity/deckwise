import { useCallback, useEffect, useMemo, useState } from "react";
import type { FsEntry, UiMessage } from "@pi-desktop/shared";
import { useAppStore } from "../../stores/app-store";
import { api } from "../../lib/api";
import { browserPluginTab, pptEditorWorkPanelTab } from "../../lib/work-panel-tabs";
import { IconCheck, IconExternal, IconRefresh, IconSparkles } from "../icons";
import {
  CoursewareImportDialog,
  type CoursewareFile,
} from "./CoursewareImportDialog";

const PPTX_EXPORT_PROMPT =
  "页面内容已确认，请完成最终检查并生成可编辑的 PPT 文件，无需再次确认。";

type PptProjectState = {
  projectPath: string;
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

function findFirstLessonPlan(messages: UiMessage[]): CoursewareFile | null {
  for (const message of messages) {
    if (message.role !== "user") continue;
    const attachment = message.attachments?.find(
      (candidate) => candidate.kind === "file" && /\.(pdf|docx?)$/i.test(candidate.name),
    );
    if (attachment) return { name: attachment.name, path: attachment.ref };
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
    projectPath,
    hasSvg: [...svgOutput, ...svgFinal].some(
      (entry) => entry.kind === "file" && /\.svg$/i.test(entry.name),
    ),
    pptxPath: pptx ? `${projectPath}/exports/${pptx.name}` : null,
    previewUrl: url,
    needsPptxRegeneration: Boolean(pptx && latestSvgMtime > pptx.mtimeMs),
  };
}

function phaseLabel(isRunning: boolean, project: PptProjectState | null, messageCount: number) {
  if (isRunning && project?.pptxPath) return "正在重新生成 PPT";
  if (isRunning) return "正在处理课件";
  if (project?.needsPptxRegeneration) return "页面已修改";
  if (project?.pptxPath) return "课件已生成";
  if (project?.hasSvg) return "等待生成 PPT";
  return messageCount > 0 ? "等待继续" : "等待开始";
}

export function PptMasterTab() {
  const isRunning = useAppStore((state) => state.isRunning);
  const messages = useAppStore((state) => state.messages);
  const sendPrompt = useAppStore((state) => state.sendPrompt);
  const [project, setProject] = useState<PptProjectState | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const projectPath = useMemo(() => referencedProject(messages), [messages]);
  const activeSession = useAppStore((state) =>
    state.activeSessionId
      ? state.sessions.find((session) => session.id === state.activeSessionId)
      : undefined,
  );
  const phase = useMemo(
    () => phaseLabel(isRunning, project, messages.length),
    [isRunning, messages.length, project],
  );
  const firstLessonPlan = useMemo(() => findFirstLessonPlan(messages), [messages]);
  const refreshProject = useCallback(async () => {
    if (!projectPath) return;
    setProject(await inspectProject(projectPath));
  }, [projectPath]);

  useEffect(() => {
    setProject((current) =>
      projectPath && current?.projectPath === projectPath ? current : null,
    );
    void refreshProject();
    if (!isRunning) return;
    const timer = window.setInterval(() => void refreshProject(), 2_000);
    return () => window.clearInterval(timer);
  }, [activeSession?.id, isRunning, projectPath, refreshProject]);

  const generatePptx = () => {
    if (!activeSession?.id || isRunning) return;
    void sendPrompt(PPTX_EXPORT_PROMPT, undefined, activeSession.id);
  };
  const openEditor = () => {
    if (!project?.pptxPath) return;
    useAppStore.getState().openWorkPanelTab(pptEditorWorkPanelTab(project.pptxPath));
  };
  const openSvgPreview = async () => {
    if (!project?.projectPath || previewBusy) return;
    setPreviewBusy(true);
    setPreviewError(null);
    try {
      const preview = await api.pptPreviewOpen(project.projectPath);
      useAppStore.getState().openWorkPanelTab(browserPluginTab(preview.url));
      await refreshProject();
    } catch (error) {
      setPreviewError(error instanceof Error ? error.message : "页面预览启动失败");
    } finally {
      setPreviewBusy(false);
    }
  };

  const pageGenerationDone =
    Boolean(project?.hasSvg) && (!isRunning || Boolean(project?.pptxPath));
  const progress =
    isRunning && project?.pptxPath
      ? "88%"
      : project?.needsPptxRegeneration
        ? "80%"
        : project?.pptxPath
          ? "100%"
          : project?.hasSvg
            ? isRunning
              ? "60%"
              : "75%"
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
            <IconSparkles size={13} /> AI 课件
          </div>
          <h2>课件生成工作台</h2>
          <p>需求分析、页面预览和课件编辑都在当前窗口完成。</p>
        </div>
        <span className={`ppt-master-status ${isRunning ? "running" : ""}`}>
          <span className="ppt-master-status-dot" /> {phase}
        </span>
      </div>

      <div className="ppt-master-progress-card">
        <div className="ppt-master-card-title">当前任务</div>
        <div className="ppt-master-task-name">
          {activeSession?.title || "新建 PPT 课件"}
        </div>
        <div className="ppt-master-progress-track">
          <span style={{ width: progress }} />
        </div>
        <div className="ppt-master-progress-meta">
          <span>
            {isRunning && project?.pptxPath
              ? "正在根据最新页面生成新版本 PPT"
              : project?.needsPptxRegeneration
                ? "页面已修改，请重新生成 PPT"
                : project?.pptxPath
                  ? "PPT 可编辑；后续 AI 修改以页面稿为准"
                  : project?.hasSvg
                    ? isRunning
                      ? "页面正在生成，可预览已完成页面"
                      : "请完成页面预览和修改"
                    : isRunning
                      ? "正在分析需求并生成页面"
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
          <span>分析课件需求</span>
          <em>{messages.length > 0 ? "已开始" : "等待任务"}</em>
        </div>
        <div className={`ppt-master-event ${pageGenerationDone ? "done" : isRunning ? "active" : ""}`}>
          {pageGenerationDone ? <IconCheck size={14} /> : <span className="ppt-master-event-dot" />}
          <span>生成课件页面</span>
          <em>{pageGenerationDone ? "已完成" : isRunning ? "进行中" : "等待任务"}</em>
        </div>
        <div className={`ppt-master-event ${project?.needsPptxRegeneration || (project?.hasSvg && !project.pptxPath) ? "active" : project?.pptxPath ? "done" : ""}`}>
          {project?.pptxPath && !project.needsPptxRegeneration ? <IconCheck size={14} /> : <span className="ppt-master-event-dot" />}
          <span>预览与编辑页面</span>
          <em>{project?.needsPptxRegeneration ? "已修改" : project?.pptxPath ? "已确认" : project?.hasSvg ? isRunning ? "生成中可预览" : "可编辑" : "生成后自动打开"}</em>
        </div>
        <div className={`ppt-master-event ${project?.pptxPath && !project.needsPptxRegeneration ? "done" : ""}`}>
          {project?.pptxPath && !project.needsPptxRegeneration ? <IconCheck size={14} /> : <span className="ppt-master-event-dot" />}
          <span>编辑 PPT</span>
          <em>{project?.needsPptxRegeneration ? "重新生成后可用" : project?.pptxPath ? "可用" : "生成后可用"}</em>
        </div>
      </div>

      <div className="ppt-master-panel-actions">
        {project?.hasSvg ? (
          <button
            type="button"
            className="ppt-master-action"
            disabled={previewBusy}
            onClick={() => void openSvgPreview()}
          >
            <IconExternal size={14} /> {previewBusy ? "正在启动预览" : "预览与编辑页面"}
          </button>
        ) : null}
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
            <IconSparkles size={14} /> {project?.needsPptxRegeneration ? "重新生成 PPT" : "生成 PPT"}
          </button>
        )}
        <button
          type="button"
          className="ppt-master-action"
          disabled={!project?.pptxPath || project.needsPptxRegeneration || isRunning}
          onClick={() => setImportOpen(true)}
        >
          <IconRefresh size={14} /> 发布到教学平台
        </button>
        {previewError ? <div className="ppt-master-action-error" role="alert">{previewError}</div> : null}
      </div>
      {activeSession?.id && project?.pptxPath ? (
        <CoursewareImportDialog
          open={importOpen}
          sessionId={activeSession.id}
          initialTitle={activeSession.title || "新建 PPT 课件"}
          pptxPath={project.pptxPath}
          firstLessonPlan={firstLessonPlan}
          onClose={() => setImportOpen(false)}
        />
      ) : null}
    </div>
  );
}
