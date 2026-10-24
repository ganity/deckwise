import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { CoursewareEducationContext, CoursewareTaskType } from "@pi-desktop/shared";
import { useAppStore } from "../stores/app-store";
import { Button, portalOverlay, TooltipButton } from "./ui";
import { IconClose } from "./icons";

export function CoursewareTaskDialog() {
  const request = useAppStore((state) => state.newTaskDialog);
  const close = useAppStore((state) => state.closeNewTaskDialog);
  return request ? <TaskForm key={request.projectPath} projectPath={request.projectPath} onClose={close} /> : null;
}

function TaskForm({ projectPath, onClose }: { projectPath: string; onClose: () => void }) {
  const { t } = useTranslation();
  const [taskType, setTaskType] = useState<CoursewareTaskType>("plain");
  const [education, setEducation] = useState<CoursewareEducationContext>({});
  const [brief, setBrief] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const initialFocus = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    initialFocus.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (!busyRef.current) onClose();
      }
      if (event.key !== "Tab") return;
      const items = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary',
      ) ?? []).filter(item => item.getClientRects().length > 0);
      if (!items?.length) { event.preventDefault(); return; }
      const first = items[0], last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault(); first.focus();
      }
    };
    window.addEventListener("keydown", keydown, true);
    return () => {
      window.removeEventListener("keydown", keydown, true);
      document.body.style.overflow = overflow;
      if (previous?.isConnected) previous.focus();
    };
  }, [onClose]);

  const submit = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await useAppStore.getState().newSession({ projectPath, courseware: { taskType, educationContext: education,
        ...(brief.trim() ? { initialPrompt: brief } : {}) } });
      onClose();
      requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>(".composer-input")?.focus());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  const field = (key: "grade" | "customSubjectName" | "textbookVersion" | "chapter" | "lessonType") => (
    <label className="courseware-task-field">
      <span>{t(`coursewareTask.${key}`)}</span>
      <input className="field-input" value={education[key] ?? ""} maxLength={500}
        placeholder={t(key === "grade" ? "coursewareTask.gradeHint" : "coursewareTask.optional")}
        onChange={(event) => setEducation({ ...education, [key]: event.target.value || undefined })} />
    </label>
  );

  return portalOverlay(
    <div className="overlay courseware-task-overlay" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !busyRef.current) onClose();
    }}>
      <div className="dialog courseware-task-dialog" role="dialog" aria-modal="true"
        aria-labelledby="courseware-task-title" aria-describedby="courseware-task-description" ref={dialogRef} tabIndex={-1}>
        <header className="courseware-task-header">
          <div><h2 id="courseware-task-title">{t("coursewareTask.title")}</h2>
            <p id="courseware-task-description">{t("coursewareTask.description")}</p></div>
          <TooltipButton type="button" tooltip={t("common.close")} ariaLabel={t("common.close")}
            disabled={busy} onClick={onClose}><IconClose size={17} /></TooltipButton>
        </header>
        <form onSubmit={(event) => { event.preventDefault(); void submit(); }}>
          <div className="courseware-task-body">
            <fieldset disabled={busy} className="courseware-task-types">
              <legend>{t("coursewareTask.type")}</legend>
              {(["plain", "scene", "import"] as const).map((kind, index) => (
                <label key={kind} className={`courseware-task-choice ${taskType === kind ? "is-selected" : ""}`}>
                  <input ref={index === 0 ? initialFocus : undefined} type="radio" name="courseware-task-type"
                    value={kind} checked={taskType === kind} onChange={() => setTaskType(kind)} />
                  <span><strong>{t(`coursewareTask.${kind}`)}</strong><small>{t(`coursewareTask.${kind}Hint`)}</small></span>
                </label>
              ))}
            </fieldset>
            <label className="courseware-task-field courseware-task-brief">
              <span>{t("coursewareTask.brief")}</span>
              <textarea className="field-input" value={brief} rows={3} maxLength={4000} disabled={busy}
                placeholder={t("coursewareTask.briefHint")} aria-describedby="courseware-task-brief-hint"
                onChange={event => setBrief(event.target.value)} />
              <small id="courseware-task-brief-hint">{t("coursewareTask.briefReview")}</small>
            </label>
            <fieldset disabled={busy} className="courseware-task-education">
              <legend>{t("coursewareTask.education")}</legend>
              <div className="courseware-task-fields">
                <label className="courseware-task-field"><span>{t("coursewareTask.schoolStage")}</span>
                  <select className="field-input" value={education.schoolStage ?? ""} onChange={(event) =>
                    setEducation({ ...education, schoolStage: event.target.value || undefined,
                      fullEnglishTeaching: event.target.value === "kindergarten" && education.fullEnglishTeaching === true })}>
                    <option value="">{t("coursewareTask.unspecified")}</option>
                    {(["kindergarten", "primary", "junior_high", "senior_high"] as const).map((stage) =>
                      <option key={stage} value={stage}>{t(`coursewareTask.${stage}`)}</option>)}
                  </select></label>
                {field("grade")}
                <label className="courseware-task-field"><span>{t("coursewareTask.subject")}</span>
                  <select className="field-input" value={education.subject ?? ""} onChange={(event) =>
                    setEducation({ ...education, subject: event.target.value || undefined,
                      fullEnglishTeaching: event.target.value === "english" && education.fullEnglishTeaching === true })}>
                    <option value="">{t("coursewareTask.unspecified")}</option>
                    {(["chinese", "math", "english", "other"] as const).map((subject) =>
                      <option key={subject} value={subject}>{t(`coursewareTask.${subject}`)}</option>)}
                  </select></label>
                {education.subject === "other" ? field("customSubjectName") : null}
              </div>
              {education.schoolStage === "kindergarten" && education.subject === "english" ?
                <label className="courseware-task-english"><input type="checkbox" checked={education.fullEnglishTeaching === true}
                  onChange={(event) => setEducation({ ...education, fullEnglishTeaching: event.target.checked })} />
                  {t("coursewareTask.fullEnglishTeaching")}</label> : null}
              <details className="courseware-task-details">
                <summary>{t("coursewareTask.moreDetails")}</summary>
                <div className="courseware-task-fields">
                  {field("textbookVersion")}{field("chapter")}{field("lessonType")}
                </div>
              </details>
            </fieldset>
            {error ? <p role="alert" className="courseware-task-error">{error}</p> : null}
          </div>
          <footer className="courseware-task-footer">
            <Button type="button" variant="secondary" disabled={busy} onClick={onClose}>{t("common.cancel")}</Button>
            <Button type="submit" variant="primary" disabled={busy}>{t(busy ? "coursewareTask.creating" : "coursewareTask.create")}</Button>
          </footer>
        </form>
      </div>
    </div>,
  );
}
