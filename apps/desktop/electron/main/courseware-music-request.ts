import { createHash } from "node:crypto";

export type MusicOptions = { title: string; tags?: string | null; negativeTags?: string | null; instrumental?: boolean | null };
export type MusicRequest = { kind: "music"; model: string; input: string; music: MusicOptions };
export type MusicExportRequest = { kind: "music-export"; model: string; input: string };
export type MusicOperation = MusicRequest["kind"] | MusicExportRequest["kind"];
export type MusicCandidate = { candidateId: string; order: number; state: "pending" | "processing" | "completed" | "failed";
  durationMs?: number; exportable: boolean };
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const exact = (v: unknown, required: string[], optional: string[] = []): v is Record<string, unknown> =>
  record(v) && required.every(key => Object.hasOwn(v, key)) && Object.keys(v).every(key => required.includes(key) || optional.includes(key));
const text = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max && Buffer.from(v, "utf8").toString("utf8") === v;
export const musicCandidateId = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(v);

export function musicRequest(value: unknown): MusicRequest | MusicExportRequest {
  if (!record(value) || !text(value.model, 128) || !/^[A-Za-z0-9._-]+$/u.test(value.model) || [".", ".."].includes(value.model))
    throw new Error("COURSEWARE_MEDIA_INVALID_REQUEST");
  if (value.kind === "music-export") {
    if (!exact(value, ["kind", "model", "input"]) || !musicCandidateId(value.input)) throw new Error("COURSEWARE_MEDIA_INVALID_REQUEST");
    return { kind: "music-export", model: value.model, input: value.input };
  }
  if (!exact(value, ["kind", "model", "input", "music"]) || value.kind !== "music" || !text(value.input, 4000) ||
      !exact(value.music, ["title"], ["tags", "negativeTags", "instrumental"]) || !text(value.music.title, 100) || !value.music.title.trim() ||
      [value.music.tags, value.music.negativeTags].some(v => v !== undefined && v !== null && !text(v, 1000)) ||
      (value.music.instrumental !== undefined && value.music.instrumental !== null && typeof value.music.instrumental !== "boolean") ||
      (value.music.instrumental !== true && !value.input.trim())) throw new Error("COURSEWARE_MEDIA_INVALID_REQUEST");
  return structuredClone(value) as MusicRequest;
}

/** Java String.length and JS length both count UTF-16; null/empty/options retain their exact hashes. */
export function musicRequestHash(value: MusicRequest | MusicExportRequest): string {
  const input = musicRequest(value);
  const fields: Array<string | null> = [input.kind, input.model, input.input, null];
  if (input.kind === "music") fields.push("courseware-music-options-v1", input.music.title, input.music.tags ?? null,
    input.music.negativeTags ?? null, input.music.instrumental == null ? null : String(input.music.instrumental));
  const canonical = fields.reduce<string>((result, v) => `${result}:${v === null ? -1 : v.length}:${v ?? ""}`, "courseware-media-v1");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

export function musicCandidates(value: unknown, ready: boolean): MusicCandidate[] {
  if (!Array.isArray(value) || value.length > 16 || value.some((c, order) =>
    !exact(c, ["candidateId", "order", "state", "exportable"], ["durationMs"]) || !musicCandidateId(c.candidateId) || c.order !== order ||
    !["pending", "processing", "completed", "failed"].includes(String(c.state)) || typeof c.exportable !== "boolean" ||
    c.exportable !== (ready && c.state === "completed") ||
    (c.durationMs !== undefined && (!Number.isSafeInteger(c.durationMs) || Number(c.durationMs) < 0))) ||
    new Set(value.map(c => c.candidateId)).size !== value.length ||
    (ready && (!value.some(c => c.state === "completed") || value.some(c => !["completed", "failed"].includes(c.state)))))
    throw new Error("COURSEWARE_MEDIA_INVALID_RESPONSE");
  return structuredClone(value) as MusicCandidate[];
}

export function assertMusicMp3(bytes: Buffer, mime: string | undefined): void {
  if (mime !== "audio/mpeg" || bytes.length < 4 || !(bytes.subarray(0, 3).equals(Buffer.from("ID3")) ||
      bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)) throw new Error("COURSEWARE_MEDIA_ASSET_INTEGRITY_ERROR");
}
