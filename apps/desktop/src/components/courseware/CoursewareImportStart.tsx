import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { CoursewareEducationContext, CoursewareTeachingView, ComposerPastedFile } from "@pi-desktop/shared";
import { api, type PptEditorState } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
import { toolWorkPanelTab } from "../../lib/work-panel-tabs";
import { CoursewarePlaybackPanel } from "../workpanel/CoursewarePlaybackPanel";
import { PptxInspectionPanel } from "../workpanel/PptxInspectionPanel";
import { importTeachingSummary, isImportedEditorPath } from "./import-start";

export function CoursewareImportStart({ sessionId, path, education, editor }: {
  sessionId: string; path: string; education?: CoursewareEducationContext; editor: PptEditorState | null;
}) {
  const { t } = useTranslation();
  const running = useAppStore(s => s.runningSessions[sessionId] ?? false);
  const messages = useAppStore(s => s.messages);
  const workspace = useAppStore(s => s.sessions.find(session => session.id === sessionId)?.projectPath);
  const [audience, setAudience] = useState(education ?? {});
  const [files, setFiles] = useState<Array<ComposerPastedFile & { role: "plan" | "script" }>>([]);
  const [view, setView] = useState<CoursewareTeachingView | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [review, setReview] = useState(false);
  const [previewActive, setPreviewActive] = useState(false);
  const [refresh, setRefresh] = useState(0);
  // Tool history also covers paginated transcripts whose initial user turn is absent.
  const handedOff = submitted || !busy && (running || messages.some(message => message.role === "user" || message.role === "tool"));
  const active = useRef(true), inFlight = useRef(false), generation = useRef(0);
  const current = () => active.current && useAppStore.getState().activeSessionId === sessionId;
  const matchingEditor = isImportedEditorPath(path, editor?.path, workspace);
  const ready = matchingEditor && !!editor && ["ready", "saved"].includes(editor.status) && !editor.dirty && !editor.readOnly;
  const readyRef = useRef(ready); readyRef.current = ready;
  useEffect(() => {
    active.current = true;
    const unsubscribe = api.onAuthChanged((state) => {
      if (state.status !== "authenticated") { generation.current++; setView(null); setBusy(false); setFiles([]); setReview(false); }
      setRefresh(n => n + 1);
    });
    return () => { active.current = false; generation.current++; unsubscribe(); };
  }, []);
  useEffect(() => {
    if (!ready || running || handedOff) return;
    let disposed = false;
    const epoch = generation.current;
    setView(null);
    void api.pptEditorTeachingOpen(sessionId).then(value => {
      if (!disposed && current() && generation.current === epoch) { setView(value); setError(""); }
    }).catch(cause => { if (!disposed && current() && generation.current === epoch) setError(String(cause)); });
    return () => { disposed = true; };
  }, [ready, running, handedOff, editor?.revision, editor?.sha256, refresh, sessionId]);
  const summary = view && importTeachingSummary(view);
  const blocked = busy || running || previewActive;
  const enabled = ready && !!view && !view.readOnly && !blocked;
  const label = (path.split(/[/\\]/).pop() ?? path).replace(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}-/iu, "");
  const audienceLabel = [audience.schoolStage && t(`coursewareTask.${audience.schoolStage}`), audience.grade,
    audience.subject && (audience.subject === "other" ? audience.customSubjectName : t(`coursewareTask.${audience.subject}`))].filter(Boolean).join(" · ");

  const run = async (operation: (valid: () => boolean) => Promise<void>) => {
    if (!current() || inFlight.current || useAppStore.getState().runningSessions[sessionId] || previewActive) return;
    const epoch = generation.current;
    const valid = () => current() && generation.current === epoch;
    inFlight.current = true; setBusy(true); setError("");
    try { await operation(valid); }
    catch (cause) { if (valid()) setError(String(cause)); }
    finally { inFlight.current = false; if (valid()) setBusy(false); }
  };
  const send = () => run(async valid => {
    if (!readyRef.current || !view || view.readOnly) return;
    const choices = (["narration", "audio", "focus", "animation"] as const).map(key =>
      t(`importCourseware.request_${key}`));
    const prompt = [
      t("importCourseware.startPrompt", { title: label, audience: audienceLabel || t("coursewareTask.unspecified") }),
      ...choices,
      t("importCourseware.activityPrompt"),
      t("importCourseware.preservePrompt"),
      ...files.map(file => t(`importCourseware.${file.role}Prompt`, { name: file.name, path: file.path })),
    ].join("\n");
    const content = `${prompt}\n${t("importCourseware.executionPrompt")}`;
    if (!valid() || !readyRef.current || useAppStore.getState().runningSessions[sessionId]) return;
    const accepted = await useAppStore.getState().sendPrompt(content,
      { text: content, fileReferences: files.map(({ path, name, kind, mimeType }) => ({ path, name, kind, mimeType })) }, sessionId);
    if (!accepted) throw new Error(t("coursewareWorkflow.sendFailed"));
    if (valid()) { setSubmitted(true); setCollapsed(true); setReview(false); setFiles([]); }
  });
  const attach = () => run(async valid => {
    const picked = await api.pickFiles();
    if (!valid() || !picked.token) return;
    const result = await api.importFiles(sessionId, picked.token);
    if (!valid()) return;
    if (result.files.some(file => !/\.(pdf|docx?|txt|md)$/i.test(file.name))) throw new Error(t("importCourseware.fileTypes"));
    setFiles(previous => [...previous, ...result.files.filter(file => !previous.some(p => p.path === file.path)).map(file => ({ ...file, role: "plan" as const }))]);
  });
  const openEditor = () => run(async () => {
    useAppStore.getState().openWorkPanelTab(toolWorkPanelTab("ppt"));
    await api.pptEditorOpen(path);
  });

  if (handedOff) return null;

  return <section className="courseware-import-start" aria-label={t("importCourseware.title")}>
    <header><div><small>{t("importCourseware.title")}</small><h2 title={path}>{label}</h2></div>
      <button type="button" aria-expanded={!collapsed} onClick={() => setCollapsed(value => !value)}>{t(collapsed ? "importCourseware.expand" : "importCourseware.collapse")}</button></header>
    <p role="status" aria-live="polite">{summary ? t("importCourseware.progress", summary) : t("importCourseware.preparing")}</p>
    {!ready && <p role="status">{t(matchingEditor && editor?.readOnly ? "importCourseware.readOnly" : "importCourseware.waitEditor")}</p>}
    {!collapsed && <div className="courseware-import-options">
      <p>{t("importCourseware.hint")}</p>
      <details><summary>{t("importCourseware.audience")}{audienceLabel ? ` · ${audienceLabel}` : ""}</summary><fieldset disabled={blocked} className="courseware-import-audience">
        <label>{t("coursewareTask.schoolStage")}<select value={audience.schoolStage ?? ""} onChange={e => setAudience(value => ({ ...value, schoolStage: e.target.value }))}>
          <option value="">{t("coursewareTask.unspecified")}</option>{["kindergarten", "primary", "junior_high", "senior_high"].map(stage => <option value={stage} key={stage}>{t(`coursewareTask.${stage}`)}</option>)}</select></label>
        <label>{t("coursewareTask.grade")}<input value={audience.grade ?? ""} maxLength={100} onChange={e => setAudience(value => ({ ...value, grade: e.target.value }))} /></label>
        <label>{t("coursewareTask.subject")}<select value={audience.subject ?? ""} onChange={e => setAudience(value => ({ ...value, subject: e.target.value }))}>
          <option value="">{t("coursewareTask.unspecified")}</option>{["chinese", "math", "english", "other"].map(subject => <option value={subject} key={subject}>{t(`coursewareTask.${subject}`)}</option>)}</select></label>
        {audience.subject === "other" && <label>{t("coursewareTask.customSubjectName")}<input value={audience.customSubjectName ?? ""} maxLength={100} onChange={e => setAudience(value => ({ ...value, customSubjectName: e.target.value }))} /></label>}
      </fieldset></details>
      <button type="button" disabled={blocked} onClick={() => void attach()}>{t("importCourseware.attach")}</button>
      {files.map(file => <div className="courseware-import-file" key={file.path}><span>{file.name}</span><select disabled={blocked} aria-label={t("importCourseware.fileRole", { name: file.name })} value={file.role} onChange={e => setFiles(values => values.map(v => v.path === file.path ? { ...v, role: e.target.value === "script" ? "script" : "plan" } : v))}>
        <option value="plan">{t("importCourseware.plan")}</option><option value="script">{t("importCourseware.script")}</option></select>
        <button type="button" disabled={blocked} aria-label={t("importCourseware.removeFile", { name: file.name })} onClick={() => setFiles(values => values.filter(v => v.path !== file.path))}>{t("importCourseware.remove")}</button></div>)}
    </div>}
    {error && <p role="alert">{error} <button type="button" disabled={blocked} onClick={() => setRefresh(value => value + 1)}>{t("importCourseware.retry")}</button></p>}
    <footer>
      {!collapsed && <button type="button" className="courseware-import-primary" disabled={!enabled} onClick={() => void send()}>{t("importCourseware.start")}</button>}
        <button type="button" disabled={blocked} onClick={() => { setCollapsed(true); void openEditor(); }}>{t("importCourseware.edit")}</button>
        {!!summary?.narration && <button type="button" disabled={!enabled} aria-expanded={review} onClick={() => setReview(value => !value)}>{t("importCourseware.preview")}</button>}
    </footer>
    {review && view && <div className="courseware-import-review"><p>{t("importCourseware.reviewHint")}</p>
      <CoursewarePlaybackPanel key={view.project.teachingRevision} view={view} sessionId={sessionId} enabled={ready && !running && !busy} onActiveChange={setPreviewActive} />
      <PptxInspectionPanel enabled={enabled} revision={editor?.revision} />
    </div>}
  </section>;
}
