import type { CoursewareTeachingView } from "@pi-desktop/shared";
import type { CoursewareNativeAudio } from "./courseware-native-audio";
import type { CoursewareTeachingCoordinator } from "./courseware-teaching";

type Intent = { intentId: string; actionId: string; current: boolean; model: string; voice: string | null };
type Status = { phase: string; task: { state: string; errorCode?: string | null } | null };

/** Recover original orders only. No quote, purchase, or replacement request is made here. */
export async function recoverNativeAudio(input: {
  teaching: CoursewareTeachingCoordinator; audio: CoursewareNativeAudio; view: CoursewareTeachingView;
  pageNumbers: number[]; model?: string; voice?: string | null; check(): void;
}) {
  const { teaching, audio, view, check } = input;
  const pages: Array<{ pageId: string; pageNumber: number; actionId: string; intentId?: string; applied: boolean; audioReady: boolean; state: string }> = [];
  const results: Array<{ job: { kind: "tts"; sourceSha256: string; pageNumber: number; intentId: string }; applied: boolean; saved: boolean; media: Status }> = [];
  const failures: Array<{ pageId: string; actionId?: string; intentId?: string; error: string }> = [];
  for (const number of input.pageNumbers) {
    const original = view.project.pages[number - 1];
    for (const speech of original.actions.filter(a => a.type === "speech")) {
      try {
        check();
        const root = (await teaching.native("open"))?.value as CoursewareTeachingView | undefined;
        if (!root || root.project.projectId !== view.project.projectId || root.project.source.sha256 !== view.project.source.sha256)
          throw new Error("Native source changed during audio recovery");
        const pageNumber = root.project.pages.findIndex(p => p.pageId === original.pageId) + 1;
        if (!pageNumber) throw new Error("Native recovery page was deleted");
        const current = (await teaching.native("open", {}, pageNumber))?.value as CoursewareTeachingView | undefined;
        if (!pageNumber || !current || current.pageId !== original.pageId || current.project.projectId !== view.project.projectId ||
            current.project.source.sha256 !== view.project.source.sha256) throw new Error("Native recovery page changed");
        const page = current.project.pages.find(p => p.pageId === original.pageId)!;
        const action = page.actions.find(a => a.id === speech.id && a.type === "speech");
        if (!action || action.text !== speech.text) throw new Error("Narration changed during audio recovery");
        const row = { pageId: page.pageId, pageNumber, actionId: String(action.id), applied: false, audioReady: typeof action.audioAssetId === "string" };
        if (row.audioReady) {
          if (action.attention !== undefined) {
            if (current.readOnly || page.locked) throw new Error("Attention repair target is read-only or locked");
            await teaching.native("write", { viewId: current.viewId, expectedTeachingRevision: current.project.teachingRevision, actions: page.actions }, pageNumber);
            check();
            const repaired = (await teaching.native("open", {}, pageNumber))?.value as CoursewareTeachingView | undefined;
            const retained = repaired?.project.pages.find(p => p.pageId === original.pageId)?.actions.find(a => a.id === action.id);
            if (!retained || retained.text !== action.text || retained.audioAssetId !== action.audioAssetId || retained.attention !== undefined)
              throw new Error("Saved audio attention was not resolved; preserve the original audio and inspect native context");
            pages.push({ ...row, applied: true, state: "retained_effects_repaired" });
          } else pages.push({ ...row, state: "retained" });
          continue;
        }
        if (current.readOnly || page.locked) throw new Error("Audio recovery target is read-only or locked");
        const scope = { viewId: current.viewId, expectedTeachingRevision: current.project.teachingRevision };
        const intents = await audio.execute("tts:list", scope, pageNumber, current) as Intent[];
        check();
        const matching = intents.filter(i => i.current && i.actionId === action.id &&
          (input.model === undefined || i.model === input.model) && (input.voice === undefined || i.voice === input.voice));
        if (matching.length > 1) throw new Error("Multiple matching speech tasks; refresh an explicit intent ID");
        if (!matching.length) { pages.push({ ...row, state: "missing" }); continue; }
        const intentId = matching[0].intentId, args = { ...scope, intentId };
        const media = await audio.execute("tts:status", args, pageNumber, current) as Status;
        check();
        const applied = media.task?.state === "ready";
        if (applied) { await audio.execute("tts:adopt", args, pageNumber, current); check(); }
        const state = applied ? "adopted" : media.task?.state ?? media.phase;
        pages.push({ ...row, intentId, state, applied, audioReady: applied });
        results.push({ job: { kind: "tts", sourceSha256: view.project.source.sha256, pageNumber, intentId }, applied, saved: false, media });
        if (["failed", "cancelled", "submission_unknown", "submission-unknown", "prepared"].includes(state) || media.task?.errorCode)
          failures.push({ pageId: page.pageId, actionId: String(action.id), intentId, error: media.task?.errorCode || state });
      } catch (error) {
        check();
        // Adoption can succeed before its journal reply fails. Save provable native output.
        const reread = (await teaching.native("open").catch(() => undefined))?.value as CoursewareTeachingView | undefined;
        check();
        const page = reread?.project.pages.find(p => p.pageId === original.pageId);
        const action = page?.actions.find(a => a.id === speech.id && a.type === "speech" && a.text === speech.text);
        const applied = reread?.project.projectId === view.project.projectId && reread.project.source.sha256 === view.project.source.sha256 &&
          typeof action?.audioAssetId === "string" && typeof speech.audioAssetId !== "string";
        pages.push({ pageId: original.pageId, pageNumber: number, actionId: String(speech.id), applied, audioReady: applied, state: applied ? "adopted_with_error" : "failed" });
        failures.push({ pageId: original.pageId, actionId: String(speech.id), error: String(error) });
      }
    }
  }
  const narrated = input.pageNumbers.every(n => view.project.pages[n - 1].actions.some(a => a.type === "speech") ||
    view.enrichment?.script?.silentPageIds.includes(view.project.pages[n - 1].pageId));
  return { pages, results, failures, saved: false, audioReady: narrated && pages.every(p => p.audioReady),
    jobs: results.filter(r => !r.applied).map(r => r.job) };
}
