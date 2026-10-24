import { createHash } from "node:crypto";
import { COURSEWARE_MAX_MEDIA_ASSET_BYTES, type CoursewareTaskRef } from "@pi-desktop/shared";
import { mediaQuote, mediaTask, taskRef, type MediaQuote, type MediaTasks } from "./courseware-media-contracts";
import { CoursewareMediaTransport, mediaEnvelope, mediaSubmissionPath } from "./courseware-media-transport";
import { assertMusicMp3, musicCandidateId, musicCandidates, musicRequest, musicRequestHash,
  type MusicOperation, type MusicRequest, type MusicExportRequest } from "./courseware-music-request";

const id = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9._-]{1,128}$/u.test(v) && v !== "." && v !== "..";
function operation(value: unknown): asserts value is MusicOperation {
  if (value !== "music" && value !== "music-export") throw new Error("COURSEWARE_MEDIA_INVALID_REQUEST");
}

/** Collections and explicit paid exports share transport, never a one-song fallback or implicit POST. */
export class CoursewareMusicMediaClient extends CoursewareMediaTransport {
  async models(kind: MusicOperation, signal?: AbortSignal): Promise<Array<{ model: string }>> {
    operation(kind);
    const result = await this.json(`/courseware/media/models?kind=${kind}`, this.principal(), signal);
    if (!Array.isArray(result) || result.length > 100 || result.some(v => !v || typeof v !== "object" ||
        Object.keys(v).sort().join(",") !== "model,providerDefaultVoice,voices" || !id(v.model) ||
        !Array.isArray(v.voices) || v.voices.length !== 0 || v.providerDefaultVoice !== false) ||
        new Set(result.map(v => v.model)).size !== result.length) throw new Error("COURSEWARE_MEDIA_INVALID_RESPONSE");
    return result.map(v => ({ model: v.model }));
  }

  async quote<K extends MusicOperation>(model: string, kind: K, signal?: AbortSignal): Promise<MediaQuote<K>> {
    operation(kind);
    if (!id(model)) throw new Error("COURSEWARE_MEDIA_INVALID_REQUEST");
    return mediaQuote(await this.json(`/courseware/media/models/${model}/quote?kind=${kind}`, this.principal(), signal), model, kind);
  }

  async submitConfirmed(key: string, input: MusicRequest | MusicExportRequest, quote: MediaQuote<MusicOperation>,
    signal?: AbortSignal, projectId?: string): Promise<MediaTasks[MusicOperation]> {
    if (typeof key !== "string" || !/^[A-Za-z0-9._-]{1,96}$/u.test(key)) throw new Error("COURSEWARE_MEDIA_INVALID_KEY");
    const body = musicRequest(input), confirmed = mediaQuote(quote, body.model, body.kind);
    if (body.input.length > confirmed.maxChars) throw new Error("COURSEWARE_MEDIA_INVALID_REQUEST");
    const result = await this.json(mediaSubmissionPath(projectId, true), this.principal(), signal, {
      method: "POST", headers: { "Idempotency-Key": key }, body: JSON.stringify({ request: body,
        confirmation: { priceVersion: confirmed.priceVersion, maxPoints: confirmed.maxPoints, quoteToken: confirmed.quoteToken } }),
    });
    const task = mediaTask(result, { idempotencyKey: key, requestHash: musicRequestHash(body), model: body.model }, body.kind);
    if (task.reservedPoints > confirmed.maxPoints) throw new Error("COURSEWARE_MEDIA_INVALID_RESPONSE");
    return task;
  }

  async get<K extends MusicOperation>(reference: CoursewareTaskRef, kind: K, signal?: AbortSignal): Promise<MediaTasks[K]> {
    operation(kind);
    const ref = taskRef(reference);
    return mediaTask(await this.json(`/courseware/media/tasks/${ref.taskId}`, this.principal(), signal), ref, kind);
  }

  async find<K extends MusicOperation>(reference: Pick<CoursewareTaskRef, "idempotencyKey" | "requestHash">,
    kind: K, signal?: AbortSignal): Promise<MediaTasks[K] | null> {
    operation(kind);
    if (!reference || Object.keys(reference).sort().join(",") !== "idempotencyKey,requestHash" ||
        typeof reference.idempotencyKey !== "string" || !/^[A-Za-z0-9._-]{1,96}$/u.test(reference.idempotencyKey) ||
        typeof reference.requestHash !== "string" || !/^[a-f0-9]{64}$/u.test(reference.requestHash))
      throw new Error("COURSEWARE_MEDIA_INVALID_TASK_REF");
    const expected = { ...reference }, principal = this.principal();
    let result: unknown;
    try {
      result = await this.json("/courseware/media/tasks/by-idempotency?" + new URLSearchParams({ key: expected.idempotencyKey,
        requestHash: expected.requestHash }), principal, signal);
    } catch (error) {
      this.assertPrincipal(principal);
      if (error instanceof Error && error.message === "COURSEWARE_MEDIA_PLATFORM_46006") return null;
      throw error;
    }
    return mediaTask(result, expected, kind);
  }

  async candidates(reference: CoursewareTaskRef, signal?: AbortSignal) {
    const principal = this.principal(), task = await this.get(reference, "music", signal);
    this.assertPrincipal(principal);
    const value = await this.json(`/courseware/media/tasks/${task.taskId}/music-candidates`, principal, signal);
    return { task, candidates: musicCandidates(value, task.state === "ready") };
  }

  async preview(reference: CoursewareTaskRef, candidateId: string, signal?: AbortSignal) {
    if (!musicCandidateId(candidateId)) throw new Error("COURSEWARE_MEDIA_INVALID_REQUEST");
    const principal = this.principal(), collection = await this.candidates(reference, signal);
    this.assertPrincipal(principal);
    const candidate = collection.candidates.find(c => c.candidateId === candidateId);
    if (collection.task.state !== "ready" || candidate?.state !== "completed") throw new Error("COURSEWARE_MEDIA_ASSET_NOT_READY");
    const result = await this.receive(`/courseware/media/tasks/${collection.task.taskId}/music-candidates/${candidateId}/preview`,
      principal, signal, COURSEWARE_MAX_MEDIA_ASSET_BYTES);
    if (result.mime === "application/json") { mediaEnvelope(result.bytes); throw new Error("COURSEWARE_MEDIA_INVALID_RESPONSE"); }
    assertMusicMp3(result.bytes, result.mime);
    return { ...collection, candidate, bytes: result.bytes, preview: { mimeType: "audio/mpeg" as const,
      sha256: createHash("sha256").update(result.bytes).digest("hex"), byteLength: result.bytes.length } };
  }

  async downloadExport(reference: CoursewareTaskRef, signal?: AbortSignal) {
    const principal = this.principal(), task = await this.get(reference, "music-export", signal);
    this.assertPrincipal(principal);
    if (task.state !== "ready" || !task.assetRef) throw new Error("COURSEWARE_MEDIA_ASSET_NOT_READY");
    const result = await this.receive(`/courseware/media/tasks/${task.taskId}/asset`, principal, signal, COURSEWARE_MAX_MEDIA_ASSET_BYTES);
    if (result.mime === "application/json") { mediaEnvelope(result.bytes); throw new Error("COURSEWARE_MEDIA_INVALID_RESPONSE"); }
    assertMusicMp3(result.bytes, result.mime);
    if (result.bytes.length !== task.assetRef.byteLength || createHash("sha256").update(result.bytes).digest("hex") !== task.assetRef.sha256)
      throw new Error("COURSEWARE_MEDIA_ASSET_INTEGRITY_ERROR");
    return { task, bytes: result.bytes };
  }
}
