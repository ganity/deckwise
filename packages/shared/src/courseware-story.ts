import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import type { CoursewareEducationContext } from "./courseware-contract.js";

const text = (maxLength: number) => Type.String({ minLength: 1, maxLength, pattern: "\\S" });
const strings = (maxItems: number, maxLength: number, minItems = 0) => Type.Array(text(maxLength), { minItems, maxItems, uniqueItems: true });
export const coursewareStorySchema = Type.Object({
  title: text(200), summary: text(3000), setting: text(1500),
  objectives: strings(20, 500, 1),
  characters: Type.Array(Type.Object({ name: text(100), description: text(1000) }, { additionalProperties: false }), { maxItems: 20 }),
  beats: Type.Array(Type.Object({
    id: Type.String({ minLength: 1, maxLength: 64, pattern: "^[A-Za-z0-9_-]+$" }),
    title: text(200), event: text(3000), objective: text(500), activity: text(2000),
    assessment: Type.Optional(Type.Object({ kind: Type.Union([Type.Literal("quiz"), Type.Literal("checkpoint")]),
      question: text(1000), referenceAnswer: text(2000) }, { additionalProperties: false })),
  }, { additionalProperties: false }), { minItems: 1, maxItems: 30 }),
  assumptions: strings(20, 500),
  durationMinutes: Type.Optional(Type.Integer({ minimum: 1, maximum: 240 })),
  bodyPageLimit: Type.Optional(Type.Integer({ minimum: 1, maximum: 30 })),
}, { additionalProperties: false });
export type CoursewareStory = Static<typeof coursewareStorySchema>;
export type CoursewareStoryState = {
  schemaVersion: 1; revision: number; draft: CoursewareStory | null; sha256: string | null;
  approvedSha256: string | null; educationContext: CoursewareEducationContext | null;
  bound: boolean;
};
export function isCoursewareStory(value: unknown): value is CoursewareStory {
  if (!Check(coursewareStorySchema, value) || new TextEncoder().encode(JSON.stringify(value)).length > 65536) return false;
  return new Set(value.beats.map(beat => beat.id)).size === value.beats.length &&
    value.beats.every(beat => value.objectives.includes(beat.objective));
}
export function storyNeedsApproval(story: CoursewareStoryState | null | undefined): boolean {
  return !!story && (!story.draft || !story.sha256 || story.sha256 !== story.approvedSha256);
}
