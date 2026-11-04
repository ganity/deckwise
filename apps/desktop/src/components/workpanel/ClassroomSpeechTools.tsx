import { useEffect, useRef, useState } from "react";
import type { CoursewareTtsModel } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import type { ClassroomEditorView, ClassroomScene, ClassroomTtsResult, ClassroomTtsSelection } from "../../lib/courseware-classroom";

export function ClassroomSpeechTools({ sessionId, view, scene, disabled, dirty, onBusy, onAdopt, onChange, onError }: {
  sessionId: string; view: ClassroomEditorView; scene: ClassroomScene; disabled: boolean; dirty: boolean;
  onBusy(value: boolean): void; onAdopt(view: ClassroomEditorView): void;
  onChange(scene: ClassroomScene): void; onError(error: string): void;
}) {
  const [opened, setOpened] = useState(false);
  const [models, setModels] = useState<CoursewareTtsModel[]>([]);
  const [model, setModel] = useState("");
  const [voice, setVoice] = useState("");
  const [actionId, setActionId] = useState("");
  const [result, setResult] = useState<ClassroomTtsResult>();
  const [running, setRunning] = useState(false);
  const owner = useRef(0);
  const actions = scene.actions?.filter(action => action.type === "speech") ?? [];
  const selected = actions.find(action => action.id === actionId) ?? actions[0];
  const selectionKey = [sessionId, view.projectId, view.revision, view.sourceRevision, scene.id, selected?.id, model, voice].join(":");
  useEffect(() => { ++owner.current; setResult(undefined); return () => { ++owner.current; }; }, [selectionKey]);
  async function loadModels() {
    const generation = owner.current; setRunning(true); onError("");
    try {
      const values = await api.coursewareClassroomTtsModels(sessionId);
      if (generation !== owner.current) return;
      setModels(values); setModel(values[0]?.model ?? ""); setVoice(values[0]?.voices[0] ?? "");
    } catch (failure) { if (generation === owner.current) onError(String(failure)); }
    finally { setRunning(false); }
  }
  async function run(kind: "quote" | "submit" | "refresh") {
    if (disabled || dirty || running || !selected || !model || !view.revision) return;
    const generation = owner.current;
    const input: ClassroomTtsSelection = { sessionId, projectId: view.projectId, expectedRevision: view.revision,
      expectedSourceRevision: view.sourceRevision, sceneId: scene.id, actionId: String(selected.id), model, voice: voice || null };
    setRunning(true); onBusy(true); onError("");
    try {
      const next = kind === "quote" ? await api.coursewareClassroomTtsQuote(input) : kind === "refresh" ? await api.coursewareClassroomTtsRefresh(input)
        : await api.coursewareClassroomTtsSubmit({ ...input, quoteId: result?.quote?.quoteId ?? "" });
      if (generation !== owner.current) return;
      setResult(next);
      if (next.view) onAdopt({ ...next.view, resourceUrls: { ...view.resourceUrls, ...next.view.resourceUrls } });
    } catch (failure) { if (generation === owner.current) onError(String(failure)); }
    finally { setRunning(false); onBusy(false); }
  }
  return <details open={opened} onToggle={event => setOpened(event.currentTarget.open)}>
    <summary>讲解与语音</summary>
    <button disabled={disabled || running} onClick={() => onChange({ ...scene, actions: [...scene.actions ?? [], {
      id: crypto.randomUUID(), type: "speech", text: scene.content.questions?.map(q => [q.question, ...q.options?.map(option => option.label) ?? []].join("\n")).join("\n\n") || "新讲解",
    }] })}>添加讲解</button>
    {selected && <>
      <label>讲解动作<select value={String(selected.id)} disabled={disabled || running} onChange={event => setActionId(event.target.value)}>{actions.map((action, index) => <option key={String(action.id)} value={String(action.id)}>讲解 {index + 1}</option>)}</select></label>
      <label>讲解文本<textarea aria-label="讲解文本" disabled={disabled || running} value={String(selected.text ?? "")} onChange={event => onChange({ ...scene, actions: scene.actions?.map(action => action.id === selected.id ? { ...action, text: event.target.value } : action) })} /></label>
      <button disabled={disabled || running} onClick={() => onChange({ ...scene, actions: scene.actions?.filter(action => action.id !== selected.id) })}>删除讲解</button>
      <button disabled={disabled || running} onClick={() => void loadModels()}>读取语音模型</button>
      <label>语音模型<select disabled={disabled || running || !models.length} value={model} onChange={event => { setModel(event.target.value); setVoice(models.find(item => item.model === event.target.value)?.voices[0] ?? ""); }}>{models.map(item => <option key={item.model} value={item.model}>{item.model}</option>)}</select></label>
      <label>音色<select disabled={disabled || dirty || running || !model} value={voice} onChange={event => setVoice(event.target.value)}>{models.find(item => item.model === model)?.providerDefaultVoice && <option value="">模型默认音色</option>}{models.find(item => item.model === model)?.voices.map(item => <option key={item} value={item}>{item}</option>)}</select></label>
      <button disabled={disabled || dirty || running || !model} onClick={() => void run("quote")}>获取语音报价</button>
      {result?.quote && <p>本次语音费用上限：{result.quote.maxPoints} 积分。报价有效至 {new Date(result.quote.expiresAt).toLocaleString()}。</p>}
      <button disabled={disabled || dirty || running || !result?.quote || Date.parse(result.quote.expiresAt) <= Date.now()} onClick={() => void run("submit")}>确认报价并生成语音</button>
      <button disabled={disabled || dirty || running || !model} onClick={() => void run("refresh")}>刷新并应用语音</button>
      {result && <p role="status">语音状态：{result.state}{result.task?.errorCode ? ` · ${result.task.errorCode}` : ""}</p>}
    </>}
  </details>;
}
