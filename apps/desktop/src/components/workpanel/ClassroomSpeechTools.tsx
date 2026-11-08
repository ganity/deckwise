import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { CoursewareTtsModel } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { speechGenerationError } from "../../lib/courseware-speech-error";
import type { ClassroomEditorView, ClassroomScene, ClassroomTtsResult, ClassroomTtsSelection } from "../../lib/courseware-classroom";

export function ClassroomSpeechTools({ sessionId, view, scene, transport = api, speechActionId, speechText, disabled, dirty, onBusy, onAdopt, onChange, onError }: {
  sessionId: string; view: ClassroomEditorView; scene: ClassroomScene; disabled: boolean; dirty: boolean;
  transport?: Pick<typeof api, "coursewareClassroomTtsModels" | "coursewareClassroomTtsQuote" | "coursewareClassroomTtsSubmit" | "coursewareClassroomTtsRefresh">;
  speechActionId?: string; speechText?: string;
  onBusy(value: boolean): void; onAdopt(view: ClassroomEditorView): void;
  onChange(scene: ClassroomScene): void; onError(error: string): void;
}) {
  const { t } = useTranslation();
  const [opened, setOpened] = useState(false);
  const [models, setModels] = useState<CoursewareTtsModel[]>([]);
  const [model, setModel] = useState("");
  const [voice, setVoice] = useState("");
  const [actionId, setActionId] = useState("");
  const [result, setResult] = useState<ClassroomTtsResult>();
  const [running, setRunning] = useState(false);
  const [awaitingSpeech, setAwaitingSpeech] = useState(false);
  const owner = useRef(0);
  const managedIds = Object.values(scene.metadata?.assessmentSpeechIds ?? {});
  const actions = scene.actions?.filter(action => action.type === "speech" && (speechActionId || !managedIds.includes(action.id))) ?? [];
  const selected = speechActionId ? actions.find(action => action.id === speechActionId) : actions.find(action => action.id === actionId) ?? actions[0];
  const selectionKey = [sessionId, view.projectId, view.revision, view.sourceRevision, scene.id, selected?.id, selected?.text, speechText].join(":");
  useEffect(() => { ++owner.current; setResult(undefined); return () => { ++owner.current; }; }, [selectionKey]);
  useEffect(() => {
    if (awaitingSpeech && selected && !dirty && !disabled) { setAwaitingSpeech(false); void run(); }
  }, [awaitingSpeech, selected, dirty, disabled]);
  async function run() {
    if (disabled || dirty || running || !selected || !view.revision) return;
    const generation = owner.current;
    setRunning(true); onBusy(true); onError("");
    try {
      let selectedModel = model, selectedVoice = voice;
      if (!selectedModel) {
        const values = await transport.coursewareClassroomTtsModels(sessionId);
        if (generation !== owner.current) return;
        if (!values.length) throw new Error(t("panel.pptEditor.ttsNoModels"));
        selectedModel = values[0].model; selectedVoice = values[0].voices[0] ?? "";
        setModels(values); setModel(selectedModel); setVoice(selectedVoice);
      }
      const input: ClassroomTtsSelection = { sessionId, projectId: view.projectId, expectedRevision: view.revision,
        expectedSourceRevision: view.sourceRevision, sceneId: scene.id, actionId: String(selected.id), model: selectedModel, voice: selectedVoice || null, regenerate: true };
      let next: ClassroomTtsResult;
      if (result && !["failed", "cancelled", "not_submitted", "adopted"].includes(result.state)) {
        next = await transport.coursewareClassroomTtsRefresh(input);
      } else {
        const quote = await transport.coursewareClassroomTtsQuote(input);
        if (generation !== owner.current) return;
        next = await transport.coursewareClassroomTtsSubmit({ ...input, quoteId: quote.quote?.quoteId ?? "" });
      }
      // A subsequent click only queries an unfinished submission; it cannot charge twice.
      for (let attempt = 0; attempt < 100 && generation === owner.current; attempt++) {
        setResult(next);
        if (next.view || ["failed", "cancelled", "submission_unknown", "submission-unknown", "not_submitted"].includes(next.state)) break;
        if (attempt) await new Promise(resolve => setTimeout(resolve, 3000));
        if (generation !== owner.current) return;
        next = await transport.coursewareClassroomTtsRefresh(input);
        if (next.view || next.state === "not_submitted") break;
      }
      if (generation !== owner.current) return;
      setResult(next);
      if (next.view) onAdopt({ ...next.view, resourceUrls: { ...view.resourceUrls, ...next.view.resourceUrls } });
      else if (["failed", "cancelled"].includes(next.state)) onError(speechGenerationError(next.task?.errorCode || t("panel.pptEditor.ttsFailed"), t("panel.pptEditor.ttsInsufficientPoints")));
    } catch (failure) { if (generation === owner.current) onError(speechGenerationError(failure, t("panel.pptEditor.ttsInsufficientPoints"))); }
    finally { setRunning(false); onBusy(false); }
  }
  const ready = !!selected?.audioId || !!selected?.audioUrl;
  const textChanged = speechActionId ? speechText !== selected?.text
    : selected?.text !== view.classroom?.scenes.find(item => item.id === scene.id)?.actions?.find(action => action.id === selected?.id)?.text;
  return <div className="maic-speech-tools">
    {(speechActionId || selected) && <div className="maic-speech-status">
      <span role="status">{t(running ? "panel.pptEditor.ttsBusy" : textChanged && dirty ? "panel.pptEditor.speechNeedsUpdate" : ready ? "panel.pptEditor.speechReady" : "panel.pptEditor.speechMissing")}</span>
      <button disabled={disabled || running || dirty || (speechActionId ? !speechText?.trim() : !selected?.text)} onClick={() => {
        setOpened(true);
        if (!speechActionId || selected?.text === speechText) { void run(); return; }
        const existing = actions.find(action => action.id === speechActionId);
        const speech = { id: speechActionId!, type: "speech" as const, text: speechText };
        onChange({ ...scene, actions: existing ? scene.actions?.map(action => {
          if (action.id !== speechActionId) return action;
          const next: Record<string, unknown> = { ...action, ...speech }; delete next.audioId; delete next.audioUrl; return next;
        }) : [...scene.actions ?? [], speech] });
        setAwaitingSpeech(true);
      }}>{t(ready ? "panel.pptEditor.speechRegenerate" : "panel.pptEditor.speechGenerate")}</button>
    </div>}
    <details open={opened} onToggle={event => setOpened(event.currentTarget.open)}>
    <summary>{t(speechActionId ? "panel.pptEditor.questionSpeech" : "panel.pptEditor.teachingTitle")}</summary>
    {!speechText && <button disabled={disabled || running} onClick={() => onChange({ ...scene, actions: [...scene.actions ?? [], {
      id: crypto.randomUUID(), type: "speech", text: scene.content.questions?.map(q => [q.question, ...q.options?.map(option => option.label) ?? []].join("\n")).join("\n\n") || t("panel.pptEditor.teachingTitle"),
    }] })}>{t("panel.pptEditor.teachingAdd")}</button>}
    {selected && <>
      {!speechActionId && <label>{t("panel.pptEditor.ttsSegment")}<select value={String(selected.id)} disabled={disabled || running} onChange={event => setActionId(event.target.value)}>{actions.map((action, index) => <option key={String(action.id)} value={String(action.id)}>{t("panel.pptEditor.teachingSegment", { segment: index + 1 })}</option>)}</select></label>}
      {!speechActionId && <label>{t("panel.pptEditor.speechText")}<textarea aria-label={t("panel.pptEditor.speechText")} disabled={disabled || running} value={String(selected.text ?? "")} onChange={event => onChange({ ...scene, actions: scene.actions?.map(action => {
        if (action.id !== selected.id) return action;
        const next: Record<string, unknown> = { ...action, text: event.target.value }; delete next.audioId; delete next.audioUrl; return next;
      }) })} /></label>}
      {!speechActionId && <button disabled={disabled || running} onClick={() => onChange({ ...scene, actions: scene.actions?.filter(action => action.id !== selected.id) })}>{t("panel.pptEditor.removeSpeech")}</button>}
      <label>{t("panel.pptEditor.ttsModel")}<select disabled={disabled || running || !models.length} value={model} onChange={event => { ++owner.current; setResult(undefined); setModel(event.target.value); setVoice(models.find(item => item.model === event.target.value)?.voices[0] ?? ""); }}>{models.map(item => <option key={item.model} value={item.model}>{item.model}</option>)}</select></label>
      <label>{t("panel.pptEditor.ttsVoiceLabel")}<select disabled={disabled || dirty || running || !model} value={voice} onChange={event => { ++owner.current; setResult(undefined); setVoice(event.target.value); }}>{models.find(item => item.model === model)?.providerDefaultVoice && <option value="">{t("panel.pptEditor.ttsDefaultVoice")}</option>}{models.find(item => item.model === model)?.voices.map(item => <option key={item} value={item}>{item}</option>)}</select></label>
      {!running && result && !result.view && !["failed", "cancelled", "not_submitted"].includes(result.state) && <p role="status">{t("panel.pptEditor.ttsUnknown")}</p>}
    </>}
  </details></div>;
}
