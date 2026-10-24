import type { CoursewareEducationContext as EducationContext } from "@pi-desktop/shared";
import { buildKindergartenEnglishCommandPolicy } from "./kindergarten-english-commands.js";
type Edition = "EDUCATION" | "ENTERPRISE";
type GenerateClassroomInput = { edition?: Edition; workflowProfile?: string; interactionProfile?: string; educationContext?: EducationContext };
const isKindergartenSchoolStage = (stage?: string) => stage?.trim().toUpperCase() === "KINDERGARTEN";

type WorkflowProfileId = 'enterprise_training_workflow' | 'school_classroom_workflow';
type InteractionProfileId = 'subjective_checkpoint' | 'objective_quiz_first';

export interface GenerationProfile {
  edition: Edition;
  workflowProfile: WorkflowProfileId;
  interactionProfile: InteractionProfileId;
  educationContext?: EducationContext;
  workflow: {
    allowQuizScenes: boolean;
    allowInteractiveScenes: boolean;
    allowChapterInteraction: boolean;
  };
  interaction: {
    objectiveQuizEnabled: boolean;
    gameQuizEnabled: boolean;
  };
  prompt: {
    audienceTone: 'enterprise_training' | 'teacher_classroom';
  };
}

export interface StagePromptContext {
  editionProfile: string;
  audienceStageProfile: string;
  flowProfile: string;
  interactionProfile: string;
  languagePolicy: string;
}

function invalidProfileError(
  field: 'workflowProfile' | 'interactionProfile',
  value: string,
): Error {
  return new Error(`Invalid ${field}: ${value}`);
}

export function isGenerationProfileValidationError(error: unknown): error is Error {
  return (
    error instanceof Error && /Invalid (workflowProfile|interactionProfile):/i.test(error.message)
  );
}

function resolveEnterpriseProfile(
  input: Pick<GenerateClassroomInput, 'workflowProfile' | 'interactionProfile'>,
): GenerationProfile {
  const workflowProfile = input.workflowProfile ?? 'enterprise_training_workflow';
  const interactionProfile = input.interactionProfile ?? 'subjective_checkpoint';

  if (workflowProfile !== 'enterprise_training_workflow') {
    throw invalidProfileError('workflowProfile', workflowProfile);
  }

  if (interactionProfile !== 'subjective_checkpoint') {
    throw invalidProfileError('interactionProfile', interactionProfile);
  }

  return {
    edition: 'ENTERPRISE',
    workflowProfile,
    interactionProfile,
    workflow: {
      allowQuizScenes: false,
      allowInteractiveScenes: false,
      allowChapterInteraction: true,
    },
    interaction: {
      objectiveQuizEnabled: false,
      gameQuizEnabled: false,
    },
    prompt: {
      audienceTone: 'enterprise_training',
    },
  };
}

function resolveEducationProfile(
  input: Pick<
    GenerateClassroomInput,
    'workflowProfile' | 'interactionProfile' | 'educationContext'
  >,
): GenerationProfile {
  if (!input.workflowProfile) {
    throw new Error('Missing workflowProfile for EDUCATION');
  }

  if (!input.interactionProfile) {
    throw new Error('Missing interactionProfile for EDUCATION');
  }

  if (input.workflowProfile !== 'school_classroom_workflow') {
    throw invalidProfileError('workflowProfile', input.workflowProfile);
  }

  if (input.interactionProfile !== 'objective_quiz_first') {
    throw invalidProfileError('interactionProfile', input.interactionProfile);
  }

  return {
    edition: 'EDUCATION',
    workflowProfile: input.workflowProfile,
    interactionProfile: input.interactionProfile,
    ...(input.educationContext ? { educationContext: input.educationContext } : {}),
    workflow: {
      allowQuizScenes: true,
      allowInteractiveScenes: false,
      allowChapterInteraction: true,
    },
    interaction: {
      objectiveQuizEnabled: true,
      gameQuizEnabled: false,
    },
    prompt: {
      audienceTone: 'teacher_classroom',
    },
  };
}

export function resolveGenerationProfile(
  input: Pick<
    GenerateClassroomInput,
    'edition' | 'workflowProfile' | 'interactionProfile' | 'educationContext'
  >,
): GenerationProfile {
  if (isKindergartenSchoolStage(input.educationContext?.schoolStage)) {
    return resolveEducationProfile({
      ...input,
      workflowProfile:
        !input.workflowProfile ||
        input.workflowProfile === 'KINDERGARTEN_V1' ||
        input.workflowProfile === 'enterprise_training_workflow'
          ? 'school_classroom_workflow'
          : input.workflowProfile,
      interactionProfile:
        !input.interactionProfile || input.interactionProfile === 'subjective_checkpoint'
          ? 'objective_quiz_first'
          : input.interactionProfile,
    });
  }
  const edition = input.edition === 'EDUCATION' ? 'EDUCATION' : 'ENTERPRISE';
  return edition === 'EDUCATION' ? resolveEducationProfile(input) : resolveEnterpriseProfile(input);
}

function buildEducationAudienceStageProfile(context?: EducationContext): string {
  const schoolStage = context?.schoolStage?.trim().toUpperCase() || 'GENERAL_SCHOOL';
  const gradeText = context?.grade ? ` Grade=${context.grade}.` : '';
  const subjectText = context?.subject ? ` Subject=${context.subject}.` : '';
  const lessonTypeText = context?.lessonType ? ` LessonType=${context.lessonType}.` : '';
  const subjectProfile = buildEducationSubjectProfile(context);

  switch (schoolStage) {
    case 'KINDERGARTEN':
      return (
        `Audience stage [${schoolStage}]: kindergarten classroom.${gradeText}${subjectText}${lessonTypeText} ` +
        'Use playful, story-driven, concrete teacher talk. Prefer short sentences, vivid actions, and participation cues. ' +
        'For outline JSON, keyPoints are child-facing display words or short phrases only (for example Hello, Hi, or a character name). ' +
        'Put teacher operating guidance such as playing media, leading actions, repetition rounds, classroom instructions, and rewards in description or teachingObjective, never in keyPoints. ' +
        'Avoid enterprise, workplace, and abstract policy language.'
      );
    case 'PRIMARY':
      return (
        `Audience stage [${schoolStage}]: primary school classroom.${gradeText}${subjectText}${lessonTypeText} ` +
        'Use concrete examples, step-by-step explanation, and short classroom practice. Keep wording lively but age-appropriate. ' +
        'Student-visible pages must emphasize the actual knowledge, example, operation, or short task with prominent keywords and little prose. ' +
        'Narration must be the teacher speaking directly to the class, usually using 同学们/我们/请, never third-person lesson-plan wording such as 引导学生 or 教师示范. ' +
        'Avoid enterprise or roadshow framing. ' +
        subjectProfile
      );
    case 'JUNIOR_HIGH':
      return (
        `Audience stage [${schoolStage}]: junior high classroom.${gradeText}${subjectText}${lessonTypeText} ` +
        'Balance concept explanation with comparison and reasoning. Use classroom situations instead of workplace scenarios.'
      );
    case 'SENIOR_HIGH':
      return (
        `Audience stage [${schoolStage}]: senior high classroom.${gradeText}${subjectText}${lessonTypeText} ` +
        'Emphasize reasoning, problem solving, and precise subject language. Keep the tone rigorous and exam-relevant, not corporate.'
      );
    default:
      return (
        `Audience stage [${schoolStage}]: general school classroom.${gradeText}${subjectText}${lessonTypeText} ` +
        'Use teacher/student/classroom wording and age-appropriate examples. Avoid enterprise training language.'
      );
  }
}

function buildEducationSubjectProfile(context?: EducationContext): string {
  switch (context?.subject) {
    case 'MATH':
      return (
        'Subject profile [PRIMARY_MATH]: teach through a concrete situation, an exact native representation, and a reasoning move. ' +
        'Use source-grounded numbers, units, labels, and operations. Tables, charts, number lines, geometric figures, parallel/perpendicular marks, auxiliary lines, and formulas must be editable native slide elements or canonical SVG/LaTeX, never AI-generated raster artwork. ' +
        'Give semantic mathematical shapes and lines ids beginning with math_, and do not count decorative regions as mathematics. Never invent a replacement numeric example when the source already supplies values. Treat source misconception/correction pairs as hard factual constraints. Use images only for real-world context objects or scenes that do not need exact labels. Narration must explain what each quantity means, why the operation is chosen, what changes or stays the same, and how the result is interpreted; do not merely read the formula or answer.'
      );
    case 'CHINESE':
      return (
        "Subject profile [PRIMARY_CHINESE]: follow the source text and the teacher's teaching progression. " +
        'Recognition-only characters or words may be grouped into one meaningful recognition/game page when the source treats them as a set; do not create a chain of pronunciation-only pages. ' +
        'A character gets its own page only when it needs meaning, context, contrast, structure, or writing guidance. ' +
        'Never invent stroke-order diagrams or claim an unverified generated character image is accurate. Use exact native text, verified source assets, or explain structure without fabricated stroke sequences, then return to the complete text and its meaning.'
      );
    default:
      return '';
  }
}

function buildLanguagePolicy(profile: GenerationProfile): string {
  if (
    profile.edition === 'EDUCATION' &&
    isKindergartenSchoolStage(profile.educationContext?.schoolStage) &&
    profile.educationContext?.subject === 'ENGLISH'
  ) {
    const languageMode = profile.educationContext.fullEnglishTeaching
      ? 'This is a full-English kindergarten English lesson. Teach entirely in simple, concrete English. Narration, robot speech, quiz stems/options/feedback, and interaction copy must be in English.'
      : 'This is a kindergarten English lesson taught mainly in Chinese, not a full-English class. Keep surrounding teacher guidance in short Chinese that young children can understand.';
    return (
      `Language policy [${profile.educationContext.fullEnglishTeaching ? 'FULL_ENGLISH_KINDERGARTEN' : 'BILINGUAL_ENGLISH_KINDERGARTEN'}]: ${languageMode} ` +
      'Use exact target English only for source-grounded words, phrases, model sentences, classroom commands, lyrics, and canonical character names being taught. ' +
      'Explain meanings and actions in Chinese when this is not a full-English lesson. Short, natural English transitions or praise are allowed when they help the classroom rhythm, but they must not become the main explanation. ' +
      'Do not apply primary-school English proportion or English-first targets.\n' +
      buildKindergartenEnglishCommandPolicy()
    );
  }

  if (
    profile.edition === 'EDUCATION' &&
    profile.educationContext?.subject === 'ENGLISH' &&
    profile.educationContext.fullEnglishTeaching
  ) {
    return (
      'Language policy [FULL_ENGLISH]: Teach entirely in English. ' +
      'Narration, robot speech, quiz stems/options/feedback, and interaction copy must be in English. ' +
      'Do not switch back to Chinese unless an unavoidable proper noun requires it. ' +
      'Do not translate or rewrite original imported slide text.'
    );
  }

  if (profile.edition === 'EDUCATION' && profile.educationContext?.subject === 'ENGLISH') {
    return (
      'Language policy [BILINGUAL_ENGLISH_PRIMARY]: This is an English subject taught mainly in Chinese, not a full-English class. ' +
      'Use English as the main student-facing language and keep approximately 60-80% of meaningful slide copy and teacher narration in age-appropriate English, with concise Chinese support at approximately 20-40%. ' +
      'For each important explanation, say the English sentence, phrase, or pattern first, then give a short Chinese explanation of its meaning or use. ' +
      'Do not translate every word, do not replace source-grounded English with Chinese, and do not add English facts or examples absent from the source.'
    );
  }

  return 'Language policy [DEFAULT]: Follow the requested language field.';
}

export function buildStagePromptContext(profile: GenerationProfile): StagePromptContext {
  const languagePolicy = buildLanguagePolicy(profile);

  if (profile.edition === 'EDUCATION') {
    const editionProfile = [
      'Edition policy [EDUCATION]: education classroom generation. Use teacher/student/classroom framing. Never default to enterprise training framing.',
      'Separate three layers: lesson-plan intent is internal, slide copy is what students see, and narration is what the teacher says directly to students.',
      'Never expose teacher actions, instructional design labels, learning-objective boilerplate, or competency-development claims as student-visible page copy.',
      'Keep slide text focused and scannable. Put explanation, transitions, encouragement, and teacher-student dialogue in narration.',
      'Do not just repeat the slide text. Fill in what/why/example/misconception/application only when the current stage needs it.',
    ].join('\n');

    return {
      editionProfile,
      audienceStageProfile: buildEducationAudienceStageProfile(profile.educationContext),
      flowProfile:
        `Workflow policy [${profile.workflowProfile}]: school classroom flow. ` +
        `allowQuizScenes=${profile.workflow.allowQuizScenes}. ` +
        `allowInteractiveScenes=${profile.workflow.allowInteractiveScenes}. ` +
        `allowChapterInteraction=${profile.workflow.allowChapterInteraction}.`,
      interactionProfile:
        `Interaction policy [${profile.interactionProfile}]: ` +
        (profile.interaction.objectiveQuizEnabled
          ? 'objective classroom quiz is enabled. Prefer classroom checks over enterprise checkpoint wording.'
          : 'subjective classroom checkpoint only.') +
        ` gameQuizEnabled=${profile.interaction.gameQuizEnabled}.`,
      languagePolicy,
    };
  }

  return {
    editionProfile:
      'Edition policy [ENTERPRISE]: enterprise training generation. Use trainee, workplace, business scenario, and transfer-to-work language.',
    audienceStageProfile:
      'Audience stage [ENTERPRISE]: enterprise learners. Keep practical job-facing explanations and business terminology.',
    flowProfile:
      `Workflow policy [${profile.workflowProfile}]: enterprise training flow. ` +
      `allowQuizScenes=${profile.workflow.allowQuizScenes}. ` +
      `allowInteractiveScenes=${profile.workflow.allowInteractiveScenes}. ` +
      `allowChapterInteraction=${profile.workflow.allowChapterInteraction}.`,
    interactionProfile:
      `Interaction policy [${profile.interactionProfile}]: subjective checkpoint only. ` +
      `objectiveQuizEnabled=${profile.interaction.objectiveQuizEnabled}. ` +
      `gameQuizEnabled=${profile.interaction.gameQuizEnabled}.`,
    languagePolicy,
  };
}
