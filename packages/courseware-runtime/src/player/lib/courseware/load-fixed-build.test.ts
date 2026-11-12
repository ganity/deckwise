import { afterEach, expect, it, vi } from "vitest";
import { digestBytes, loadFixedBuild } from "./load-fixed-build";
const audio = new Uint8Array([82, 73, 70, 70]);
const encode = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value));
async function payload() {
  return {
    schemaVersion: "deckwise-playback/1",
    report: {
      ready: true,
      visualFidelity: "NOT_VERIFIED",
      reviewedWarningCodes: [],
      diagnostics: [],
      capabilities: {
        staticSlides: "limited",
        fixedNarration: true,
        teacherWait: true,
        transitions: false,
        objectAnimations: false,
        spotlight: false,
      },
      sourceSha256: "a".repeat(64),
      sourceRevision: "R8",
      teachingRevision: "T8",
      mappingRevision: "M8",
      converter: {
        version: "maic-pptx-import-ir/1",
        manifestSha256: "b".repeat(64),
      },
    },
    pages: [
      {
        pageId: "logical-page",
        title: "Test",
        slide: {
          id: "slide",
          viewportSize: 1000,
          viewportRatio: 0.5625,
          elements: [],
          theme: {},
          background: {},
        },
        objects: [],
        actions: [
          {
            id: "speech",
            type: "speech",
            text: "Narration",
            audioAssetId: "voice",
          },
        ],
      },
    ],
    assets: [
      {
        id: "voice",
        path: `assets/${await digestBytes(audio)}.wav`,
        mimeType: "audio/wav",
        sha256: await digestBytes(audio),
      },
    ],
  };
}
afterEach(() => vi.restoreAllMocks());
it("loads a distinct verified audio clip and rejects missing or non-audio assets", async () => {
  const original = await payload();
  const candidate = { ...original, report: { ...original.report, capabilities: { ...original.report.capabilities, teachingAudioClips: "sequential/1" } }, pages: [{ ...original.pages[0], actions: [{ id: "music", type: "audio_clip", audioAssetId: "voice" }] }] };
  const load = async () => { const bytes = encode(candidate); return loadFixedBuild(bytes, await digestBytes(bytes), async () => audio); };
  const loaded = await load();
  expect(loaded.scenes[0].actions?.[0]).toMatchObject({ id: "music", type: "audio_clip", audioAssetId: "voice", audioId: "voice", audioUrl: expect.stringMatching(/^blob:/) });
  expect(loaded.speechVisualCues.size).toBe(0); loaded.dispose();
  Reflect.deleteProperty(candidate.report.capabilities, "teachingAudioClips");
  await expect(load()).rejects.toThrow("AUDIO_CLIP_CAPABILITY_MISMATCH");
  candidate.report.capabilities.teachingAudioClips = "sequential/1";
  candidate.pages[0].actions[0].audioAssetId = "missing";
  await expect(load()).rejects.toThrow("AUDIO_ASSET_MISSING");
  candidate.pages[0].actions[0].audioAssetId = "voice";
  candidate.assets[0].mimeType = "image/png";
  await expect(load()).rejects.toThrow("AUDIO_ASSET_MISSING");
});
async function nativePayload() {
  const value = await payload();
  return { ...value, report: { ...value.report, capabilities: { ...value.report.capabilities,
    nativeObjectAnimations: "click-appear-fade/1" } }, pages: [{ ...value.pages[0],
    slide: { ...value.pages[0].slide, elements: [{ id: "target", type: "text", left: 10, top: 10, width: 100, height: 50 }] },
    objects: [{ objectId: "logical-target", importElementId: "target" }],
    nativeAnimations: { version: 1, sequence: "before-narration", steps: [
      { id: "step-1", trigger: "click", elementId: "target", effect: "fade", durationMs: 500 },
      { id: "step-2", trigger: "click", elementId: "target", effect: "appear", durationMs: 1 },
    ] },
  }] };
}
it("loads finite native clicks before unchanged canonical speech, retaining explicit teacher gates", async () => {
  const candidate = await nativePayload(); const bytes = encode(candidate);
  const loaded = await loadFixedBuild(bytes, await digestBytes(bytes), async () => audio);
  expect(loaded.scenes[0].actions?.map(action => action.type)).toEqual([
    "interaction_checkpoint", "element_animation", "interaction_checkpoint", "element_animation", "speech",
  ]);
  expect(loaded.scenes[0].actions?.[1]).toMatchObject({ elementId: "target", effect: "fadeIn", duration: 500,
    pptistTrigger: "click", pptxTimeline: { version: 1 } });
  expect(loaded.scenes[0].actions?.[3]).toMatchObject({ effect: "appear", duration: 1, pptistTrigger: "click" });
  expect(loaded.scenes[0].actions?.[4]).toMatchObject(candidate.pages[0].actions[0]);
  expect(loaded.nativeAnimations?.get("logical-page")).toEqual(candidate.pages[0].nativeAnimations);
  loaded.dispose();
});
it.each(["version", "effect", "trigger", "duration", "target", "group", "capability", "cue-conflict"])(
  "rejects unsupported native click %s without expanding the action whitelist", async kind => {
    const candidate = await nativePayload();
    const native = candidate.pages[0].nativeAnimations, step = native.steps[0];
    if (kind === "version") native.version = 2;
    if (kind === "effect") step.effect = "fly";
    if (kind === "trigger") step.trigger = "auto";
    if (kind === "duration") step.durationMs = 5001;
    if (kind === "target") step.elementId = "absent";
    if (kind === "group") Reflect.set(candidate.pages[0].slide.elements[0], "sourceGroupShapeIds", ["group"]);
    if (kind === "capability") Reflect.deleteProperty(candidate.report.capabilities, "nativeObjectAnimations");
    if (kind === "cue-conflict") {
      Reflect.set(candidate.pages[0].actions[0], "visualCues", [{ id: "conflict", atMs: 0, endMs: 100,
        effect: { type: "element_animation", elementId: "logical-target", effect: "pulse" } }]);
      Reflect.set(candidate.report.capabilities, "speechVisualCues", "fixed-audio/2");
      Reflect.set(candidate.report.capabilities, "playerObjectAnimations", "fade-pulse/1");
    }
    const bytes = encode(candidate);
    await expect(loadFixedBuild(bytes, await digestBytes(bytes), async () => audio)).rejects.toThrow();
  });
it("binds highlight and spotlight to an object revealed by native clicks, retaining target validation", async () => {
  const candidate = await nativePayload();
  const cues = [
    { id: "highlight", atMs: 0, endMs: 100, effect: { type: "highlight", elementIds: ["logical-target"] } },
    { id: "spotlight", atMs: 100, endMs: 200, effect: { type: "spotlight", elementId: "logical-target", dimOpacity: .7 } },
  ];
  Reflect.set(candidate.pages[0].actions[0], "visualCues", cues);
  Reflect.set(candidate.report.capabilities, "speechVisualCues", "fixed-audio/1");
  Reflect.set(candidate.report.capabilities, "spotlight", true);
  const load = async () => { const bytes = encode(candidate); return loadFixedBuild(bytes, await digestBytes(bytes), async () => audio); };
  const loaded = await load();
  expect(loaded.scenes[0].actions?.map(action => action.type)).toEqual([
    "interaction_checkpoint", "element_animation", "interaction_checkpoint", "element_animation", "speech",
  ]);
  expect(loaded.speechVisualCues.get("speech")).toEqual([
    { id: "highlight", atMs: 0, endMs: 100, effect: { kind: "highlight", targetIds: ["target"] } },
    { id: "spotlight", atMs: 100, endMs: 200, effect: { kind: "spotlight", targetId: "target", dimOpacity: .7 } },
  ]);
  loaded.dispose();
  cues[1].effect.elementId = "deleted";
  await expect(load()).rejects.toThrow("EFFECT_BINDING_MISMATCH");
  cues[1].effect.elementId = "logical-target";
  cues[1].effect.elementIds = ["deleted"];
  await expect(load()).rejects.toThrow("EFFECT_BINDING_MISMATCH");
});
it.each(["fadeIn", "fadeOut", "pulse"])("rejects a competing %s cue on a native entrance target", async effect => {
  const candidate = await nativePayload();
  Reflect.set(candidate.pages[0].actions[0], "visualCues", [
    { id: "attention", atMs: 0, endMs: 100, effect: { type: "highlight", elementIds: ["logical-target"] } },
    { id: "animation", atMs: 100, endMs: 200, effect: { type: "element_animation", elementId: "logical-target", effect } },
  ]);
  Reflect.set(candidate.report.capabilities, "speechVisualCues", "fixed-audio/2");
  Reflect.set(candidate.report.capabilities, "playerObjectAnimations", "fade-pulse/1");
  const bytes = encode(candidate);
  await expect(loadFixedBuild(bytes, await digestBytes(bytes), async () => audio)).rejects.toThrow("NATIVE_ANIMATION_CUE_CONFLICT");
});
it("loads a generated slide background without inventing a logical object binding", async () => {
  const value = await payload();
  const background = {
    id: "page_1_background", type: "image", imageType: "background",
    left: 0, top: 0, width: 1000, height: 562.5, rotate: 0, src: "picture",
  };
  const picture = new Uint8Array([137, 80, 78, 71]);
  value.assets.push({ id: "picture", path: `assets/${await digestBytes(picture)}.png`,
    mimeType: "image/png", sha256: await digestBytes(picture) });
  const candidate = { ...value, pages: [{ ...value.pages[0],
    slide: { ...value.pages[0].slide, elements: [background] } }] };
  const load = async () => {
    const bytes = encode(candidate);
    return loadFixedBuild(bytes, await digestBytes(bytes), async asset => asset.id === "picture" ? picture : audio);
  };
  const loaded = await load();
  expect(loaded.scenes[0].content).toMatchObject({ type: "slide", canvas: {
    elements: [{ id: "page_1_background", src: expect.stringMatching(/^blob:/) }],
  } });
  loaded.dispose();
  for (const change of [{ id: "unmapped" }, { type: "shape" }, { imageType: "content" },
    { left: 1 }, { top: 1 }, { width: 999 }, { height: 561 }, { rotate: 1 }]) {
    const original = { ...background };
    Object.assign(background, change);
    await expect(load()).rejects.toThrow("OBJECT_BINDING_MISMATCH");
    Object.assign(background, original);
  }
});
it("loads only verified archived audio and revokes its URL", async () => {
  const bytes = encode(await payload());
  const revoke = vi.spyOn(URL, "revokeObjectURL");
  const loaded = await loadFixedBuild(
    bytes,
    await digestBytes(bytes),
    async () => audio,
  );
  expect(loaded.scenes[0].actions?.[0]).toMatchObject({
    type: "speech",
    audioUrl: expect.stringMatching(/^blob:/),
  });
  loaded.dispose();
  loaded.dispose();
  expect(revoke).toHaveBeenCalledTimes(1);
});
it("rejects a changed package before resolving any asset", async () => {
  const resolver = vi.fn();
  await expect(
    loadFixedBuild(encode(await payload()), "0".repeat(64), resolver),
  ).rejects.toThrow("PACKAGE_HASH_MISMATCH");
  expect(resolver).not.toHaveBeenCalled();
});
it("parses the verified package snapshot if its caller changes the input during hashing", async () => {
  const value = await payload();
  const bytes = encode(value);
  const expectedHash = await digestBytes(bytes);
  const changed = encode({ ...value, pages: [{ ...value.pages[0], title: "Evil" }] });
  expect(changed.length).toBe(bytes.length);
  const digest = crypto.subtle.digest.bind(crypto.subtle);
  let calls = 0;
  vi.spyOn(crypto.subtle, "digest").mockImplementation(async (...args) => {
    const result = await digest(...args);
    if (++calls === 1) bytes.set(changed);
    return result;
  });
  const loaded = await loadFixedBuild(bytes, expectedHash, async () => audio);
  try {
    expect(bytes).toEqual(changed);
    expect(loaded.scenes[0].title).toBe("Test");
  } finally {
    loaded.dispose();
  }
});
it("plays the verified asset snapshot if its resolver changes the input during hashing", async () => {
  const bytes = encode(await payload());
  const expectedHash = await digestBytes(bytes);
  const resolved = audio.slice();
  const digest = crypto.subtle.digest.bind(crypto.subtle);
  let calls = 0;
  vi.spyOn(crypto.subtle, "digest").mockImplementation(async (...args) => {
    const result = await digest(...args);
    if (++calls === 2) resolved.fill(0);
    return result;
  });
  const loaded = await loadFixedBuild(bytes, expectedHash, async () => resolved);
  try {
    expect(resolved).toEqual(new Uint8Array(audio.length));
    const action = loaded.scenes[0].actions?.[0];
    if (action?.type !== "speech" || !action.audioUrl)
      throw new Error("Missing archived speech");
    const played = new Uint8Array(await (await fetch(action.audioUrl)).arrayBuffer());
    expect(played).toEqual(audio);
  } finally {
    loaded.dispose();
  }
});
it.each(["schema", "content", "review"] as const)(
  "rejects %s even with a matching content hash",
  async (kind) => {
    const value = await payload();
    if (kind === "schema") value.schemaVersion = "unknown";
    else
      value.report.diagnostics.push({
        code: "UNSUPPORTED",
        severity: kind === "content" ? "error" : "warning",
        message: "Unsupported",
      } as never);
    const bytes = encode(value);
    await expect(
      loadFixedBuild(bytes, await digestBytes(bytes), async () => audio),
    ).rejects.toThrow(
      kind === "schema"
        ? "PACKAGE_SCHEMA_INVALID"
        : kind === "content"
          ? "CONTENT_ERROR"
          : "CONTENT_REVIEW_REQUIRED",
    );
  },
);
it("rejects missing/corrupt assets and releases already loaded assets on failure", async () => {
  const value = await payload();
  value.assets.push({ ...value.assets[0], id: "second" });
  const bytes = encode(value);
  const revoke = vi.spyOn(URL, "revokeObjectURL");
  await expect(
    loadFixedBuild(bytes, await digestBytes(bytes), async (asset) =>
      asset.id === "voice" ? audio : new Uint8Array([0]),
    ),
  ).rejects.toThrow("ASSET_HASH_MISMATCH");
  expect(revoke).toHaveBeenCalledTimes(1);
  await expect(
    loadFixedBuild(bytes, await digestBytes(bytes), async () => {
      throw new Error("Missing asset");
    }),
  ).rejects.toThrow("Missing asset");
});
it("rejects unsafe resolver paths and cancellation", async () => {
  const value = await payload();
  value.assets[0].path = "../secret";
  const bytes = encode(value);
  await expect(
    loadFixedBuild(bytes, await digestBytes(bytes), async () => audio),
  ).rejects.toThrow("UNSAFE_ASSET_PATH");
  const clean = encode(await payload());
  await expect(
    loadFixedBuild(
      clean,
      await digestBytes(clean),
      async () => audio,
      AbortSignal.abort(new Error("Canceled")),
    ),
  ).rejects.toThrow("Canceled");
});

it.each([1, 3])(
  "honors cancellation during digest %i and releases prior asset URLs",
  async (abortAt) => {
    const value = await payload();
    value.assets.push({ ...value.assets[0], id: "second" });
    const bytes = encode(value);
    const expectedHash = await digestBytes(bytes);
    const controller = new AbortController();
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    const create = vi.spyOn(URL, "createObjectURL");
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    let calls = 0;
    vi.spyOn(crypto.subtle, "digest").mockImplementation(async (...args) => {
      const result = await digest(...args);
      if (++calls === abortAt)
        controller.abort(new Error("Selection replaced"));
      return result;
    });
    const resolver = vi.fn(async () => audio);
    await expect(
      loadFixedBuild(bytes, expectedHash, resolver, controller.signal),
    ).rejects.toThrow("Selection replaced");
    expect(resolver).toHaveBeenCalledTimes(abortAt === 1 ? 0 : 2);
    expect(create).toHaveBeenCalledTimes(abortAt === 1 ? 0 : 1);
    expect(revoke).toHaveBeenCalledTimes(create.mock.calls.length);
  },
);

const checkpoint = (id: string, pageId = "logical-page") => ({
  id,
  type: "interaction_checkpoint",
  checkpointId: "teacher-wait",
  checkpointKind: "chapter_summary",
  chapterId: "chapter",
  chapterTitle: "Teacher wait",
  question: "Continue when ready.",
  referenceAnswer: { summary: "", keyPoints: [] },
  context: { chapterSummary: "", sourceSceneIds: [pageId] },
});

it.each(["missing-page", "duplicate-checkpoint"])(
  "rejects %s waits before resolving assets",
  async (kind) => {
    const value = await payload();
    const actions =
      kind === "missing-page"
        ? [checkpoint("wait-1", "absent-page")]
        : [checkpoint("wait-1"), checkpoint("wait-2")];
    const bytes = encode({ ...value, pages: [{ ...value.pages[0], actions }] });
    const resolver = vi.fn(async () => audio);
    await expect(
      loadFixedBuild(bytes, await digestBytes(bytes), resolver),
    ).rejects.toThrow(
      kind === "missing-page"
        ? "WAIT_BINDING_MISMATCH"
        : "DUPLICATE_CHECKPOINT_ID",
    );
    expect(resolver).not.toHaveBeenCalled();
  },
);

it("preserves a valid structured teacher wait", async () => {
  const value = await payload();
  const wait = { id: "wait-1", type: "interaction_checkpoint", checkpointId: "wait-1", checkpointKind: "teacher_continue" };
  const bytes = encode({
    ...value,
    pages: [{ ...value.pages[0], actions: [wait] }],
  });
  const loaded = await loadFixedBuild(
    bytes,
    await digestBytes(bytes),
    async () => audio,
  );
  expect(loaded.scenes[0].actions).toEqual([wait]);
  loaded.dispose();
});

it("binds speech effects through logical object IDs and refuses undeclared effects or ambiguous bindings", async () => {
  const base = await payload();
  const value = {
    ...base,
    report: {
      ...base.report,
      capabilities: {
        ...base.report.capabilities,
        spotlight: true,
        speechVisualCues: "fixed-audio/1",
      },
    },
    pages: [
      {
        ...base.pages[0],
        slide: {
          ...base.pages[0].slide,
          elements: [
            {
              id: "render-object",
              type: "shape",
              left: 10,
              top: 20,
              width: 30,
              height: 40,
            },
          ],
        },
        objects: [
          { objectId: "logical-object", importElementId: "render-object" },
        ],
        actions: [
          {
            ...base.pages[0].actions[0],
            visualCues: [
              {
                id: "focus",
                atMs: 50,
                endMs: 500,
                effect: { type: "spotlight", elementId: "logical-object" },
              },
            ],
          },
        ],
      },
    ],
  };
  const load = async () => {
    const bytes = encode(value);
    return loadFixedBuild(bytes, await digestBytes(bytes), async () => audio);
  };
  const loaded = await load();
  expect(loaded.speechVisualCues.get("speech")).toEqual([
    {
      id: "focus",
      atMs: 50,
      endMs: 500,
      effect: {
        kind: "spotlight",
        targetId: "render-object",
        elementIds: undefined,
        dimOpacity: undefined,
      },
    },
  ]);
  loaded.dispose();
  value.pages[0].actions[0].visualCues[0].effect.elementId = "render-object";
  await expect(load()).rejects.toThrow("EFFECT_BINDING_MISMATCH");
  value.pages[0].actions[0].visualCues[0].effect.elementId = "logical-object";
  value.pages[0].objects.push({
    objectId: "duplicate-target",
    importElementId: "render-object",
  });
  await expect(load()).rejects.toThrow("OBJECT_BINDING_MISMATCH");
  value.pages[0].objects.pop();
  value.report.capabilities.speechVisualCues = "unknown";
  await expect(load()).rejects.toThrow("PACKAGE_SCHEMA_INVALID");
  value.report.capabilities.speechVisualCues = "fixed-audio/1";
  const { speechVisualCues: _capability, ...missingCapability } =
    value.report.capabilities;
  const undeclared = encode({
    ...value,
    report: { ...value.report, capabilities: missingCapability },
  });
  await expect(
    loadFixedBuild(
      undeclared,
      await digestBytes(undeclared),
      async () => audio,
    ),
  ).rejects.toThrow("EFFECT_CAPABILITY_MISMATCH");
  value.pages[0].slide.elements[0].type = "line";
  await expect(load()).rejects.toThrow("EFFECT_TARGET_UNSUPPORTED");
  value.pages[0].slide.elements[0].type = "shape";
  value.pages[0].actions[0].visualCues[0].endMs = 50;
  await expect(load()).rejects.toThrow("PACKAGE_SCHEMA_INVALID");
});

it("binds limited player animations and rejects unsupported/conflicting targets and undeclared capabilities", async () => {
  const base = await payload();
  const value = {
    ...base,
    report: {
      ...base.report,
      capabilities: {
        ...base.report.capabilities,
        speechVisualCues: "fixed-audio/2",
        playerObjectAnimations: "fade-pulse/1",
      },
    },
    pages: [
      {
        ...base.pages[0],
        slide: {
          ...base.pages[0].slide,
          elements: [
            {
              id: "shape",
              type: "shape",
              left: 0,
              top: 0,
              width: 100,
              height: 100,
            },
          ],
        },
        objects: [{ objectId: "logical-shape", importElementId: "shape" }],
        actions: [
          {
            ...base.pages[0].actions[0],
            visualCues: [
              {
                id: "reveal",
                atMs: 100,
                endMs: 500,
                effect: {
                  type: "element_animation",
                  elementId: "logical-shape",
                  effect: "fadeIn",
                },
              },
            ],
          },
        ],
      },
    ],
  };
  const load = async () => {
    const bytes = encode(value);
    return loadFixedBuild(bytes, await digestBytes(bytes), async () => audio);
  };
  const loaded = await load();
  expect(loaded.speechVisualCues.get("speech")?.[0].effect).toEqual({
    kind: "element_animation",
    action: {
      id: "reveal",
      type: "element_animation",
      elementId: "shape",
      effect: "fadeIn",
      animationType: "in",
      duration: 400,
      pptistTrigger: "auto",
    },
  });
  loaded.dispose();
  value.pages[0].actions[0].visualCues.push({
    ...value.pages[0].actions[0].visualCues[0],
    id: "duplicate-target",
  });
  await expect(load()).rejects.toThrow("ANIMATION_TARGET_CONFLICT");
  value.pages[0].actions[0].visualCues.pop();
  value.pages[0].actions.push({ ...value.pages[0].actions[0], id: "repeat-speech", visualCues: [{
    ...value.pages[0].actions[0].visualCues[0], id: "repeat-pulse", atMs: 0,
    effect: { type: "element_animation", elementId: "logical-shape", effect: "pulse" },
  }] });
  const repeated = await load();
  expect(repeated.speechVisualCues.get("repeat-speech")?.[0].effect).toMatchObject({ kind: "element_animation", action: { effect: "pulse" } });
  repeated.dispose();
  value.pages[0].actions[1].visualCues[0].effect.effect = "fadeIn";
  await expect(load()).rejects.toThrow("ANIMATION_TARGET_CONFLICT");
  value.pages[0].actions.pop();
  value.pages[0].slide.elements[0].type = "video";
  await expect(load()).rejects.toThrow("ANIMATION_TARGET_UNSUPPORTED");
  value.pages[0].slide.elements[0].type = "shape";
  value.report.capabilities.speechVisualCues = "fixed-audio/1";
  await expect(load()).rejects.toThrow("EFFECT_CAPABILITY_MISMATCH");
  value.report.capabilities.speechVisualCues = "fixed-audio/2";
  const { playerObjectAnimations: _animation, ...undeclared } =
    value.report.capabilities;
  const bytes = encode({
    ...value,
    report: { ...value.report, capabilities: undeclared },
  });
  await expect(
    loadFixedBuild(bytes, await digestBytes(bytes), async () => audio),
  ).rejects.toThrow("ANIMATION_CAPABILITY_MISMATCH");
  value.pages[0].actions[0].visualCues[0].effect.effect = "arbitrary-effect";
  await expect(load()).rejects.toThrow("PACKAGE_SCHEMA_INVALID");
});

it("loads verified MP4 clips and rejects a video referencing an audio asset", async () => {
  const original = await payload();
  const candidate = { ...original, pages: [{ ...original.pages[0], actions: [{ id: "video", type: "video_clip", videoAssetId: "voice" }] }],
    assets: [{ ...original.assets[0], mimeType: "video/mp4", path: `assets/${await digestBytes(audio)}.mp4` }] };
  const load = async () => { const bytes = encode(candidate); return loadFixedBuild(bytes, await digestBytes(bytes), async () => audio); };
  const loaded = await load();
  expect(loaded.scenes[0].actions?.[0]).toMatchObject({ type: "video_clip", videoUrl: expect.stringMatching(/^blob:/) });
  loaded.dispose(); candidate.assets[0].mimeType = "audio/wav"; candidate.assets[0].path = `assets/${await digestBytes(audio)}.wav`;
  await expect(load()).rejects.toThrow("VIDEO_ASSET_MISSING");
});

it.each([-1, 0.5, 30001])('rejects invalid packaged delay %s before playback', async durationMs => {
  const original = await payload();
  const candidate = { ...original, pages: [{ ...original.pages[0], actions: [{ id: 'delay', type: 'delay', durationMs }] }] };
  const bytes = encode(candidate);
  await expect(loadFixedBuild(bytes, await digestBytes(bytes), async () => audio)).rejects.toThrow();
});

async function boundNativePayload() {
  const value = await nativePayload();
  const node = (stepIndex: number) => ({ id: `bound-${stepIndex}`, type: 'native_animation', version: 1,
    sourceSha256: value.report.sourceSha256, stepIndex });
  return { ...value, report: { ...value.report, capabilities: { ...value.report.capabilities,
    nativeObjectAnimations: 'click-appear-fade/2', speechVisualCues: 'fixed-audio/1', spotlight: true } },
    pages: [{ ...value.pages[0], nativeAnimations: { ...value.pages[0].nativeAnimations, version: 2, sequence: 'teaching-timeline' },
      actions: [value.pages[0].actions[0], node(0), { ...value.pages[0].actions[0], id: 'after-first',
        visualCues: [{ id: 'h', atMs: 0, endMs: 100, effect: { type: 'highlight', elementIds: ['logical-target'] } }] },
      { id: 'teacher', type: 'interaction_checkpoint', checkpointId: 'teacher', checkpointKind: 'teacher_continue' }, node(1),
      { ...value.pages[0].actions[0], id: 'after-second', visualCues: [{ id: 's', atMs: 0, endMs: 100,
        effect: { type: 'spotlight', elementId: 'logical-target' } }] }],
    }] };
}
it('compiles bound native steps at their authored timeline positions without inserting extra teacher gates', async () => {
  const candidate = await boundNativePayload(), before = structuredClone(candidate);
  const bytes = encode(candidate), loaded = await loadFixedBuild(bytes, await digestBytes(bytes), async () => audio);
  try {
    expect(loaded.scenes[0].actions?.map(action => [action.id, action.type])).toEqual([
      ['speech', 'speech'], ['bound-0', 'element_animation'], ['after-first', 'speech'],
      ['teacher', 'interaction_checkpoint'], ['bound-1', 'element_animation'], ['after-second', 'speech'],
    ]);
    expect(loaded.scenes[0].actions?.[1]).toMatchObject({ elementId: 'target', effect: 'fadeIn', duration: 500 });
    expect(loaded.scenes[0].actions?.[4]).toMatchObject({ elementId: 'target', effect: 'appear', duration: 1 });
    expect(loaded.nativeAnimations?.get('logical-page')).toMatchObject({ version: 2, sequence: 'teaching-timeline' });
    expect(loaded.speechVisualCues.get('after-first')?.[0].effect).toMatchObject({ kind: 'highlight', targetIds: ['target'] });
    expect(loaded.speechVisualCues.get('after-second')?.[0].effect).toMatchObject({ kind: 'spotlight', targetId: 'target' });
    expect(candidate).toEqual(before);
  } finally { loaded.dispose(); }
});
it.each(['source', 'missing', 'duplicate', 'reordered', 'legacy-metadata', 'unbound-metadata', 'capability', 'hidden-target'])(
  'rejects %s timeline bindings before playing a different native step', async kind => {
    const candidate = await boundNativePayload(), page = candidate.pages[0];
    if (kind === 'source') Reflect.set(page.actions[1], 'sourceSha256', 'f'.repeat(64));
    if (kind === 'missing') page.actions.splice(4, 1);
    if (kind === 'duplicate') Reflect.set(page.actions[4], 'stepIndex', 0);
    if (kind === 'reordered') [page.actions[1], page.actions[4]] = [page.actions[4], page.actions[1]];
    if (kind === 'legacy-metadata') { page.nativeAnimations.version = 1; page.nativeAnimations.sequence = 'before-narration';
      candidate.report.capabilities.nativeObjectAnimations = 'click-appear-fade/1'; }
    if (kind === 'unbound-metadata') page.actions = page.actions.filter(action => action.type !== 'native_animation');
    if (kind === 'capability') candidate.report.capabilities.nativeObjectAnimations = 'click-appear-fade/1';
    if (kind === 'hidden-target') [page.actions[0], page.actions[2]] = [page.actions[2], page.actions[0]];
    const bytes = encode(candidate);
    await expect(loadFixedBuild(bytes, await digestBytes(bytes), async () => audio)).rejects.toThrow(
      kind === 'capability' ? 'NATIVE_ANIMATION_CAPABILITY_MISMATCH' : kind === 'hidden-target'
        ? 'NATIVE_ANIMATION_TARGET_NOT_REVEALED' : 'NATIVE_ANIMATION_BINDING_MISMATCH');
  });

it('loads automatic native preset steps and keeps click waits and delays before narration', async () => {
  const candidate: any = await nativePayload();
  delete candidate.pages[0].nativeAnimations;
  candidate.report.capabilities.nativeObjectAnimations = 'finite-presets/1';
  candidate.pages[0].nativeTimeline = { version: 1, steps: [
    { id: 'auto', trigger: 'auto', items: [{ elementId: 'target', effect: 'grow150', animationType: 'attention', durationMs: 600, startAtMs: 500 }] },
    { id: 'click', trigger: 'click', items: [{ elementId: 'target', effect: 'fadeIn', animationType: 'in', durationMs: 500, startAtMs: 0 }] },
  ] };
  const load = async () => { const bytes = encode(candidate); return loadFixedBuild(bytes, await digestBytes(bytes), async () => audio); };
  const loaded = await load();
  expect(loaded.nativeTimeline).toBe(true);
  expect(loaded.scenes[0].actions?.map(action => action.type)).toEqual(['element_animation', 'interaction_checkpoint', 'element_animation', 'speech']);
  expect(loaded.scenes[0].actions?.[0]).toMatchObject({ effect: 'grow150', duration: 600, startAtMs: 500, pptistTrigger: 'auto' });
  loaded.dispose();
  candidate.pages[0].nativeTimeline.steps[0].items[0].elementId = 'missing';
  await expect(load()).rejects.toThrow('NATIVE_ANIMATION_TARGET_UNSUPPORTED');
});

it('loads native edited quiz images and reference answers from archived build assets', async () => {
  const data: any = await payload();
  const image = new Uint8Array([137, 80, 78, 71]);
  data.assets.push({ id: 'picture', path: `assets/${await digestBytes(image)}.png`, sha256: await digestBytes(image), mimeType: 'image/png' });
  data.pages[0].quiz = { type: 'quiz', interactionMode: 'classroom_instant_feedback', questions: [{ id: 'q', type: 'single', question: 'Choose',
    options: [{ value: 'A', label: 'One', image: { src: 'picture', mimeType: 'image/png' } }, { value: 'B', label: 'Two' }], answer: ['B'], referenceAnswer: 'Two' }] };
  const encoded = encode(data);
  const loaded = await loadFixedBuild(encoded, await digestBytes(encoded), async asset => asset.id === 'picture' ? image : audio);
  expect(loaded.scenes[0].type).toBe('quiz');
  const content: any = loaded.scenes[0].content;
  expect(content.questions[0].answer).toEqual(['B']);
  expect(content.questions[0].options[0].image.src).toMatch(/^blob:/);
  expect(content.questions[0].referenceAnswer).toBe('Two');
  loaded.dispose();
});
