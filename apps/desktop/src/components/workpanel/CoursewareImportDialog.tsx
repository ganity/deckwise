import type { DesktopAuthDictionaryItem, DesktopAuthProfile } from "@pi-desktop/shared";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../lib/api";
import { Button, Input, Select, portalOverlay } from "../ui";
import { IconClose, IconFileText } from "../icons";

export type CoursewareFile = { name: string; path: string };

const FALLBACK_GRADES: DesktopAuthDictionaryItem[] = Array.from({ length: 6 }, (_, index) => ({
  value: `grade_${index + 1}`,
  label: `${index + 1}年级`,
  sort: index + 1,
  parentValue: "primary",
}));

const FALLBACK_SUBJECTS: DesktopAuthDictionaryItem[] = [
  { value: "chinese", label: "语文" },
  { value: "math", label: "数学" },
  { value: "english", label: "英语" },
  { value: "information_technology", label: "信息科技" },
  { value: "other", label: "其他" },
];

function enabledPrimary(items: DesktopAuthDictionaryItem[]) {
  return items
    .filter((item) => item.enabled !== false && (!item.parentValue || item.parentValue === "primary"))
    .sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0));
}

function gradeOptions(account: DesktopAuthProfile) {
  return enabledPrimary(account.dictionaries?.grades ?? FALLBACK_GRADES);
}

function subjectOptions(account: DesktopAuthProfile) {
  return enabledPrimary(account.dictionaries?.subjects ?? FALLBACK_SUBJECTS);
}

function isLessonPlan(name: string) {
  return /\.(pdf|docx?)$/i.test(name);
}

export function CoursewareImportDialog({
  open,
  sessionId,
  initialTitle,
  pptxPath,
  firstLessonPlan,
  onClose,
}: {
  open: boolean;
  sessionId: string;
  initialTitle: string;
  pptxPath: string;
  firstLessonPlan: CoursewareFile | null;
  onClose: () => void;
}) {
  const [account, setAccount] = useState<DesktopAuthProfile | null>(null);
  const [title, setTitle] = useState(initialTitle);
  const [grade, setGrade] = useState("");
  const [subject, setSubject] = useState("");
  const [customSubjectName, setCustomSubjectName] = useState("");
  const [detailLevel, setDetailLevel] = useState<"quick" | "normal" | "detailed">("normal");
  const [lessonPlan, setLessonPlan] = useState<CoursewareFile | null>(firstLessonPlan);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState("");
  const titleRef = useRef<HTMLInputElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const busyRef = useRef(false);

  const grades = useMemo(() => account ? gradeOptions(account) : [], [account]);
  const subjects = useMemo(() => account ? subjectOptions(account) : [], [account]);

  useEffect(() => {
    if (!open) return;
    let active = true;
    setTitle(initialTitle);
    setLessonPlan(firstLessonPlan);
    setCustomSubjectName("");
    setError("");
    setResult("");
    setBusy(false);
    busyRef.current = false;
    setAccount(null);
    void api.restoreAuth().then((state) => {
      if (!active || state.status !== "authenticated") {
        if (active) setError("登录已过期，请重新扫码");
        return;
      }
      const nextGrades = gradeOptions(state.profile);
      const nextSubjects = subjectOptions(state.profile);
      setAccount(state.profile);
      setGrade(
        nextGrades.some((item) => item.value === state.profile.generationDefaults?.grade)
          ? state.profile.generationDefaults?.grade ?? ""
          : nextGrades[0]?.value ?? "",
      );
      setSubject(
        nextSubjects.some((item) => item.value === state.profile.generationDefaults?.subject)
          ? state.profile.generationDefaults?.subject ?? ""
          : nextSubjects[0]?.value ?? "",
      );
      setDetailLevel(state.profile.generationDefaults?.detailLevel ?? "normal");
      requestAnimationFrame(() => titleRef.current?.focus());
    }).catch((reason) => {
      if (active) setError(reason instanceof Error ? reason.message : String(reason));
    });
    return () => {
      active = false;
    };
  }, [firstLessonPlan, initialTitle, open]);

  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busyRef.current) {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
        'input:not([disabled]), select:not([disabled]), button:not([disabled])',
      );
      if (!focusable?.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("keydown", closeOnEscape);
      document.body.style.overflow = previousOverflow;
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, [onClose, open]);

  const pickLessonPlan = async () => {
    if (busy) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    try {
      const picked = await api.pickFiles();
      if (!picked.token) return;
      const imported = await api.importFiles(sessionId, picked.token);
      const file = imported.files.find((candidate) => isLessonPlan(candidate.name));
      if (!file) {
        setError("请选择 PDF、DOC 或 DOCX 教案");
        return;
      }
      setLessonPlan({ name: file.name, path: file.path });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || result) return;
    if (!title.trim() || !grade || !subject || !lessonPlan) {
      setError("请填写课件名称、年级、学科并选择教案");
      return;
    }
    if (subject === "other" && !customSubjectName.trim()) {
      setError("请填写自定义学科");
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setError("");
    try {
      const task = await api.importCourseware({
        title: title.trim(),
        grade,
        subject,
        customSubjectName: subject === "other" ? customSubjectName.trim() : undefined,
        detailLevel,
        pptxPath,
        lessonPlanPath: lessonPlan.path,
      });
      setResult(`已提交到教学平台，任务编号 ${task.taskId}`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  if (!open) return null;

  return portalOverlay(
    <div
      className="overlay courseware-import-overlay"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="dialog courseware-import-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="courseware-import-title"
      >
        <div className="courseware-import-head">
          <div>
            <h2 id="courseware-import-title">发布到教学平台</h2>
            <p>使用当前 PPT 和对话中最先上传的教案创建小学课件。</p>
          </div>
          <button type="button" className="courseware-import-close" aria-label="关闭" disabled={busy} onClick={onClose}>
            <IconClose size={16} />
          </button>
        </div>

        <form className="courseware-import-form" onSubmit={(event) => void submit(event)}>
          <label>
            <span>课件名称</span>
            <Input ref={titleRef} value={title} maxLength={80} disabled={busy || Boolean(result)} onChange={(event) => setTitle(event.target.value)} />
          </label>
          <div className="courseware-import-grid">
            <label>
              <span>年级</span>
              <Select value={grade} disabled={busy || Boolean(result) || !account} onChange={(event) => setGrade(event.target.value)}>
                {grades.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
              </Select>
            </label>
            <label>
              <span>学科</span>
              <Select value={subject} disabled={busy || Boolean(result) || !account} onChange={(event) => setSubject(event.target.value)}>
                {subjects.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
              </Select>
            </label>
          </div>
          {subject === "other" ? (
            <label>
              <span>自定义学科</span>
              <Input value={customSubjectName} maxLength={30} disabled={busy || Boolean(result)} onChange={(event) => setCustomSubjectName(event.target.value)} />
            </label>
          ) : null}
          <label>
            <span>讲解词详细程度</span>
            <Select value={detailLevel} disabled={busy || Boolean(result)} onChange={(event) => setDetailLevel(event.target.value as typeof detailLevel)}>
              <option value="quick">简洁</option>
              <option value="normal">正常</option>
              <option value="detailed">详细</option>
            </Select>
          </label>

          <div className="courseware-import-files">
            <div>
              <span>PPT 文件</span>
              <strong><IconFileText size={15} /> {pptxPath.split(/[\\/]/).at(-1)}</strong>
            </div>
            <div>
              <span>教案</span>
              <strong><IconFileText size={15} /> {lessonPlan?.name ?? "未选择"}</strong>
              {!result ? <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void pickLessonPlan()}>重新选择</Button> : null}
            </div>
          </div>

          {error ? <div className="courseware-import-message error" role="alert">{error}</div> : null}
          {result ? <div className="courseware-import-message success" role="status">{result}</div> : null}

          <div className="courseware-import-actions">
            <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>{result ? "完成" : "取消"}</Button>
            {!result ? <Button type="submit" variant="primary" disabled={busy || !account}>{busy ? "正在上传并提交…" : "发布课件"}</Button> : null}
          </div>
        </form>
      </div>
    </div>,
  );
}
