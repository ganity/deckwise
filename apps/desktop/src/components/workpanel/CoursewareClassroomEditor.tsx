import { useEffect, useRef, useState, type ComponentProps } from "react";
import { MaicQuiz, parseMaicClassroom } from "@pi-desktop/courseware-runtime/player";
import { ClassroomSpeechTools } from "./ClassroomSpeechTools";
import { api } from "../../lib/api";
import "@pi-desktop/courseware-runtime/player.css";
import "./courseware-classroom-editor.css";

import { clone, initialPlayback, question, createInteractionCanvas, shortAnswerReferencePatch, recoverClassroomDraft, updateCheckpointQuestion, pruneQuizImageBindings, pruneRemovedSceneBindings, saveBeforeImageAttachment, removeQuestionOption, newOptionValue, type QuizImage, type QuizQuestion, type ClassroomScene, type ClassroomDocument, type ClassroomEditorView } from "../../lib/courseware-classroom";

function imageData(file: File): Promise<QuizImage> {
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type) || file.size > 5 * 1024 * 1024)
    return Promise.reject(new Error("请选择不超过 5 MiB 的 PNG、JPEG 或 WebP 图片"));
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("图片读取失败"));
    reader.onload = () => resolve({ src: String(reader.result), mimeType: file.type });
    reader.readAsDataURL(file);
  });
}

export function CoursewareClassroomEditor({ sessionId, readOnly = false }: { sessionId: string; readOnly?: boolean }) {
  const [view, setView] = useState<ClassroomEditorView>();
  const [draft, setDraft] = useState<ClassroomDocument>();
  const [selectedId, setSelectedId] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState(false);
  const [reload, setReload] = useState(0);
  const [insertPosition, setInsertPosition] = useState(0);
  const [bindings, setBindings] = useState<Record<string, string>>({});
  const [undo, setUndo] = useState<ClassroomDocument[]>([]);
  const [redo, setRedo] = useState<ClassroomDocument[]>([]);
  const owner = useRef(0);
  const pending = useRef(0);
  useEffect(() => {
    const generation = ++owner.current;
    pending.current = 0;
    setBusy(true); setError(""); setNotice(""); setBindings({}); setView(undefined); setDraft(undefined);
    void api.coursewareClassroomOpen(sessionId).then(result => {
      if (generation !== owner.current) return;
      const next = result as ClassroomEditorView;
      let restored = next.classroom ? clone(next.classroom) : undefined;
      try {
        const stored = localStorage.getItem(`maic-classroom-draft:${sessionId}`);
        if (stored) {
          const recovery = JSON.parse(stored) as ClassroomEditorView;
          if (recoverClassroomDraft(next, recovery)) {
            parseMaicClassroom(recovery.classroom); restored = recovery.classroom!; setNotice("已恢复未保存的修改");
          } else { localStorage.setItem(`maic-classroom-draft:${sessionId}:previous`, stored); setNotice("检测到旧草稿，但课件版本已改变。旧草稿已保留，请先核对当前内容。"); }
        }
      } catch { setNotice("本地草稿无法读取，当前显示已保存版本。"); }
      setView(next); setDraft(restored); setSelectedId(restored?.scenes[0]?.id ?? ""); setUndo([]); setRedo([]);
    }).catch(failure => { if (generation === owner.current) setError(String(failure)); })
      .finally(() => { if (generation === owner.current) setBusy(false); });
    return () => { ++owner.current; };
  }, [sessionId, reload]);
  const scene = draft?.scenes.find(item => item.id === selectedId);
  async function download() {
    if (!view || busy || changed) return;
    setBusy(true); setError("");
    try {
      const result = await api.coursewareClassroomExport(sessionId, view.projectId, view.revision, view.sourceRevision);
      const url = URL.createObjectURL(new Blob([new Uint8Array(result.bytes)], { type: "application/zip" }));
      const anchor = document.createElement("a"); anchor.href = url; anchor.download = result.fileName; anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (failure) { setError(String(failure)); }
    finally { setBusy(false); }
  }
  const changed = !!draft && !!view && JSON.stringify(draft) !== JSON.stringify(view.classroom);
  const editable = !readOnly && !busy && !preview;
  function edit(next: ClassroomDocument) {
    if (!draft || !editable) return;
    setUndo(items => [...items.slice(-19), clone(draft)]); setRedo([]); setDraft(pruneQuizImageBindings(pruneRemovedSceneBindings(next, draft))); setError("");
  }
  function updateScene(next: ClassroomScene) {
    if (draft) edit({ ...draft, scenes: draft.scenes.map(item => item.id === next.id ? next : item) });
  }
  function updateQuestion(id: string, patch: Partial<QuizQuestion>) {
    if (scene) updateScene({ ...scene, content: { ...scene.content, questions: scene.content.questions?.map(q => q.id === id ? { ...q, ...patch } : q) } });
  }
  async function save() {
    if (!view || !draft || pending.current === owner.current || busy || readOnly) return;
    const generation = owner.current;
    setBusy(true); setError("");
    try {
      const next = await api.coursewareClassroomWrite(sessionId, view.projectId, view.revision, view.sourceRevision, draft) as ClassroomEditorView;
      if (owner.current === generation) { setView(next); setDraft(next.classroom ? clone(next.classroom) : undefined); }
    } catch (failure) { if (owner.current === generation) setError(String(failure)); }
    finally { if (owner.current === generation) setBusy(false); }
  }
  // Recovery keeps the exact source/content fence from open; it can never overwrite newer native edits.
  useEffect(() => {
    if (!view || !draft) return;
    try {
      if (changed) localStorage.setItem(`maic-classroom-draft:${sessionId}`, JSON.stringify({ projectId: view.projectId, revision: view.revision, sourceRevision: view.sourceRevision, classroom: draft }));
      else localStorage.removeItem(`maic-classroom-draft:${sessionId}`);
    } catch { setNotice("本地草稿空间不足，请及时保存课程。"); }
  }, [sessionId, view, draft, changed]);
  useEffect(() => {
    if (!changed || busy || readOnly || error) return;
    const timer = setTimeout(() => void save(), 1000);
    return () => clearTimeout(timer);
  }, [draft, view, busy, changed, readOnly, error]);
  useEffect(() => {
    if (!changed) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [changed]);
  async function upload(file: File, q: QuizQuestion, optionValue?: string) {
    if (!editable || !view || !scene || !draft) return;
    const generation = owner.current, sceneId = scene.id, questionId = q.id;
    const contentBefore = JSON.stringify(draft);
    pending.current = generation; setBusy(true); setError("");
    try {
      const image = await imageData(file);
      if (generation !== owner.current) return;
      // Upload attaches to explicit content identity with revision CAS, never current selection.
      const next = await saveBeforeImageAttachment({
        save: () => api.coursewareClassroomWrite(sessionId, view.projectId, view.revision, view.sourceRevision, draft),
        current: () => generation === owner.current,
        saved: setView,
        attach: saved => api.coursewareClassroomImage(sessionId, saved.projectId, saved.revision, saved.sourceRevision,
          { sceneId, questionId, ...(optionValue ? { optionValue } : {}), dataUrl: image.src }),
      });
      if (!next) return;
      if (generation === owner.current && contentBefore === JSON.stringify(draft)) {
        setView(next); setDraft(next.classroom ? clone(next.classroom) : undefined); setUndo(items => [...items.slice(-19), clone(draft)]); setRedo([]);
      }
    } catch (failure) { if (generation === owner.current) setError(String(failure)); }
    finally { if (pending.current === generation) pending.current = 0; if (generation === owner.current) setBusy(false); }
  }
  async function regenerateReference(actionId: string) {
    if (!editable || !view || !draft || !scene) return;
    const generation = owner.current;
    setBusy(true); setError("");
    try {
      const saved = await api.coursewareClassroomWrite(sessionId, view.projectId, view.revision, view.sourceRevision, draft);
      if (generation !== owner.current) return;
      setView(saved);
      const next = await api.coursewareClassroomReference(sessionId, saved.projectId, saved.revision, saved.sourceRevision, scene.id, actionId);
      if (generation !== owner.current) return;
      setView(next); setDraft(next.classroom ? clone(next.classroom) : undefined);
      setUndo(items => [...items.slice(-19), clone(draft)]); setRedo([]);
    } catch (failure) { if (generation === owner.current) setError(String(failure)); }
    finally { if (generation === owner.current) setBusy(false); }
  }
  async function play() {
    if (!view || changed || busy) return;
    const generation = owner.current; setBusy(true); setError("");
    try { await api.coursewareClassroomPlay(sessionId, view.projectId, view.revision, view.sourceRevision, "zh-CN"); }
    catch (failure) { if (generation === owner.current) setError(String(failure)); }
    finally { if (generation === owner.current) setBusy(false); }
  }
  function reloadSaved() {
    const key = `maic-classroom-draft:${sessionId}`;
    const value = localStorage.getItem(key);
    if (value) localStorage.setItem(`${key}:previous`, value);
    localStorage.removeItem(key);
    setReload(current => current + 1);
  }
  function addScene(kind: "quiz" | "interaction") {
    if (!draft) return;
    const id = crypto.randomUUID();
    const stageId = String(draft.stage.id ?? draft.id);
    const checkpoint = { id: crypto.randomUUID(), type: "interaction_checkpoint", checkpointId: crypto.randomUUID(), checkpointKind: "chapter_summary", chapterId: id, chapterTitle: "课堂互动", question: "请描述你的想法", constraintPrompt: "", referenceAnswer: { summary: "", keyPoints: [] }, context: { chapterSummary: "", sourceSceneIds: [] } };
    const next: ClassroomScene = kind === "quiz"
      ? { id, stageId, type: "quiz", title: "课堂测验", order: 0, content: { type: "quiz", questions: [question()], interactionMode: "classroom_instant_feedback", playbackConfig: initialPlayback }, actions: [] }
      : { id, stageId, type: "slide", title: "课堂互动", order: 0, content: { type: "slide", canvas: { ...createInteractionCanvas(draft, id), elements: [{ id: `${id}_question`, type: "text", content: "<p>请描述你的想法</p>", left: 80, top: 160, width: 840, height: 120, rotate: 0, defaultFontName: "Noto Sans SC", defaultColor: "#172033" }] } }, actions: [checkpoint], metadata: { interaction: { kind: "chapter_summary", chapterId: id, chapterTitle: "课堂互动", sourceSceneIds: [] } } };
    const index = draft.scenes.findIndex(item => item.id === selectedId);
    const scenes = [...draft.scenes]; scenes.splice(index + 1, 0, next);
    edit({ ...draft, scenes: scenes.map((item, position) => ({ ...item, order: position + 1 })) }); setSelectedId(id);
  }
  return <section className="maic-editor" aria-label="课程内容编辑器">
    <header className="maic-editor-toolbar">
      <strong>课程内容</strong>
      <button disabled={!editable} onClick={() => addScene("quiz")}>添加 Quiz</button>
      <button disabled={!editable} onClick={() => addScene("interaction")}>添加互动</button>
      <button disabled={!editable || !undo.length} onClick={() => { if (draft) { setRedo(items => [...items, clone(draft)]); setDraft(undo.at(-1)); setUndo(items => items.slice(0, -1)); } }}>撤销</button>
      <button disabled={!editable || !redo.length} onClick={() => { if (draft) { setUndo(items => [...items, clone(draft)]); setDraft(redo.at(-1)); setRedo(items => items.slice(0, -1)); } }}>重做</button>
      <button aria-pressed={preview} disabled={busy} onClick={() => setPreview(value => !value)}>{preview ? "返回编辑" : "预览题目"}</button>
      <button disabled={busy || readOnly || !changed} onClick={() => void save()}>保存课程</button>
      <button disabled={busy || changed || !view?.classroom} onClick={() => void play()}>播放整个课程</button>
      <button disabled={busy || changed || !view?.classroom} onClick={() => void download()}>导出 maic 课件</button>
      <span role="status">{busy ? "正在处理…" : changed ? "有未保存修改" : view ? "已保存" : ""}</span>
    </header>
    {notice && <p role="status">{notice}</p>}
    {error && <p role="alert" className="maic-error">{error} <button disabled={busy} onClick={reloadSaved}>重新加载已保存版本</button></p>}
    <div className="maic-editor-layout">
      <nav aria-label="课程场景"><ol>{draft?.scenes.map((item, index) => <li key={item.id}>
        <button aria-current={item.id === selectedId ? "page" : undefined} onClick={() => setSelectedId(item.id)}>{index + 1}. {item.type === "quiz" ? "Quiz · " : item.actions?.some(a => a.type === "interaction_checkpoint" && a.checkpointKind === "chapter_summary") ? "互动 · " : "课件 · "}{item.title}</button>
      </li>)}</ol></nav>
      <main>
        {!draft && <button disabled={busy || readOnly} onClick={() => {
          const now = Date.now(); const id = crypto.randomUUID(); const generation = owner.current;
          setBusy(true); setError("");
          void api.coursewareClassroomCreate(sessionId, { id, stage: { id, name: "新课程", createdAt: now, updatedAt: now }, scenes: [], createdAt: new Date(now).toISOString() })
            .then(next => { if (generation === owner.current) { setView(next); setDraft(next.classroom ? clone(next.classroom) : undefined); } })
            .catch(failure => { if (generation === owner.current) setError(String(failure)); })
            .finally(() => { if (generation === owner.current) setBusy(false); });
        }}>创建标准课程</button>}
        {scene && <>
          {!preview && <div className="maic-scene-controls"><label>场景标题<input value={scene.title} disabled={!editable} onChange={event => updateScene({ ...scene, title: event.target.value })} /></label>
            <button disabled={!editable || draft?.scenes[0]?.id === scene.id} onClick={() => { if (!draft) return; const scenes = [...draft.scenes], index = scenes.findIndex(s => s.id === scene.id); [scenes[index - 1], scenes[index]] = [scenes[index], scenes[index - 1]]; edit({ ...draft, scenes: scenes.map((s, i) => ({ ...s, order: i + 1 })) }); }}>上移场景</button>
            <button disabled={!editable || draft?.scenes.at(-1)?.id === scene.id} onClick={() => { if (!draft) return; const scenes = [...draft.scenes], index = scenes.findIndex(s => s.id === scene.id); [scenes[index], scenes[index + 1]] = [scenes[index + 1], scenes[index]]; edit({ ...draft, scenes: scenes.map((s, i) => ({ ...s, order: i + 1 })) }); }}>下移场景</button>
            <button disabled={!editable || draft?.scenes.length === 1 || typeof scene.metadata?.nativePageId === "string"} title={typeof scene.metadata?.nativePageId === "string" ? "请先在 PPT 源文件中删除此页，再刷新课程。" : undefined} onClick={() => { if (draft && window.confirm("删除这个场景？")) { const scenes = draft.scenes.filter(item => item.id !== scene.id).map((s, i) => ({ ...s, order: i + 1 })); edit({ ...draft, scenes }); setSelectedId(scenes[0]?.id ?? ""); } }}>删除场景</button>
          </div>}
          {!preview && view && <ClassroomSpeechTools key={scene.id} sessionId={sessionId} view={view} scene={scene} disabled={!editable} dirty={changed}
            onBusy={setBusy} onChange={updateScene} onError={setError} onAdopt={next => {
              setView(next); setDraft(next.classroom ? clone(next.classroom) : undefined);
              if (draft) setUndo(items => [...items.slice(-19), clone(draft)]); setRedo([]);
            }} />}
          {scene.type === "quiz" ? <>
            {!preview && <label>测验模式<select value={scene.content.interactionMode ?? "assessment_review"} disabled={!editable} onChange={event => updateScene({ ...scene, content: { ...scene.content, interactionMode: event.target.value } })}><option disabled={(scene.content.questions?.length ?? 0) > 1} value="classroom_instant_feedback">课堂即时反馈（每页一题）</option><option value="assessment_review">测验与复盘</option></select></label>}
            {!preview && <fieldset disabled={!editable}><legend>播放设置</legend>
              <label>正确反馈<textarea value={String(scene.content.playbackConfig?.successSpeechText ?? initialPlayback.successSpeechText)} onChange={event => updateScene({ ...scene, content: { ...scene.content, playbackConfig: { ...initialPlayback, ...scene.content.playbackConfig, successSpeechText: event.target.value } } })} /></label>
              <label>错误反馈<textarea value={String(scene.content.playbackConfig?.failureSpeechText ?? initialPlayback.failureSpeechText)} onChange={event => updateScene({ ...scene, content: { ...scene.content, playbackConfig: { ...initialPlayback, ...scene.content.playbackConfig, failureSpeechText: event.target.value } } })} /></label>
              {(["cueUserOnEnter", "cueUserOnRetry"] as const).map(key => <label key={key}><input type="checkbox" checked={Boolean(scene.content.playbackConfig?.[key] ?? initialPlayback[key])} onChange={event => updateScene({ ...scene, content: { ...scene.content, playbackConfig: { ...initialPlayback, ...scene.content.playbackConfig, [key]: event.target.checked } } })} />{key === "cueUserOnEnter" ? "进入题目时提示作答" : "重试时提示作答"}</label>)}
            </fieldset>}
            {preview && <MaicQuiz key={scene.id} content={resolveQuizImages(scene.content, view?.resourceUrls) as ComponentProps<typeof MaicQuiz>["content"]} />}
            {!preview && scene.content.questions?.map((q, index) => <QuizForm key={q.id} question={q} index={index} disabled={!editable}
              resourceUrls={view?.resourceUrls} onChange={patch => updateQuestion(q.id, patch)} onImage={(file, value) => void upload(file, q, value)}
              onRemove={() => updateScene({ ...scene, content: { ...scene.content, questions: scene.content.questions?.filter(item => item.id !== q.id) } })} />)}
            {!preview && <button disabled={!editable || scene.content.interactionMode === "classroom_instant_feedback" && (scene.content.questions?.length ?? 0) > 0} onClick={() => updateScene({ ...scene, content: { ...scene.content, questions: [...(scene.content.questions ?? []), question()] } })}>添加题目</button>}
          </> : <>
            {!preview && <div><label>插入互动的位置<select disabled={!editable} value={Math.min(insertPosition, scene.actions?.length ?? 0)} onChange={event => setInsertPosition(Number(event.target.value))}>{Array.from({ length: (scene.actions?.length ?? 0) + 1 }, (_, index) => <option key={index} value={index}>{index === 0 ? "第一个动作之前" : `第 ${index} 个动作之后`}</option>)}</select></label>
              <button disabled={!editable} onClick={() => {
                const id = crypto.randomUUID(), elementId = `${id}_question`;
                const action = { id, type: "interaction_checkpoint", checkpointId: id, checkpointKind: "chapter_summary", chapterId: scene.id, chapterTitle: scene.title, question: "请描述你的想法", referenceAnswer: { summary: "", keyPoints: [] }, context: { chapterSummary: "", sourceSceneIds: [] } };
                const actions = [...scene.actions ?? []]; actions.splice(Math.min(insertPosition, actions.length), 0, action);
                const elements = Array.isArray(scene.content.canvas?.elements) ? scene.content.canvas.elements : [];
                setBindings(items => ({ ...items, [`${scene.id}:${id}`]: elementId }));
                updateScene({ ...scene, actions, content: { ...scene.content, canvas: { ...createInteractionCanvas(draft!, scene.id), ...scene.content.canvas, id: scene.content.canvas?.id ?? scene.id, elements: [...elements, { id: elementId, type: "text", content: "<p>请描述你的想法</p>", left: 80, top: 160, width: 840, height: 120, rotate: 0, defaultFontName: "Noto Sans SC", defaultColor: "#172033" }] } } });
              }}>插入互动动作</button></div>}
            {scene.actions?.map((action, actionIndex) => {
              if (action.type !== "interaction_checkpoint" || action.checkpointKind !== "chapter_summary") return null;
              const elements = Array.isArray(scene.content.canvas?.elements) ? scene.content.canvas.elements as Array<Record<string, unknown>> : [];
              const textElements = elements.filter(element => element.type === "text");
              const bindingKey = `${scene.id}:${String(action.id)}`;
              const boundId = bindings[bindingKey] ?? (textElements.some(element => element.id === `${scene.id}_question`) ? `${scene.id}_question` : "");
              return <div key={String(action.id)}>
                {!preview && <><label>问题对应的画布文本<select value={boundId} disabled={!editable} onChange={event => {
                  const elementId = event.target.value;
                  setBindings(items => ({ ...items, [bindingKey]: elementId }));
                  updateScene({ ...scene, metadata: { ...scene.metadata, nativeQuestionElementId: elementId } });
                }}><option value="">请选择需要同步的文本框</option>{textElements.map(element => <option key={String(element.id)} value={String(element.id)}>{String(element.id)}</option>)}</select></label>
                  {!boundId && <p role="status">修改问题前，请明确选择对应文本框；参考答案和上下文可独立编辑。</p>}
                  <button disabled={!editable} onClick={() => void regenerateReference(String(action.id))}>根据当前问题更新参考答案</button>
                  <span>教学动作位置 {actionIndex + 1} / {scene.actions?.length}</span>
                  <button disabled={!editable || actionIndex === 0} onClick={() => { const actions = [...scene.actions!]; [actions[actionIndex - 1], actions[actionIndex]] = [actions[actionIndex], actions[actionIndex - 1]]; updateScene({ ...scene, actions }); }}>前移互动</button>
                  <button disabled={!editable || actionIndex === scene.actions!.length - 1} onClick={() => { const actions = [...scene.actions!]; [actions[actionIndex + 1], actions[actionIndex]] = [actions[actionIndex], actions[actionIndex + 1]]; updateScene({ ...scene, actions }); }}>后移互动</button>
                  <button disabled={!editable} onClick={() => updateScene({ ...scene, actions: scene.actions?.filter(item => item.id !== action.id) })}>删除互动动作</button>
                </>}
                <InteractionForm action={action} preview={preview} disabled={!editable} questionDisabled={!boundId} onChange={patch => {
                  const next = { ...scene, actions: scene.actions?.map(item => item.id === action.id ? { ...item, ...patch } : item) };
                  if (typeof patch.question === "string") {
                    try { updateScene(updateCheckpointQuestion(scene, String(action.id), patch.question, boundId)); }
                    catch (failure) { setError(String(failure)); }
                    return;
                  }
                  updateScene(next);
                }} />
              </div>;
            })}
            {!scene.actions?.some(action => action.type === "interaction_checkpoint" && action.checkpointKind === "chapter_summary") && <p>此场景为普通课件页。返回 PPT 编辑可修改画布内容。</p>}
          </>}
        </>}
      </main>
    </div>
  </section>;
}

function ImageField({ image, label, disabled, onUpload, onRemove }: { image?: QuizImage; label: string; disabled: boolean; onUpload(file: File): void; onRemove(): void }) {
  return <div className="maic-image-field">{image && <img src={image.src} alt={label} />}
    <label>{label}<input type="file" accept="image/png,image/jpeg,image/webp" disabled={disabled} onChange={event => { const file = event.target.files?.[0]; if (file) onUpload(file); event.target.value = ""; }} /></label>
    {image && <button disabled={disabled} onClick={onRemove}>移除图片</button>}
  </div>;
}
function QuizForm({ question: q, index, disabled, resourceUrls, onChange, onImage, onRemove }: { question: QuizQuestion; index: number; disabled: boolean; resourceUrls?: Record<string, string>; onChange(patch: Partial<QuizQuestion>): void; onImage(file: File, value?: string): void; onRemove(): void }) {
  function setType(type: QuizQuestion["type"]) {
    const preserveChoices = ["single", "multiple"].includes(q.type) && ["single", "multiple"].includes(type);
    if (!preserveChoices && q.options?.length && !window.confirm("更改题型会重置选项与正确答案，是否继续？")) return;
    onChange({ type, hasAnswer: type !== "short_answer", options: type === "short_answer" ? undefined : type === "judge" ? [{ value: "T", label: "正确" }, { value: "F", label: "错误" }] : preserveChoices && q.options?.length ? q.options : [{ value: "A", label: "" }, { value: "B", label: "" }], answer: [] });
  }
  return <fieldset className="maic-question" disabled={disabled}><legend>题目 {index + 1}</legend>
    <label>题型<select value={q.type} onChange={event => setType(event.target.value as QuizQuestion["type"])}><option value="single">单选</option><option value="multiple">多选</option><option value="judge">判断</option><option value="short_answer">简答</option></select></label>
    <label>问题<textarea aria-label="问题" value={q.question} onChange={event => onChange({ question: event.target.value })} /></label>
    <ImageField image={q.image ? { ...q.image, src: resourceUrls?.[q.image.src] ?? q.image.src } : undefined} label="题目图片" disabled={disabled} onUpload={file => onImage(file)} onRemove={() => onChange({ image: undefined })} />
    {q.options?.map((option, position) => <div key={option.value} className="maic-option">
      <label><input type={q.type === "multiple" ? "checkbox" : "radio"} name={`correct-${q.id}`} checked={q.answer?.includes(option.value) ?? false} onChange={() => onChange({ answer: q.type === "multiple" ? q.answer?.includes(option.value) ? q.answer.filter(value => value !== option.value) : [...(q.answer ?? []), option.value] : [option.value] })} />正确答案 {option.value}</label>
      <label>选项文字<input value={option.label} onChange={event => onChange({ options: q.options?.map(item => item.value === option.value ? { ...item, label: event.target.value } : item) })} /></label>
      <ImageField image={option.image ? { ...option.image, src: resourceUrls?.[option.image.src] ?? option.image.src } : undefined} label={`选项 ${option.value} 图片`} disabled={disabled} onUpload={file => onImage(file, option.value)} onRemove={() => onChange({ options: q.options?.map(item => item.value === option.value ? { ...item, image: undefined } : item) })} />
      <button disabled={position === 0} onClick={() => { const options = [...q.options!]; [options[position - 1], options[position]] = [options[position], options[position - 1]]; onChange({ options }); }}>上移选项</button>
      <button disabled={q.type === "judge" || (q.options?.length ?? 0) <= 2} onClick={() => onChange(removeQuestionOption(q, option.value))}>删除选项</button>
    </div>)}
    {q.type !== "short_answer" && q.type !== "judge" && <button disabled={!newOptionValue(q)} onClick={() => { const value = newOptionValue(q); if (value) onChange({ options: [...(q.options ?? []), { value, label: "" }] }); }}>添加选项</button>}
    <label>解析<textarea value={q.analysis ?? ""} onChange={event => onChange({ analysis: event.target.value })} /></label>
    {q.type === "short_answer" && <><label>参考答案<textarea aria-label="参考答案" value={q.answer?.[0] ?? q.referenceAnswer ?? ""} onChange={event => onChange(shortAnswerReferencePatch(event.target.value))} /></label><label>关键点（每行一项）<textarea value={q.keyPoints?.join("\n") ?? ""} onChange={event => onChange({ keyPoints: event.target.value.split("\n") })} /></label><label>评分提示<textarea value={q.commentPrompt ?? ""} onChange={event => onChange({ commentPrompt: event.target.value })} /></label></>}
    <label>分值<input type="number" min={0} value={q.points ?? 1} onChange={event => onChange({ points: event.target.valueAsNumber })} /></label>
    <button onClick={onRemove}>删除题目</button>
  </fieldset>;
}
function InteractionForm({ action, disabled, preview, questionDisabled, onChange }: { action: Record<string, unknown>; disabled: boolean; preview: boolean; questionDisabled: boolean; onChange(patch: Record<string, unknown>): void }) {
  const reference = action.referenceAnswer as { summary: string; keyPoints: string[] };
  const context = action.context as { chapterSummary: string; sourceSceneIds: string[]; sourceOutlineIds?: string[]; keyTerms?: string[] };
  return <fieldset className="maic-question" disabled={disabled}><legend>课堂互动</legend>
    {preview ? <p>{String(action.question)}</p> : <>
      <label>问题<textarea aria-label="问题" disabled={questionDisabled} value={String(action.question ?? "")} onChange={event => onChange({ question: event.target.value })} /></label>
      <label>参考答案<textarea aria-label="参考答案" value={reference?.summary ?? ""} onChange={event => onChange({ referenceAnswer: { ...reference, summary: event.target.value } })} /></label>
      <label>关键点（每行一项）<textarea value={reference?.keyPoints?.join("\n") ?? ""} onChange={event => onChange({ referenceAnswer: { ...reference, keyPoints: event.target.value.split("\n") } })} /></label>
      <label>章节 ID<input value={String(action.chapterId ?? "")} onChange={event => onChange({ chapterId: event.target.value })} /></label>
      <label>章节标题<input value={String(action.chapterTitle ?? "")} onChange={event => onChange({ chapterTitle: event.target.value })} /></label>
      <label>章节摘要<textarea value={context?.chapterSummary ?? ""} onChange={event => onChange({ context: { ...context, chapterSummary: event.target.value } })} /></label>
      <label>来源场景 ID（每行一项）<textarea value={context?.sourceSceneIds?.join("\n") ?? ""} onChange={event => onChange({ context: { ...context, sourceSceneIds: event.target.value.split("\n").filter(Boolean) } })} /></label>
      <label>来源大纲 ID（每行一项）<textarea value={context?.sourceOutlineIds?.join("\n") ?? ""} onChange={event => onChange({ context: { ...context, sourceOutlineIds: event.target.value.split("\n").filter(Boolean) } })} /></label>
      <label>关键术语（每行一项）<textarea value={context?.keyTerms?.join("\n") ?? ""} onChange={event => onChange({ context: { ...context, keyTerms: event.target.value.split("\n").filter(Boolean) } })} /></label>
      <label>约束性提示词<textarea value={String(action.constraintPrompt ?? "")} onChange={event => onChange({ constraintPrompt: event.target.value })} /></label>
    </>}
  </fieldset>;
}

function resolveQuizImages(content: ClassroomScene["content"], urls?: Record<string, string>): ClassroomScene["content"] {
  return { ...content, questions: content.questions?.map(q => ({ ...q,
    image: q.image ? { ...q.image, src: urls?.[q.image.src] ?? q.image.src } : undefined,
    options: q.options?.map(option => ({ ...option, image: option.image ? { ...option.image, src: urls?.[option.image.src] ?? option.image.src } : undefined })),
  })) };
}
