import JSON5 from "json5";

/** Model verdicts may wrap a single data object in Markdown or use unquoted keys. */
export function parseReviewJson(text: string): unknown {
  const fenced = /^```(?:json5?)?\s*\n([\s\S]*?)\n```$/iu.exec(text.trim());
  return JSON5.parse(fenced ? fenced[1] : text);
}
