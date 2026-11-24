import { createHash, randomUUID } from "node:crypto";
import { samePptEditorBinding, type PptEditorContext } from "@pi-desktop/shared";
import type { DesktopAuthSession } from "./auth-session";
import { imageRequest } from "./courseware-media-contracts";
import { requestHash, type CoursewareImageQuote, type CoursewareImageRequest, type CoursewareImageTask } from "./courseware-media";

type ImageJob = {
  id: string;
  context: PptEditorContext;
  owner: string;
  principal: ReturnType<DesktopAuthSession["getCoursewarePrincipal"]>;
  request: CoursewareImageRequest;
  quote: CoursewareImageQuote;
  submitted: boolean;
  task?: CoursewareImageTask;
};

function sameTarget(a: PptEditorContext, b: PptEditorContext) {
  return samePptEditorBinding(a, b) && a.page === b.page && a.editGeneration === b.editGeneration && !a.readOnly && !b.readOnly;
}

function imageTaskRef({ taskId, idempotencyKey, requestHash }: CoursewareImageTask) {
  return { taskId, idempotencyKey, requestHash };
}

export function createEditorImageHandler(
  auth: Pick<DesktopAuthSession, "getCoursewarePrincipal" | "coursewareMedia">,
  context: () => Promise<PptEditorContext>,
  owner: () => string | null,
) {
  const media = auth.coursewareMedia;
  let job: ImageJob | undefined;
  let busy = false;

  return async (operation: string, args: Record<string, unknown>, target: PptEditorContext) => {
    const active = owner();
    if (!active || target.readOnly || !target.page) throw new Error("Open an editable slide first");
    const principal = auth.getCoursewarePrincipal();
    const check = async () => {
      principal.assertCurrent();
      const current = await context();
      principal.assertCurrent();
      if (owner() !== active || !sameTarget(current, target)) throw new Error("The selected slide or image changed");
    };
    await check();
    if (operation === "editor-image:models") {
      const models = await media.getImageModels();
      await check();
      return models;
    }
    if (busy) throw new Error("An image request is already in progress");
    busy = true;
    try {
      if (operation === "editor-image:quote") {
        if (typeof args.prompt !== "string" || typeof args.model !== "string") throw new Error("Invalid image request");
        let referenceImage: CoursewareImageRequest["referenceImage"];
        if (args.reference !== undefined) {
          if (typeof args.reference !== "string" || args.reference.length > 11_184_840) throw new Error("Invalid image reference");
          const match = /^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/=]+)$/u.exec(args.reference);
          if (!match) throw new Error("Invalid image reference");
          const bytes = Buffer.from(match[2], "base64");
          referenceImage = { mimeType: match[1] as "image/png" | "image/jpeg", bytesBase64: match[2],
            byteLength: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
        }
        const request = imageRequest({ kind: "image", model: args.model, input: args.prompt, ...(referenceImage ? { referenceImage } : {}) });
        const models = await media.getImageModels();
        if (!models.some(model => model.model === request.model && (!referenceImage || model.supportsReferenceImage === true)))
          throw new Error("The selected model does not support this image request");
        const quote = await media.getImageQuote(request.model);
        if (request.input.length > quote.maxChars) throw new Error("The prompt exceeds the model's character limit");
        await check();
        const id = randomUUID();
        job = { id, context: target, owner: active, principal, request, quote, submitted: false };
        return { id, maxPoints: quote.maxPoints, expiresAt: quote.expiresAt };
      }

      const current = job;
      if (!current || args.id !== current.id || current.owner !== active || current.principal.key !== principal.key ||
          !sameTarget(current.context, target)) throw new Error("The image request expired");
      current.principal.assertCurrent();
      if (operation === "editor-image:submit" && !current.submitted) {
        if (Date.parse(current.quote.expiresAt) <= Date.now()) throw new Error("The image quote expired");
        current.submitted = true;
        current.task = await media.submitConfirmedImage(current.id, current.request, current.quote, undefined, undefined, check);
      } else if (operation !== "editor-image:status" && operation !== "editor-image:submit") {
        throw new Error("Unsupported image operation");
      }
      if (!current.submitted) throw new Error("Confirm the image generation first");
      current.task = current.task
        ? await media.getImage(imageTaskRef(current.task))
        : await media.findImage({ idempotencyKey: current.id, requestHash: requestHash(current.request) }) ?? undefined;
      await check();
      if (current.task?.state !== "ready") return { state: current.task?.state ?? "submission_unknown", errorCode: current.task?.errorCode };
      if (!current.task.assetRef || current.task.assetRef.byteLength > 32 * 1024 * 1024)
        throw new Error("The generated image is too large for the editor");
      const { task, bytes } = await media.downloadImage(imageTaskRef(current.task));
      await check();
      return { state: "ready", image: `data:${task.assetRef!.mime};base64,${bytes.toString("base64")}` };
    } finally {
      busy = false;
    }
  };
}
