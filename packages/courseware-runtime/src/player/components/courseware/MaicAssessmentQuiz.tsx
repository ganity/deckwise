import { useState, type ReactNode, type SVGProps } from 'react';
import type { QuizQuestion } from '../../lib/types/stage';

// Pure presentation/choice grading port of cloud-web quiz-view.tsx, pinned by maic-types/provenance.json.
// Desktop has no implicit online grading or microphone service; short answers stay explicitly ungraded.
interface QuestionResult { questionId: string; correct: boolean | null; status: 'correct' | 'incorrect' | 'ungraded'; earned: number; aiComment?: string }
const cn = (...values: Array<string | false | null | undefined>) => values.filter(Boolean).join(' ');
const labels: Record<string,string> = {"title": "随堂测验", "subtitle": "检测你的学习成果", "questionsCount": "道题", "totalPrefix": "共", "pointsSuffix": "分", "startQuiz": "开始答题", "multipleChoiceHint": "（多选题，请选择所有正确答案）", "inputPlaceholder": "请在此输入你的回答...", "charCount": "字", "yourAnswer": "你的回答：", "notAnswered": "未作答", "aiComment": "AI 点评", "singleChoice": "单选", "multipleChoice": "多选", "shortAnswer": "简答", "analysis": "解析：", "excellent": "优秀！", "keepGoing": "继续加油！", "needsReview": "需要复习", "correct": "正确", "incorrect": "错误", "answering": "答题中", "submitAnswers": "提交答案", "aiGrading": "AI 正在批改中...", "aiGradingWait": "请稍候，正在分析你的答案", "quizReport": "答题报告", "retry": "重新答题"};
const useI18n = () => ({t:(key:string) => labels[key.replace("quiz.","")] ?? key});
function Icon({ children, ...props }: SVGProps<SVGSVGElement>) { return <svg {...props} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{children}</svg>; }
const CheckCircle2 = (props: SVGProps<SVGSVGElement>) => <Icon {...props}><circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/></Icon>;
const XCircle = (props: SVGProps<SVGSVGElement>) => <Icon {...props}><circle cx="12" cy="12" r="10"/><path d="m15 9-6 6m0-6 6 6"/></Icon>;
const Check = (props: SVGProps<SVGSVGElement>) => <Icon {...props}><path d="m20 6-11 11-5-5"/></Icon>;
const Sparkles = (props: SVGProps<SVGSVGElement>) => <Icon {...props}><path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z"/></Icon>;
function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

function toArray(v: string | string[] | undefined): string[] {
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}

function normalizeAnswerToken(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function getOptionValueFromAnswerText(value: string): string | null {
  const trimmed = value.trim();
  const match = /^(?:option|选项)?\s*([A-Z])(?:\s*[:：]|$)/i.exec(trimmed);
  return match?.[1]?.toUpperCase() ?? null;
}

function normalizeChoiceAnswer(
  value: string,
  options: QuizQuestion["options"],
): string {
  const raw = value.trim();
  if (!raw) return raw;

  const normalizedRaw = normalizeAnswerToken(raw);
  const explicitOptionValue = getOptionValueFromAnswerText(raw);
  const optionMatch = options?.find((option) => {
    const optionValue = normalizeAnswerToken(option.value);
    const optionLabel = normalizeAnswerToken(option.label);
    return (
      explicitOptionValue === option.value ||
      normalizedRaw === optionValue ||
      normalizedRaw === optionLabel
    );
  });

  return optionMatch?.value ?? raw;
}

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

function getQuestionPoints(question: QuizQuestion): number {
  const points = Number(question.points);
  return Number.isFinite(points) && points > 0 ? points : 1;
}

function isShortAnswer(q: QuizQuestion): boolean {
  return (
    q.type === "short_answer" ||
    (!q.hasAnswer && (!q.answer || q.answer.length === 0))
  );
}

function getShortAnswerReferenceAnswer(question: QuizQuestion): string {
  if (question.type !== "short_answer") return "";
  const first = toArray(question.answer)[0] ?? question.referenceAnswer;
  return typeof first === "string" ? first.trim() : "";
}

export function gradeChoiceQuestions(
  questions: QuizQuestion[],
  answers: Record<string, string | string[]>,
): QuestionResult[] {
  return questions
    .filter((q) => !isShortAnswer(q))
    .map((q) => {
      const pts = getQuestionPoints(q);
      const userAnswer = toArray(answers[q.id]).map((answer) =>
        normalizeChoiceAnswer(answer, q.options),
      );
      const correctAnswer = toArray(q.answer).map((answer) =>
        normalizeChoiceAnswer(answer, q.options),
      );
      const correct = arraysEqual(userAnswer, correctAnswer);
      return {
        questionId: q.id,
        correct,
        status: correct ? ("correct" as const) : ("incorrect" as const),
        earned: correct ? pts : 0,
      };
    });
}

function SingleChoiceQuestion({
  question,
  index,
  value,
  onChange,
  disabled,
  result,
}: {
  question: QuizQuestion;
  index: number;
  value?: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  result?: QuestionResult;
}) {
  const isReview = !!result;

  return (
    <QuestionCard question={question} index={index} result={result}>
      <div className="grid gap-2">
        {question.options?.map((opt) => {
          const selected = value === opt.value;
          const isCorrectOpt = isReview && question.answer?.includes(opt.value);
          const isWrong =
            isReview && selected && result?.status === "incorrect";

          return (
            <button
              key={opt.value}
              aria-pressed={Array.isArray(value) ? value.includes(opt.value) : value === opt.value}
              disabled={disabled}
              onClick={() => !disabled && onChange(opt.value)}
              className={cn(
                "flex items-center gap-3 px-4 py-3 rounded-xl border text-left transition-all text-sm",
                // Default state
                !isReview &&
                  !selected &&
                  "border-gray-200 dark:border-gray-600 hover:border-violet-200 dark:hover:border-violet-700 hover:bg-violet-50/50 dark:hover:bg-violet-900/30",
                !isReview &&
                  selected &&
                  "border-violet-400 bg-violet-50 dark:bg-violet-900/30 ring-1 ring-violet-200 dark:ring-violet-700",
                // Review states
                isReview &&
                  isCorrectOpt &&
                  "border-emerald-400 bg-emerald-50 dark:bg-emerald-900/30",
                isReview &&
                  isWrong &&
                  !isCorrectOpt &&
                  "border-red-300 bg-red-50 dark:bg-red-900/30",
                isReview &&
                  !isCorrectOpt &&
                  !selected &&
                  "border-gray-100 dark:border-gray-700 opacity-60",
                disabled && !isReview && "cursor-default",
              )}
            >
              <span
                className={cn(
                  "w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold shrink-0 transition-colors",
                  !isReview &&
                    !selected &&
                    "bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400",
                  !isReview && selected && "bg-violet-500 text-white",
                  isReview && isCorrectOpt && "bg-emerald-500 text-white",
                  isReview &&
                    isWrong &&
                    !isCorrectOpt &&
                    "bg-red-400 text-white",
                  isReview &&
                    !isCorrectOpt &&
                    !selected &&
                    "bg-gray-100 dark:bg-gray-700 text-gray-400 dark:text-gray-500",
                )}
              >
                {opt.value}
              </span>
              <span
                className={cn(
                  "flex-1",
                  isReview &&
                    !isCorrectOpt &&
                    !selected &&
                    "text-gray-400 dark:text-gray-500",
                )}
              >
                {opt.image && <img src={opt.image.src} alt={opt.label || opt.value} style={{maxWidth:160,maxHeight:120,objectFit:"contain"}} />}{opt.label}
              </span>
              {isReview && isCorrectOpt && (
                <CheckCircle2 className="w-5 h-5 text-emerald-500 shrink-0" />
              )}
              {isReview && isWrong && !isCorrectOpt && (
                <XCircle className="w-5 h-5 text-red-400 shrink-0" />
              )}
            </button>
          );
        })}
      </div>
    </QuestionCard>
  );
}

function MultipleChoiceQuestion({
  question,
  index,
  value,
  onChange,
  disabled,
  result,
}: {
  question: QuizQuestion;
  index: number;
  value?: string[];
  onChange: (value: string[]) => void;
  disabled?: boolean;
  result?: QuestionResult;
}) {
  const isReview = !!result;
  const selected = value ?? [];

  const toggle = (optValue: string) => {
    if (disabled) return;
    if (selected.includes(optValue)) {
      onChange(selected.filter((v) => v !== optValue));
    } else {
      onChange([...selected, optValue]);
    }
  };

  const { t } = useI18n();

  return (
    <QuestionCard question={question} index={index} result={result}>
      {!isReview && (
        <p className="text-xs text-gray-400 dark:text-gray-500 mb-2">
          {t("quiz.multipleChoiceHint")}
        </p>
      )}
      <div className="grid gap-2">
        {question.options?.map((opt) => {
          const isSelected = selected.includes(opt.value);
          const isCorrectOpt = isReview && question.answer?.includes(opt.value);
          const isWrong = isReview && isSelected && !isCorrectOpt;

          return (
            <button
              key={opt.value}
              aria-pressed={Array.isArray(value) ? value.includes(opt.value) : value === opt.value}
              disabled={disabled}
              onClick={() => toggle(opt.value)}
              className={cn(
                "flex items-center gap-3 px-4 py-3 rounded-xl border text-left transition-all text-sm",
                !isReview &&
                  !isSelected &&
                  "border-gray-200 dark:border-gray-600 hover:border-violet-200 dark:hover:border-violet-700 hover:bg-violet-50/50 dark:hover:bg-violet-900/30",
                !isReview &&
                  isSelected &&
                  "border-violet-400 bg-violet-50 dark:bg-violet-900/30 ring-1 ring-violet-200 dark:ring-violet-700",
                isReview &&
                  isCorrectOpt &&
                  "border-emerald-400 bg-emerald-50 dark:bg-emerald-900/30",
                isReview &&
                  isWrong &&
                  "border-red-300 bg-red-50 dark:bg-red-900/30",
                isReview &&
                  !isCorrectOpt &&
                  !isSelected &&
                  "border-gray-100 dark:border-gray-700 opacity-60",
                disabled && !isReview && "cursor-default",
              )}
            >
              <span
                className={cn(
                  "w-7 h-7 rounded-lg flex items-center justify-center text-xs font-bold shrink-0 transition-colors",
                  !isReview &&
                    !isSelected &&
                    "bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400",
                  !isReview && isSelected && "bg-violet-500 text-white",
                  isReview && isCorrectOpt && "bg-emerald-500 text-white",
                  isReview && isWrong && "bg-red-400 text-white",
                  isReview &&
                    !isCorrectOpt &&
                    !isSelected &&
                    "bg-gray-100 dark:bg-gray-700 text-gray-400 dark:text-gray-500",
                )}
              >
                {!isReview && isSelected ? (
                  <Check className="w-3.5 h-3.5" />
                ) : (
                  opt.value
                )}
              </span>
              <span
                className={cn(
                  "flex-1",
                  isReview &&
                    !isCorrectOpt &&
                    !isSelected &&
                    "text-gray-400 dark:text-gray-500",
                )}
              >
                {opt.image && <img src={opt.image.src} alt={opt.label || opt.value} style={{maxWidth:160,maxHeight:120,objectFit:"contain"}} />}{opt.label}
              </span>
              {isReview && isCorrectOpt && (
                <CheckCircle2 className="w-5 h-5 text-emerald-500 shrink-0" />
              )}
              {isReview && isWrong && (
                <XCircle className="w-5 h-5 text-red-400 shrink-0" />
              )}
            </button>
          );
        })}
      </div>
    </QuestionCard>
  );
}

function ShortAnswerQuestion({
  question,
  index,
  value,
  onChange,
  disabled,
  result,
}: {
  question: QuizQuestion;
  index: number;
  value?: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  result?: QuestionResult;
}) {
  const isReview = !!result;
  const { t } = useI18n();
  const pts = getQuestionPoints(question);
  const referenceAnswer = getShortAnswerReferenceAnswer(question);

  return (
    <QuestionCard question={question} index={index} result={result}>
      {!isReview ? (
        <div className="relative">
          <textarea
            value={value ?? ""}
            onChange={(e) => onChange(e.target.value)}
            disabled={disabled}
            placeholder={t("quiz.inputPlaceholder")}
            className="w-full min-h-[100px] p-3 pb-10 rounded-xl border border-gray-200 dark:border-gray-600 text-sm resize-none focus:outline-none focus:border-violet-300 dark:focus:border-violet-600 focus:ring-2 focus:ring-violet-100 dark:focus:ring-violet-900/50 transition-all disabled:bg-gray-50 dark:disabled:bg-gray-800 disabled:text-gray-500 dark:bg-gray-800/50 dark:text-gray-200 dark:placeholder:text-gray-500"
          />
          <span className="absolute bottom-3 right-3 text-xs text-gray-300 dark:text-gray-600">
            {(value ?? "").length} {t("quiz.charCount")}
          </span>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="p-3 rounded-xl bg-gray-50 dark:bg-gray-800/50 border border-gray-100 dark:border-gray-700 text-sm text-gray-700 dark:text-gray-300">
            <p className="text-xs text-gray-400 dark:text-gray-500 mb-1">
              {t("quiz.yourAnswer")}
            </p>
            {value || (
              <span className="text-gray-400 dark:text-gray-500 italic">
                {t("quiz.notAnswered")}
              </span>
            )}
          </div>
          {result.status === "ungraded" && <p role="status" className="text-sm text-gray-500">本题需要教师或在线评价，当前尚未评分。</p>}
          {result.aiComment && (
            <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-violet-50 dark:bg-violet-900/30 border border-violet-100 dark:border-violet-800">
              <Sparkles className="w-4 h-4 text-violet-500 shrink-0 mt-0.5" />
              <div>
                <p className="text-xs font-medium text-violet-600 dark:text-violet-400 mb-0.5">
                  {t("quiz.aiComment")}
                </p>
                <p className="text-xs text-violet-600/80 dark:text-violet-400/80">
                  {result.aiComment}
                </p>
              </div>
              <span className="ml-auto text-xs font-bold text-violet-600 dark:text-violet-400 shrink-0">
                {result.earned}/{pts}
                {t("quiz.pointsSuffix")}
              </span>
            </div>
          )}
          {question.keyPoints?.length ? <div className="text-sm text-gray-500"><p>参考要点</p><ul>{question.keyPoints.map((point,index)=><li key={index}>{point}</li>)}</ul></div> : null}
          {referenceAnswer && (
            <div className="p-3 rounded-xl bg-emerald-50/70 dark:bg-emerald-900/20 border border-emerald-100 dark:border-emerald-800 text-sm text-emerald-700 dark:text-emerald-300">
              <p className="text-xs font-medium mb-1">参考答案</p>
              <p>{referenceAnswer}</p>
            </div>
          )}
        </div>
      )}
    </QuestionCard>
  );
}

function QuestionCard({
  question,
  index,
  result,
  children,
}: {
  question: QuizQuestion;
  index: number;
  result?: QuestionResult;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const isReview = !!result;
  const pts = getQuestionPoints(question);
  const reviewStatusLabel = isReview
    ? result.status === "correct"
      ? t("quiz.correct")
      : result.status === "ungraded" ? "尚未评分" : t("quiz.incorrect")
    : null;

  return (
    <div
      data-question-id={question.id}
      data-grading-status={result?.status}
      className={cn(
        "bg-white dark:bg-gray-800 rounded-2xl border p-5 relative overflow-hidden",
        !isReview && "border-gray-150 dark:border-gray-700 shadow-sm",
        isReview &&
          result.status === "correct" &&
          "border-emerald-200 dark:border-emerald-800 shadow-sm shadow-emerald-50 dark:shadow-emerald-900/20",
        isReview &&
          result.status === "incorrect" &&
          "border-red-200 dark:border-red-800 shadow-sm shadow-red-50 dark:shadow-red-900/20",
      )}
    >
      {/* Left accent */}
      <div
        className={cn(
          "absolute left-0 top-0 bottom-0 w-1 rounded-l-2xl",
          !isReview && "bg-violet-400",
          isReview && result.status === "correct" && "bg-emerald-400",
          isReview && result.status === "incorrect" && "bg-red-400",
        )}
      />

      {/* Header */}
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-start gap-3">
          <span
            className={cn(
              "w-7 h-7 rounded-lg flex items-center justify-center text-xs font-bold shrink-0",
              !isReview &&
                "bg-violet-100 dark:bg-violet-900/50 text-violet-600 dark:text-violet-400",
              isReview &&
                result.status === "correct" &&
                "bg-emerald-100 dark:bg-emerald-900/50 text-emerald-600 dark:text-emerald-400",
              isReview &&
                result.status === "incorrect" &&
                "bg-red-100 dark:bg-red-900/50 text-red-600 dark:text-red-400",
            )}
          >
            {index + 1}
          </span>
          <div>
            <p className="text-sm font-medium text-gray-800 dark:text-gray-100 leading-relaxed">
              {question.question}
            </p>
            <div className="flex flex-wrap items-center gap-2 mt-0.5">
              <p className="text-xs text-gray-400">
                {question.type === "single"
                  ? t("quiz.singleChoice")
                  : question.type === "multiple"
                    ? t("quiz.multipleChoice")
                    : question.type === "judge"
                      ? getJudgeQuestionTypeLabel(question)
                      : t("quiz.shortAnswer")}
                {" · "}
                {pts} {t("quiz.pointsSuffix")}
              </p>
              {isReview && reviewStatusLabel && (
                <span
                  className={cn(
                    "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold",
                    result.status === "correct" &&
                      "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300",
                    result.status === "incorrect" &&
                      "bg-red-100 text-red-600 dark:bg-red-900/40 dark:text-red-300",
                  )}
                >
                  {reviewStatusLabel}
                </span>
              )}
            </div>
          </div>
        </div>
        {isReview && (
          <div className="shrink-0 ml-2">
            {result.status === "correct" && (
              <CheckCircle2 className="w-6 h-6 text-emerald-500" />
            )}
            {result.status === "incorrect" && (
              <XCircle className="w-6 h-6 text-red-400" />
            )}
          </div>
        )}
      </div>

      {question.image && <img src={question.image.src} alt="题目图片" style={{maxWidth:"100%",maxHeight:220,objectFit:"contain",marginBottom:12}} />}
      {/* Body */}
      {children}
      {isReview && question.analysis && <p className="text-xs text-gray-500 mt-3">解析：{question.analysis}</p>}
    </div>
  );
}

function ScoreBanner({
  score,
  total,
  results,
}: {
  score: number;
  total: number;
  results: QuestionResult[];
}) {
  const { t } = useI18n();
  const pct = total > 0 ? Math.round((score / total) * 100) : 0;
  const correctCount = results.filter((r) => r.status === "correct").length;
  const incorrectCount = results.filter((r) => r.status === "incorrect").length;

  const color = pct >= 80 ? "emerald" : pct >= 60 ? "amber" : "red";
  const colorMap = {
    emerald: {
      bg: "from-emerald-500 to-teal-500",
      shadow: "shadow-emerald-200/50 dark:shadow-emerald-900/50",
      ring: "bg-emerald-400/30",
      text: t("quiz.excellent"),
    },
    amber: {
      bg: "from-amber-500 to-yellow-500",
      shadow: "shadow-amber-200/50 dark:shadow-amber-900/50",
      ring: "bg-amber-400/30",
      text: t("quiz.keepGoing"),
    },
    red: {
      bg: "from-red-500 to-rose-500",
      shadow: "shadow-red-200/50 dark:shadow-red-900/50",
      ring: "bg-red-400/30",
      text: t("quiz.needsReview"),
    },
  };
  const c = colorMap[color];

  return (
    <div
      className={cn(
        "rounded-2xl p-6 bg-gradient-to-r text-white shadow-lg",
        c.bg,
        c.shadow,
      )}
    >
      <div className="flex items-center justify-between">
        <div>
          <p className="text-white/80 text-sm font-medium">{c.text}</p>
          <div className="flex items-baseline gap-1 mt-1">
            <span className="text-3xl font-black">{score}</span>
            <span className="text-white/60 text-base">/ {total}</span>
          </div>
          <div className="flex gap-3 mt-3 text-xs">
            <span className="flex items-center gap-1">
              <CheckCircle2 className="w-3.5 h-3.5" /> {correctCount}{" "}
              {t("quiz.correct")}
            </span>
            <span className="flex items-center gap-1">
              <XCircle className="w-3.5 h-3.5" /> {incorrectCount}{" "}
              {t("quiz.incorrect")}
            </span>
          </div>
        </div>

        {/* Percentage ring */}
        <div className="relative w-16 h-16">
          <svg className="w-16 h-16 -rotate-90" viewBox="0 0 80 80">
            <circle
              cx="40"
              cy="40"
              r="34"
              fill="none"
              stroke="rgba(255,255,255,0.2)"
              strokeWidth="6"
            />
            <circle
              cx="40"
              cy="40"
              r="34"
              fill="none"
              stroke="white"
              strokeWidth="6"
              strokeLinecap="round"
              strokeDasharray={`${2 * Math.PI * 34}`}
              strokeDashoffset={2 * Math.PI * 34 * (1 - pct / 100)}
            />
          </svg>
          <div className="absolute inset-0 flex items-center justify-center">
            <span className="text-base font-black">{pct}%</span>
          </div>
        </div>
      </div>
    </div>
  );
}


export function MaicAssessmentQuiz({questions, disabled = false, onComplete}: {questions: QuizQuestion[]; disabled?: boolean; onComplete?: () => void}) {
  const [phase, setPhase] = useState<'answering' | 'reviewing'>('answering');
  const [answers, setAnswers] = useState<Record<string,string | string[]>>({});
  const reviewing = phase === 'reviewing';
  const results = gradeChoiceQuestions(questions, answers);
  const resultMap = new Map(results.map(result => [result.questionId, result]));
  const ungraded = questions.filter(isShortAnswer);
  const total = questions.filter(question => !isShortAnswer(question)).reduce((sum,question) => sum + getQuestionPoints(question),0);
  const allAnswered = questions.length > 0 && questions.every(question => { const answer=answers[question.id]; return Array.isArray(answer) ? answer.length > 0 : !!answer?.trim(); });
  const answered = Object.values(answers).filter(answer => Array.isArray(answer) ? answer.length : answer.trim()).length;
  const setAnswer = (id:string, value:string | string[]) => setAnswers(previous=>({...previous,[id]:value}));
  return <section aria-label="课堂测验" data-scene-type="quiz" data-maic-quiz-card className="maic-assessment-shell">
    <div className="w-full h-full bg-gradient-to-b from-gray-50 to-white dark:from-gray-900 dark:to-gray-900 overflow-hidden flex flex-col">
      <div className="flex-1 flex flex-col min-h-0">
        <div className="flex items-center justify-between px-6 py-3 border-b border-gray-100 dark:border-gray-700 bg-white/80 dark:bg-gray-900/80 backdrop-blur shrink-0">
          <div className="flex items-center gap-2">
            {reviewing ? <CheckCircle2 className="w-4 h-4 text-emerald-500"/> : <Icon className="w-4 h-4 text-violet-500"><path d="M21 12A9 9 0 1 1 12 3v9Z"/><path d="M21 9h-6V3a9 9 0 0 1 6 6Z"/></Icon>}
            <span className="text-sm font-semibold text-gray-700 dark:text-gray-200">{reviewing ? '答题报告' : '答题中'}</span>
            {!reviewing && <span className="text-xs text-gray-400 ml-1">{answered} / {questions.length}</span>}
          </div>
          {reviewing ? <button type="button" disabled={disabled} onClick={()=>{setAnswers({});setPhase('answering');}} className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400 hover:text-violet-600 dark:hover:text-violet-400 transition-colors">重新答题</button>
            : <button type="button" disabled={disabled || !allAnswered} onClick={()=>setPhase('reviewing')} className={cn('px-4 py-1.5 rounded-lg text-xs font-medium transition-all',allAnswered ? 'bg-gradient-to-r from-violet-500 to-purple-500 text-white shadow-sm hover:shadow-md hover:shadow-violet-200/50 dark:hover:shadow-violet-900/50 active:scale-[0.97]' : 'bg-gray-100 dark:bg-gray-700 text-gray-400 dark:text-gray-500 cursor-not-allowed')}>提交答案</button>}
        </div>
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
          {reviewing && <>{total > 0 && <ScoreBanner score={results.reduce((sum,result)=>sum+result.earned,0)} total={total} results={results}/>}
            {ungraded.length > 0 && <p role="status" className="text-sm text-gray-500">{ungraded.length} 道题需要教师或在线评价，未计入当前得分。</p>}</>}
          {questions.map((question,index)=>{
            const result: QuestionResult | undefined = reviewing ? resultMap.get(question.id) ?? {questionId:question.id,correct:null,status:'ungraded',earned:0} : undefined;
            const common={question,index,disabled:disabled || reviewing,result};
            if(question.type==='single' || question.type==='judge') return <SingleChoiceQuestion key={question.id} {...common} value={answers[question.id] as string | undefined} onChange={value=>setAnswer(question.id,value)}/>;
            if(question.type==='multiple') return <MultipleChoiceQuestion key={question.id} {...common} value={answers[question.id] as string[] | undefined} onChange={value=>setAnswer(question.id,value)}/>;
            return <ShortAnswerQuestion key={question.id} {...common} value={answers[question.id] as string | undefined} onChange={value=>setAnswer(question.id,value)}/>;
          })}
          {!questions.length && <p>本页尚未添加题目。</p>}
          {reviewing && onComplete && <button type="button" disabled={disabled} onClick={onComplete} className="px-4 py-1.5 rounded-lg text-xs font-medium bg-violet-500 text-white">完成测验</button>}
        </div>
      </div>
    </div>
  </section>;
}
