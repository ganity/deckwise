import { Type } from "typebox";

const text = (maxLength: number) => Type.String({ minLength: 1, maxLength });
const reference = Type.Object({ summary: text(4000), keyPoints: Type.Array(text(500), { maxItems: 20 }) }, { additionalProperties: false });
const response = Type.Object({ kind: Type.Union(["short_answer", "discussion", "practice", "pbl"].map(value => Type.Literal(value))),
  options: Type.Array(text(500), { maxItems: 0 }), answerIndices: Type.Array(Type.Integer({ minimum: 0 }), { maxItems: 0 }) }, { additionalProperties: false });
const media = Type.Object({ purpose: text(500), prompt: text(4000) }, { additionalProperties: false });
const question = Type.Object({ text: text(160), response, referenceAnswer: Type.Optional(reference), constraintPrompt: Type.Optional(text(4000)) }, { additionalProperties: false });
const teaching = {
  phase: Type.Union(["opening", "explore", "practice", "review"].map(value => Type.Literal(value))),
  objective: text(1000), durationSeconds: Type.Integer({ minimum: 5, maximum: 1800 }),
  requiredObjects: Type.Array(text(200), { maxItems: 30, uniqueItems: true }),
  requiredEffects: Type.Optional(Type.Array(Type.Union(["highlight", "spotlight", "animation"].map(value => Type.Literal(value))), { maxItems: 3, uniqueItems: true })),
  music: Type.Optional(media), video: Type.Optional(media),
};
const quiz = Type.Object({ type: Type.Literal("quiz"), questions: Type.Array(Type.Object({
  id: text(128), type: Type.Union(["single", "multiple", "judge", "short_answer"].map(value => Type.Literal(value))), question: text(4000),
  options: Type.Optional(Type.Array(Type.Object({ value: Type.Union(["A", "B", "C", "D", "T", "F"].map(value => Type.Literal(value))), label: text(500) }, { additionalProperties: false }), { maxItems: 4 })),
  answer: Type.Optional(Type.Array(text(500), { maxItems: 4 })), analysis: Type.Optional(text(4000)),
  referenceAnswer: Type.Optional(text(4000)), keyPoints: Type.Optional(Type.Array(text(500), { maxItems: 20 })),
}, { additionalProperties: false }), { minItems: 1, maxItems: 1 }),
  interactionMode: Type.Optional(Type.Union([Type.Literal("assessment_review"), Type.Literal("classroom_instant_feedback")])),
}, { additionalProperties: false });

const pageNumber = Type.Integer({ minimum: 1, maximum: 100 });
const { music: _music, video: _video, ...assessmentFields } = teaching;
const assessmentTeaching = { ...assessmentFields, requiredObjects: Type.Array(text(200), { maxItems: 0 }),
  requiredEffects: Type.Optional(Type.Array(Type.Literal("highlight"), { maxItems: 0 })) };
const pages = Type.Array(Type.Union([
  Type.Object({ pageNumber, teaching: Type.Object({ ...teaching, pageType: Type.Literal("slide") }, { additionalProperties: false }) }, { additionalProperties: false }),
  Type.Object({ pageNumber, teaching: Type.Object({ ...assessmentTeaching, pageType: Type.Literal("quiz") }, { additionalProperties: false }), quiz }, { additionalProperties: false }),
  Type.Object({ pageNumber, teaching: Type.Object({ ...assessmentTeaching, pageType: Type.Union([Type.Literal("interactive"), Type.Literal("pbl")]), question }, { additionalProperties: false }) }, { additionalProperties: false }),
]), { minItems: 1, maxItems: 100 });
export const coursewarePresentationPrepareDefinition = {
  name: "courseware_presentation_prepare", label: "Prepare fixed assessment pages",
  parameters: Type.Object({ projectPath: text(4096), pages,
    canvas: Type.Object({ width: Type.Integer({ minimum: 100, maximum: 4096 }), height: Type.Integer({ minimum: 100, maximum: 4096 }) }, { additionalProperties: false }),
  }, { additionalProperties: false }),
  description: "Before ordinary PPT Master SVG authoring, save the complete ordered teaching plan and generate fixed Quiz/checkpoint SVGs in the existing workspace project. Use its locked canvas dimensions. Body: teaching.pageType=slide. Quiz: teaching.pageType=quiz plus a sibling quiz:{type:quiz,questions:[one question]}. Classroom interaction: teaching.pageType=interactive plus teaching.question:{text,response:{kind:discussion,options:[],answerIndices:[]},referenceAnswer:{summary,keyPoints}}; no quiz. Never substitute a short-answer Quiz for a requested classroom interaction, even after validation fails; repair the reported field in the same page type. Returns one NN.svg filename per physical page: author only body entries yourself, never redesign generated assessments. No lecture, decoration or animation on assessment pages; requiredObjects/effects stay empty. Answers and constraints stay hidden. No model or media generation, export, adoption or approval. Replaying identical input is safe; existing different/manual files are preserved and reported as conflicts. Later use shared assessment media tools for question TTS and option images. After export pass the same saved pages to courseware_presentation_adopt.",
};
export const coursewarePresentationDefinition = {
  name: "courseware_presentation_adopt", label: "Continue exported presentation teaching",
  parameters: Type.Object({ path: text(4096), sourceSha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    pages,
    continueTeaching: Type.Optional(Type.Boolean({ description: "Defaults to true for this teaching-course export. Set false only when the user explicitly requests PPTX-only delivery without narration or paid media." })),
  }, { additionalProperties: false }),
  description: "After the user explicitly requests official PPTX export, adopt that verified PPT Master exports/*.pptx into the shared saved teaching workflow. Supply its actual SHA-256 and exactly one teaching entry per physical page in order. Plan these entries before SVG authoring so Quiz/checkpoint pages stay within the requested total/body budget. Quiz uses pageType:quiz plus quiz with exactly one real question, 2–4 choices keyed A-D (judge uses T/F), and answer keys referencing those exact values; interaction uses pageType:interactive plus question with referenceAnswer. Body pages retain speaker notes and requiredObjects. requiredEffects records explicitly requested highlight/spotlight/animation, only on pages with safe target objects. Never convert a body activity into an assessment or add pages here. Host verifies current final SVG quality, planning, notes and source identity. Adoption itself does not generate media. Course export defaults to continueTeaching:true even if omitted: finish detailed narration, TTS, question TTS and option images using shared saved tools, without another Continue request. For an explicit PPTX-only request set continueTeaching:false; never omit it in that case or generate paid media. Do not re-export SVG once Office editing has started; resume the saved workflow instead.",
};
