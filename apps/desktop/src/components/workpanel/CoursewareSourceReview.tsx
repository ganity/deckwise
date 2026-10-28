import { useState } from "react";
import { useTranslation } from "react-i18next";
import { isCoursewareAttentionCue, type CoursewareSourceReview as Review } from "@pi-desktop/shared";

export function CoursewareSourceReview({ review, disabled, adopt, cancel }: {
  review: Review; disabled: boolean; adopt: (bindings: Array<number | null>, effectBindings?: Array<{pageIndex: number; objectId: string; targetIndex: number}>) => void; cancel: () => void;
}) {
  const { t } = useTranslation();
  const [bindings, setBindings] = useState<string[]>(() => Array.from({ length: review.pageCount }, () => ""));
  const [confirmed, setConfirmed] = useState(false);
  const [effectsConfirmed, setEffectsConfirmed] = useState(false);
  const [objectBindings, setObjectBindings] = useState<Record<string, string>>({});
  const targets = review.effectTargets ?? [];
  const selected = bindings.filter((value) => value !== "" && value !== "new");
  const effectBindings = targets.map(target => {
    const oldIndex = review.project.pages.findIndex(page => page.pageId === target.pageId);
    const pageIndex = bindings.indexOf(String(oldIndex));
    return { pageIndex, objectId: target.objectId, targetIndex: Number(objectBindings[JSON.stringify([target.pageId, target.objectId])] ?? 0) };
  });
  const effectsValid = effectBindings.every(binding => binding.pageIndex >= 0 && binding.targetIndex > 0 &&
    ["text", "shape", "image"].includes(review.targetPages?.[binding.pageIndex]?.objects[binding.targetIndex - 1]?.kind ?? "")) &&
    new Set(effectBindings.map(binding => JSON.stringify([binding.pageIndex, binding.targetIndex]))).size === effectBindings.length;
  const valid = bindings.every(Boolean) && new Set(selected).size === selected.length && effectsValid &&
    review.project.pages.every((page, index) => !page.locked || selected.includes(String(index)));
  const kindLabel = (kind: string, index: number) => t(kind === "text" ? "panel.pptEditor.effectsObjectText" :
    kind === "shape" ? "panel.pptEditor.effectsObjectShape" : kind === "image" ? "panel.pptEditor.effectsObjectImage" : "panel.pptEditor.effectsObject", { number: index });

  return <section className="courseware-source-review" aria-label={t("panel.pptEditor.sourceReviewTitle")}>
    <strong>{t("panel.pptEditor.sourceReviewTitle")}</strong>
    <p>{t("panel.pptEditor.sourceReviewScope")}</p>
    <details open>
      <summary>{t("panel.pptEditor.sourceReviewPrevious")}</summary>
      {review.project.pages.map((page, index) => <div key={page.pageId}>
        {t("panel.pptEditor.sourceReviewOldPage", { page: index + 1 })}{page.locked ? ` · ${t("panel.pptEditor.teachingLock")}` : ""}
        <br />{page.actions.map((action) => String(action.text ?? "")).join(" ").slice(0, 160) || t("panel.pptEditor.sourceReviewEmpty")}
        {page.actions.filter((action) => typeof action.pauseAfterMs === "number").map((action) =>
          <p key={String(action.id)}>{t("panel.pptEditor.candidatePause", { ms: action.pauseAfterMs })}</p>)}
        {page.actions.filter(action => action.type === "speech").map(action =>
          Array.isArray(action.visualCues) && action.visualCues.filter(isCoursewareAttentionCue).map(cue =>
            <p key={`${String(action.id)}:${cue.id}`}>{t("panel.pptEditor.effectsCue", {
              effect: t(cue.effect.type === "element_animation" ? `panel.pptEditor.effects${({ fadeIn: "FadeIn", fadeOut: "FadeOut", pulse: "Pulse" } as const)[cue.effect.effect]}` : cue.effect.type === "highlight" ? "panel.pptEditor.effectsHighlight" : "panel.pptEditor.effectsSpotlight"),
              start: cue.atMs, end: cue.endMs,
            })}</p>))}
      </div>)}
    </details>
    {bindings.map((value, index) => <label key={index}>
      {t("panel.pptEditor.sourceReviewNewPage", { page: index + 1 })}
      <select value={value} disabled={disabled} onChange={(event) => {
        const selected = event.target.value;
        setBindings((current) => current.map((entry, position) => position === index ? selected : entry));
        setConfirmed(false); setEffectsConfirmed(false); setObjectBindings({});
      }}>
        <option value="">{t("panel.pptEditor.sourceReviewChoose")}</option>
        <option value="new">{t("panel.pptEditor.sourceReviewNew")}</option>
        {review.project.pages.map((page, oldIndex) => <option key={page.pageId} value={String(oldIndex)}>
          {t("panel.pptEditor.sourceReviewOldPage", { page: oldIndex + 1 })}
        </option>)}
      </select>
    </label>)}
    {targets.length > 0 && <section aria-label={t("panel.pptEditor.sourceEffectTitle")}>
      <strong>{t("panel.pptEditor.sourceEffectTitle")}</strong>
      <p>{t("panel.pptEditor.sourceEffectScope")}</p>
      {targets.map(target => {
        const oldIndex = review.project.pages.findIndex(page => page.pageId === target.pageId);
        const pageIndex = bindings.indexOf(String(oldIndex));
        const key = JSON.stringify([target.pageId, target.objectId]);
        return <label key={key}>
          {t("panel.pptEditor.sourceEffectTarget", { page: oldIndex + 1, object: kindLabel(target.kind, target.index) })}
          <select value={objectBindings[key] ?? ""} disabled={disabled || pageIndex < 0} onChange={event => {
            const value = event.target.value; setObjectBindings(current => ({ ...current, [key]: value }));
            setEffectsConfirmed(false); setConfirmed(false);
          }}>
            <option value="">{t("panel.pptEditor.sourceEffectChoose")}</option>
            {(review.targetPages?.[pageIndex]?.objects ?? []).filter(object => ["text", "shape", "image"].includes(object.kind)).map(object =>
              <option key={object.index} value={String(object.index)}>{t("panel.pptEditor.sourceReviewNewPage", { page: pageIndex + 1 })} · {kindLabel(object.kind, object.index)}</option>)}
          </select>
        </label>;
      })}
      <label><input type="checkbox" checked={effectsConfirmed} disabled={disabled || !valid} onChange={event => setEffectsConfirmed(event.target.checked)} />
        {t("panel.pptEditor.sourceEffectConfirm")}
      </label>
    </section>}
    <p>{t("panel.pptEditor.sourceReviewRules")}</p>
    <label><input type="checkbox" checked={confirmed} disabled={disabled || !valid} onChange={(event) => setConfirmed(event.target.checked)} />
      {t("panel.pptEditor.sourceReviewConfirm")}
    </label>
    <div className="courseware-teaching-actions">
      <button type="button" disabled={disabled || !valid || !confirmed || (targets.length > 0 && !effectsConfirmed)} onClick={() => adopt(bindings.map((value) => value === "new" ? null : Number(value)), targets.length ? effectBindings : undefined)}>{t("panel.pptEditor.sourceReviewAdopt")}</button>
      <button type="button" disabled={disabled} onClick={cancel}>{t("panel.pptEditor.sourceReviewCancel")}</button>
    </div>
  </section>;
}
