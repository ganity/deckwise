import { isCoursewareAttentionCue, type CoursewareAttentionCue, type CoursewareTeachingView } from "@pi-desktop/shared";
import { useState } from "react";
import { useTranslation } from "react-i18next";

export function CoursewareTeachingEffects({ view, actions, disabled, onChange }: {
  view: CoursewareTeachingView;
  actions: Array<Record<string, unknown>>;
  disabled: boolean;
  onChange: (actions: Array<Record<string, unknown>>) => void;
}) {
  const { t } = useTranslation();
  const [speechId, setSpeechId] = useState("");
  const [kind, setKind] = useState<"highlight" | "spotlight">("highlight");
  const [targets, setTargets] = useState<string[]>([]);
  const [start, setStart] = useState("0"), [end, setEnd] = useState("1000");
  const [editing, setEditing] = useState<string | null>(null);
  const [reviewed, setReviewed] = useState(false);
  const page = view.project.pages.find(entry => entry.pageId === view.pageId);
  const speeches = actions.filter(action => action.type === "speech" && typeof action.text === "string");
  const speech = speeches.find(action => action.id === speechId) ?? speeches.find(action => typeof action.audioAssetId === "string") ?? speeches[0];
  const objects = (view.teachingObjects ?? []).filter(object => object.status === "mapped" && object.effectTargetEligible === true);
  const cues = Array.isArray(speech?.visualCues) ? speech.visualCues : [];
  const editable = !disabled && !!page && !page.locked && page.reviewState === "ready";
  const audioReady = typeof speech?.audioAssetId === "string" && !!speech.audioAssetId;
  const atMs = Number(start), endMs = Number(end);
  const objectLabel = (object: NonNullable<CoursewareTeachingView["teachingObjects"]>[number]) =>
    object.savedKind && object.savedIndex ? t(object.savedKind === "text" ? "panel.pptEditor.effectsObjectText" :
      object.savedKind === "shape" ? "panel.pptEditor.effectsObjectShape" : object.savedKind === "image" ?
      "panel.pptEditor.effectsObjectImage" : "panel.pptEditor.effectsObject",
      { number: object.savedIndex }) : object.role || object.name;
  const valid = start.trim() !== "" && end.trim() !== "" && Number.isInteger(atMs) && atMs >= 0 &&
    Number.isInteger(endMs) && endMs > atMs && endMs <= 3_600_000 && targets.length > 0 &&
    targets.every(id => objects.some(object => object.objectId === id)) &&
    (!editing || cues.some(cue => isCoursewareAttentionCue(cue) && cue.id === editing));
  const reset = () => { setEditing(null); setTargets([]); setStart("0"); setEnd("1000"); setReviewed(false); };
  const replace = (nextCues: unknown[]) => {
    if (!editable || !speech) return;
    onChange(actions.map(action => {
      if (action !== speech) return action;
      const next = { ...action };
      if (nextCues.length) next.visualCues = nextCues; else delete next.visualCues;
      return next;
    }));
    reset();
  };
  const edit = (cue: CoursewareAttentionCue) => {
    if (!editable) return;
    setEditing(cue.id); setKind(cue.effect.type); setStart(String(cue.atMs)); setEnd(String(cue.endMs));
    setTargets(cue.effect.type === "highlight" ? [...cue.effect.elementIds] : [cue.effect.elementId, ...(cue.effect.elementIds ?? [])]);
    setReviewed(false);
  };

  return <section aria-label={t("panel.pptEditor.effectsTitle")}>
    <strong>{t("panel.pptEditor.effectsTitle")}</strong>
    <p>{t("panel.pptEditor.effectsScope")}</p>
    {view.project.taskType !== "scene" ? <p>{t("panel.pptEditor.effectsSavedObjectsScope")}</p> : null}
    {page?.reviewState !== "ready" ? <p role="status">{t("panel.pptEditor.effectsConfirmPage")}</p> : null}
    {!objects.length ? <p role="status">{t("panel.pptEditor.effectsObjectsRequired")}</p> : null}
    {!audioReady ? <p role="status">{t("panel.pptEditor.effectsAudioRequired")}</p> : null}
    <label>{t("panel.pptEditor.effectsSpeech")}
      <select value={String(speech?.id ?? "")} disabled={!editable || !speeches.length} onChange={event => { setSpeechId(event.target.value); reset(); }}>
        {!speeches.length ? <option value="">{t("panel.pptEditor.effectsAudioRequired")}</option> : null}
        {speeches.map((action, index) => <option key={String(action.id)} value={String(action.id)}>
          {t("panel.pptEditor.effectsSpeechOption", { number: index + 1, text: String(action.text) })}
        </option>)}
      </select>
    </label>
    {cues.map((cue, index) => isCoursewareAttentionCue(cue) ? <div key={cue.id}>
      <p>{t("panel.pptEditor.effectsCue", { effect: t(`panel.pptEditor.effects${cue.effect.type === "highlight" ? "Highlight" : "Spotlight"}`), start: cue.atMs, end: cue.endMs })}</p>
      <p>{(cue.effect.type === "highlight" ? cue.effect.elementIds : [cue.effect.elementId, ...(cue.effect.elementIds ?? [])])
        .map(id => { const object = view.teachingObjects?.find(entry => entry.objectId === id); return object ? objectLabel(object) : id; }).join(" · ")}</p>
      <button type="button" disabled={!editable || !audioReady} onClick={() => edit(cue)}>{t("panel.pptEditor.effectsEdit")}</button>
      <button type="button" disabled={!editable || !audioReady} onClick={() => replace(cues.filter((_, position) => position !== index))}>{t("panel.pptEditor.effectsRemove")}</button>
    </div> : <p key={index} role="status">{t("panel.pptEditor.effectsUnsupported")}</p>)}
    {speech?.visualCues !== undefined && !Array.isArray(speech.visualCues) ? <p role="alert">{t("panel.pptEditor.effectsUnsupported")}</p> : null}
    <form onSubmit={event => {
      event.preventDefault();
      if (!editable || !audioReady || !reviewed || !valid || (!editing && cues.length >= 200) ||
          (speech?.visualCues !== undefined && !Array.isArray(speech.visualCues))) return;
      const old = cues.find(cue => isCoursewareAttentionCue(cue) && cue.id === editing);
      const effect: CoursewareAttentionCue["effect"] = kind === "highlight"
        ? { ...(isCoursewareAttentionCue(old) && old.effect.type === kind ? old.effect : {}), type: kind, elementIds: [...targets] }
        : { ...(isCoursewareAttentionCue(old) && old.effect.type === kind ? old.effect : {}), type: kind, elementId: targets[0],
          elementIds: targets.slice(1) };
      const cue: CoursewareAttentionCue = { id: editing ?? crypto.randomUUID(), atMs, endMs, effect };
      replace(editing ? cues.map(existing => existing === old ? cue : existing) : [...cues, cue]);
    }}>
      <fieldset disabled={!editable || !audioReady || !objects.length}>
        <legend>{t(editing ? "panel.pptEditor.effectsEdit" : "panel.pptEditor.effectsAdd")}</legend>
        <label>{t("panel.pptEditor.effectsType")}
          <select value={kind} onChange={event => { if (event.target.value === "highlight" || event.target.value === "spotlight") { setKind(event.target.value); setReviewed(false); } }}>
            <option value="highlight">{t("panel.pptEditor.effectsHighlight")}</option>
            <option value="spotlight">{t("panel.pptEditor.effectsSpotlight")}</option>
          </select>
        </label>
        <p>{t("panel.pptEditor.effectsTargets")}</p>
        {objects.map(object => <label key={object.objectId}>
          <input type="checkbox" checked={targets.includes(object.objectId)} onChange={event => {
            setTargets(event.target.checked ? [...targets, object.objectId] : targets.filter(id => id !== object.objectId)); setReviewed(false);
          }} />{objectLabel(object)}{object.aliases.length ? ` · ${object.aliases.join(" / ")}` : ""}
        </label>)}
        <label>{t("panel.pptEditor.effectsStart")}
          <input type="number" min={0} max={3_600_000} step={1} value={start} onChange={event => { setStart(event.target.value); setReviewed(false); }} />
        </label>
        <label>{t("panel.pptEditor.effectsEnd")}
          <input type="number" min={1} max={3_600_000} step={1} value={end} onChange={event => { setEnd(event.target.value); setReviewed(false); }} />
        </label>
        {!valid ? <p role="status">{t("panel.pptEditor.effectsInvalid")}</p> : null}
        <label><input type="checkbox" checked={reviewed} onChange={event => setReviewed(event.target.checked)} />{t("panel.pptEditor.effectsReviewed")}</label>
        <button type="submit" disabled={!editable || !audioReady || !reviewed || !valid || (!editing && cues.length >= 200) ||
          (speech?.visualCues !== undefined && !Array.isArray(speech.visualCues))}>{t(editing ? "panel.pptEditor.effectsApply" : "panel.pptEditor.effectsAdd")}</button>
        {editing ? <button type="button" onClick={reset}>{t("panel.pptEditor.effectsCancel")}</button> : null}
      </fieldset>
    </form>
  </section>;
}
