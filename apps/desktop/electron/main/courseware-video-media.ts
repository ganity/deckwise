import { createHash } from "node:crypto";
import type { CoursewareTaskRef } from "@pi-desktop/shared";
import type { CoursewareImageReference } from "./courseware-media";
import { imageRequest, mediaQuote, mediaTask, taskRef, type MediaQuote } from "./courseware-media-contracts";
import { CoursewareMediaTransport, mediaEnvelope, mediaSubmissionPath } from "./courseware-media-transport";

export type VideoRequest = { kind: "video"; model: string; input: string; referenceImage?: CoursewareImageReference };
export function videoRequest(input: VideoRequest): VideoRequest {
  if (input.kind !== "video") throw new Error("COURSEWARE_MEDIA_INVALID_REQUEST");
  return { ...imageRequest({ ...input, kind: "image" }), kind: "video" };
}
export function videoRequestHash(input: VideoRequest): string {
  const fields: Array<string | null> = [input.kind, input.model, input.input, null];
  if (input.referenceImage) fields.push(input.referenceImage.sha256, input.referenceImage.mimeType, String(input.referenceImage.byteLength));
  return createHash("sha256").update("courseware-media-v1" + fields.map(field => field === null ? ":-1:" : `:${field.length}:${field}`).join("")).digest("hex");
}

/** Videos use Platform's existing task queue and quoted per-clip tariff. */
export class CoursewareVideoMediaClient extends CoursewareMediaTransport {
  async models() {
    const value = await this.json("/courseware/media/models?kind=video", this.principal());
    if (!Array.isArray(value) || value.length > 100 || value.some(row => !row || typeof row !== "object" ||
      !/^[\w.-]{1,128}$/u.test(row.model) || !Array.isArray(row.voices) || row.voices.length || row.providerDefaultVoice !== false ||
      typeof row.supportsReferenceImage !== "boolean" || Object.keys(row).sort().join(",") !== "model,providerDefaultVoice,supportsReferenceImage,voices") ||
      new Set(value.map(row => row.model)).size !== value.length) throw new Error("COURSEWARE_MEDIA_INVALID_RESPONSE");
    return value as Array<{ model: string; voices: string[]; providerDefaultVoice: false; supportsReferenceImage: boolean }>;
  }
  async quote(model: string) {
    if (!/^[\w.-]{1,128}$/u.test(model)) throw new Error("COURSEWARE_MEDIA_INVALID_REQUEST");
    return mediaQuote(await this.json(`/courseware/media/models/${model}/quote?kind=video`, this.principal()), model, "video");
  }
  async submit(key: string, input: VideoRequest, quote: MediaQuote<"video">, projectId?: string, check?: () => void | Promise<void>, admit?: () => Promise<string | undefined>) {
    const body = videoRequest(input), confirmed = mediaQuote(quote, body.model, "video");
    if (!/^[\w.-]{1,96}$/u.test(key) || body.input.length > confirmed.maxChars) throw new Error("COURSEWARE_MEDIA_INVALID_REQUEST");
    const principal = this.principal();
    if (body.referenceImage && !(await this.models()).some(model => model.model === body.model && model.supportsReferenceImage))
      throw new Error("COURSEWARE_MEDIA_REFERENCE_UNSUPPORTED");
    this.assertPrincipal(principal);
    const ref = { idempotencyKey: key, requestHash: videoRequestHash(body) };
    mediaSubmissionPath(projectId, true);
    return this.generate(body.kind, principal, async () => {
      if (admit) projectId = await admit();
      this.assertPrincipal(principal);
      const path = mediaSubmissionPath(projectId, true);
      const result = mediaTask(await this.json(path, principal, undefined, { method: "POST",
        headers: { "Idempotency-Key": key }, body: JSON.stringify({ request: body, confirmation: {
          priceVersion: confirmed.priceVersion, maxPoints: confirmed.maxPoints, quoteToken: confirmed.quoteToken } }) }),
        { idempotencyKey: key, requestHash: videoRequestHash(body), model: body.model }, "video");
      if (result.reservedPoints > confirmed.maxPoints) throw new Error("COURSEWARE_MEDIA_INVALID_RESPONSE");
      return result;
    }, () => this.find(ref), undefined, async () => { await check?.(); mediaQuote(confirmed, body.model, "video"); });
  }
  async get(reference: CoursewareTaskRef) {
    const ref = taskRef(reference);
    return mediaTask(await this.json(`/courseware/media/tasks/${ref.taskId}`, this.principal()), ref, "video");
  }
  async find(reference: Pick<CoursewareTaskRef, "idempotencyKey" | "requestHash">) {
    if (!/^[\w.-]{1,96}$/u.test(reference.idempotencyKey) || !/^[a-f0-9]{64}$/u.test(reference.requestHash)) throw new Error("COURSEWARE_MEDIA_INVALID_TASK_REF");
    try { return mediaTask(await this.json("/courseware/media/tasks/by-idempotency?" + new URLSearchParams({ key: reference.idempotencyKey,
      requestHash: reference.requestHash }), this.principal()), reference, "video"); }
    catch (error) { if (error instanceof Error && error.message === "COURSEWARE_MEDIA_PLATFORM_46006") return null; throw error; }
  }
  async download(reference: CoursewareTaskRef) {
    const principal = this.principal(), task = await this.get(reference), asset = task.assetRef;
    this.assertPrincipal(principal);
    if (task.state !== "ready" || !asset) throw new Error("COURSEWARE_MEDIA_ASSET_NOT_READY");
    const result = await this.receive(asset.downloadPath, principal, undefined, 16 * 1024 * 1024, {}, "application/json, video/mp4");
    if (result.mime === "application/json") mediaEnvelope(result.bytes);
    if (result.mime !== asset.mime || result.bytes.length !== asset.byteLength ||
      createHash("sha256").update(result.bytes).digest("hex") !== asset.sha256 || result.bytes.length < 12 || result.bytes.toString("ascii", 4, 8) !== "ftyp")
      throw new Error("COURSEWARE_MEDIA_ASSET_INTEGRITY_ERROR");
    return { task, bytes: result.bytes };
  }
}
