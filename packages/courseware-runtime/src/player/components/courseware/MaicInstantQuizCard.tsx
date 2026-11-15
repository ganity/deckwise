// Presentation port of cloud-web components/scene-renderers/quiz-view.tsx,
// ClassroomInstantSingleQuestionView. No store, upload, or network dependency.
import type { QuizQuestion } from '../../lib/types/stage';
const cn = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(' ');
const CheckCircle2 = ({ className }: { className: string }) => <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/></svg>;
const XCircle = ({ className }: { className: string }) => <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><path d="m9 9 6 6m0-6-6 6"/></svg>;
function isEnglishLikeQuizText(text?: string): boolean {
  if (!text) return false;
  return /[A-Za-z]/.test(text) && !/\p{Script=Han}/u.test(text);
}

function isEnglishQuizQuestion(question: QuizQuestion): boolean {
  if (/\p{Script=Han}/u.test(question.question)) return false;
  if (isEnglishLikeQuizText(question.question)) return true;
  if (isEnglishLikeQuizText(question.analysis)) return true;
  return (
    question.options?.some((option) => isEnglishLikeQuizText(option.label)) ?? false
  );
}

function isEnglishJudgeQuestion(question: QuizQuestion): boolean {
  if (question.type !== "judge") return false;
  return isEnglishQuizQuestion(question);
}

function getJudgeQuestionTypeLabel(question: QuizQuestion): string {
  return isEnglishJudgeQuestion(question) ? "True or False" : "判断题";
}

function getJudgeActionLabel(question: QuizQuestion): string {
  return isEnglishJudgeQuestion(question) ? "True or False" : "立即判断";
}

function getJudgeHelperText(question: QuizQuestion): string {
  return isEnglishJudgeQuestion(question)
    ? "Decide whether the statement is true or false."
    : "请判断这个说法是否正确。";
}

function getClassroomInstantActionLabel(question: QuizQuestion): string {
  if (question.type === "judge") {
    return getJudgeActionLabel(question);
  }
  return isEnglishQuizQuestion(question) ? "Choose the Best Answer" : "立即选择";
}

function getClassroomInstantHelperText(
  question: QuizQuestion,
  chineseText: string,
): string | undefined {
  if (question.type === "judge") {
    return undefined;
  }
  return isEnglishQuizQuestion(question)
    ? "Please choose the best answer."
    : chineseText;
}

function shouldUseCompactClassroomInstantLayout(question: QuizQuestion): boolean {
  const questionLength = question.question.trim().length;
  const optionLabels =
    question.options?.map((option) => option.label.trim()).filter(Boolean) ?? [];
  const longestOptionLength = optionLabels.reduce(
    (max, label) => Math.max(max, label.length),
    0,
  );
  const totalOptionLength = optionLabels.reduce(
    (sum, label) => sum + label.length,
    0,
  );

  return (
    questionLength >= 72 ||
    longestOptionLength >= 32 ||
    totalOptionLength >= 96
  );
}

function QuizImagePreview({
  src,
  alt,
  className,
}: {
  src?: string;
  alt: string;
  className?: string;
}) {
  if (!src) return null;
  return (
    <img
      src={src}
      alt={alt}
      className={cn(
        "block w-full object-cover shadow-[0_8px_24px_rgba(15,23,42,0.08)]",
        !className?.includes('rounded-') && 'rounded-[24px]',
        className,
      )}
    />
  );
}

export function MaicInstantQuizCard({ question, value, result, disabled, onAnswer }: {
  question: QuizQuestion; value?: string; result?: { status: 'correct' | 'incorrect' }; disabled?: boolean;
  onAnswer: (value: string) => void;
}) {
const actionLabel = getClassroomInstantActionLabel(question);
  const helperText = getClassroomInstantHelperText(question, "请选择最合适的答案");
  const useCompactLayout = shouldUseCompactClassroomInstantLayout(question);
  return (
    <div
      data-classroom-instant-layout={useCompactLayout ? "compact" : "default"}
      className={cn(
        "flex h-full w-full justify-center overflow-y-auto bg-[radial-gradient(circle_at_top,_#f8fbff,_#eef5ff_40%,_#ffffff_78%)] px-6 py-8 dark:bg-gradient-to-b dark:from-slate-950 dark:via-slate-950 dark:to-slate-900",
        useCompactLayout ? "items-start" : "items-center",
      )}
    >
      <div className="w-full max-w-6xl rounded-[36px] border border-[#d9e7ff] bg-white/96 px-8 py-8 shadow-[0_24px_70px_rgba(59,130,246,0.10)] dark:border-slate-800 dark:bg-slate-900/95">
        <div className="space-y-8">
          <div
            className={cn(
              "grid items-start gap-6",
              question.image
                ? "grid-cols-1 lg:grid-cols-[360px_minmax(0,1fr)]"
                : "grid-cols-1",
            )}
          >
            <QuizImagePreview
              src={question.image?.src}
              alt={question.question}
              className="aspect-[16/9] max-h-[240px] bg-slate-100"
            />
            <div className="space-y-3 pt-1">
              <p className="text-sm font-semibold text-[#3b82f6]">
                {actionLabel}
              </p>
              <h3
                className={cn(
                  "font-semibold text-slate-900 dark:text-slate-50",
                  useCompactLayout
                    ? "text-[22px] leading-[1.4] lg:text-[24px]"
                    : "text-[28px] leading-[1.45]",
                )}
              >
                {question.question}
              </h3>
              {helperText && (
                <p className="text-base text-slate-400 dark:text-slate-500">
                  {helperText}
                </p>
              )}
            </div>
          </div>

          <div
            className={cn(
              "grid gap-5",
              question.type === "judge"
                ? "grid-cols-1 md:grid-cols-2"
                : useCompactLayout
                  ? "grid-cols-1 md:grid-cols-2 xl:grid-cols-2"
                  : "grid-cols-1 md:grid-cols-2 xl:grid-cols-4",
            )}
          >
            {question.options?.map((option) => {
              const selected = value === option.value;
              const isCorrectOption = question.answer?.includes(option.value);
              const isCorrect = result?.status === "correct" && isCorrectOption;
              const isWrong =
                result?.status === "incorrect" && selected && !isCorrectOption;
              const isDimmed =
                !!result &&
                result.status === "incorrect" &&
                !selected &&
                !isCorrectOption;

              return (
                <button
                  key={option.value}
                  type="button"
                  disabled={disabled} aria-pressed={value === option.value} onClick={() => onAnswer(option.value)}
                  className={cn(
                    "rounded-[28px] border bg-white px-5 py-5 text-left shadow-[0_10px_30px_rgba(15,23,42,0.06)] transition-all",
                    !result &&
                      !selected &&
                      "border-slate-200 hover:-translate-y-0.5 hover:border-[#8eb8ff] hover:bg-[#f8fbff] dark:border-slate-700 dark:bg-slate-950/40 dark:hover:border-[#3b82f6]",
                    !result &&
                      selected &&
                      "border-[#3b82f6] bg-[#eff6ff] ring-2 ring-[#bfdbfe] dark:border-[#60a5fa] dark:bg-[#0f172a] dark:ring-[#1d4ed8]",
                    isCorrect &&
                      "border-emerald-300 bg-emerald-50 dark:border-emerald-600 dark:bg-emerald-950/20",
                    isWrong &&
                      "border-red-300 bg-red-50 dark:border-red-600 dark:bg-red-950/20",
                    isDimmed &&
                      "border-slate-100 bg-slate-50/80 opacity-70 dark:border-slate-800 dark:bg-slate-900/70",
                  )}
                >
                  <div className="space-y-4">
                    {option.image?.src && (
                      <QuizImagePreview
                        src={option.image.src}
                        alt={option.label}
                        className={cn(
                          "rounded-[20px] bg-slate-100",
                          question.type === "judge" ? "aspect-[16/9]" : "aspect-[4/3]",
                        )}
                      />
                    )}
                    <div
                      className={cn(
                        "flex gap-4",
                        useCompactLayout ? "items-start" : "items-center",
                      )}
                    >
                      <span
                        className={cn(
                          "flex h-12 w-12 shrink-0 items-center justify-center rounded-full text-lg font-bold",
                          !result && !selected && "bg-[#3b82f6] text-white",
                          !result && selected && "bg-[#2563eb] text-white",
                          isCorrect && "bg-emerald-500 text-white",
                          isWrong && "bg-red-500 text-white",
                          isDimmed &&
                            "bg-slate-200 text-slate-500 dark:bg-slate-800 dark:text-slate-400",
                        )}
                      >
                        {question.type === "judge"
                          ? option.value === "T"
                            ? "√"
                            : "×"
                          : option.value}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p
                          className={cn(
                            "font-semibold text-slate-900 dark:text-slate-100",
                            question.type === "judge"
                              ? "text-[30px]"
                              : useCompactLayout
                                ? "text-[18px] leading-[1.5] lg:text-[20px]"
                                : "text-[22px]",
                          )}
                        >
                          {option.label}
                        </p>
                      </div>
                      {isCorrect && (
                        <CheckCircle2 className="h-6 w-6 shrink-0 text-emerald-500" />
                      )}
                      {isWrong && (
                        <XCircle className="h-6 w-6 shrink-0 text-red-500" />
                      )}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
