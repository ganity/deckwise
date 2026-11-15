import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { parseMaicClassroom } from "@pi-desktop/courseware-runtime/player";
import { ClassroomSpeechTools } from "./ClassroomSpeechTools";
import { ClassroomOptionImageTools } from "./ClassroomOptionImageTools";
import { api } from "../../lib/api";
import "@pi-desktop/courseware-runtime/player.css";
import "./courseware-classroom-editor.css";

import { clone, copyClassroomScene, initialPlayback, question, createInteractionCanvas, shortAnswerReferencePatch, recoverClassroomDraft, updateCheckpointQuestion, pruneQuizImageBindings, pruneRemovedSceneBindings, removeQuestionOption, newOptionValue, type QuizImage, type QuizQuestion, type ClassroomScene, type ClassroomDocument, type ClassroomEditorView } from "../../lib/courseware-classroom";

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

export type ClassroomEditorToolbar = {
  status: string;
  canUndo: boolean; canRedo: boolean; canSave: boolean; canPlay: boolean; canRefresh: boolean;
  undo(): void; redo(): void; save(): void; play(): void; refresh(): void;
};

export type ClassroomEditorTransport = Pick<typeof api,
  "coursewareClassroomOpen" | "coursewareClassroomWrite" | "coursewareClassroomImage" | "coursewareClassroomReference" |
  "coursewareClassroomExport" | "coursewareClassroomPlay" | "coursewareClassroomCreate" |
  "coursewareClassroomTtsModels" | "coursewareClassroomTtsQuote" | "coursewareClassroomTtsSubmit" | "coursewareClassroomTtsRefresh" |
  "coursewareClassroomImageModels" | "coursewareClassroomImageQuote" | "coursewareClassroomImageSubmit" | "coursewareClassroomImageRefresh">;

export function CoursewareClassroomEditor({ sessionId, readOnly = false, initialPageIndex = 0, sidebar = false, refreshKey, initialView, onToolbarChange, transport = api }: { sessionId: string; readOnly?: boolean; initialPageIndex?: number; sidebar?: boolean; refreshKey?: string; initialView?: ClassroomEditorView; onToolbarChange?(toolbar: ClassroomEditorToolbar): void; transport?: ClassroomEditorTransport }) {
  const { t } = useTranslation();
  const [view, setView] = useState<ClassroomEditorView>();
  const [draft, setDraft] = useState<ClassroomDocument>();
  const [selectedId, setSelectedId] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const [bindings, setBindings] = useState<Record<string, string>>({});
  const [undo, setUndo] = useState<ClassroomDocument[]>([]);
  const [redo, setRedo] = useState<ClassroomDocument[]>([]);
  const latestRefreshKey = useRef(refreshKey);
  latestRefreshKey.current = refreshKey;
  const owner = useRef(0);
  const pending = useRef(0);
  useEffect(() => {
    const generation = ++owner.current;
    pending.current = 0;
    setBusy(true); setError(""); setNotice(""); setBindings({}); setView(undefined); setDraft(undefined);
    void (initialView && reload === 0 ? Promise.resolve(initialView) : transport.coursewareClassroomOpen(sessionId)).then(result => {
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
      setView(next); setDraft(restored); setSelectedId(restored?.scenes[initialPageIndex]?.id ?? restored?.scenes[0]?.id ?? ""); setUndo([]); setRedo([]);
    }).catch(failure => { if (generation === owner.current) setError(String(failure)); })
      .finally(() => { if (generation === owner.current) setBusy(false); });
    return () => { ++owner.current; };
  }, [sessionId, reload]);
  const scene = draft?.scenes.find(item => item.id === selectedId);
  const speechTargets = scene?.type === "quiz"
    ? [{ key: scene.id, text: (scene.content.questions ?? []).map(q => [q.question, ...(q.options ?? []).map(option => `${option.value}. ${option.label}`)].join("\n")).join("\n\n") }]
    : scene?.actions?.flatMap(action => action.type === "interaction_checkpoint" && action.checkpointKind === "chapter_summary"
      ? [{ key: String(action.id), text: String(action.question ?? "") }] : []) ?? [];
  // Native navigation supplies images for the selected page without changing the classroom revision.
  const resourceUrls = view && initialView?.projectId === view.projectId && initialView.revision === view.revision && initialView.sourceRevision === view.sourceRevision
    ? { ...view.resourceUrls, ...initialView.resourceUrls } : view?.resourceUrls;
  useEffect(() => {
    if (sidebar && draft) setSelectedId(draft.scenes[initialPageIndex]?.id ?? "");
  }, [sidebar, initialPageIndex, draft?.scenes.length]);
  async function download() {
    if (!view || busy || changed) return;
    setBusy(true); setError("");
    try {
      const result = await transport.coursewareClassroomExport(sessionId, view.projectId, view.revision, view.sourceRevision);
      const url = URL.createObjectURL(new Blob([new Uint8Array(result.bytes)], { type: "application/zip" }));
      const anchor = document.createElement("a"); anchor.href = url; anchor.download = result.fileName; anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (failure) { setError(String(failure)); }
    finally { setBusy(false); }
  }
  const changed = !!draft && !!view && JSON.stringify(draft) !== JSON.stringify(view.classroom);
  const observedSource = useRef(refreshKey);
  useEffect(() => {
    if (refreshKey === observedSource.current || busy || changed) return;
    observedSource.current = refreshKey;
    if (sidebar) setReload(value => value + 1);
  }, [refreshKey, sidebar, busy, changed]);
  const editable = !readOnly && !busy;
  const pendingNativeScene = draft?.scenes.find(item => item.metadata?.nativeTeachingSyncPending === true);
  const nativeTeachingPending = !!pendingNativeScene;
  function edit(next: ClassroomDocument) {
    if (!draft || !editable) return;
    setUndo(items => [...items.slice(-19), clone(draft)]); setRedo([]); setDraft(pruneQuizImageBindings(pruneRemovedSceneBindings(next, draft))); setError("");
  }
  function updateScene(next: ClassroomScene) {
    const invalidated = new Set(scene?.actions?.filter(action => action.type === "speech" &&
      !next.actions?.some(item => item.id === action.id && item.text === action.text)).map(action => action.id));
    if (draft) edit({ ...draft, scenes: draft.scenes.map(item => item.id === next.id ? next : item),
      audioManifest: draft.audioManifest?.filter(entry => entry.sceneId !== next.id || !invalidated.has(entry.actionId)) });
  }
  function speechTools(target?: { key: string; text: string }) {
    return view && scene && <ClassroomSpeechTools key={target?.key ?? `narration-${scene.id}`} sessionId={sessionId} view={view} scene={scene} transport={transport} disabled={!editable} dirty={changed}
      speechActionId={target ? String((scene.metadata?.assessmentSpeechIds as Record<string, string> | undefined)?.[target.key] ?? `${target.key}-question-tts`) : undefined}
      speechText={target?.text} onBusy={setBusy} onChange={updateScene} onError={setError} onAdopt={next => {
        observedSource.current = latestRefreshKey.current;
        setView(next); setDraft(next.classroom ? clone(next.classroom) : undefined);
        if (draft) setUndo(items => [...items.slice(-19), clone(draft)]); setRedo([]);
      }} />;
  }
  function updateQuestion(id: string, patch: Partial<QuizQuestion>) {
    if (scene) updateScene({ ...scene, content: { ...scene.content, questions: scene.content.questions?.map(q => q.id === id ? { ...q, ...patch } : q) } });
  }
  async function save() {
    if (!view || !draft || pending.current === owner.current || busy || readOnly) return;
    const generation = owner.current;
    setBusy(true); setError("");
    try {
      const next = await transport.coursewareClassroomWrite(sessionId, view.projectId, view.revision, view.sourceRevision, draft) as ClassroomEditorView;
      if (owner.current === generation) { observedSource.current = latestRefreshKey.current; setView(next); setDraft(next.classroom ? clone(next.classroom) : undefined); }
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
      // Attach the image and unsaved question edits in one revision-fenced commit.
      const next = await transport.coursewareClassroomImage(sessionId, view.projectId, view.revision, view.sourceRevision,
        { sceneId, questionId, ...(optionValue ? { optionValue } : {}), dataUrl: image.src, classroom: draft });
      if (generation === owner.current && contentBefore === JSON.stringify(draft)) {
        observedSource.current = latestRefreshKey.current;
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
      const saved = await transport.coursewareClassroomWrite(sessionId, view.projectId, view.revision, view.sourceRevision, draft);
      if (generation !== owner.current) return;
      setView(saved);
      const next = await transport.coursewareClassroomReference(sessionId, saved.projectId, saved.revision, saved.sourceRevision, scene.id, actionId);
      if (generation !== owner.current) return;
      observedSource.current = latestRefreshKey.current;
      setView(next); setDraft(next.classroom ? clone(next.classroom) : undefined);
      setUndo(items => [...items.slice(-19), clone(draft)]); setRedo([]);
    } catch (failure) { if (generation === owner.current) setError(String(failure)); }
    finally { if (generation === owner.current) setBusy(false); }
  }
  async function play() {
    if (!view || changed || busy) return;
    const generation = owner.current; setBusy(true); setError("");
    try { await transport.coursewareClassroomPlay(sessionId, view.projectId, view.revision, view.sourceRevision, "zh-CN"); }
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
      : { id, stageId, type: "slide", title: "课堂互动", order: 0, content: { type: "slide", canvas: { ...createInteractionCanvas(draft, id) } }, actions: [checkpoint], metadata: { interaction: { kind: "chapter_summary", chapterId: id, chapterTitle: "课堂互动", sourceSceneIds: [] } } };
    const index = draft.scenes.findIndex(item => item.id === selectedId);
    const scenes = [...draft.scenes]; scenes.splice(index + 1, 0, next);
    edit({ ...draft, scenes: scenes.map((item, position) => ({ ...item, order: position + 1 })) }); setSelectedId(id);
  }
  const status = busy ? "正在处理…" : changed ? "等待自动保存…" : view ? "已自动保存" : "";
  const undoEdit = () => { if (draft) { setRedo(items => [...items, clone(draft)]); setDraft(undo.at(-1)); setUndo(items => items.slice(0, -1)); } };
  const redoEdit = () => { if (draft) { setUndo(items => [...items, clone(draft)]); setDraft(redo.at(-1)); setRedo(items => items.slice(0, -1)); } };
  useEffect(() => {
    onToolbarChange?.({
      status, canUndo: editable && !!undo.length, canRedo: editable && !!redo.length,
      canSave: editable && changed, canPlay: !busy && !changed && !!view?.classroom, canRefresh: !busy,
      undo: undoEdit, redo: redoEdit, save: () => void save(), play: () => void play(),
      refresh: () => { if (changed) void save(); else setReload(value => value + 1); },
    });
  });
  return <section className={`maic-editor${sidebar ? " maic-editor-sidebar" : ""}`} aria-label="课程内容编辑器">
    {!onToolbarChange && <div className="maic-editor-toolbar" role="toolbar" aria-label="题目编辑工具">
      <strong>{sidebar ? scene?.type === "quiz" ? "Quiz 编辑" : scene?.actions?.some(a => a.type === "interaction_checkpoint" && a.checkpointKind === "chapter_summary") ? "课堂互动编辑" : "本页题目" : "课程内容"}</strong>
      {!sidebar && <>
      <button disabled={!editable} onClick={() => addScene("quiz")}>添加 Quiz</button>
      <button disabled={!editable} onClick={() => addScene("interaction")}>添加互动</button>
      </>}
      <button disabled={!editable || !undo.length} onClick={undoEdit}>撤销</button>
      <button disabled={!editable || !redo.length} onClick={redoEdit}>重做</button>
      {!sidebar && <button disabled={busy || readOnly || !changed} onClick={() => void save()}>保存课程</button>}
      {sidebar && error && changed && <button disabled={busy || readOnly} onClick={() => void save()}>重试保存</button>}
      {sidebar && <button disabled={busy || changed || !view?.classroom} onClick={() => void play()}>课件预览</button>}
      {!sidebar && <><button disabled={busy || changed || !view?.classroom || nativeTeachingPending} onClick={() => void play()}>播放整个课程</button>
      <button disabled={busy || changed || !view?.classroom || nativeTeachingPending} onClick={() => void download()}>导出 maic 课件</button></>}
      <span role="status">{status}</span>
    </div>}
    {!sidebar && pendingNativeScene && <p role="status">本页原生教学暂不能同步到 MAIC：{String(pendingNativeScene.metadata?.nativeTeachingSyncReason ?? "存在无法转换的教学动作")}。完整课程播放和导出暂不可用；请先调整本页教学动作。</p>}
    {notice && <p role="status">{notice}</p>}
    {error && <p role="alert" className="maic-error">{error} <button disabled={busy} onClick={reloadSaved}>重新加载已保存版本</button></p>}
    <div className="maic-editor-layout">
      {!sidebar && <nav aria-label="课程场景"><ol>{draft?.scenes.map((item, index) => <li key={item.id}>
        <button aria-current={item.id === selectedId ? "page" : undefined} onClick={() => setSelectedId(item.id)}>{index + 1}. {item.type === "quiz" ? "Quiz · " : item.actions?.some(a => a.type === "interaction_checkpoint" && a.checkpointKind === "chapter_summary") ? "互动 · " : "课件 · "}{item.title}</button>
      </li>)}</ol></nav>}
      <main>
        {!draft && !sidebar && <button disabled={busy || readOnly} onClick={() => {
          const now = Date.now(); const id = crypto.randomUUID(); const generation = owner.current;
          setBusy(true); setError("");
          void transport.coursewareClassroomCreate(sessionId, { id, stage: { id, name: "新课程", createdAt: now, updatedAt: now }, scenes: [], createdAt: new Date(now).toISOString() })
            .then(next => { if (generation === owner.current) { setView(next); setDraft(next.classroom ? clone(next.classroom) : undefined); } })
            .catch(failure => { if (generation === owner.current) setError(String(failure)); })
            .finally(() => { if (generation === owner.current) setBusy(false); });
        }}>创建标准课程</button>}
        {scene && <>
          {(!sidebar || scene.type === "quiz") && <div className="maic-scene-controls"><label>场景标题<input value={scene.title} disabled={!editable} onChange={event => updateScene({ ...scene, title: event.target.value })} /></label>
            {!sidebar && <><button disabled={!editable || draft?.scenes[0]?.id === scene.id} onClick={() => { if (!draft) return; const scenes = [...draft.scenes], index = scenes.findIndex(s => s.id === scene.id); [scenes[index - 1], scenes[index]] = [scenes[index], scenes[index - 1]]; edit({ ...draft, scenes: scenes.map((s, i) => ({ ...s, order: i + 1 })) }); }}>上移场景</button>
            <button disabled={!editable || draft?.scenes.at(-1)?.id === scene.id} onClick={() => { if (!draft) return; const scenes = [...draft.scenes], index = scenes.findIndex(s => s.id === scene.id); [scenes[index], scenes[index + 1]] = [scenes[index + 1], scenes[index]]; edit({ ...draft, scenes: scenes.map((s, i) => ({ ...s, order: i + 1 })) }); }}>下移场景</button>
            <button disabled={!editable} onClick={() => { if (draft) { const id = crypto.randomUUID(); edit(copyClassroomScene(draft, scene.id, id)); setSelectedId(id); } }}>{t("panel.pptEditor.copyScene")}</button>
            <button disabled={!editable || draft?.scenes.length === 1} onClick={() => { if (draft && window.confirm("删除这个场景？")) { const scenes = draft.scenes.filter(item => item.id !== scene.id).map((s, i) => ({ ...s, order: i + 1 })); edit({ ...draft, scenes }); setSelectedId(scenes[0]?.id ?? ""); } }}>删除场景</button></>}
          </div>}
          {(!sidebar || !speechTargets.length) && speechTools()}
          {scene.type === "quiz" ? <>
            {scene.content.questions?.map((q, index) => <div key={q.id}><QuizForm question={q} index={index} compact={sidebar} disabled={!editable}
              speechTools={index === 0 ? speechTools(speechTargets[0]) : undefined}
              resourceUrls={resourceUrls} onChange={patch => updateQuestion(q.id, patch)} onImage={(file, value) => void upload(file, q, value)}
              />{view && (q.type === "single" || q.type === "multiple") && <ClassroomOptionImageTools sessionId={sessionId} view={view} sceneId={scene.id} questionId={q.id} options={q.options ?? []}
                disabled={!editable} dirty={changed} transport={transport} onBusy={setBusy} onError={setError} onAdopt={next => {
                  observedSource.current = latestRefreshKey.current; setView(next); setDraft(next.classroom ? clone(next.classroom) : undefined);
                  if (draft) setUndo(items => [...items.slice(-19), clone(draft)]); setRedo([]);
                }} />}</div>)}
            <details><summary>答题反馈设置</summary><fieldset disabled={!editable}><legend>播放设置</legend>
              <label>正确反馈<textarea value={String(scene.content.playbackConfig?.successSpeechText ?? initialPlayback.successSpeechText)} onChange={event => updateScene({ ...scene, content: { ...scene.content, playbackConfig: { ...initialPlayback, ...scene.content.playbackConfig, successSpeechText: event.target.value } } })} /></label>
              <label>错误反馈<textarea value={String(scene.content.playbackConfig?.failureSpeechText ?? initialPlayback.failureSpeechText)} onChange={event => updateScene({ ...scene, content: { ...scene.content, playbackConfig: { ...initialPlayback, ...scene.content.playbackConfig, failureSpeechText: event.target.value } } })} /></label>
              {(["cueUserOnEnter", "cueUserOnRetry"] as const).map(key => <label key={key}><input type="checkbox" checked={Boolean(scene.content.playbackConfig?.[key] ?? initialPlayback[key])} onChange={event => updateScene({ ...scene, content: { ...scene.content, playbackConfig: { ...initialPlayback, ...scene.content.playbackConfig, [key]: event.target.checked } } })} />{key === "cueUserOnEnter" ? "进入题目时提示作答" : "重试时提示作答"}</label>)}
            </fieldset></details>

          </> : <>
            {scene.actions?.map((action) => {
              if (action.type !== "interaction_checkpoint" || action.checkpointKind !== "chapter_summary") return null;
              const elements = Array.isArray(scene.content.canvas?.elements) ? scene.content.canvas.elements as Array<Record<string, unknown>> : [];
              const textElements = elements.filter(element => element.type === "text");
              const bindingKey = `${scene.id}:${String(action.id)}`;
              const boundId = bindings[bindingKey] ?? (typeof scene.metadata?.nativeQuestionElementId === "string" ? scene.metadata.nativeQuestionElementId : undefined) ?? (textElements.some(element => element.id === `${scene.id}_question`) ? `${scene.id}_question` : "");
              return <div key={String(action.id)}>
                <details open={!boundId}><summary>问题文本框绑定</summary><label>问题对应的画布文本<select value={boundId} disabled={!editable} onChange={event => {
                  const elementId = event.target.value;
                  setBindings(items => ({ ...items, [bindingKey]: elementId }));
                  updateScene({ ...scene, metadata: { ...scene.metadata, nativeQuestionElementId: elementId } });
                }}><option value="">请选择需要同步的文本框</option>{textElements.map(element => <option key={String(element.id)} value={String(element.id)}>{String(element.id)}</option>)}</select></label>
                  {!boundId && <p role="status">修改问题前，请明确选择对应文本框；参考答案和上下文可独立编辑。</p>}
                </details>
                <InteractionForm action={action} onRegenerate={() => void regenerateReference(String(action.id))} disabled={!editable} questionDisabled={!boundId} onChange={patch => {
                  const next = { ...scene, actions: scene.actions?.map(item => item.id === action.id ? { ...item, ...patch } : item) };
                  if (typeof patch.question === "string") {
                    try { updateScene(updateCheckpointQuestion(scene, String(action.id), patch.question, boundId)); }
                    catch (failure) { setError(String(failure)); }
                    return;
                  }
                  updateScene(next);
                }} speechTools={speechTools(speechTargets.find(target => target.key === action.id))} />
              </div>;
            })}
            {!scene.actions?.some(action => action.type === "interaction_checkpoint" && action.checkpointKind === "chapter_summary") && <p>此场景为普通课件页。返回 PPT 编辑可修改画布内容。</p>}
          </>}
        </>}
      </main>
    </div>
  </section>;
}

function ImageField({ image, label, disabled, onUpload, onRemove }: { image?: QuizImage; label: string; disabled: boolean; onUpload(file: File): void; onRemove?(): void }) {
  const input = useRef<HTMLInputElement>(null);
  return <div className="maic-image-field">{image && <img src={image.src} alt={label} />}
    <span>{label}</span>
    <input ref={input} hidden aria-label={label} type="file" accept="image/png,image/jpeg,image/webp" disabled={disabled} onChange={event => { const file = event.target.files?.[0]; if (file) onUpload(file); event.target.value = ""; }} />
    <button disabled={disabled} onClick={() => input.current?.click()}>上传图片</button>
    {image && <button disabled={disabled} onClick={onRemove}>移除图片</button>}
  </div>;
}
function QuizForm({ question: q, index, compact = false, disabled, resourceUrls, speechTools, onChange, onImage, onRemove }: { question: QuizQuestion; index: number; compact?: boolean; disabled: boolean; resourceUrls?: Record<string, string>; speechTools?: ReactNode; onChange(patch: Partial<QuizQuestion>): void; onImage(file: File, value?: string): void; onRemove?(): void }) {
  const { t } = useTranslation();
  function setType(type: QuizQuestion["type"]) {
    const preserveChoices = ["single", "multiple"].includes(q.type) && ["single", "multiple"].includes(type);
    if (!preserveChoices && q.options?.length && !window.confirm("更改题型会重置选项与正确答案，是否继续？")) return;
    onChange({ type, hasAnswer: type !== "short_answer", options: type === "short_answer" ? undefined : type === "judge" ? [{ value: "T", label: "正确" }, { value: "F", label: "错误" }] : preserveChoices && q.options?.length ? q.options : [{ value: "A", label: "" }, { value: "B", label: "" }], answer: [] });
  }
  return <fieldset className="maic-question" disabled={disabled}><legend>{compact ? "Quiz" : `题目 ${index + 1}`}</legend>
    <label>{t("panel.pptEditor.questionType")}<select aria-label={t("panel.pptEditor.questionType")} value={q.type} onChange={event => setType(event.target.value as QuizQuestion["type"])}><option value="single">选择题</option>{(!compact || q.type === "multiple") && <option value="multiple">多选题</option>}<option value="judge">判断题</option>{(!compact || q.type === "short_answer") && <option value="short_answer">简答题</option>}</select></label>
    <label>问题<textarea aria-label="问题" value={q.question} onChange={event => onChange({ question: event.target.value })} /></label>
    {speechTools}
    <ImageField image={q.image ? { ...q.image, src: resourceUrls?.[q.image.src] ?? q.image.src } : undefined} label="题目图片" disabled={disabled} onUpload={file => onImage(file)} onRemove={() => onChange({ image: undefined })} />
    {q.options?.length ? <p>点击选项字母设置正确答案；选择题保留 2 至 4 个选项。</p> : null}
    {q.options?.map((option, position) => <div key={option.value} className="maic-option">
      <div className="maic-option-row">
        <button className="maic-answer-option" aria-label={`正确答案 ${option.value}`} aria-pressed={q.answer?.includes(option.value) ?? false} onClick={() => onChange({ answer: q.type === "multiple" ? q.answer?.includes(option.value) ? q.answer.filter(value => value !== option.value) : [...(q.answer ?? []), option.value] : [option.value] })}>{option.value}</button>
        <input aria-label="选项文字" value={option.label} onChange={event => onChange({ options: q.options?.map(item => item.value === option.value ? { ...item, label: event.target.value } : item) })} />
        <button disabled={q.type === "judge" || (q.options?.length ?? 0) <= 2} onClick={() => onChange(removeQuestionOption(q, option.value))}>删除选项</button>
      </div>
      <ImageField image={option.image ? { ...option.image, src: resourceUrls?.[option.image.src] ?? option.image.src } : undefined} label={`选项 ${option.value} 图片`} disabled={disabled} onUpload={file => onImage(file, option.value)} onRemove={() => onChange({ options: q.options?.map(item => item.value === option.value ? { ...item, image: undefined } : item) })} />
      {!compact && <button disabled={position === 0} onClick={() => { const options = [...q.options!]; [options[position - 1], options[position]] = [options[position], options[position - 1]]; onChange({ options }); }}>上移选项</button>}
    </div>)}
    {q.type !== "short_answer" && q.type !== "judge" && <button disabled={!newOptionValue(q)} onClick={() => { const value = newOptionValue(q); if (value) onChange({ options: [...(q.options ?? []), { value, label: "" }] }); }}>添加选项</button>}
    <label>{compact ? "解析 / 讲评" : "解析"}<textarea value={q.analysis ?? ""} onChange={event => onChange({ analysis: event.target.value })} /></label>
    {q.type === "short_answer" && <><label>参考答案<textarea aria-label="参考答案" value={q.answer?.[0] ?? q.referenceAnswer ?? ""} onChange={event => onChange(shortAnswerReferencePatch(event.target.value))} /></label><label>关键点（每行一项）<textarea value={q.keyPoints?.join("\n") ?? ""} onChange={event => onChange({ keyPoints: event.target.value.split("\n") })} /></label><label>评分提示<textarea value={q.commentPrompt ?? ""} onChange={event => onChange({ commentPrompt: event.target.value })} /></label></>}
    {!compact && <label>分值<input type="number" min={0} value={q.points ?? 1} onChange={event => onChange({ points: event.target.valueAsNumber })} /></label>}
    {onRemove && <button onClick={onRemove}>删除题目</button>}
  </fieldset>;
}
function InteractionForm({ action, onRegenerate, disabled, questionDisabled, speechTools, onChange }: { action: Record<string, unknown>; onRegenerate(): void; disabled: boolean; questionDisabled: boolean; speechTools?: ReactNode; onChange(patch: Record<string, unknown>): void }) {
  const reference = action.referenceAnswer as { summary: string; keyPoints: string[]; label?: string };
  const context = action.context as { chapterSummary: string; sourceSceneIds: string[]; sourceOutlineIds?: string[]; keyTerms?: string[] };
  return <fieldset className="maic-question" disabled={disabled}><legend>课堂互动</legend>
    <div>
      <label>问题<textarea aria-label="问题" disabled={questionDisabled} value={String(action.question ?? "")} onChange={event => onChange({ question: event.target.value })} /></label>
      {speechTools}
      <label>约束性提示词<textarea value={String(action.constraintPrompt ?? "")} placeholder="例如：只回答与本章相关的内容，用简短的语言回答。留空则按默认方式回答。" onChange={event => onChange({ constraintPrompt: event.target.value })} /></label>
      <button disabled={disabled} onClick={onRegenerate}>根据当前问题更新参考答案</button>
      <p>更新会同时替换参考答案和关键点。</p>
      <label>参考答案<textarea aria-label="参考答案" value={reference?.summary ?? ""} onChange={event => onChange({ referenceAnswer: { ...reference, summary: event.target.value } })} /></label>
      <div className="maic-keypoints"><span>关键点</span><button onClick={() => onChange({ referenceAnswer: { ...reference, keyPoints: [...(reference?.keyPoints ?? []), ""] } })}>添加关键点</button>
        {(reference?.keyPoints ?? []).map((point, index) => <div key={index}>
          <textarea aria-label={`关键点 ${index + 1}`} value={point} onChange={event => onChange({ referenceAnswer: { ...reference, keyPoints: reference.keyPoints.map((item, position) => position === index ? event.target.value : item) } })} />
          <button aria-label={`删除关键点 ${index + 1}`} onClick={() => onChange({ referenceAnswer: { ...reference, keyPoints: reference.keyPoints.filter((_, position) => position !== index) } })}>删除</button>
        </div>)}
      </div>
      <details><summary>更多上下文设置</summary>
      <label>参考答案标签<input value={reference?.label ?? ""} onChange={event => onChange({ referenceAnswer: { ...reference, label: event.target.value } })} /></label>
      <label>章节 ID<input value={String(action.chapterId ?? "")} onChange={event => onChange({ chapterId: event.target.value })} /></label>
      <label>章节标题<input value={String(action.chapterTitle ?? "")} onChange={event => onChange({ chapterTitle: event.target.value })} /></label>
      <label>章节摘要<textarea value={context?.chapterSummary ?? ""} onChange={event => onChange({ context: { ...context, chapterSummary: event.target.value } })} /></label>
      <label>来源场景 ID（每行一项）<textarea value={context?.sourceSceneIds?.join("\n") ?? ""} onChange={event => onChange({ context: { ...context, sourceSceneIds: event.target.value.split("\n").filter(Boolean) } })} /></label>
      <label>来源大纲 ID（每行一项）<textarea value={context?.sourceOutlineIds?.join("\n") ?? ""} onChange={event => onChange({ context: { ...context, sourceOutlineIds: event.target.value.split("\n").filter(Boolean) } })} /></label>
      <label>关键术语（每行一项）<textarea value={context?.keyTerms?.join("\n") ?? ""} onChange={event => onChange({ context: { ...context, keyTerms: event.target.value.split("\n").filter(Boolean) } })} /></label>
      </details>
      <p>仅对本互动页生效，修改后自动保存。</p>
    </div>
  </fieldset>;
}
