import { sequenceSpeechFocus } from "@pi-desktop/shared";
import { detachLinkedSpeechAnimations, nativeMotionPreset, type MaicClassroom, type MaicSlideIR } from "@pi-desktop/courseware-runtime/node";

type Scene = MaicClassroom["scenes"][number];
type Action = NonNullable<Scene["actions"]>[number];
type Element = Extract<Scene["content"], { type: "slide" }>["canvas"]["elements"][number];
export type NativeResource = { url: string; mimeType: string; durationMs?: number };

/** Translate native teaching to MAIC actions. */
export function convertNativeTeaching(input: {
  scene: Scene; actions: Array<Record<string, unknown>>; page: MaicSlideIR["pages"][number];
  objects: Array<{ objectId: string; importElementId: string }>;
  resources: ReadonlyMap<string, NativeResource>; sourceSha256?: string; platformDelivery?: boolean;
}) {
  const { scene, resources } = input;
  const actions: Action[] = [], elements: Element[] = [], media: NonNullable<MaicClassroom["mediaManifest"]> = [];
  const assessmentIds = Object.values(scene.metadata?.assessmentSpeechIds ?? {});
  const speeches = (scene.actions ?? []).filter(a => a.type === "speech").filter(a => !assessmentIds.includes(a.id));
  let speechIndex = 0;
  const fail = (message: string): never => { throw new Error(message); };
  const canvas = scene.content.type === "slide" ? scene.content.canvas : undefined;
  const target = (id: unknown) => {
    const imported = input.objects.find(o => o.objectId === id)?.importElementId;
    const raw = input.page.elements.find(e => e.id === imported);
    const matches = canvas?.elements.filter(e => e.id === id || e.id === imported || raw?.sourceObjectName === e.id || raw?.sourceShapeId && raw.sourceShapeId === e.sourceShapeId) ?? [];
    if (matches.length !== 1) return fail(`Native teaching target is missing or ambiguous: ${String(id)}`);
    return matches[0];
  };
  const animation = (id: string, elementId: string, effect: string, duration: number, atMs = 0): Extract<Action, { type: "element_animation" }> => ({
    id, type: "element_animation", elementId, effect: effect === "appear" ? "fadeIn" : effect === "disappear" ? "fadeOut" : effect,
    animationType: ["fadeOut", "disappear"].includes(effect) ? "out" : ["pulse", "gentleRotate"].includes(effect) ? "attention" : "in",
    duration, pptistTrigger: "auto", startAtMs: atMs,
  });
  const nodes: Array<Record<string, unknown> & { type: string }> = input.actions.map(node => ({ ...structuredClone(node), type: String(node.type) }));
  detachLinkedSpeechAnimations(input.page, nodes, input.objects);
  // Fold authored waits into their speech before materializing its end step.
  for (let i = nodes.length - 1; i > 0; i--) {
    const wait = nodes[i], previous = nodes[i-1];
    if (wait.type !== "delay" || !["delay", "speech"].includes(previous.type)) continue;
    const key = previous.type === "speech" ? "pauseAfterMs" : "durationMs";
    const before = previous[key] ?? 0;
    if (!Number.isInteger(before) || Number(before) < 0 || !Number.isInteger(wait.durationMs) || Number(wait.durationMs) < 0 ||
        Number(before) + Number(wait.durationMs) > 30000) fail("Invalid native speech pause");
    previous[key] = Number(before) + Number(wait.durationMs);
    nodes.splice(i, 1);
  }
  for (const [index, node] of nodes.entries()) {
    const id = typeof node.id === "string" ? node.id : `${scene.id}-native-${index}`;
    if (node.type === "speech" && typeof node.text === "string") {
      const previous = speeches.find(a => a.id === id) ?? speeches[speechIndex];
      speechIndex++;
      const speech: Action = previous?.text === node.text ? { ...previous } : { id: previous?.id ?? id, type: "speech", text: node.text };
      const bindings = scene.metadata?.nativeAudioBindings;
      const boundAudio = bindings && typeof bindings === "object" ? Reflect.get(bindings, id) : undefined;
      const duplicateAudio = boundAudio === undefined && speech.type === "speech" && input.actions.some(other =>
        other.id !== node.id && other.type === "speech" && other.text === node.text && other.audioAssetId === speech.audioId);
      if ((typeof boundAudio === "string" && boundAudio !== node.audioAssetId || duplicateAudio) && speech.type === "speech") {
        delete speech.audioId; delete speech.audioUrl;
      }
      delete speech.pptxTimeline;
      if (node.pauseAfterMs !== undefined && (!Number.isInteger(node.pauseAfterMs) || Number(node.pauseAfterMs) < 0 || Number(node.pauseAfterMs) > 30000)) fail(`Invalid native speech pause: ${id}`);
      if (node.pauseAfterMs !== undefined) Object.assign(speech, { pauseAfterMs: node.pauseAfterMs });
      else delete speech.pauseAfterMs;
      actions.push(speech);
      const speechIndexInActions = actions.length - 1;
      const startAnimations: Array<Extract<Action, { type: "element_animation" }>> = [];
      let primaryFocus: Extract<Action, { type: "spotlight" | "highlight" }> | undefined;
      let tailDuration = 0;
      const tailStep = { version: 1 as const, stepId: `${id}-speech-end` };
      if (node.visualCues !== undefined && !Array.isArray(node.visualCues)) fail(`Invalid native speech cues: ${id}`);
      type NativeCue = { id: string; atMs: number; endMs: number; trigger?: { kind: string; audioAssetId?: string; stale?: boolean; start?: number; end?: number; text?: string }; effect: { type: string; elementId?: string; elementIds?: string[]; effect?: string; dimOpacity?: number; color?: string; style?: string; opacity?: number } };
      const resource = typeof node.audioAssetId === "string" ? resources.get(node.audioAssetId) : undefined;
      const resolved = (Array.isArray(node.visualCues) ? node.visualCues : []).map((rawCue, index) => {
        const cue = rawCue as NativeCue;
        if (!cue || !cue.effect || !Number.isInteger(cue.atMs) || !Number.isInteger(cue.endMs) || cue.atMs < 0 || cue.endMs <= cue.atMs) fail(`Invalid native speech cue: ${id}`);
        if (!resource?.durationMs) fail(`Native speech cues require archived audio timing: ${id}`);
        if (speech.type === "speech" && speech.audioId && speech.audioId !== node.audioAssetId)
          fail(`Native speech cues require recalibration after voice replacement: ${id}`);
        let atMs = cue.atMs;
        if (cue.trigger?.kind === "end") {
          if (!resource?.durationMs) fail(`Native speech timing requires archived audio: ${id}`);
          atMs = resource!.durationMs!;
        } else if (cue.trigger?.kind === "start") atMs = 0;
        else if (cue.trigger && (cue.trigger.kind !== "text" || cue.trigger.stale || cue.trigger.audioAssetId !== node.audioAssetId ||
            speech.text.slice(cue.trigger.start, cue.trigger.end) !== cue.trigger.text || !resource?.durationMs || atMs > resource.durationMs)) fail(`Native speech timing requires recalibration: ${id}`);
        const endMs = atMs + cue.endMs - cue.atMs;
        if (atMs > resource!.durationMs! || atMs < resource!.durationMs! && endMs > resource!.durationMs!) fail(`Native cue exceeds MAIC narration timing: ${id}`);
        if (cue.effect.type === "element_animation" && !["fadeIn","fadeOut","pulse","zoomIn","slideInLeft","slideInRight","gentleRotate"].includes(cue.effect.effect ?? "")) fail(`Unsupported native speech animation: ${id}`);
        if (!["element_animation", "highlight", "spotlight"].includes(cue.effect.type)) fail(`Unsupported native speech effect: ${id}`);
        const ids = [...(cue.effect.elementId ? [cue.effect.elementId] : []), ...(cue.effect.elementIds ?? [])];
        if (!ids.length) fail(`Native speech effect has no target: ${id}`);
        ids.forEach(target);
        return { ...cue, atMs, endMs, index };
      });
      const scheduled = sequenceSpeechFocus(resolved);
      const hasMidSpeechMotion = scheduled.some(c => c.effect.type === "element_animation" && c.atMs > 0 && c.atMs < resource!.durationMs!);
      const focusCount = scheduled.filter(c => c.effect.type !== "element_animation").length;
      for (const cue of scheduled) {
        const { atMs, endMs, index: cueIndex } = cue;
        const timed = (effect: Extract<Action, { type: "element_animation" }>, when: number) => {
          if (atMs === resource!.durationMs!) {
            const stepId = tailStep.stepId;
            tailDuration = Math.max(tailDuration, when - atMs + effect.duration);
            const existing = actions.some(a => a.type === "element_animation" && a.pptxTimeline?.stepId === stepId);
            Object.assign(effect, { startAtMs: when - atMs, pptistTrigger: existing ? "meantime" : "auto", pptxTimeline: { version: 1, stepId } });
            actions.push(effect); return;
          }
          Object.assign(effect, { speechCue: { version: 1, speechActionId: speech.id, timingTrackId: String(node.audioAssetId ?? speech.id),
            atMs: when, anchorText: node.text, occurrence: 1, targetElementId: "elementId" in effect ? effect.elementId : "", motionIntent: "fade_in" } });
          delete effect.startAtMs; actions.push(effect);
        };
        const effect = cue.effect;
        if (effect.type === "element_animation") {
          if (!["fadeIn", "fadeOut", "pulse", "zoomIn", "slideInLeft", "slideInRight", "gentleRotate"].includes(effect.effect ?? "")) fail(`Unsupported native speech animation: ${id}`);
          const motion = animation(`${id}-cue-${cueIndex}`, target(effect.elementId).id, effect.effect!, endMs - atMs);
          if (input.platformDelivery && motion.effect === "gentleRotate") motion.effect = "swing";
          // Web's audio-cue scheduler reconciles time-zero animations without playing them.
          if (input.platformDelivery && atMs === 0) {
            startAnimations.push(motion);
          } else {
            timed(motion, atMs);
          }
          continue;
        }
        if (!canvas) fail(`Unsupported native speech effect: ${id}`);
        const targets = [...new Set([...(effect.elementId ? [effect.elementId] : []), ...(effect.elementIds ?? [])])].map(target);
        if (input.platformDelivery && !hasMidSpeechMotion && focusCount === 1 && endMs === resource!.durationMs &&
            (atMs === 0 || scheduled.some(c => c.effect.type === "element_animation" && c.atMs === 0 && c.endMs === atMs))) {
          const elementIds = [...new Set(targets.map(element => element.id))];
          const effectId = `${id}-cue-${cueIndex}`;
          // Only a whole-speech focus can use the platform's untimed overlay.
          primaryFocus = effect.type === "spotlight"
            ? { id: effectId, type: "spotlight", elementId: elementIds[0], elementIds, dimOpacity: effect.dimOpacity ?? .6 }
            : { id: effectId, type: "highlight", elementIds, color: effect.color ?? "#f59e0b",
                style: effect.style === "fill" || effect.style === "glow" ? effect.style : "outline", opacity: effect.opacity };
          continue;
        }
        // Standard PPTist shapes plus speech-cued entrance/exit work in both players.
        const boxes = targets.map(e => ({ x: e.left - 3, y: e.top - 3, w: e.width + 6, h: ("height" in e ? Number(e.height) : 0) + 6 }));
        const shape = (suffix: string, path: string, left: number, top: number, width: number, height: number, fill: string, outline = false) => {
          const elementId = `${scene.id}-native-cue-${id}-${cueIndex}-${suffix}`;
          const element: Element = { id: elementId, type: "shape", left, top, width, height, rotate: 0, viewBox: [width, height], path, fixedRatio: false, fill,
            ...(outline ? { outline: { color: effect.color ?? "#f59e0b", width: 3, style: "solid" as const } } : {}) };
          elements.push(element);
          timed(animation(`${elementId}-in`, elementId, "appear", 0), atMs);
          timed(animation(`${elementId}-out`, elementId, "disappear", 0), endMs);
        };
        if (effect.type === "highlight") {
          for (const [i, box] of boxes.entries()) shape(String(i), `M0 0H${box.w}V${box.h}H0Z`, box.x, box.y, box.w, box.h,
            effect.style === "fill" ? effect.color ?? "#f59e0b" : "transparent", effect.style !== "fill");
          for (const e of elements.slice(-boxes.length)) if (e.type === "shape" && effect.style === "fill") e.opacity = effect.opacity ?? .25;
        } else {
          const w = canvas!.viewportSize, h = w * canvas!.viewportRatio;
          const xs = [...new Set([0, w, ...boxes.flatMap(b => [Math.max(0, Math.min(w, b.x)), Math.max(0, Math.min(w, b.x + b.w))])])].sort((a,b) => a-b);
          const ys = [...new Set([0, h, ...boxes.flatMap(b => [Math.max(0, Math.min(h, b.y)), Math.max(0, Math.min(h, b.y + b.h))])])].sort((a,b) => a-b);
          let path = "";
          for (let x=0; x<xs.length-1; x++) for (let y=0; y<ys.length-1; y++) {
            const cx=(xs[x]+xs[x+1])/2, cy=(ys[y]+ys[y+1])/2;
            if (!boxes.some(b => cx >= b.x && cx <= b.x+b.w && cy >= b.y && cy <= b.y+b.h)) path += `M${xs[x]} ${ys[y]}H${xs[x+1]}V${ys[y+1]}H${xs[x]}Z`;
          }
          shape("spotlight", path, 0, 0, w, h, "#000000");
          const overlay = elements.at(-1); if (overlay?.type === "shape") overlay.opacity = effect.dimOpacity ?? .6;
        }
      }
      if (tailDuration && speech.pauseAfterMs) {
        // The end step starts at audio completion and lasts for max(pause, motion).
        if (speech.pauseAfterMs > tailDuration) {
          const holdId = `${scene.id}-native-hold-${id}`;
          elements.push({ id: holdId, type: "shape", left: 0, top: 0, width: 1, height: 1, rotate: 0, viewBox: [1,1],
            path: "M0 0H1V1H0Z", fixedRatio: false, fill: "transparent", opacity: 0 });
          actions.push({ ...animation(holdId, holdId, "fadeOut", 0, speech.pauseAfterMs), pptistTrigger: "meantime", pptxTimeline: tailStep });
        }
        delete speech.pauseAfterMs;
      }
      if (startAnimations.length) {
        const step = { version: 1 as const, stepId: `${id}-speech-start` };
        for (const [index, motion] of startAnimations.entries()) {
          motion.pptxTimeline = step;
          motion.pptistTrigger = index === 0 ? "auto" : "meantime";
        }
        if (!primaryFocus) speech.pptxTimeline = { ...step, phase: "with" };
      }
      actions.splice(speechIndexInActions, 0, ...startAnimations, ...(primaryFocus ? [primaryFocus] : []));
    } else if (node.type === "delay") {
      const previous = actions.findLast(a => a.type === "speech");
      if (!previous || previous.type !== "speech" || actions.slice(actions.indexOf(previous)+1).some(a => a.type !== "element_animation" || !a.speechCue) ||
          !Number.isInteger(node.durationMs) || Number(node.durationMs) < 0 || Number(node.durationMs) + (previous.pauseAfterMs ?? 0) > 30000) fail(`Native delay requires a preceding narration and at most 30 seconds: ${id}`);
      previous!.pauseAfterMs = Number(node.durationMs) + (previous!.type === "speech" ? previous!.pauseAfterMs ?? 0 : 0);
    } else if (node.type === "audio_clip" || node.type === "video_clip") {
      if (!canvas) fail(`Native media requires a slide: ${id}`);
      const assetId = String(node.type === "audio_clip" ? node.audioAssetId : node.videoAssetId), asset = resources.get(assetId);
      const video = node.type === "video_clip";
      if (!asset || !asset.mimeType.startsWith(video ? "video/" : "audio/")) fail(`Native media is not archived: ${assetId}`);
      const elementId = `${scene.id}-native-media-${id}`;
      elements.push(video ? { id: elementId, type: "video", left: 0, top: 0, width: canvas!.viewportSize, height: canvas!.viewportSize * canvas!.viewportRatio,
        rotate: 0, src: asset!.url, autoplay: false } : { id: elementId, type: "audio", left: 0, top: 0, width: 32, height: 32,
        rotate: 0, src: asset!.url, fixedRatio: true, color: "#5b6b83", loop: false, autoplay: false });
      media.push({ sceneId: scene.id, elementId, assetId, assetType: video ? "video" : "audio", src: asset!.url, originalSrc: asset!.url, mimeType: asset!.mimeType });
      actions.push({ id, type: video ? "play_video" : "play_audio", elementId });
    } else if (node.type === "native_animation") {
      const stepIndex = Number(node.stepIndex), step = input.page.pptxAnimation?.steps[stepIndex];
      if (!canvas || node.version !== 1 || node.sourceSha256 !== input.sourceSha256 || !Number.isInteger(stepIndex) || !step?.items.length) fail(`Native animation no longer matches saved source: ${id}`);
      for (const [i, item] of step!.items.entries()) {
        const targets = input.page.elements.filter(e => e.sourceShapeId === item.target?.shapeId);
        const presetEffect = ["fadeIn", "fadeOut", "pulse", "zoomIn", "slideInLeft", "slideInRight", "gentleRotate"].find(name => {
          const preset = nativeMotionPreset(name)!;
          return item.nativePreset?.class === preset.ooxmlClass && item.nativePreset.id === preset.presetId && (item.nativePreset.subtype ?? 0) === preset.subtype;
        });
        const effect = presetEffect ?? (item.effect === "fade" ? item.animationType === "out" ? "fadeOut" : "fadeIn" : item.effect);
        if (targets.length !== 1 || !effect || !["appear", "disappear", "fadeIn", "fadeOut", "pulse", "zoomIn", "slideInLeft", "slideInRight"].includes(effect) || item.motion || item.rotation || item.target?.characterRange || item.target?.paragraphIndexes) fail(`Native animation cannot be represented by the current MAIC importer: ${id}`);
        const element = canvas!.elements.find(e => e.id === targets[0].id || e.sourceShapeId === item.target?.shapeId || e.id === targets[0].sourceObjectName);
        if (!element) fail(`Native animation target is missing: ${id}`);
        const a = animation(`${id}-${i}`, element!.id, effect!, ["appear", "disappear"].includes(effect!) ? 0 : item.durationMs, item.startAtMs);
        Object.assign(a, { animationType: item.animationType, pptistTrigger: i ? "meantime" : "auto", pptistAnimationId: item.id,
          pptxTimeline: { version: 1, stepId: id } }); actions.push(a);
      }
    } else if (node.type === "interaction_checkpoint" && ["chapter_summary", "media_playback"].includes(String(node.checkpointKind))) {
      const { response: _response, ...canonical } = node; actions.push(canonical as unknown as Action);
    } else fail(`Native teaching step has no equivalent in current MAIC: ${String(node.type)}${node.checkpointKind ? `/${node.checkpointKind}` : ""}`);
  }
  return { actions, elements, media };
}
