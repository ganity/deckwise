import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { isCoursewareAttentionCue, type CoursewareOnlineSourceDecisions, type CoursewareOnlineSourceReviewView } from "@pi-desktop/shared";

export type CoursewareOnlineSourceReviewProps = {
  view: CoursewareOnlineSourceReviewView;
  disabled: boolean;
  onConfirm(decisions: CoursewareOnlineSourceDecisions): void;
  onCancel(): void;
  onPreview?(importPageId: string): Promise<string>;
  onOriginalPreview?(pageId: string): Promise<string>;
};
type Choice = { decision: "" | "keep" | "rebind" | "remove"; target: string };
type Draft = {
  scope: string;
  pages: Record<string, string>;
  removed: Record<string, boolean>;
  cues: Record<string, { deleteCue: boolean; targets: Record<string, Choice> }>;
};
const eligible = (kind: string) => ["text", "shape", "image"].includes(kind);
const cueKey = (page: string, action: string, cue: string) => JSON.stringify([page, action, cue]);
const empty = (scope: string): Draft => ({ scope, pages: {}, removed: {}, cues: {} });

export function CoursewareOnlineSourceReview({ view, disabled, onConfirm, onCancel, onPreview, onOriginalPreview }: CoursewareOnlineSourceReviewProps) {
  const { t } = useTranslation();
  const scope = JSON.stringify([view.ownerId, view.viewId]);
  const [draft, setDraft] = useState(() => empty(scope));
  const [preview, setPreview] = useState<{ scope: string; page: string; original: boolean; image?: string; error?: boolean } | null>(null);
  const current = useRef({ scope, disabled, draft });
  current.current = { scope, disabled, draft };
  const previewSequence = useRef(0);
  useEffect(() => {
    setDraft(empty(scope)); setPreview(null); previewSequence.current++;
    return () => { previewSequence.current++; };
  }, [scope]);
  const active = () => current.current.scope === scope && !current.current.disabled && current.current.draft === draft && draft.scope === scope;
  const update = (next: Draft) => {
    if (!active()) return;
    current.current.draft = next; setDraft(next);
  };
  const used = Object.values(draft.pages).filter(value => value && value !== "new");
  const oldPages = view.original.project.pages;
  let valid = draft.scope === scope && view.targetPages.length > 0 && new Set(used).size === used.length;
  const decisions: CoursewareOnlineSourceDecisions = { pages: [], removedPages: [], cues: [] };
  const kept = new Map<string, string>(), keptTargets = new Map<string, string>();
  for (const target of view.targetPages) {
    const oldId = draft.pages[target.importPageId];
    const page = oldPages.find(value => value.pageId === oldId);
    if (oldId === "new") decisions.pages.push({ kind: "new", targetImportPageId: target.importPageId, confirmReady: false });
    else if (page) decisions.pages.push({ kind: "carry", targetImportPageId: target.importPageId, oldPageId: page.pageId, confirmReady: false });
    else valid = false;
    for (const action of page?.actions ?? []) {
      if (action.visualCues === undefined) continue;
      if (action.type !== "speech" || !Array.isArray(action.visualCues) || !action.visualCues.every(isCoursewareAttentionCue)) { valid = false; continue; }
      for (const cue of action.visualCues) {
        const key = cueKey(page!.pageId, String(action.id), cue.id), choice = draft.cues[key];
        const ids = cue.effect.type === "highlight" ? cue.effect.elementIds : [cue.effect.elementId, ...(cue.effect.elementIds ?? [])];
        const targets: CoursewareOnlineSourceDecisions["cues"][number]["targets"] = [];
        const actual = new Set<string>();
        for (const id of ids) {
          const entry = choice?.targets[id];
          const previous = view.previousPages.find(value => value.pageId === page!.pageId)?.objects.find(value => value.objectId === id);
          if (!previous || !eligible(previous.kind)) valid = false;
          if (entry?.decision === "remove") targets.push({ decision: "remove", oldObjectId: id });
          else if ((entry?.decision === "keep" || entry?.decision === "rebind") && target.objects.some(object => object.importElementId === entry.target && eligible(object.kind))) {
            targets.push({ decision: entry.decision, oldObjectId: id, targetImportElementId: entry.target });
            if (actual.has(entry.target)) valid = false;
            actual.add(entry.target);
            if (entry.decision === "keep") {
              const oldKey = JSON.stringify([page!.pageId, id]), targetKey = JSON.stringify([target.importPageId, entry.target]);
              if ((kept.has(oldKey) && kept.get(oldKey) !== targetKey) || (keptTargets.has(targetKey) && keptTargets.get(targetKey) !== oldKey)) valid = false;
              kept.set(oldKey, targetKey); keptTargets.set(targetKey, oldKey);
            }
          } else valid = false;
        }
        const deleting = choice?.deleteCue === true;
        const primary = cue.effect.type !== "highlight" ? cue.effect.elementId : null;
        if (deleting && !targets.every(entry => entry.decision === "remove")) valid = false;
        if (!deleting && (targets.every(entry => entry.decision === "remove") || (primary !== null && targets.find(entry => entry.oldObjectId === primary)?.decision === "remove"))) valid = false;
        decisions.cues.push({ oldPageId: page!.pageId, actionId: String(action.id), cueId: cue.id, deleteCue: deleting, targets });
      }
    }
  }
  for (const page of oldPages) {
    if (used.includes(page.pageId)) continue;
    if (page.locked || !draft.removed[page.pageId]) valid = false;
    else decisions.removedPages.push({ oldPageId: page.pageId, confirmDelete: true });
  }
  const objectLabel = (kind: string, index: number) => t(kind === "text" ? "panel.pptEditor.effectsObjectText" : kind === "shape" ? "panel.pptEditor.effectsObjectShape" : kind === "image" ? "panel.pptEditor.effectsObjectImage" : "panel.pptEditor.effectsObject", { number: index });
  const changeCue = (key: string, next: Draft["cues"][string]) => update({ ...draft, cues: { ...draft.cues, [key]: next } });
  const showPreview = async (page: string, original = false) => {
    const read = original ? onOriginalPreview : onPreview;
    if (!active() || !read) return;
    const sequence = ++previewSequence.current; setPreview({ scope, page, original });
    try {
      const image = await read(page);
      if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/u.test(image)) throw new Error("Invalid preview");
      if (current.current.scope === scope && sequence === previewSequence.current) setPreview({ scope, page, original, image });
    } catch {
      if (current.current.scope === scope && sequence === previewSequence.current) setPreview({ scope, page, original, error: true });
    }
  };

  return <section className="courseware-source-review courseware-online-source-review" aria-label={t("panel.onlineSource.title")}>
    <strong>{t("panel.onlineSource.title")}</strong>
    <p role="note">{t("panel.onlineSource.scope")}</p>
    <details open><summary>{t("panel.pptEditor.sourceReviewPrevious")}</summary>
      {oldPages.map(page => <div key={page.pageId}>
        <strong>{t("panel.pptEditor.sourceReviewOldPage", { page: view.previousPages.find(value => value.pageId === page.pageId)?.pageNumber })}{page.locked ? ` · ${t("panel.pptEditor.teachingLock")}` : ""}</strong>
        {onOriginalPreview && <button type="button" disabled={disabled} onClick={() => void showPreview(page.pageId, true)}>{t("panel.onlineSource.previewOriginal", { page: view.previousPages.find(value => value.pageId === page.pageId)?.pageNumber })}</button>}
        {page.actions.length === 0 && <p>{t("panel.pptEditor.sourceReviewEmpty")}</p>}
        {page.actions.map(action => <div key={String(action.id)}>
          {typeof action.text === "string" && <p>{action.text}</p>}
          {typeof action.pauseAfterMs === "number" && <p>{t("panel.pptEditor.candidatePause", { ms: action.pauseAfterMs })}</p>}
          {typeof action.audioAssetId === "string" && <p>{t("panel.onlineSource.audio", { asset: action.audioAssetId })}</p>}
          {action.type === "interaction_checkpoint" && <p>{t("panel.pptEditor.candidateTeacherContinue")}</p>}
          {Array.isArray(action.visualCues) && action.visualCues.filter(isCoursewareAttentionCue).map(cue => <p key={cue.id}>{t("panel.pptEditor.effectsCue", { effect: t(cue.effect.type === "element_animation" ? `panel.pptEditor.effects${({ fadeIn: "FadeIn", fadeOut: "FadeOut", pulse: "Pulse", zoomIn: "ZoomIn", slideInLeft: "SlideInLeft", slideInRight: "SlideInRight", gentleRotate: "GentleRotate" } as const)[cue.effect.effect]}` : cue.effect.type === "highlight" ? "panel.pptEditor.effectsHighlight" : "panel.pptEditor.effectsSpotlight"), start: cue.atMs, end: cue.endMs })}</p>)}
        </div>)}
      </div>)}
    </details>
    {view.targetPages.map(target => {
      const oldId = draft.pages[target.importPageId] ?? "", page = oldPages.find(value => value.pageId === oldId);
      return <fieldset key={target.importPageId} disabled={disabled || draft.scope !== scope}>
        <legend>{t("panel.onlineSource.targetPage", { page: target.pageNumber })}</legend>
        {onPreview && <button type="button" onClick={() => void showPreview(target.importPageId)}>{t("panel.onlineSource.preview", { page: target.pageNumber })}</button>}
        <label>{t("panel.onlineSource.pageAssociation", { page: target.pageNumber })}
          <select value={oldId} onChange={event => update({ ...draft, pages: { ...draft.pages, [target.importPageId]: event.target.value }, removed: {}, cues: {} })}>
            <option value="">{t("panel.pptEditor.sourceReviewChoose")}</option>
            <option value="new">{t("panel.pptEditor.sourceReviewNew")}</option>
            {view.previousPages.map(old => <option key={old.pageId} value={old.pageId}>{t("panel.pptEditor.sourceReviewOldPage", { page: old.pageNumber })}</option>)}
          </select>
        </label>
        {page?.actions.map(action => Array.isArray(action.visualCues) && action.visualCues.filter(isCoursewareAttentionCue).map(cue => {
          const key = cueKey(page.pageId, String(action.id), cue.id), choice = draft.cues[key] ?? { deleteCue: false, targets: {} };
          const ids = cue.effect.type === "highlight" ? cue.effect.elementIds : [cue.effect.elementId, ...(cue.effect.elementIds ?? [])];
          return <fieldset key={key}>
            <legend>{t("panel.pptEditor.effectsCue", { effect: t(cue.effect.type === "element_animation" ? `panel.pptEditor.effects${({ fadeIn: "FadeIn", fadeOut: "FadeOut", pulse: "Pulse", zoomIn: "ZoomIn", slideInLeft: "SlideInLeft", slideInRight: "SlideInRight", gentleRotate: "GentleRotate" } as const)[cue.effect.effect]}` : cue.effect.type === "highlight" ? "panel.pptEditor.effectsHighlight" : "panel.pptEditor.effectsSpotlight"), start: cue.atMs, end: cue.endMs })}</legend>
            <p>{String(action.text ?? "")}</p>
            {ids.map(id => {
              const previous = view.previousPages.find(value => value.pageId === page.pageId)?.objects.find(value => value.objectId === id);
              const entry = choice.targets[id] ?? { decision: "", target: "" };
              const label = previous ? objectLabel(previous.kind, previous.index) : id;
              return <div key={id}>
                <label>{t("panel.onlineSource.targetDecision", { object: label })}
                  <select value={entry.decision} onChange={event => changeCue(key, { ...choice, deleteCue: false, targets: { ...choice.targets, [id]: { decision: event.target.value as Choice["decision"], target: "" } } })}>
                    <option value="">{t("panel.pptEditor.sourceReviewChoose")}</option>
                    <option value="keep">{t("panel.onlineSource.keep")}</option>
                    <option value="rebind">{t("panel.onlineSource.rebind")}</option>
                    <option value="remove">{t("panel.onlineSource.remove")}</option>
                  </select>
                </label>
                {(entry.decision === "keep" || entry.decision === "rebind") && <label>{t("panel.onlineSource.targetObject", { object: label })}
                  <select value={entry.target} onChange={event => changeCue(key, { ...choice, targets: { ...choice.targets, [id]: { ...entry, target: event.target.value } } })}>
                    <option value="">{t("panel.pptEditor.sourceEffectChoose")}</option>
                    {target.objects.filter(object => eligible(object.kind)).map(object => <option key={object.importElementId} value={object.importElementId}>{objectLabel(object.kind, object.index)}</option>)}
                  </select>
                </label>}
              </div>;
            })}
            <label><input type="checkbox" checked={choice.deleteCue} disabled={!ids.every(id => choice.targets[id]?.decision === "remove")} onChange={event => changeCue(key, { ...choice, deleteCue: event.target.checked })} />{t("panel.onlineSource.deleteCue")}</label>
          </fieldset>;
        }))}
      </fieldset>;
    })}
    {oldPages.filter(page => !used.includes(page.pageId)).map(page => <label key={page.pageId}>
      <input type="checkbox" checked={draft.removed[page.pageId] === true} disabled={disabled || page.locked || draft.scope !== scope} onChange={event => update({ ...draft, removed: { ...draft.removed, [page.pageId]: event.target.checked } })} />
      {t(page.locked ? "panel.onlineSource.lockedPage" : "panel.onlineSource.deletePage", { page: view.previousPages.find(value => value.pageId === page.pageId)?.pageNumber })}
    </label>)}
    {preview?.scope === scope && <figure className="courseware-source-visuals" aria-live="polite">
      {preview.image ? <img src={preview.image} alt={t(preview.original ? "panel.onlineSource.previewOriginal" : "panel.onlineSource.preview", { page: preview.original ? view.previousPages.find(value => value.pageId === preview.page)?.pageNumber : view.targetPages.find(value => value.importPageId === preview.page)?.pageNumber })} /> : <p role={preview.error ? "alert" : "status"}>{t(preview.error ? "panel.onlineSource.previewError" : "common.loading")}</p>}
    </figure>}
    {!valid && <p role="status">{t("panel.onlineSource.incomplete")}</p>}
    <div className="courseware-teaching-actions">
      <button type="button" disabled={disabled || !valid} onClick={() => { if (active() && valid) onConfirm(decisions); }}>{t("panel.onlineSource.confirm")}</button>
      <button type="button" disabled={disabled} onClick={() => { if (active()) onCancel(); }}>{t("panel.pptEditor.sourceReviewCancel")}</button>
    </div>
  </section>;
}
