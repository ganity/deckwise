import { createHash } from "node:crypto";
import type { CoursewareProject, CoursewareTeachingView, PptEditorContext } from "@pi-desktop/shared";
import { generateSavedNarrationBatch } from "./courseware-narration-batch";
import type { NarrationComplete, SceneComplete } from "./courseware-candidates";
import type { CoursewareTeachingCoordinator } from "./courseware-teaching";

type Capture = { view: CoursewareTeachingView; editor?: PptEditorContext; text: string; evidence: { width: number; height: number; notes: string; objects: Array<{ objectId: string; kind: string; text: string; bbox: number[] }> } };
type Result = Awaited<ReturnType<typeof generateSavedNarrationBatch>>;
/** Feed the shared visual grounding and course planner from the live document. */
export async function generateNativeNarration(input: {
  teaching: CoursewareTeachingCoordinator; sessionId: string; selected: number[]; instruction: string;
  model: { modelKey: string; thinkingLevel?: string }; complete: NarrationComplete; completeVision?: SceneComplete;
  canDispatch(): boolean; assertModel(): Promise<void>; repairRequiredTeaching?: boolean;
  contentFailures?: Map<string, string>;
}) {
  const saved = new Map<number, Result["savedPages"][number]>();
  const diagnostics: Result["diagnostics"] = [];
  const binding = (editor: Capture["editor"]) => editor && JSON.stringify([editor.projectId, editor.documentId, editor.sessionId]);
  let owner: string | undefined, pageOrder: string | undefined;
  const deadline = Date.now() + 14 * 60_000;
  const check = async () => {
    if (!input.canDispatch()) throw new Error("Native narration owner changed");
    if (Date.now() >= deadline) throw new Error("Native narration request timed out");
    await input.assertModel();
  };
  for (let attempt = 0; ; attempt++) {
    await check();
    const selected = input.selected.filter(n => !saved.has(n));
    const first = (await input.teaching.native("narration-context", {}, selected[0]))?.value as Capture | undefined;
    if (!first) throw new Error("Native narration document unavailable");
    owner ??= binding(first.editor);
    pageOrder ??= JSON.stringify(first.view.project.pages.map(p => p.pageId));
    const assertOwner = (capture: Capture | undefined) => {
      if (!capture || !owner || binding(capture.editor) !== owner) throw new Error("Native narration editor owner changed; reopen the original document");
      if (capture.editor?.readOnly) throw new Error("Native narration document is read-only");
      if (JSON.stringify(capture.view.project.pages.map(p => p.pageId)) !== pageOrder)
        throw new Error("Native narration page order changed; read fresh page numbers");
    };
    assertOwner(first);
    const initial = first.view.project;
    const captures: Capture[] = [];
    let generation = first.editor?.editGeneration;
    let changed: string | undefined;
    let changedPage: number | undefined;
    const stale = (reason: string, pageNumber?: number): never => { changed = reason; changedPage = pageNumber; throw new Error(`Native narration content changed: ${reason}`); };
    const render = async (n: number) => {
      await check();
      const result = await input.teaching.native("narration-visual", {}, n);
      const dataUrl = (result?.value as { dataUrl?: string })?.dataUrl;
      if (typeof dataUrl !== "string" || !/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(dataUrl) || dataUrl.length > 12 * 1024 * 1024) throw new Error("Invalid native narration preview");
      const bytes = Buffer.from(dataUrl.split(",")[1], "base64");
      if (bytes.length < 24 || bytes.readUInt32BE(0) !== 0x89504e47) throw new Error("Invalid native narration PNG");
      return { bytes, width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), sha256: createHash("sha256").update(bytes).digest("hex"), assetIds: [`native-page-${n}`] };
    };
    const hashes = new Map<number, string>();
    const previews = new Map<number, Awaited<ReturnType<typeof render>>>();
    let live = initial;
    const current = async (expected: CoursewareProject) => {
      await check();
      let latestGeneration = generation;
      const firstIndex = selected[0] - 1;
      const indices = [firstIndex, ...captures.map((_, i) => i).filter(i => i !== firstIndex)];
      for (const index of indices) {
        const capture = captures[index];
        const latest = (await input.teaching.native("narration-context", {}, index + 1))?.value as Capture | undefined;
        assertOwner(latest);
        if (JSON.stringify(latest!.view.project) !== JSON.stringify(expected)) {
          if (latest!.view.project.pages.some((p, i) => JSON.stringify(p.actions) !== JSON.stringify(expected.pages[i]?.actions) || p.locked !== expected.pages[i]?.locked))
            throw new Error("Native narration teaching was edited or locked; preserve current teaching and read its context before continuing");
          stale(`teaching revision changed on page ${index + 1}`);
        }
        if (JSON.stringify([latest!.text, latest!.evidence, latest!.view.teachingRequirements]) !== JSON.stringify([capture.text, capture.evidence, capture.view.teachingRequirements]))
          stale(`page ${index + 1} text, layout or requirements changed`, index + 1);
        latestGeneration = latest!.editor?.editGeneration;
        if (index === firstIndex && latestGeneration === generation) return;
      }
      if (latestGeneration !== generation) {
        // Selection and navigation also advance Office's generation; compare actual slide pixels before discarding model output.
        for (const n of selected) if ((await render(n)).sha256 !== hashes.get(n)) stale(`page ${n} appearance changed`, n);
        const after = (await input.teaching.native("narration-context", {}, selected[0]))?.value as Capture | undefined;
        assertOwner(after);
        if (after!.editor?.editGeneration !== latestGeneration || JSON.stringify(after!.view.project) !== JSON.stringify(expected))
          stale("document changed while refreshing its content");
        generation = latestGeneration;
      }
    };
    let result: Result;
    try {
      for (let n = 1; n <= initial.pages.length; n++) {
        const capture = (await input.teaching.native("narration-context", {}, n))?.value as Capture | undefined;
        assertOwner(capture); captures.push(structuredClone(capture!));
        if (selected.includes(n)) {
          const preview = await render(n); hashes.set(n, preview.sha256); previews.set(n, preview);
        }
      }
      const project = structuredClone(initial);
      for (const page of project.pages) {
        page.actions = page.actions.filter(a => a.type !== "native_animation");
        for (const action of page.actions) delete action.durationMs;
      }
      const contentKey = (n: number) => createHash("sha256").update(JSON.stringify([owner, input.sessionId, input.model,
        captures[n - 1].view.pageId, captures[n - 1].evidence, hashes.get(n), captures[n - 1].view.teachingRequirements])).digest("hex");
      const blocked = selected.flatMap(pageNumber => {
        const error = input.contentFailures?.get(contentKey(pageNumber));
        return error ? [{ pageNumber, error }] : [];
      });
      const requested = selected.filter(n => !blocked.some(f => f.pageNumber === n));
      if (blocked.length) diagnostics.push({ pageNumber: blocked[0].pageNumber,
        message: "The live page and teaching requirements are unchanged since their content mismatch. Repair the open PPT page or correct its approved page mapping before requesting narration again; SVG-only edits do not change this document." });
      result = await generateSavedNarrationBatch({
        host: { async call() { throw new Error("Native narration cannot use a Host teaching mirror"); } },
        sessionId: input.sessionId, jobId: "native", project, bytes: new Uint8Array(), selected: requested,
        instruction: input.instruction, model: input.model, complete: input.complete, completeVision: input.completeVision,
        repairRequiredTeaching: input.repairRequiredTeaching, canDispatch: () => input.canDispatch() && Date.now() < deadline,
        current: async () => current(live),
        native: {
          context: { project, mapping: { sourceSha256: project.source.sha256, revision: project.teachingRevision,
            pages: captures.map(c => ({ pageId: c.view.pageId, objects: c.evidence.objects.map(o => ({ objectId: o.objectId, importElementId: o.objectId })) })) },
            teachingRequirements: captures[0].view.teachingRequirements ?? [],
            assessmentPageIds: captures.filter(c => c.view.teaching?.pageType && c.view.teaching.pageType !== "slide" ||
              c.view.project.pages.find(p => p.pageId === c.view.pageId)?.actions.some(a => a.type === "interaction_checkpoint")).map(c => c.view.pageId) },
          evidence: async n => { const c = captures[n - 1]; return { ...c.evidence, text: c.text, elements: c.evidence.objects.map(o => ({ ...o, id: o.objectId })) }; },
          visuals: { async page(n) { return { images: [previews.get(n)!], imageBindings: [] }; }, async dispose() {} },
          async save(_expected, n, actions, semantics) {
            await current(live);
            const original = live.pages[n - 1];
            for (const [index, action] of original.actions.entries()) {
              if (!["music_slot", "audio_clip", "video_slot", "video_clip", "native_animation"].includes(String(action.type))) continue;
              const position = actions.findIndex(a => a.id === action.id);
              if (position >= 0) actions[position] = structuredClone(action);
              else actions.splice(Math.min(index, actions.length), 0, structuredClone(action));
            }
            for (const action of actions) {
              const old = original.actions.find(a => a.id === action.id);
              if (old?.durationMs !== undefined && action.audioAssetId && action.audioAssetId === old.audioAssetId) action.durationMs = old.durationMs;
            }
            let written;
            for (let writeAttempt = 0; ; writeAttempt++) {
              try {
                written = await input.teaching.native("write", { viewId: captures[n - 1].view.viewId,
                  expectedTeachingRevision: live.teachingRevision, expectedEditGeneration: generation, actions, ...(semantics ? { semantics } : {}) }, n);
                break;
              } catch (error) {
                const latest = (await input.teaching.native("narration-context", {}, n))?.value as Capture | undefined;
                assertOwner(latest);
                const latestActions = latest!.view.project.pages[n - 1].actions;
                if (latest!.view.project.teachingRevision !== live.teachingRevision && JSON.stringify(latestActions) === JSON.stringify(actions)) {
                  written = { value: latest!.view }; break;
                }
                await current(live);
                if (writeAttempt === 0 && error instanceof Error && error.message.includes("Native editor generation changed before narration write")) continue;
                throw error;
              }
            }
            if (!written) throw new Error("Native narration write outcome is unavailable; read saved teaching before retrying");
            live = (written.value as CoursewareTeachingView).project;
            // Record an acknowledged write before another read can fail; never regenerate it on a later-page conflict.
            saved.set(n, { pageNumber: n, pageId: original.pageId, teachingRevision: live.teachingRevision, saved: true });
            try { await current(live); }
            catch (error) { if (changedPage === n) saved.delete(n); throw error; }
            return live;
          },
        },
      });
      result.failures.push(...blocked);
      for (const failure of result.failures) if (failure.error.includes("Required visual content missing;")) {
        if ((input.contentFailures?.size ?? 0) >= 100) input.contentFailures?.clear();
        input.contentFailures?.set(contentKey(failure.pageNumber), failure.error);
      }
    } catch (error) {
      if (!changed) throw error;
      result = { savedPages: [], failures: selected.map(pageNumber => ({ pageNumber, error: String(error) })), diagnostics: [], applied: false, saved: false, audioReady: false };
    }
    for (const page of result.savedPages) saved.set(page.pageNumber, page);
    diagnostics.push(...result.diagnostics);
    const remaining = input.selected.filter(n => !saved.has(n));
    if (changed && remaining.length && attempt < 2) {
      diagnostics.push({ pageNumber: remaining[0], message: `Re-read current native document after ${changed}; regenerate only unfinished pages (refresh ${attempt + 1}/2)` });
      continue;
    }
    return { ...result, savedPages: [...saved.values()].sort((a, b) => a.pageNumber - b.pageNumber),
      failures: result.failures.filter(f => !saved.has(f.pageNumber)).map(f => ({ ...f,
        ...(f.error.includes("Required visual content missing;") ? { code: "COURSEWARE_PAGE_CONTENT_MISMATCH", retriable: false, repair: "repair-live-page" } : {}) })), diagnostics,
      applied: saved.size > 0, saved: saved.size === input.selected.length, audioReady: false };
  }
}
