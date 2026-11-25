import { useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { CoursewareStory } from "@pi-desktop/shared";

export function CoursewareStoryPreview({ draft }: { draft: CoursewareStory }) {
  const { t } = useTranslation();
  const id = useId();
  const [view, setView] = useState<"plot" | "design">("plot");
  const tabs = useRef<HTMLDivElement>(null);
  const plot = view === "plot";
  return <>
    <div className="courseware-story-heading"><h2>{draft.title}</h2></div>
    <div className="courseware-story-tabs" role="tablist" aria-label={t("coursewareStory.title")} ref={tabs}>
      {(["plot", "design"] as const).map(name => <button key={name} type="button" role="tab" id={id + name}
        aria-selected={view === name} tabIndex={view === name ? 0 : -1} aria-controls={id + "-panel-" + name}
        onClick={() => setView(name)} onKeyDown={event => {
          const next = event.key === "Home" ? "plot" : event.key === "End" ? "design" :
            ["ArrowLeft", "ArrowRight"].includes(event.key) ? (plot ? "design" : "plot") : null;
          if (!next) return;
          event.preventDefault();
          setView(next);
          tabs.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next === "plot" ? 0 : 1]?.focus();
        }}>{t(`coursewareStory.${name}`)}</button>)}
    </div>
    {(["plot", "design"] as const).map(name => <section key={name} role="tabpanel"
      id={id + "-panel-" + name} aria-labelledby={id + name} hidden={view !== name} tabIndex={0} className="courseware-story-reading">
      {name === view && <div className="courseware-story-column">
        {plot ? <>
          <p className="courseware-story-summary">{draft.summary}</p>
          <details className="courseware-story-setting"><summary>{t("coursewareStory.setting")}</summary>
            <p>{draft.setting}</p>
            {!!draft.characters.length && <dl>{draft.characters.map((character, i) => <div key={i}>
              <dt>{character.name}</dt><dd>{character.description}</dd></div>)}</dl>}
          </details>
        </> : <>
          <h3>{t("coursewareStory.objectives")}</h3>
          <ul>{draft.objectives.map(item => <li key={item}>{item}</li>)}</ul>
          {(draft.durationMinutes || draft.bodyPageLimit) && <div className="courseware-story-meta">
            {draft.durationMinutes && <span>{t("coursewareStory.duration", { count: draft.durationMinutes })}</span>}
            {draft.bodyPageLimit && <span>{t("coursewareStory.pages", { count: draft.bodyPageLimit })}</span>}
          </div>}
        </>}
        <ol className="courseware-story-beats">{draft.beats.map((beat, index) => <li key={beat.id}>
          <span className="courseware-story-number" aria-hidden="true">{String(index + 1).padStart(2, "0")}</span>
          <div><h3>{beat.title}</h3>{plot ? <p>{beat.event}</p> : <dl>
            <div><dt>{t("coursewareStory.objective")}</dt><dd>{beat.objective}</dd></div>
            <div><dt>{t("coursewareStory.activity")}</dt><dd>{beat.activity}</dd></div>
            {beat.assessment && <div><dt>{t(beat.assessment.kind === "quiz" ? "coursewareWorkflow.quizTemplate" : "coursewareStory.checkpoint")}</dt>
              <dd>{beat.assessment.question}<details className="courseware-story-answer"><summary>{t("coursewareStory.reference")}</summary>
                <p>{beat.assessment.referenceAnswer}</p></details></dd></div>}
          </dl>}</div>
        </li>)}</ol>
        {!plot && !!draft.assumptions.length && <><h3>{t("coursewareStory.assumptions")}</h3>
          <ul>{draft.assumptions.map(item => <li key={item}>{item}</li>)}</ul></>}
      </div>}
    </section>)}
  </>;
}
