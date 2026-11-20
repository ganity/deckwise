import { createHash } from "node:crypto";
import { nativeLayerImages } from "./courseware-native-layer-images";
import type { CoursewareProject, CoursewareTeachingView, PptEditorContext } from "@pi-desktop/shared";
import { generateSavedNarrationBatch } from "./courseware-narration-batch";
import type { NarrationComplete, SceneComplete } from "./courseware-candidates";
import type { CoursewareTeachingCoordinator } from "./courseware-teaching";
import type { NativeNarrationAttempt, NativeRepairStore } from "./courseware-native-repairs";

type Capture = { view: CoursewareTeachingView & { assessment?: unknown; embeddedAssessment?: unknown }; editor?: PptEditorContext; text: string; evidence: { width: number; height: number; notes: string; objects: Array<{ objectId: string; kind: string; text: string; bbox: number[]; layerMetadata?: { name: string; description: string } }> } };
export type NativeNarrationRetryState = Map<string, NativeNarrationAttempt>;
type Result = Awaited<ReturnType<typeof generateSavedNarrationBatch>>;
/** Feed the shared visual grounding and course planner from the live document. */
type NativeNarrationInput = {
  teaching: CoursewareTeachingCoordinator; sessionId: string; selected: number[]; instruction: string; speechCount?: number;
  model: { modelKey: string; thinkingLevel?: string }; complete: NarrationComplete; completeVision?: SceneComplete;
  canDispatch(): boolean; assertModel(): Promise<void>; repairRequiredTeaching?: boolean; repairObjectsOnly?: boolean;
  contentFailures?: Map<string, string>;
  frozenArtwork?: boolean;
  retryState?: NativeNarrationRetryState;
  retryStore?: NativeRepairStore; turnId?: string;
  persistRetryState?: () => Promise<void>;
  persist?: () => Promise<void>;
};

export async function generateNativeNarration(input: NativeNarrationInput): Promise<Result> {
  input = { ...input, retryState: input.retryState ?? new Map() };
  const savedPages: Result["savedPages"] = [], failures: Result["failures"] = [], diagnostics: Result["diagnostics"] = [];
  const original = (await input.teaching.native("narration-context", {}, input.selected[0]))?.value as Capture | undefined;
  if (!original) throw new Error("Native narration document unavailable");
  if (input.retryStore) {
    const { retryStore, turnId, sessionId } = input;
    if (!turnId) throw new Error("Native narration requires an active turn for its saved retry budget");
    const projectId = original.view.project.projectId;
    let state = await retryStore.read(sessionId, projectId);
    const retryState: NativeNarrationRetryState = new Map(Object.entries(state.narration?.turnId === turnId ? state.narration.pages : {}));
    let pending = Promise.resolve();
    input = { ...input, retryState, persistRetryState: () => {
      // Serialize reservations before model work; a failed write fences subsequent calls.
      pending = pending.then(async () => {
        if (!input.canDispatch()) throw new Error("Native narration turn ended before retry reservation");
        await input.assertModel();
        state = await retryStore.writeNarration(sessionId, projectId, state, { turnId, pages: Object.fromEntries(retryState) });
        if (!input.canDispatch()) throw new Error("Native narration turn ended after retry reservation");
        await input.assertModel();
      });
      return pending;
    } };
  }
  const requested = input.selected;
  const eligible: number[] = [];
  for (const pageNumber of requested) {
    const capture = pageNumber === requested[0] ? original :
      (await input.teaching.native("narration-context", {}, pageNumber))?.value as Capture | undefined;
    if (!capture) throw new Error("Native narration document unavailable");
    if (capture.view.assessment || capture.view.embeddedAssessment ||
        capture.view.teaching?.pageType && capture.view.teaching.pageType !== "slide") {
      const page = capture.view.project.pages[pageNumber - 1];
      if (page.actions.some(a => a.type === "speech" && typeof a.text === "string" && a.text.trim())) {
        savedPages.push({ pageNumber, pageId: page.pageId, teachingRevision: capture.view.project.teachingRevision, saved: true, retained: true });
        diagnostics.push({ pageNumber, message: "Assessment question reading retained; generate its audio through assessment media, not body narration" });
      } else failures.push({ pageNumber, error: "Assessment question reading is missing; repair the assessment before generating its audio", retriable: false });
    } else eligible.push(pageNumber);
  }
  input = { ...input, selected: eligible };
  for (let offset = 0; offset < input.selected.length;) {
    let end = offset + 1;
    while (end < input.selected.length && end - offset < 5 && input.selected[end] === input.selected[end - 1] + 1) end++;
    const selected = input.selected.slice(offset, end);
    offset = end;
    try {
      const result = await generateNativeNarrationBatch({ ...input, selected }, original);
      if (result.applied) await input.persist?.();
      savedPages.push(...result.savedPages); failures.push(...result.failures); diagnostics.push(...result.diagnostics);
      if (!result.saved && !result.failures.every(f => f.retriable === false)) break;
    } catch (error) {
      failures.push(...selected.map(pageNumber => ({ pageNumber, error: String(error) })));
      break;
    }
  }
  for (const pageNumber of input.selected) {
    if (!savedPages.some(p => p.pageNumber === pageNumber) && !failures.some(p => p.pageNumber === pageNumber))
      failures.push({ pageNumber, error: "Not started after an earlier batch failed; resume only unfinished pages" });
  }
  const audioReady = input.repairObjectsOnly === true && savedPages.length === requested.length && requested.every(number => {
    const speech = original.view.project.pages[number - 1].actions.filter(action => action.type === "speech");
    return speech.length > 0 && speech.every(action => typeof action.audioAssetId === "string");
  });
  return { savedPages, failures, diagnostics, applied: savedPages.some(p => !p.retained), saved: savedPages.length === requested.length, audioReady };
}

async function generateNativeNarrationBatch(input: NativeNarrationInput, original: Capture): Promise<Result> {
  const saved = new Map<number, Result["savedPages"][number]>();
  const diagnostics: Result["diagnostics"] = [];
  const binding = (editor: Capture["editor"]) => editor && JSON.stringify([editor.projectId, editor.documentId, editor.sessionId]);
  const owner = binding(original.editor), pageOrder = JSON.stringify(original.view.project.pages.map(p => p.pageId));
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
    const assertOwner = (capture: Capture | undefined) => {
      if (!capture || !owner || binding(capture.editor) !== owner) throw new Error("Native narration editor owner changed; reopen the original document");
      if (capture.editor?.readOnly) throw new Error("Native narration document is read-only");
      if (JSON.stringify(capture.view.project.pages.map(p => p.pageId)) !== pageOrder)
        throw new Error("Native narration page order changed; read fresh page numbers");
    };
    assertOwner(first);
    const initial = first.view.project;
    const source = first.view.enrichment?.script;
    if (source) {
      if (selected.some(n => source.silentPageIds.includes(initial.pages[n - 1]?.pageId))) throw new Error("This page is intentionally silent; change its source policy before generating speech");
      const originals = new Set(first.view.enrichment!.originalPages.map(p => p.pageId));
      const protectedPages = selected.filter(n => originals.has(initial.pages[n - 1]?.pageId) &&
        (source.policy === "preserve" || source.policy === "generate-missing" && initial.pages[n - 1]?.actions.some(a => a.type === "speech")));
      if (protectedPages.length && !input.repairRequiredTeaching) throw new Error("Accepted script policy prevents regeneration; explicitly revise its source policy first");
      if (input.repairRequiredTeaching && protectedPages.some(n => !initial.pages[n - 1].actions.some(a => a.type === "speech")))
        throw new Error("Preserved script has missing or intentionally silent pages; repair cannot generate filler");
    }
    const captures: Capture[] = [];
    let generation = first.editor?.editGeneration;
    let changed: string | undefined;
    let changedPage: number | undefined;
    const stale = (reason: string, pageNumber?: number): never => { changed = reason; changedPage = pageNumber; throw new Error(`Native narration content changed: ${reason}`); };
    const render = async (n: number) => {
      await check();
      const result = await input.teaching.native("narration-visual", {}, n);
      const value = result?.value as { dataUrl?: string; layers?: Array<{ objectId: string; dataUrl: string }> };
      const dataUrl = value?.dataUrl;
      if (typeof dataUrl !== "string" || !/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(dataUrl) || dataUrl.length > 12 * 1024 * 1024) throw new Error("Invalid native narration preview");
      const bytes = Buffer.from(dataUrl.split(",")[1], "base64");
      if (bytes.length < 24 || bytes.readUInt32BE(0) !== 0x89504e47) throw new Error("Invalid native narration PNG");
      const layers = nativeLayerImages(value.layers, captures[n - 1].evidence.objects.filter(o => o.layerMetadata).map(o => o.objectId));
      return { bytes, width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), sha256: createHash("sha256").update(bytes).digest("hex"), assetIds: [`native-page-${n}`], layers };
    };
    const hashes = new Map<number, string>();
    const previews = new Map<number, Awaited<ReturnType<typeof render>>>();
    let live = initial;
    const current = async (expected: CoursewareProject) => {
      await check();
      let latestGeneration = generation, verified = expected, hashChanged = false;
      const withoutPackageHash = (project: CoursewareProject) => JSON.stringify({ ...project, source: { ...project.source, sha256: "" } });
      const firstIndex = selected[0] - 1;
      const indices = [firstIndex, ...captures.map((_, i) => i).filter(i => i !== firstIndex)];
      for (const index of indices) {
        const capture = captures[index];
        const latest = (await input.teaching.native("narration-context", {}, index + 1))?.value as Capture | undefined;
        assertOwner(latest);
        if (JSON.stringify(latest!.view.project) !== JSON.stringify(expected)) {
          if (latest!.view.project.pages.some((p, i) => JSON.stringify(p.actions) !== JSON.stringify(expected.pages[i]?.actions) || p.locked !== expected.pages[i]?.locked))
            throw new Error("Native narration teaching was edited or locked; preserve current teaching and read its context before continuing");
          if (withoutPackageHash(latest!.view.project) !== withoutPackageHash(expected))
            stale(`teaching revision changed on page ${index + 1}`);
          // An idle autosave can replace the package SHA after our own teaching write.
          // Accept it only after checking all captured context and selected slide pixels below.
          verified = latest!.view.project; hashChanged = true;
        }
        if (JSON.stringify([latest!.text, latest!.evidence, latest!.view.teachingRequirements, latest!.view.enrichment]) !==
            JSON.stringify([capture.text, capture.evidence, capture.view.teachingRequirements, capture.view.enrichment]))
          stale(`page ${index + 1} text, layout or requirements changed`, index + 1);
        latestGeneration = latest!.editor?.editGeneration;
        if (index === firstIndex && latestGeneration === generation && !hashChanged) return;
      }
      if (latestGeneration !== generation || hashChanged) {
        // Selection and navigation also advance Office's generation; compare actual content.
        for (const n of selected) if ((await render(n)).sha256 !== hashes.get(n)) stale(`page ${n} appearance changed`, n);
        const after = (await input.teaching.native("narration-context", {}, selected[0]))?.value as Capture | undefined;
        assertOwner(after);
        if (after!.editor?.editGeneration !== latestGeneration || JSON.stringify(after!.view.project) !== JSON.stringify(verified))
          stale("document changed while refreshing its content");
        generation = latestGeneration;
        live = verified;
      }
    };
    let result: Result;
    try {
      const contextPages = new Set(selected.flatMap(n => [n - 2, n - 1, n, n + 1, n + 2]));
      for (let n = 1; n <= initial.pages.length; n++) {
        if (!contextPages.has(n)) continue;
        const capture = (await input.teaching.native("narration-context", {}, n))?.value as Capture | undefined;
        assertOwner(capture); captures[n - 1] = structuredClone(capture!);
        if (selected.includes(n)) {
          const preview = await render(n); hashes.set(n, preview.sha256); previews.set(n, preview);
        }
      }
      const project = structuredClone(initial);
      for (const page of project.pages) {
        if (input.repairObjectsOnly) continue;
        page.actions = page.actions.filter(a => a.type !== "native_animation");
        for (const action of page.actions) delete action.durationMs;
      }
      const contentKey = (n: number) => createHash("sha256").update(JSON.stringify([input.frozenArtwork || project.taskType === "scene" ? "frozen-artwork-actions/1" : "whole-page-visual-evidence/4", initial.projectId, input.sessionId, input.model,
        captures[n - 1].view.pageId, initial.pages[n - 1].actions, captures[n - 1].text, captures[n - 1].evidence, hashes.get(n),
        captures[n - 1].view.teachingRequirements, captures[n - 1].view.enrichment, !!input.repairRequiredTeaching, !!input.repairObjectsOnly])).digest("hex");
      const blocked = selected.flatMap(pageNumber => {
        const key = contentKey(pageNumber), contentError = input.contentFailures?.get(key), state = input.retryState?.get(key);
        const exhausted = state?.error ?? (state && state.attempts >= 3 ? "Page narration attempt budget exhausted for this user turn" : undefined);
        return contentError ? [{ pageNumber, error: contentError, code: "COURSEWARE_PAGE_CONTENT_MISMATCH", retriable: false }] :
          exhausted ? [{ pageNumber, error: exhausted, code: state?.code ?? (state && state.attempts >= 3 ? "COURSEWARE_NARRATION_RETRY_EXHAUSTED" : "COURSEWARE_NARRATION_REPAIR_REQUIRED"), retriable: false }] : [];
      });
      const requested = selected.filter(n => !blocked.some(f => f.pageNumber === n));
      for (const blockedPage of blocked) diagnostics.push({ pageNumber: blockedPage.pageNumber,
        message: blockedPage.code === "COURSEWARE_PAGE_CONTENT_MISMATCH"
          ? "The live page and teaching requirements are unchanged since their content mismatch. Repair the open PPT page or correct its approved page mapping before requesting narration again; SVG-only edits do not change this document."
          : `This unchanged page is blocked at ${blockedPage.code} for the active user turn. Preserve saved peers and continue independent pages; changing instruction wording or batch size cannot reset this budget.` });
      result = await generateSavedNarrationBatch({
        host: { async call() { throw new Error("Native narration cannot use a Host teaching mirror"); } },
        sessionId: input.sessionId, jobId: "native", project, bytes: new Uint8Array(), selected: requested, frozenArtwork: input.frozenArtwork,
        instruction: input.instruction, speechCount: input.speechCount, model: input.model, complete: input.complete, completeVision: input.completeVision,
        repairRequiredTeaching: input.repairRequiredTeaching, repairObjectsOnly: input.repairObjectsOnly, canDispatch: input.canDispatch,
        beforeGenerate: async pageNumber => {
          const key = contentKey(pageNumber), state = input.retryState?.get(key) ?? { attempts: 0 };
          if (state.attempts >= 3) throw Object.assign(new Error(state.error ?? "Page narration attempt budget exhausted for this user turn; correct the page or start a new explicit request"),
            { code: state.code ?? "COURSEWARE_NARRATION_RETRY_EXHAUSTED", retriable: false });
          state.attempts++; input.retryState?.set(key, state);
          await input.persistRetryState?.();
        },
        current: async () => current(live),
        native: {
          audioDurations: Object.fromEntries(initial.pages.map(p => [p.pageId, Object.fromEntries(p.actions.filter(a => a.type === "speech" && a.audioAssetId && Number.isSafeInteger(a.durationMs)).map(a => [String(a.id), Number(a.durationMs)]))])),
          context: { project, enrichment: first.view.enrichment, mapping: { sourceSha256: project.source.sha256, revision: project.teachingRevision,
            pages: captures.flatMap(c => ({ pageId: c.view.pageId, objects: c.evidence.objects.map(o => ({ objectId: o.objectId, importElementId: o.objectId })) })) },
            teachingRequirements: first.view.teachingRequirements ?? [],
            assessmentPageIds: captures.filter(c => c.view.teaching?.pageType && c.view.teaching.pageType !== "slide" ||
              c.view.assessment || c.view.embeddedAssessment).map(c => c.view.pageId) },
          evidence: async n => { const c = captures[n - 1]; return { ...c.evidence, text: c.text, elements: c.evidence.objects.map(o => ({ ...o, id: o.objectId })) }; },
          visuals: { async page(n) {
            const preview = previews.get(n)!;
            const layers = preview.layers.filter(l => captures[n - 1].evidence.objects.some(o => o.objectId === l.objectId && o.layerMetadata));
            return { images: [preview, ...layers], imageBindings: layers.map(l => ({ assetId: l.assetIds[0], importElementId: l.objectId })) };
          }, async dispose() {} },
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
            if (source?.policy === "preserve") {
              const speech = (items: typeof actions) => items.filter(a => a.type === "speech").map(a => [a.id, a.text]);
              if (JSON.stringify(speech(actions)) !== JSON.stringify(speech(original.actions))) throw new Error("Source repair cannot change accepted script words or order");
            }
            if (input.repairRequiredTeaching && original.actions.some(a => a.type === 'speech')) {
              const retained = (items: typeof actions) => items.filter(a => a.type === 'speech').map(a => [a.id, a.text, a.audioAssetId]);
              if (JSON.stringify(retained(actions)) !== JSON.stringify(retained(original.actions))) throw new Error('Required teaching repair must preserve existing speech and audio');
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
      for (const failure of result.failures) {
        const key = contentKey(failure.pageNumber);
        const missingContent = failure.error.includes("Required visual content missing;");
        if (missingContent) {
          if ((input.contentFailures?.size ?? 0) >= 100) input.contentFailures?.clear();
          input.contentFailures?.set(key, failure.error);
        }
        if (missingContent || failure.retriable === false) {
          const state = input.retryState?.get(key) ?? { attempts: 0 };
          state.error = failure.error.slice(0, 2000);
          if (missingContent) state.code = "COURSEWARE_PAGE_CONTENT_MISMATCH";
          else if (failure.code && /^[A-Z][A-Z0-9_]{0,99}$/u.test(failure.code)) state.code = failure.code;
          input.retryState?.set(key, state);
        }
      }
      if (result.failures.some(f => f.retriable === false || f.error.includes("Required visual content missing;"))) await input.persistRetryState?.();
    } catch (error) {
      result = { savedPages: [], failures: selected.filter(n => !saved.has(n)).map(pageNumber => ({ pageNumber, error: String(error) })), diagnostics: [], applied: saved.size > 0, saved: false, audioReady: false };
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
