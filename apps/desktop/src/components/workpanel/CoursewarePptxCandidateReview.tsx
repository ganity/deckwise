import type { CoursewareEffectBinding, CoursewarePptxCandidateReview as Review } from "@pi-desktop/shared";
import { useTranslation } from "react-i18next";
import { useState } from "react";
import { CoursewareStyleReview } from "./CoursewareStyleReview";

export function CoursewarePptxCandidateReview({ review, sessionId, disabled, preview, reject, adopt, close }: {
  review: Review;
  sessionId?: string;
  disabled: boolean;
  preview: () => void;
  reject: () => void;
  adopt: (effectBindings?: CoursewareEffectBinding[]) => void;
  close: () => void;
}) {
  const { t } = useTranslation();
  const [confirmed, setConfirmed] = useState(false);
  const [styleBusy, setStyleBusy] = useState(false);
  const [objectBindings, setObjectBindings] = useState<Record<string, string>>({});
  const [effectsConfirmed, setEffectsConfirmed] = useState(false);
  const blocked = disabled || styleBusy;
  const targets = review.effectTargets ?? [];
  const effectBindings = targets.map(target => ({ pageIndex: target.pageIndex, objectId: target.objectId,
    targetIndex: Number(objectBindings[JSON.stringify([target.pageId, target.objectId])] ?? 0) }));
  const effectsValid = effectBindings.every(binding => binding.targetIndex > 0 &&
    ["text", "shape", "image"].includes(review.effectPages?.[binding.pageIndex]?.objects[binding.targetIndex - 1]?.kind ?? "")) &&
    new Set(effectBindings.map(binding => JSON.stringify([binding.pageIndex, binding.targetIndex]))).size === effectBindings.length;
  const kindLabel = (kind: string, index: number) => t(kind === "text" ? "panel.pptEditor.effectsObjectText" :
    kind === "shape" ? "panel.pptEditor.effectsObjectShape" : kind === "image" ? "panel.pptEditor.effectsObjectImage" : "panel.pptEditor.effectsObject", { number: index });
  return <section className="courseware-source-review" aria-label={t("panel.pptEditor.pptxCandidateTitle")}>
    <strong>{t("panel.pptEditor.pptxCandidateTitle")}</strong>
    <p>{t("panel.pptEditor.pptxCandidateKind", { kind: t(`coursewareWorkflow.${review.kind}`) })}</p>
    <ul>{review.targetPages.map(page => <li key={page.pageId}>{t("panel.pptEditor.pptxCandidateTarget", { page: page.pageNumber })}</li>)}</ul>
    <p>{t("panel.pptEditor.pptxCandidateLineage", { state: review.lineageVerified ? t("panel.pptEditor.pptxCandidateVerified") : t("panel.pptEditor.pptxCandidateUnverified") })}</p>
    {review.stale && <p role="alert">{t("panel.pptEditor.candidateStale")}</p>}
    {targets.length > 0 && <section aria-label={t("panel.pptEditor.sourceEffectTitle")}>
      <strong>{t("panel.pptEditor.sourceEffectTitle")}</strong>
      <p>{t("panel.pptEditor.pptxCandidateEffectScope")}</p>
      {(review.effectCues ?? []).map((cue, index) => <p key={index}>
        {t("panel.pptEditor.pptxCandidateTarget", { page: cue.pageNumber })} · {t("panel.pptEditor.effectsCue", {
          effect: t(`panel.pptEditor.effects${({ highlight: "Highlight", spotlight: "Spotlight", fadeIn: "FadeIn", fadeOut: "FadeOut", pulse: "Pulse" } as const)[cue.effect]}`), start: cue.atMs, end: cue.endMs,
        })}
      </p>)}
      {targets.map(target => {
        const key = JSON.stringify([target.pageId, target.objectId]);
        return <label key={key}>
          {t("panel.pptEditor.sourceEffectTarget", { page: target.pageIndex + 1, object: kindLabel(target.kind, target.index) })}
          <select value={objectBindings[key] ?? ""} disabled={blocked || review.stale} onChange={event => {
            const value = event.target.value; setObjectBindings(current => ({ ...current, [key]: value }));
            setEffectsConfirmed(false); setConfirmed(false);
          }}>
            <option value="">{t("panel.pptEditor.pptxCandidateEffectChoose")}</option>
            {(review.effectPages?.[target.pageIndex]?.objects ?? []).filter(object => ["text", "shape", "image"].includes(object.kind)).map(object =>
              <option key={object.index} value={String(object.index)}>{kindLabel(object.kind, object.index)}</option>)}
          </select>
        </label>;
      })}
      <label><input type="checkbox" checked={effectsConfirmed} disabled={blocked || review.stale || !effectsValid}
        onChange={event => setEffectsConfirmed(event.target.checked)} />{t("panel.pptEditor.sourceEffectConfirm")}</label>
    </section>}
    <label><input type="checkbox" checked={confirmed} disabled={blocked || review.stale || !review.lineageVerified}
      onChange={(event) => setConfirmed(event.target.checked)} />{t("panel.pptEditor.pptxCandidateConfirm")}</label>
    <div className="courseware-teaching-actions">
      <button type="button" disabled={blocked || review.stale} onClick={preview}>{t("panel.pptEditor.pptxCandidatePreview")}</button>
      <button type="button" disabled={blocked || !confirmed || !effectsValid || (targets.length > 0 && !effectsConfirmed) || review.stale || !review.lineageVerified || !["page-fade", "page-pptx", "page-style-batch"].includes(review.kind)} onClick={() => adopt(targets.length ? effectBindings : undefined)}>{t("panel.pptEditor.pptxCandidateAdopt")}</button>
      <button type="button" disabled={blocked} onClick={reject}>{t("panel.pptEditor.candidateReject")}</button>
      <button type="button" disabled={blocked} onClick={close}>{t("panel.pptEditor.candidateClose")}</button>
    </div>
    {sessionId && review.kind === "page-pptx" && review.lineageVerified && !review.stale && <CoursewareStyleReview
      sessionId={sessionId} candidateId={review.candidateId} enabled={!disabled && !confirmed} onActiveChange={setStyleBusy} />}
  </section>;
}
