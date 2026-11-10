import { createRoot } from "react-dom/client";
import { useState } from "react";
import { MaicQuiz, TeachingQuestion, chinesePlayerLabels, type MaicClassroom, type TeachingQuestionPayload } from "@pi-desktop/courseware-runtime/player";
import playerStyles from "@pi-desktop/courseware-runtime/player.css?inline";

type Quiz = Extract<MaicClassroom["scenes"][number]["content"], { type: "quiz" }>;
function NativeQuiz({ content, complete }: { content: Quiz; complete(): void }) {
  const [index, setIndex] = useState(0);
  const [answered, setAnswered] = useState(false);
  const instant = content.interactionMode === "classroom_instant_feedback";
  const next = () => { if (index + 1 < content.questions.length) { setIndex(index + 1); setAnswered(false); } else complete(); };
  return <>
    <MaicQuiz key={index} content={instant ? { ...content, questions: content.questions.slice(index, index + 1) } : content}
      disabled={answered} onComplete={instant ? next : complete} onInstantAnswer={correct => setAnswered(correct)} />
    {answered && <button type="button" onClick={next}>{chinesePlayerLabels.teacherContinue}</button>}
  </>;
}

/** Native PPT owns rendering; both playback surfaces reuse these assessment views. */
export function mountNativeTeachingQuestion(container: HTMLElement, input: {
  quiz?: Quiz;
  question?: TeachingQuestionPayload;
  complete(): void;
}) {
  const sheet = container.ownerDocument.createElement("style");
  sheet.textContent = playerStyles;
  const content = container.ownerDocument.createElement("div");
  content.style.cssText = "width:100%;--background:#fff;--foreground:#172033;--primary:#267c72;--primary-foreground:#fff;--border:#cbd5e1";
  container.append(sheet, content);
  const root = createRoot(content);
  let disposed = false;
  const complete = () => { if (!disposed) input.complete(); };
  root.render(input.quiz
    ? <NativeQuiz content={input.quiz} complete={complete} />
    : input.question ? <>
      <TeachingQuestion question={input.question} labels={chinesePlayerLabels} />
      <button type="button" onClick={complete}>{chinesePlayerLabels.teacherContinue}</button>
    </> : null);
  return () => { disposed = true; root.unmount(); container.replaceChildren(); };
}
