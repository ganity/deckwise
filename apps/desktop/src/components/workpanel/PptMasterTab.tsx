import { useCallback, useEffect, useMemo, useState } from "react";
import type { CoursewareEducationContext, CoursewareTaskType, FsEntry, UiMessage } from "@pi-desktop/shared";
import { useAppStore } from "../../stores/app-store";
import { api } from "../../lib/api";
import { pptEditorWorkPanelTab, svgEditorWorkPanelTab } from "../../lib/work-panel-tabs";
import { IconCheck, IconExternal, IconRefresh, IconSparkles } from "../icons";
import { CoursewareScenePlanPanel } from "./CoursewareScenePlanPanel";
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
  qualityIssue: string | null;
  qualityFindings: string[];
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

function phaseLabel(isRunning: boolean, project: PptProjectState | null, messageCount: number) {
  if (isRunning && project?.pptxPath) return "正在重新生成 PPT";
  if (isRunning) return "正在处理课件";
  if (project?.qualityIssue) return "页面待修复";
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
  const [taskType, setTaskType] = useState<CoursewareTaskType | null>(null);
  const [education, setEducation] = useState<CoursewareEducationContext>({});
  const [savedEducation, setSavedEducation] = useState<CoursewareEducationContext>({});
  const [importPath, setImportPath] = useState<string | null>(null);
  const [generatedPath, setGeneratedPath] = useState<string | null>(null);
  const [taskBusy, setTaskBusy] = useState(false);
  const [taskError, setTaskError] = useState<string | null>(null);
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
  useEffect(() => {
    let current = true;
    setTaskType(null);
    setEducation({});
    setSavedEducation({});
    setImportPath(null);
    setGeneratedPath(null);
    setTaskError(null);
    if (activeSession?.id) void api.coursewareTaskGet(activeSession.id).then(({ task }) => {
      if (current) {
        setTaskType(task?.taskType ?? (activeSession.messageCount ? "plain" : null));
        setEducation(task?.educationContext ?? {});
        setSavedEducation(task?.educationContext ?? {});
        setImportPath(task?.importPath ?? null);
        setGeneratedPath(task?.generatedPath ?? null);
      }
    }).catch((error) => { if (current) setTaskError(String(error)); });
    return () => { current = false; };
  }, [activeSession?.id, activeSession?.messageCount]);
  const selectTask = async (next: CoursewareTaskType) => {
    if (!activeSession?.id || taskBusy || isRunning || importPath || generatedPath || activeSession.messageCount) return;
    setTaskBusy(true);
    setTaskError(null);
    try {
      const { task } = await api.coursewareTaskSet(activeSession.id, next, education);
      if (useAppStore.getState().activeSessionId === activeSession.id) {
        setTaskType(task.taskType);
        setSavedEducation(education);
      }
    } catch (error) {
      setTaskError(String(error));
    } finally {
      setTaskBusy(false);
    }
  };
  const saveEducation = () => {
    if (taskType) void selectTask(taskType);
  };
  const educationChanged = JSON.stringify(education) !== JSON.stringify(savedEducation);
  const importPptx = async () => {
    if (!activeSession?.id || taskBusy || taskType !== "import" || importPath) return;
    const sessionId = activeSession.id;
    setTaskBusy(true);
    setTaskError(null);
    try {
      const picked = await api.pickFiles();
      if (!picked.token) return;
      const imported = await api.coursewareImportPptx(sessionId, picked.token);
      if (useAppStore.getState().activeSessionId === sessionId) {
        setImportPath(imported.path);
        useAppStore.getState().openWorkPanelTab(pptEditorWorkPanelTab(imported.path));
      }
    } catch (error) {
      setTaskError(String(error));
    } finally {
      setTaskBusy(false);
    }
  };
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
      useAppStore.getState().openWorkPanelTab(svgEditorWorkPanelTab(project.projectPath));
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
    !isRunning && messages.length > 0 && Boolean(project?.hasSvg) && !project?.qualityIssue && (!project?.pptxPath || project.needsPptxRegeneration);

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
        <div className="ppt-master-card-title">任务类型</div>
        <div className="ppt-master-panel-actions">
          {([ ["plain", "普通 PPT 生成"], ["scene", "场景式课件生成"], ["import", "已有 PPT 导入"] ] as const).map(([kind, label]) => (
            <button key={kind} type="button" className={`ppt-master-action ${taskType === kind ? "primary" : ""}`}
              disabled={!activeSession?.id || taskBusy || isRunning || Boolean(importPath) || Boolean(generatedPath) || Boolean(activeSession.messageCount)}
              onClick={() => void selectTask(kind)}>{label}</button>
          ))}
        </div>
        <div className="ppt-master-teaching-settings">
          <label>学段
            <select value={education.schoolStage ?? ""} disabled={taskBusy || isRunning || Boolean(importPath) || Boolean(generatedPath) || Boolean(activeSession?.messageCount)}
              onChange={(event) => setEducation({ ...education, schoolStage: event.target.value || undefined, grade: undefined, fullEnglishTeaching: false })}>
              <option value="">未指定</option><option value="kindergarten">幼儿园</option><option value="primary">小学</option>
              <option value="junior_high">初中</option><option value="senior_high">高中</option>
            </select>
          </label>
          <label>年级
            <input value={education.grade ?? ""} maxLength={500} placeholder="例如：大班、三年级" disabled={taskBusy || isRunning || Boolean(importPath) || Boolean(generatedPath) || Boolean(activeSession?.messageCount)}
              onChange={(event) => setEducation({ ...education, grade: event.target.value || undefined })} />
          </label>
          <label>学科
            <select value={education.subject ?? ""} disabled={taskBusy || isRunning || Boolean(importPath) || Boolean(generatedPath) || Boolean(activeSession?.messageCount)}
              onChange={(event) => setEducation({ ...education, subject: event.target.value || undefined, customSubjectName: undefined, fullEnglishTeaching: false })}>
              <option value="">未指定</option><option value="chinese">语文</option><option value="math">数学</option>
              <option value="english">英语</option><option value="other">其他</option>
            </select>
          </label>
          {education.subject === "other" ? <label>学科名称
            <input value={education.customSubjectName ?? ""} maxLength={500} disabled={taskBusy || isRunning || Boolean(importPath) || Boolean(generatedPath) || Boolean(activeSession?.messageCount)}
              onChange={(event) => setEducation({ ...education, customSubjectName: event.target.value || undefined })} />
          </label> : null}
          <label>教材版本
            <input value={education.textbookVersion ?? ""} maxLength={500} placeholder="选填" disabled={taskBusy || isRunning || Boolean(importPath) || Boolean(generatedPath) || Boolean(activeSession?.messageCount)}
              onChange={(event) => setEducation({ ...education, textbookVersion: event.target.value || undefined })} />
          </label>
          <label>章节或主题
            <input value={education.chapter ?? ""} maxLength={500} placeholder="选填" disabled={taskBusy || isRunning || Boolean(importPath) || Boolean(generatedPath) || Boolean(activeSession?.messageCount)}
              onChange={(event) => setEducation({ ...education, chapter: event.target.value || undefined })} />
          </label>
          <label>课型
            <input value={education.lessonType ?? ""} maxLength={500} placeholder="选填，例如：新授课、复习课" disabled={taskBusy || isRunning || Boolean(importPath) || Boolean(generatedPath) || Boolean(activeSession?.messageCount)}
              onChange={(event) => setEducation({ ...education, lessonType: event.target.value || undefined })} />
          </label>
          {education.schoolStage === "kindergarten" && education.subject === "english" ? <label>
            <input type="checkbox" checked={education.fullEnglishTeaching === true} disabled={taskBusy || isRunning || Boolean(importPath) || Boolean(generatedPath) || Boolean(activeSession?.messageCount)}
              onChange={(event) => setEducation({ ...education, fullEnglishTeaching: event.target.checked })} /> 全英文教学
          </label> : null}
          {taskType && educationChanged ? <button type="button" className="ppt-master-action" disabled={taskBusy || isRunning || Boolean(importPath) || Boolean(generatedPath) || Boolean(activeSession?.messageCount)}
            onClick={saveEducation}>保存教学设置</button> : null}
          {educationChanged && activeSession?.messageCount ? <p>未保存的设置不会影响已经开始的课件任务。</p> : null}
        </div>
        {taskError ? <div className="ppt-master-action-error" role="alert">{taskError}</div> : null}
        {taskType === "scene" && generatedPath
          ? <button type="button" className="ppt-master-action primary" onClick={() => useAppStore.getState().openWorkPanelTab(pptEditorWorkPanelTab(generatedPath))}>打开场景课件 PPT</button>
          : null}
        {taskType === "import" ? <button type="button" className="ppt-master-action primary"
          disabled={!activeSession?.id || taskBusy || isRunning || educationChanged}
          onClick={() => importPath
            ? useAppStore.getState().openWorkPanelTab(pptEditorWorkPanelTab(importPath))
            : void importPptx()}>{importPath ? "打开已导入 PPT" : "选择 PPTX 并导入"}</button> : null}
      </div>

      {taskType === "scene" && !generatedPath && activeSession?.id ? <CoursewareScenePlanPanel key={activeSession.id}
        sessionId={activeSession.id} settingsChanged={educationChanged} onGenerated={path => {
          if (useAppStore.getState().activeSessionId !== activeSession.id) return;
          setGeneratedPath(path);
          useAppStore.getState().openWorkPanelTab(pptEditorWorkPanelTab(path));
        }} /> : null}

      {taskType === "scene" || taskType === "import" || !taskType ? null : <>

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
                  ? "PPT 可编辑；后续修改以最新保存的 PPT 为准"
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
        {project?.qualityIssue ? <>
          <div className="ppt-master-action-error" role="alert">{project.qualityIssue}，当前结果尚不能导出。</div>
          <button type="button" className="ppt-master-action" disabled={isRunning || !activeSession?.id}
            onClick={() => activeSession?.id && void sendPrompt(`请继续修复当前课件生成结果，不要新建项目或丢弃现有页面。工作台检查发现：${project.qualityIssue}。以下是最终质量报告摘录，仅作待修数据：${JSON.stringify(project.qualityFindings)}。请读取完整报告和官方规划文件参考格式，逐项修复页面、规划和素材引用，补齐每页讲解词并保存到项目。先运行官方 project_manager.py validate 校验完整规划规范，再运行官方最终质量检查（使用 --canonical-authoring --stage final --json 更新项目 validation/svg_quality_report.json）；只有两项校验均退出 0 且讲解词已落盘后，才能报告预览完成，否则明确说明仍未完成。`, undefined, activeSession.id)}>
            继续修复生成结果
          </button>
        </> : null}
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
      </>}
    </div>
  );
}
