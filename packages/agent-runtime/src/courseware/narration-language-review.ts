// Adapted from zpj_deck's student-facing-language rules; advisory, never a write validator.
const rules = [
  {
    pattern: /(?:教师(?:应(?:该)?|需要)|(?:引导|指导|组织)学生|\bthe teacher (?:should|needs? to)\b|\bguide students? to\b)/iu,
    issue: "Speech contains third-person teacher directions instead of words addressed to learners",
  },
  {
    pattern: /(?:本页旨在|设计意图(?:是|为)|\binstructional objective\b|\bthe purpose of this lesson is\b)/iu,
    issue: "Speech may be reading instructional design notes aloud",
  },
];

/** Call only for newly generated speech, never supplied scripts or effect-only repair. */
export function findTeacherNarrationIssues(text: string): string[] {
  return rules.filter(rule => rule.pattern.test(text)).map(rule => rule.issue);
}
