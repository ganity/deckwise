import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { COURSEWARE_CONTRACT_VERSION, type CoursewareProject } from "@pi-desktop/shared";
import { candidateHash } from "./page-candidate-baseline.js";
import { generateNarrationWrite } from "./narration-write.js";
import { pageNarrationOutputSchema, sceneSpeechTarget } from "./page-narration-candidate.js";

describe("page narration source", () => {
  it.each(["plain", "import", "scene"] as const)("keeps a named portrait eligible beside a full sentence carrier in %s", async taskType => {
    const project: CoursewareProject = { schemaVersion: COURSEWARE_CONTRACT_VERSION, projectId: "project", taskType, title: "Family",
      source: { revision: "R1", sha256: candidateHash("pptx") }, teachingRevision: "T1",
      pages: [{ pageId: "page", locked: false, reviewState: "review", actions: [] }] };
    const baseline = { projectId: "project", documentId: "doc", pageId: "page", sourceRevision: "R1", sourceHash: project.source.sha256,
      teachingRevision: "T1", contentHash: candidateHash("This is my grandmother."), clean: true, readOnly: false, manualLocked: false };
    const objects = [
      { objectId: "portrait", kind: "image", text: "", bbox: [0, 0, 100, 100], aliases: ["grandmother", "奶奶"] },
      { objectId: "word", kind: "text", text: "grandmother", bbox: [0, 100, 100, 20] },
      { objectId: "sentence", kind: "text", text: "This is my grandmother.", bbox: [0, 120, 300, 20] },
      { objectId: "other", kind: "image", text: "", bbox: [200, 0, 100, 100], aliases: ["grandfather", "爷爷"] },
    ];
    const input = { project, pageId: "page", baseline, pageText: "This is my grandmother.", instruction: "Model the family expression",
      evidence: { notes: "", visualSummary: "Grandmother and grandfather", objects }, getCurrentBaseline: async () => baseline };
    const generate = (objectIds: string[]) => async () => ({ blocks: [
      { type: "speech", text: "This is my grandmother.", attention: { type: "spotlight", objectIds } },
    ] });
    const result = await generateNarrationWrite({ ...input, generate: generate(["portrait"]) });
    expect(result.write.actions[0].attention).toMatchObject({ objectIds: ["portrait"] });
    await expect(generateNarrationWrite({ ...input, generate: generate(["other"]) })).rejects.toThrow(/do not match this speech/);
    expect(sceneSpeechTarget("This is my grandmother.", objects)?.objectId).toBe("portrait");
    expect(sceneSpeechTarget("看这位 grandmother。", objects)?.objectId).toBe("portrait");
  });
  it.each(["plain", "import", "scene"] as const)("rejects a %s card backplate mixed into word animations before saving or TTS", async taskType => {
    const project: CoursewareProject = { schemaVersion: COURSEWARE_CONTRACT_VERSION, projectId: "project", taskType, title: "字词闯关",
      source: { revision: "R1", sha256: candidateHash("pptx") }, teachingRevision: "T1",
      pages: [{ pageId: "page", locked: false, reviewState: "review", actions: [] }] };
    const baseline = { projectId: "project", documentId: "doc", pageId: "page", sourceRevision: "R1", sourceHash: project.source.sha256,
      teachingRevision: "T1", contentHash: candidateHash("痒痒 麻烦"), clean: true, readOnly: false, manualLocked: false };
    const input = { project, pageId: "page", baseline, pageText: "痒痒 麻烦", instruction: "Explain the words",
      evidence: { notes: "", visualSummary: "Words on a white card", objects: [
        { objectId: "card", kind: "shape", text: "", bbox: [0, 0, 300, 300], role: "Word card", aliases: ["痒痒", "麻烦"] },
        { objectId: "word-1", kind: "text", text: "痒痒", bbox: [20, 50, 70, 30] },
        { objectId: "word-2", kind: "text", text: "麻烦", bbox: [120, 50, 70, 30] },
      ] }, getCurrentBaseline: async () => baseline };
    await expect(generateNarrationWrite({ ...input, generate: async () => ({ blocks: [
        { type: "speech", text: "请读痒痒、麻烦。", attention: { type: "highlight", objectIds: ["card", "word-1", "word-2"], animation: "fadeIn" } },
      ] }) })).rejects.toThrow(/card.*container|container.*card/u);
    expect(project.pages[0].actions).toEqual([]);
    for (const objectIds of [["word-2"], ["word-1", "word-2"]]) {
      await expect(generateNarrationWrite({ ...input, generate: async () => ({ blocks: [
        { type: "speech", text: "请读痒痒。", attention: { type: "highlight", objectIds, animation: "fadeIn" } },
      ] }) })).rejects.toThrow(/do not match this speech.*word-2/u);
    }
    const corrected = await generateNarrationWrite({ ...input, generate: async () => ({ blocks: [
      { type: "speech", text: "请读痒痒、麻烦。", attention: { type: "highlight", objectIds: ["word-1", "word-2"], animation: "fadeIn" } },
    ] }) });
    expect(corrected.write.actions[0].attention).toMatchObject({ objectIds: ["word-1", "word-2"], animation: "fadeIn" });
  });
  it("never lets a backplate's longer alias hide its independent text targets", () => {
    const objects = [
      { objectId: "card", kind: "shape", text: "", bbox: [0, 0, 300, 300], aliases: ["请读痒痒、麻烦"] },
      { objectId: "word-1", kind: "text", text: "痒痒", bbox: [20, 50, 70, 30] },
      { objectId: "word-2", kind: "text", text: "麻烦", bbox: [120, 50, 70, 30] },
    ];
    expect(sceneSpeechTarget("请读痒痒、麻烦。", objects)).toBeUndefined();
    expect(sceneSpeechTarget("请读痒痒、麻烦。", objects, "word-1")?.objectId).toBe("word-1");
    expect(sceneSpeechTarget("请读痒痒。", objects)?.objectId).toBe("word-1");
    const circle = { objectId: "circle", kind: "shape", text: "", bbox: [400, 0, 100, 100], aliases: ["圆形"] };
    expect(sceneSpeechTarget("看这个圆形。", [...objects, circle])?.objectId).toBe("circle");
  });
  it("advertises the same fixed-wait limit that saved speech accepts", () => {
    const blocks = [{ type: "speech", text: "Listen." }, { type: "wait", durationMs: 30000 }];
    expect(pageNarrationOutputSchema.safeParse({ blocks }).success).toBe(true);
    expect(pageNarrationOutputSchema.safeParse({ blocks: [blocks[0], { type: "wait", durationMs: 30001 }] }).success).toBe(false);
  });

  it("keeps body-lecture prompts consistent with independent assessment validation and retained music", async () => {
    const project: CoursewareProject = { schemaVersion: COURSEWARE_CONTRACT_VERSION, projectId: "project", taskType: "scene", title: "Lesson",
      source: { revision: "R1", sha256: candidateHash("pptx") }, teachingRevision: "T1",
      pages: [{ pageId: "page", locked: false, reviewState: "review", actions: [
        { id: "music", type: "audio_clip", audioAssetId: `music-${"a".repeat(64)}` },
      ] }] };
    const baseline = { projectId: "project", documentId: "doc", pageId: "page", sourceRevision: "R1", sourceHash: project.source.sha256,
      teachingRevision: "T1", contentHash: candidateHash(""), clean: true, readOnly: false, manualLocked: false };
    const result = await generateNarrationWrite({ project, pageId: "page", baseline, pageText: "", instruction: "Keep the lesson's music",
      independentAssessmentPages: true, coursePlan: { teaching: { pageType: "slide", phase: "practice", objective: "Listen", durationSeconds: 30, requiredObjects: [] } },
      getCurrentBaseline: async () => baseline, generate: async ({ system }) => {
        expect(system).not.toContain("emit an interaction block");
        expect(system).toContain("separate assessment pages");
        return { blocks: [{ type: "speech", text: "Listen." }, { type: "music", title: "Song", prompt: "Retained song" }] };
      } });
    expect(result.write.actions.find(action => action.type === "music_slot")?.id).toBe("music");
    expect(project.pages[0].actions[0].audioAssetId).toBe(`music-${"a".repeat(64)}`);
  });

  it("repairs missing approved actions without a speech round trip and is idempotent", async () => {
    const speech = { id: "speech", type: "speech", text: "Hello. ", source: "original", pauseAfterMs: 1000,
      audioAssetId: "tts-" + "b".repeat(64), visualCues: [] };
    const project: CoursewareProject = { schemaVersion: COURSEWARE_CONTRACT_VERSION, projectId: "project", taskType: "scene", title: "Greeting",
      source: { revision: "R1", sha256: candidateHash("pptx") }, teachingRevision: "T1",
      pages: [{ pageId: "page", locked: false, reviewState: "review", actions: [speech] }] };
    const baseline = { projectId: "project", documentId: "doc", pageId: "page", sourceRevision: "R1", sourceHash: project.source.sha256,
      teachingRevision: "T1", contentHash: candidateHash(""), clean: true, readOnly: false, manualLocked: false };
    const question = { text: "Which greeting?", response: { kind: "single", options: ["Hello", "Bye"], answerIndices: [0] } };
    let calls = 0;
    const input = { project, pageId: "page", baseline, pageText: "", instruction: "Repair requirements", repairRequiredTeaching: true,
      coursePlan: { teaching: { pageType: "quiz", phase: "practice", objective: "Greet", durationSeconds: 30, requiredObjects: [],
        question, video: { purpose: "Show a wave", prompt: "A silent wave" } } },
      getCurrentBaseline: async () => baseline, generate: async ({ data }: { data: string }) => {
        calls++;
        expect(JSON.parse(data).speechAnchors).toEqual(["speech"]);
        return { insertions: [
          { afterSpeechId: "speech", block: { type: "interaction", question: question.text, response: question.response,
            referenceAnswer: { summary: "Hello", keyPoints: ["Hello is a greeting"] } } },
          { afterSpeechId: "speech", block: { type: "video", prompt: "A silent wave" } },
        ] };
      } };
    const result = await generateNarrationWrite(input);
    expect(result.write.actions[0]).toEqual(speech);
    expect(result.write.actions.map(a => a.type)).toEqual(["speech", "interaction_checkpoint", "video_slot"]);
    project.pages[0].actions = result.write.actions;
    const repeated = await generateNarrationWrite(input);
    expect(repeated.write.actions).toEqual(result.write.actions);
    expect(calls).toBe(1);
  });
  it.each(["plain", "import", "scene"] as const)("keeps a complete teaching move together on the same target in %s narration", async taskType => {
    const project: CoursewareProject = { schemaVersion: COURSEWARE_CONTRACT_VERSION, projectId: "project", taskType, title: "Lesson",
      source: { revision: "R1", sha256: candidateHash("pptx") }, teachingRevision: "T1",
      pages: [{ pageId: "page", locked: false, reviewState: "review", actions: [] }] };
    const baseline = { projectId: "project", documentId: "doc", pageId: "page", sourceRevision: "R1", sourceHash: project.source.sha256,
      teachingRevision: "T1", contentHash: candidateHash(""), clean: true, readOnly: false, manualLocked: false };
    const sentences = ["小猫向大家挥手。", "小猫说：Hello! ", "小猫有 1.5 米高。", "Let's say hello. ", "Are you ready?"];
    const { write } = await generateNarrationWrite({ project, pageId: "page", baseline, pageText: "", instruction: "Explain",
      evidence: { notes: "", visualSummary: "A cat", objects: [{ objectId: "cat", kind: "image", text: "", bbox: [0, 0, 100, 100], aliases: ["小猫"] }] },
      getCurrentBaseline: async () => baseline, generate: async () => ({ blocks: [
        { type: "speech", text: sentences.join(""), attention: { type: "spotlight", objectIds: ["cat"], animation: "fadeIn" } },
        { type: "wait", durationMs: 1000 }, { type: "wait", mode: "teacher_continue" },
      ] }) });
    const speech = write.actions.filter(a => a.type === "speech");
    expect(speech.map(a => a.text)).toEqual([sentences.join("")]);
    expect(speech.every(a => (a.attention as { objectIds: string[] }).objectIds[0] === "cat")).toBe(true);
    expect(speech.filter(a => (a.attention as { animation?: string }).animation === "fadeIn")).toHaveLength(1);
    expect(speech.at(-1)?.pauseAfterMs).toBe(1000);
    expect(speech.slice(0, -1).every(a => a.pauseAfterMs === undefined)).toBe(true);
    expect(write.actions.at(-1)).toMatchObject({ type: "interaction_checkpoint", checkpointKind: "teacher_continue" });
  });
  it("creates a video slot at its lesson position and preserves existing video on regeneration", async () => {
    const project: CoursewareProject = { schemaVersion: COURSEWARE_CONTRACT_VERSION, projectId: "project", taskType: "scene", title: "Shapes",
      source: { revision: "R1", sha256: candidateHash("pptx") }, teachingRevision: "T1",
      pages: [{ pageId: "page-1", locked: false, reviewState: "review", actions: [] }] };
    const baseline = { projectId: "project", documentId: "doc", pageId: "page-1", sourceRevision: "R1", sourceHash: project.source.sha256,
      teachingRevision: "T1", contentHash: candidateHash("A square"), clean: true, readOnly: false, manualLocked: false };
    const input = { project, pageId: "page-1", baseline, pageText: "A square", instruction: "Show the approved five-second demonstration",
      getCurrentBaseline: async () => baseline, generate: async () => ({ blocks: [
        { type: "speech", text: "Watch the square turn." }, { type: "video", prompt: "A silent five-second square rotation" },
        { type: "speech", text: "Its sides stay equal." },
      ] }) };
    const result = await generateNarrationWrite(input);
    expect(result.write.actions.map(a => a.type)).toEqual(["speech", "video_slot", "speech"]);
    expect(result.write.actions[1].prompt).toBe("A silent five-second square rotation");
    for (const existing of [result.write.actions[1], { id: "clip", type: "video_clip", videoAssetId: "video-" + "a".repeat(64) }]) {
      project.pages[0].actions = [existing];
      const regenerated = await generateNarrationWrite(input);
      expect(regenerated.write.actions.map(a => a.type)).toEqual(["speech", "speech"]);
      expect(project.pages[0].actions).toEqual([existing]);
    }
  });
  it.each(["kindergarten", "primary"])("writes a real question checkpoint and can regenerate it for %s", async schoolStage => {
    const project: CoursewareProject = { schemaVersion: COURSEWARE_CONTRACT_VERSION, projectId: "project", taskType: "scene", title: "Shapes",
      source: { revision: "R1", sha256: candidateHash("pptx") }, teachingRevision: "T1", educationContext: { schoolStage, subject: "math" },
      pages: [{ pageId: "page-1", locked: false, reviewState: "review", actions: [] }] };
    const baseline = { projectId: "project", documentId: "doc", pageId: "page-1", sourceRevision: "R1", sourceHash: project.source.sha256,
      teachingRevision: "T1", contentHash: candidateHash("A square"), clean: true, readOnly: false, manualLocked: false };
    const input = { project, pageId: "page-1", baseline, pageText: "A square", instruction: "Compare its sides",
      getCurrentBaseline: async () => baseline, generate: async () => ({ blocks: [
        { type: "speech", text: "Look at the square and compare its sides." },
        { type: "interaction", question: "What do you notice about the four sides?", referenceAnswer: { summary: "All four sides are equal.", keyPoints: ["Four equal sides"] } },
        { type: "speech", text: "Let's compare each side together." },
      ] }) };
    const { write } = await generateNarrationWrite(input);
    expect(write.actions[1]).toMatchObject({ type: "interaction_checkpoint", checkpointKind: "chapter_summary", chapterId: "page-1",
      question: "What do you notice about the four sides?", referenceAnswer: { summary: "All four sides are equal.", keyPoints: ["Four equal sides"] },
      context: { sourceSceneIds: ["page-1"] } });
    expect(write.actions.filter(a => a.type === "speech")).toHaveLength(2);
    project.pages[0].actions = write.actions;
    await expect(generateNarrationWrite(input)).resolves.toMatchObject({ write: { actions: expect.any(Array) } });
  });
  it.each(["kindergarten", "primary"])("keeps scene teaching motion and participation for %s", async schoolStage => {
    const project: CoursewareProject = { schemaVersion: COURSEWARE_CONTRACT_VERSION, projectId: "project", taskType: "scene", title: "Lesson",
      source: { revision: "R1", sha256: candidateHash("pptx") }, teachingRevision: "T1", educationContext: { schoolStage, subject: "math" },
      pages: [{ pageId: "page-1", locked: false, reviewState: "review", actions: [] }] };
    const baseline = { projectId: "project", documentId: "doc", pageId: "page-1", sourceRevision: "R1", sourceHash: project.source.sha256,
      teachingRevision: "T1", contentHash: candidateHash(""), clean: true, readOnly: false, manualLocked: false };
    const result = await generateNarrationWrite({ project, pageId: "page-1", baseline, pageText: "", instruction: "Explain and let students compare",
      evidence: { notes: "", visualSummary: "A square", objects: [{ objectId: "square", kind: "image", text: "", bbox: [0,0,100,100] }] },
      getCurrentBaseline: async () => baseline, generate: async ({ system }) => {
        expect(system).toContain("Scene mode");
        return { blocks: [{ type: "speech", text: "Look at this square.", attention: { type: "spotlight", objectIds: ["square"], animation: "fadeIn" } },
          { type: "speech", text: "Compare its sides.", attention: { type: "highlight", objectIds: ["square"], animation: "pulse" } },
          { type: "wait", mode: "teacher_continue" }] };
      } });
    expect(result.write.actions[0]).toMatchObject({ attention: { animation: "fadeIn", objectIds: ["square"] } });
    expect(result.write.actions[1].attention).toEqual({ type: "highlight", objectIds: ["square"], animation: "pulse" });
    expect(result.write.actions[2]).toMatchObject({ type: "interaction_checkpoint", checkpointKind: "teacher_continue" });
  });
  it("splits long speech without dropping text, duplicating entrances or moving the final pause", async () => {
    const project: CoursewareProject = { schemaVersion: COURSEWARE_CONTRACT_VERSION, projectId: "project", taskType: "scene", title: "Lesson",
      source: { revision: "R1", sha256: candidateHash("pptx") }, teachingRevision: "T1",
      pages: [{ pageId: "page-1", locked: false, reviewState: "review", actions: [] }] };
    const baseline = { projectId: "project", documentId: "doc", pageId: "page-1", sourceRevision: "R1", sourceHash: project.source.sha256,
      teachingRevision: "T1", contentHash: candidateHash(""), clean: true, readOnly: false, manualLocked: false };
    for (const text of ["Sentence. ".repeat(700).trim(), "x".repeat(3999) + "😀" + "y".repeat(500), "z".repeat(8000)]) {
      const { write } = await generateNarrationWrite({ project, pageId: "page-1", baseline, pageText: "", instruction: "Explain",
        evidence: { notes: "", visualSummary: "A square", objects: [{ objectId: "square", kind: "image", text: "", bbox: [0,0,100,100] }] },
        getCurrentBaseline: async () => baseline, generate: async () => ({ blocks: [
          { type: "speech", text, attention: { type: "spotlight", objectIds: ["square"], animation: "fadeIn" } },
          { type: "wait", durationMs: 1500 },
        ] }) });
      expect(write.actions.map(a => a.text).join("")).toBe(text);
      expect(write.actions.every(a => typeof a.text === "string" && a.text.length <= 4000 && Buffer.from(a.text).toString() === a.text)).toBe(true);
      expect(write.actions.filter(a => (a.attention as { animation?: string }).animation)).toHaveLength(1);
      expect(write.actions.at(-1)?.pauseAfterMs).toBe(1500);
      expect(write.actions[0].pauseAfterMs).toBeUndefined();
    }
  });
  it("binds automatic attention to supplied objects and defers timing to decoded audio", async () => {
    const project: CoursewareProject = { schemaVersion: COURSEWARE_CONTRACT_VERSION, projectId: "project", taskType: "import", title: "Lesson",
      source: { revision: "R1", sha256: candidateHash("pptx") }, teachingRevision: "T1",
      pages: [{ pageId: "page-1", locked: false, reviewState: "review", actions: [] }] };
    const baseline = { projectId: "project", documentId: "document", pageId: "page-1", sourceRevision: "R1", sourceHash: project.source.sha256,
      teachingRevision: "T1", contentHash: candidateHash(""), clean: true, readOnly: false, manualLocked: false };
    const input = { project, pageId: "page-1", baseline, pageText: "", instruction: "Explain the picture",
      evidence: { notes: "Compare shadows", visualSummary: "Two children and their shadows", objects: [{ objectId: "object-1", kind: "image", text: "", bbox: [0, 0, 100, 100] }] },
      getCurrentBaseline: async () => baseline };
    const result = await generateNarrationWrite({ ...input, generate: async () => ({ blocks: [{ type: "speech", text: "Look at the shadow.", attention: { type: "spotlight", objectIds: ["object-1"] } }] }) });
    expect(result.write.actions[0]).toMatchObject({ attention: { type: "spotlight", objectIds: ["object-1"] } });
    expect(result.write.actions[0]).not.toHaveProperty("visualCues");
    await expect(generateNarrationWrite({ ...input, generate: async () => ({ blocks: [{ type: "speech", text: "Look.", attention: { type: "highlight", objectIds: ["invented"] } }] }) })).rejects.toThrow("attention target");
  });
  it.each(["plain", "import", "scene"] as const)("regenerates %s narration beside retained music and teacher continuation", async (taskType) => {
    const project: CoursewareProject = {
      schemaVersion: COURSEWARE_CONTRACT_VERSION, projectId: "project", taskType, title: "Lesson",
      source: { revision: "R1", sha256: candidateHash("pptx") }, teachingRevision: "T2",
      pages: [{ pageId: "page-1", locked: false, reviewState: "review", actions: [
        { id: "speech-1", type: "speech", text: "Original explanation", audioAssetId: "tts-old" },
        { id: "continue-1", type: "interaction_checkpoint", checkpointId: "continue-1", checkpointKind: "teacher_continue" },
        { id: "speech-2", type: "speech", text: "Continue after the teacher", pauseAfterMs: 1000 },
        { id: "music-1", type: "audio_clip", audioAssetId: `music-${"a".repeat(64)}` },
      ] }],
    };
    const baseline = { projectId: "project", documentId: "document", pageId: "page-1", sourceRevision: "R1",
      sourceHash: project.source.sha256, teachingRevision: "T2", contentHash: candidateHash("Slide text"),
      clean: true, readOnly: false, manualLocked: false };
    const before = structuredClone(project);
    const result = await generateNarrationWrite({ project, pageId: "page-1", baseline, pageText: "Slide text",
      instruction: "Rewrite and retain teacher continuation", getCurrentBaseline: async () => baseline,
      generate: async ({ data }) => {
        expect(JSON.parse(data).existingNarration).toBe("Original explanation\nContinue after the teacher");
        expect(data).not.toContain("continue-1");
        expect(data).not.toContain("music-1");
        return { blocks: [{ type: "speech", text: "New question" }, { type: "wait", mode: "teacher_continue" }, { type: "speech", text: "New follow-up" }] };
      } });
    expect(result.write.actions.map((action) => action.type)).toEqual(["speech", "interaction_checkpoint", "speech"]);
    expect(result.write.actions[1]).toMatchObject({ checkpointKind: "teacher_continue", checkpointId: result.write.actions[1].id });
    expect(result.write.actions.every((action) => !Object.hasOwn(action, "audioAssetId"))).toBe(true);
    expect(project).toEqual(before);
    for (const invalid of [
      { checkpointKind: "quiz" }, { checkpointId: "" }, { checkpointId: "not a bounded id" },
      { text: "Do not read this" }, { audioAssetId: "checkpoint-audio" }, { visualCues: [] },
    ]) {
      project.pages[0].actions[1] = { ...before.pages[0].actions[1], ...invalid };
      let called = false;
      await expect(generateNarrationWrite({ project, pageId: "page-1", baseline, pageText: "Slide text",
        instruction: "Rewrite", getCurrentBaseline: async () => baseline,
        generate: async () => { called = true; return { blocks: [{ type: "speech", text: "Unexpected" }] }; },
      })).rejects.toThrow("Unsupported or locked teaching");
      expect(called).toBe(false);
    }
    project.pages[0].actions[1] = structuredClone(before.pages[0].actions[1]);
    for (const invalid of [{ id: "" }, { audioAssetId: "tts-other" }, { audioUrl: "https://untrusted.invalid/audio" }, { text: "music is not narration" }]) {
      project.pages[0].actions[3] = { ...before.pages[0].actions[3], ...invalid };
      let called = false;
      await expect(generateNarrationWrite({ project, pageId: "page-1", baseline, pageText: "Slide text",
        instruction: "Rewrite", getCurrentBaseline: async () => baseline,
        generate: async () => { called = true; return { blocks: [{ type: "speech", text: "Unexpected" }] }; },
      })).rejects.toThrow("Unsupported or locked teaching");
      expect(called).toBe(false);
    }
  });

  it("proposes new narration after audio adoption without reusing stale audio or changing the source", async () => {
    const project: CoursewareProject = {
      schemaVersion: COURSEWARE_CONTRACT_VERSION, projectId: "project", taskType: "plain", title: "Lesson",
      source: { revision: "R1", sha256: candidateHash("pptx") }, teachingRevision: "T2",
      pages: [{ pageId: "page-1", locked: false, reviewState: "ready", actions: [
        { id: "speech-1", type: "speech", text: "Original explanation", audioAssetId: "tts-old" },
      ] }],
    };
    const baseline = { projectId: "project", documentId: "document", pageId: "page-1", sourceRevision: "R1",
      sourceHash: project.source.sha256, teachingRevision: "T2", contentHash: candidateHash("Slide text"),
      clean: true, readOnly: false, manualLocked: false };
    const before = structuredClone(project);
    const input = { project, pageId: "page-1", baseline, pageText: "Slide text", instruction: "Rewrite",
      getCurrentBaseline: async () => baseline,
      generate: async () => ({ blocks: [{ type: "speech", text: "New explanation" }] }) };
    const result = await generateNarrationWrite(input);
    expect(result.write.actions).toEqual([{ id: expect.any(String), type: "speech", text: "New explanation" }]);
    expect(project).toEqual(before);
    project.pages[0].locked = true;
    await expect(generateNarrationWrite(input)).rejects.toThrow("Unsupported or locked teaching");
    project.pages[0].locked = false;
    project.pages[0].actions[0].visualCues = [{ id: "highlight" }];
    await expect(generateNarrationWrite(input)).rejects.toThrow("Unsupported or locked teaching");
  });
  it("bounds praise and English phrase blocks and keeps English phrases kindergarten-English only", async () => {
    const project: CoursewareProject = {
      schemaVersion: COURSEWARE_CONTRACT_VERSION, projectId: "project", taskType: "plain", title: "Lesson",
      source: { revision: "R1", sha256: candidateHash("pptx") }, teachingRevision: "T1",
      educationContext: { schoolStage: "KINDERGARTEN", subject: "ENGLISH" },
      pages: [{ pageId: "page-1", locked: false, reviewState: "review", actions: [] }],
    };
    const baseline = { projectId: "project", documentId: "document", pageId: "page-1", sourceRevision: "R1", sourceHash: project.source.sha256,
      teachingRevision: "T1", contentHash: candidateHash("Slide text"), clean: true, readOnly: false, manualLocked: false };
    const call = (blocks: unknown[]) => generateNarrationWrite({ project, pageId: "page-1", baseline,
      pageText: "Slide text", instruction: "Rewrite", getCurrentBaseline: async () => baseline, generate: async () => ({ blocks }) });
    const valid = await call([{ type: "speech", text: "Hello." }, { type: "english_phrase", text: "Good job!" }, { type: "english_phrase", text: "Good!" }, { type: "praise", text: "Thank you for trying." }]);
    expect(valid.write.actions).toHaveLength(4);
    await expect(call([{ type: "speech", text: "Hello." }, { type: "praise", text: "Thank you for trying." }, { type: "praise", text: "Thank you for joining in." }])).rejects.toThrow();
    const nonEnglishProject = { ...project, educationContext: undefined };
    await expect(generateNarrationWrite({ project: nonEnglishProject, pageId: "page-1", baseline, pageText: "Slide text", instruction: "Rewrite",
      getCurrentBaseline: async () => baseline, generate: async () => ({ blocks: [{ type: "speech", text: "Hello." }, { type: "english_phrase", text: "Good!" }] }) })).rejects.toThrow("only allowed for kindergarten English");
    await expect(generateNarrationWrite({ project: nonEnglishProject, pageId: "page-1", baseline, pageText: "Slide text", instruction: "Rewrite",
      getCurrentBaseline: async () => baseline, generate: async () => ({ blocks: [{ type: "speech", text: "Hello." }, { type: "praise", text: "Thank you for trying." }] }) })).rejects.toThrow("only allowed for kindergarten English");
    await expect(call([{ type: "speech", text: "Hello." }, { type: "english_phrase", text: "You are the smartest child ever!" }])).rejects.toThrow("command bank");
  });
  it("selects the kindergarten English command bank only for that stage and subject", async () => {
    const project: CoursewareProject = {
      schemaVersion: COURSEWARE_CONTRACT_VERSION, projectId: "project", taskType: "plain", title: "Lesson",
      source: { revision: "R1", sha256: candidateHash("pptx") }, teachingRevision: "T1",
      educationContext: { schoolStage: "KINDERGARTEN", subject: "MATH" },
      pages: [{ pageId: "page-1", locked: false, reviewState: "review", actions: [] }],
    };
    const baseline = { projectId: "project", documentId: "document", pageId: "page-1", sourceRevision: "R1", sourceHash: project.source.sha256,
      teachingRevision: "T1", contentHash: candidateHash("Slide text"), clean: true, readOnly: false, manualLocked: false };
    const prompts: string[] = [];
    const generate = async ({ system }: { system: string }) => { prompts.push(system); return { blocks: [{ type: "speech", text: "小朋友，我们来数一数。" }] }; };
    await generateNarrationWrite({ project, pageId: "page-1", baseline, pageText: "Slide text", instruction: "Rewrite", getCurrentBaseline: async () => baseline, generate });
    const ordinaryProject = { ...project, educationContext: undefined };
    await generateNarrationWrite({ project: ordinaryProject, pageId: "page-1", baseline, pageText: "Slide text", instruction: "Rewrite", getCurrentBaseline: async () => baseline, generate });
    const englishProject = { ...project, educationContext: { schoolStage: "KINDERGARTEN", subject: "ENGLISH" } };
    await generateNarrationWrite({ project: englishProject, pageId: "page-1", baseline, pageText: "Slide text", instruction: "Rewrite", getCurrentBaseline: async () => baseline, generate: async ({ system }) => {
      prompts.push(system);
      return { blocks: [{ type: "speech", text: "小朋友，我们一起数一数。" }, { type: "english_phrase", text: "Good!" }] };
    } });
    expect(prompts[0]).toContain("Audience stage [KINDERGARTEN]");
    expect(prompts[0]).not.toContain("Kindergarten English classroom command policy");
    expect(prompts[1]).not.toContain("Kindergarten English classroom command policy");
    expect(prompts[2]).toContain("Kindergarten English classroom command policy");
    expect(prompts[2]).toContain("Good!");
    for (const prompt of prompts.slice(0, 2)) {
      expect(prompt).toContain("For spoken teaching use speech blocks.");
      expect(prompt).not.toContain('"type":"praise"');
      expect(prompt).toContain("Do not emit english_phrase or praise blocks.");
    }
    expect(prompts[2]).toContain("Only fixed classroom commands from the kindergarten command bank use english_phrase");
    expect(prompts[2]).toContain("Thank you for trying.");
  });
  it("regenerates imported narration without retaining its former source", async () => {
    const project: CoursewareProject = {
      schemaVersion: COURSEWARE_CONTRACT_VERSION, projectId: "project", taskType: "import", title: "Lesson",
      source: { revision: "R1", sha256: candidateHash("pptx") }, teachingRevision: "T1",
      pages: [{ pageId: "page-1", locked: false, reviewState: "review", actions: [
        { id: "speech-1", type: "speech", text: "Original note", source: "notes" },
      ] }],
    };
    const baseline = {
      projectId: "project", documentId: "document", pageId: "page-1", sourceRevision: "R1",
      sourceHash: project.source.sha256, teachingRevision: "T1", contentHash: candidateHash("Slide text"),
      clean: true, readOnly: false, manualLocked: false,
    };
    const result = await generateNarrationWrite({ project, pageId: "page-1", baseline, pageText: "Slide text",
      instruction: "Rewrite", getCurrentBaseline: async () => baseline,
      generate: async () => ({ blocks: [{ type: "speech", text: "New explanation" }] }),
    });
    expect(result.write.actions).toMatchObject([{ type: "speech", text: "New explanation" }]);
    expect(Object.keys(result.write.actions[0])).toEqual(["id", "type", "text"]);
    expect(project.pages[0].actions[0].source).toBe("notes");
  });
});


it.each(["scene", "plain"] as const)("binds %s image aliases by teaching focus, preserves words and pauses, and repeats emphasis", async taskType => {
  const project: CoursewareProject = { schemaVersion: COURSEWARE_CONTRACT_VERSION, projectId: "project", taskType, title: "Friends",
    source: { revision: "R1", sha256: candidateHash("pptx") }, teachingRevision: "T1",
    pages: [{ pageId: "page", locked: false, reviewState: "review", actions: [] }] };
  const baseline = { projectId: "project", documentId: "doc", pageId: "page", sourceRevision: "R1", sourceHash: project.source.sha256,
    teachingRevision: "T1", contentHash: candidateHash(""), clean: true, readOnly: false, manualLocked: false };
  const objects = [
    { objectId: "monkey", kind: "image", text: "", bbox: [0,0,100,100], aliases: ["Monkey Munchy", "小猴"] },
    { objectId: "panda", kind: "image", text: "", bbox: [100,0,100,100], aliases: ["Panda Pandy", "熊猫"] },
  ];
  const text = "我们先坐好。Monkey Munchy 挥挥手！Panda Pandy 说你好。小猴再挥挥手。";
  const input = { project, pageId: "page", baseline, pageText: "", instruction: "Explain", evidence: { notes: "", visualSummary: "Two friends", objects }, getCurrentBaseline: async () => baseline };
  const { write } = await generateNarrationWrite({ ...input, generate: async () => ({ blocks: [{ type: "speech", text }, { type: "wait", durationMs: 1000 }] }) });
  expect(write.actions.map(a => a.text).join("")).toBe(text);
  expect(write.actions.map(a => a.attention)).toEqual([undefined,
    { type: "spotlight", objectIds: ["monkey"], animation: "pulse" },
    { type: "spotlight", objectIds: ["panda"], animation: "pulse" },
    { type: "spotlight", objectIds: ["monkey"], animation: "pulse" }]);
  expect(write.actions.at(-1)?.pauseAfterMs).toBe(1000);
  expect(write.actions.slice(0,-1).every(a => !a.pauseAfterMs)).toBe(true);
  const corrected = await generateNarrationWrite({ ...input, generate: async () => ({ blocks: [
    { type: "speech", text, attention: { type: "spotlight", objectIds: ["panda"], animation: "fadeIn" } },
  ] }) });
  expect(corrected.write.actions.map(a => a.attention && (a.attention as { objectIds: string[] }).objectIds[0])).toEqual([undefined, "monkey", "panda", "monkey"]);

  const quoted = await generateNarrationWrite({ ...input, generate: async () => ({ blocks: [
    { type: "speech", text: "“小猴！”。" }, { type: "wait", durationMs: 1000 },
  ] }) });
  expect(quoted.write.actions).toHaveLength(1);
  expect(quoted.write.actions[0]).toMatchObject({ text: "“小猴！”。", pauseAfterMs: 1000,
    attention: { type: "spotlight", objectIds: ["monkey"] } });

  const ambiguous = await generateNarrationWrite({ ...input,
    evidence: { ...input.evidence, objects: [...objects, { ...objects[0], objectId: "other-monkey" }] },
    generate: async () => ({ blocks: [{ type: "speech", text: "小猴在哪里？" }] }) });
  expect(ambiguous.write.actions[0].attention).toBeUndefined();
  const substring = await generateNarrationWrite({ ...input, evidence: { ...input.evidence, objects: [{ ...objects[0], aliases: ["Hi"] }] },
    generate: async () => ({ blocks: [{ type: "speech", text: "Highlight the topic." }] }) });
  expect(substring.write.actions[0].attention).toBeUndefined();

  const label = { ...objects[0], objectId: "monkey-label", text: "Monkey Munchy", aliases: ["Monkey Munchy name"] };
  for (const attention of [undefined, { type: "spotlight", objectIds: ["monkey"], animation: "pulse" }]) {
    const repeated = await generateNarrationWrite({ ...input, evidence: { ...input.evidence, objects: [...objects, label] },
      generate: async () => ({ blocks: [{ type: "speech", text: "Monkey Munchy！", ...(attention ? { attention } : {}) }] }) });
    expect(repeated.write.actions[0].attention).toMatchObject({ objectIds: ["monkey"] });
  }
});

it.each(["plain", "import", "scene"] as const)("keeps %s reading cues and their expressions on one speech clock", async taskType => {
  const project: CoursewareProject = { schemaVersion: COURSEWARE_CONTRACT_VERSION, projectId: "project", taskType, title: "Family",
    source: { revision: "R1", sha256: candidateHash("pptx") }, teachingRevision: "T1",
    pages: [{ pageId: "page", locked: false, reviewState: "review", actions: [] }] };
  const baseline = { projectId: "project", documentId: "doc", pageId: "page", sourceRevision: "R1", sourceHash: project.source.sha256,
    teachingRevision: "T1", contentHash: candidateHash(""), clean: true, readOnly: false, manualLocked: false };
  const input = { project, pageId: "page", baseline, pageText: "", instruction: "Model the exact expression, then let learners repeat",
    evidence: { notes: "", visualSummary: "A family word card", objects: [
      { objectId: "family", kind: "text", text: "This is my family!", bbox: [0,0,100,100] },
    ] }, getCurrentBaseline: async () => baseline };
  for (const attention of [undefined, { type: "highlight", objectIds: ["family"], anchorText: "This is my family!" }]) {
    const text = "先看上面这句话，跟老师说：This is my family!";
    const { write } = await generateNarrationWrite({ ...input, generate: async () => ({ blocks: [
      { type: "speech", text, ...(attention ? { attention } : {}) }, { type: "wait", durationMs: 4000 },
    ] }) });
    expect(write.actions).toEqual([expect.objectContaining({ type: "speech", text, pauseAfterMs: 4000,
      attention: { type: "highlight", objectIds: ["family"] } })]);
    expect(write.actions[0]).not.toHaveProperty("audioAssetId");
    expect(project.pages[0].actions).toEqual([]);
  }
  const text = "跟着老师说：";
  const expression = "This is my family!";
  const { write } = await generateNarrationWrite({ ...input, generate: async () => ({ blocks: [
    { type: "speech", text }, { type: "speech", text: expression, attention: { type: "highlight", objectIds: ["family"] } },
    { type: "wait", durationMs: 4000 },
  ] }) });
  expect(write.actions).toEqual([expect.objectContaining({ text: text + expression, pauseAfterMs: 4000,
    attention: { type: "highlight", objectIds: ["family"] } })]);
  await expect(generateNarrationWrite({ ...input, generate: async () => ({ blocks: [
    { type: "speech", text }, { type: "wait", durationMs: 4000 }, { type: "speech", text: expression },
  ] }) })).rejects.toMatchObject({ code: "INVALID_OUTPUT", message: expect.stringContaining("Incomplete reading cue") });
  const incompatible = { ...input.evidence.objects[0], objectId: "other", text: "Another card" };
  await expect(generateNarrationWrite({ ...input, evidence: { ...input.evidence, objects: [...input.evidence.objects, incompatible] },
    generate: async () => ({ blocks: [
      { type: "speech", text, attention: { type: "highlight", objectIds: ["family"] } },
      { type: "speech", text: expression, attention: { type: "highlight", objectIds: ["other"] } },
    ] }) })).rejects.toMatchObject({ code: "INVALID_OUTPUT" });
});

it("checks source-backed spoken targets and incomplete cues before returning teaching for TTS", async () => {
  const project: CoursewareProject = { schemaVersion: COURSEWARE_CONTRACT_VERSION, projectId: "project", taskType: "plain", title: "Family",
    source: { revision: "R1", sha256: candidateHash("pptx") }, teachingRevision: "T1",
    educationContext: { schoolStage: "KINDERGARTEN", subject: "ENGLISH" },
    pages: [{ pageId: "page", locked: false, reviewState: "review", actions: [] }] };
  const baseline = { projectId: "project", documentId: "doc", pageId: "page", sourceRevision: "R1", sourceHash: project.source.sha256,
    teachingRevision: "T1", contentHash: candidateHash("father grandfather"), clean: true, readOnly: false, manualLocked: false };
  const input = { project, pageId: "page", baseline, pageText: "father grandfather", instruction: "Teach father",
    coursePlan: { page: { mustMention: ["father"] } }, getCurrentBaseline: async () => baseline };
  for (const text of ["This is my grandfather.", "跟着老师说：", "你们都答对了，father 是爸爸。"])
    await expect(generateNarrationWrite({ ...input, generate: async () => ({ blocks: [{ type: "speech", text }] }) }))
      .rejects.toMatchObject({ code: "INVALID_OUTPUT" });
  const { write } = await generateNarrationWrite({ ...input,
    generate: async () => ({ blocks: [{ type: "speech", text: "这是爸爸。听老师说：This is my father." }] }) });
  expect(write.actions.map(a => a.text).join("")).toBe("这是爸爸。听老师说：This is my father.");
  expect(project.pages[0].actions).toEqual([]);
  await expect(generateNarrationWrite({ ...input, coursePlan: { page: { mustMention: ["not on this page"] } },
    generate: async () => ({ blocks: [{ type: "speech", text: "Father means 爸爸。" }] }) })).resolves.toHaveProperty("write");
});

it("rejects incomplete required ordinary effects before saving narration and accepts grounded animation", async () => {
  const project: CoursewareProject = { schemaVersion: COURSEWARE_CONTRACT_VERSION, projectId: "project", taskType: "plain", title: "Family",
    source: { revision: "R1", sha256: candidateHash("pptx") }, teachingRevision: "T1",
    pages: [{ pageId: "page", locked: false, reviewState: "review", actions: [] }] };
  const baseline = { projectId: "project", documentId: "doc", pageId: "page", sourceRevision: "R1", sourceHash: project.source.sha256,
    teachingRevision: "T1", contentHash: candidateHash("father"), clean: true, readOnly: false, manualLocked: false };
  const input = { project, pageId: "page", baseline, pageText: "father", instruction: "Explain with animation", getCurrentBaseline: async () => baseline,
    coursePlan: { teaching: { pageType: "slide", phase: "explore", objective: "Name father", durationSeconds: 30, requiredObjects: ["father"], requiredEffects: ["animation"] } },
    evidence: { notes: "father", visualSummary: "A text label", objects: [{ objectId: "label", kind: "text", text: "father", bbox: [0, 0, 100, 100] }] } };
  await expect(generateNarrationWrite({ ...input, generate: async () => ({ blocks: [{ type: "speech", text: "father" }] }) }))
    .rejects.toThrow("Missing required teaching effects: animation");
  const result = await generateNarrationWrite({ ...input, generate: async () => ({ blocks: [{ type: "speech", text: "father",
    attention: { type: "highlight", objectIds: ["label"], animation: "pulse" } }] }) });
  expect(result.write.actions[0].attention).toMatchObject({ objectIds: ["label"], animation: "pulse" });
});

it("starts an explicit focus at its verified quote and never invents timing or replays an entrance", async () => {
  const project: CoursewareProject = { schemaVersion: COURSEWARE_CONTRACT_VERSION, projectId: "project", taskType: "scene", title: "Friends",
    source: { revision: "R1", sha256: candidateHash("pptx") }, teachingRevision: "T1",
    pages: [{ pageId: "page", locked: false, reviewState: "review", actions: [] }] };
  const baseline = { projectId: "project", documentId: "doc", pageId: "page", sourceRevision: "R1", sourceHash: project.source.sha256,
    teachingRevision: "T1", contentHash: candidateHash(""), clean: true, readOnly: false, manualLocked: false };
  const input = { project, pageId: "page", baseline, pageText: "", instruction: "Explain", evidence: { notes: "", visualSummary: "A monkey", objects: [
    { objectId: "monkey", kind: "image", text: "", bbox: [0,0,100,100], aliases: ["小猴"] }] }, getCurrentBaseline: async () => baseline };
  const attention = { type: "spotlight", objectIds: ["monkey"], animation: "fadeIn", anchorText: "小猴向我们招手。" };
  const { write } = await generateNarrationWrite({ ...input, generate: async () => ({ blocks: [
    { type: "speech", text: "请看这里。小猴向我们招手。", attention },
    { type: "speech", text: "小猴向我们招手。", attention },
  ] }) });
  expect(write.actions.map(a => a.text)).toEqual(["请看这里。", "小猴向我们招手。", "小猴向我们招手。"]);
  expect(write.actions.map(a => a.attention)).toEqual([undefined,
    { type: "spotlight", objectIds: ["monkey"], animation: "fadeIn" },
    { type: "spotlight", objectIds: ["monkey"], animation: "pulse" }]);
  await expect(generateNarrationWrite({ ...input, generate: async () => ({ blocks: [
    { type: "speech", text: "我们坐好。", attention },
  ] }) })).rejects.toThrow("anchor");
});

it('puts music and typed questions at their authored speech positions and reuses an adopted song identity', async () => {
  const project: CoursewareProject = { schemaVersion: COURSEWARE_CONTRACT_VERSION, projectId: 'project', taskType: 'scene', title: 'Greetings',
    source: { revision: 'R1', sha256: candidateHash('pptx') }, teachingRevision: 'T1',
    pages: [{ pageId: 'page', locked: false, reviewState: 'review', actions: [{ id: 'existing-song', type: 'audio_clip', audioAssetId: `music-${'a'.repeat(64)}` }] }] };
  const baseline = { projectId: 'project', documentId: 'doc', pageId: 'page', sourceRevision: 'R1', sourceHash: project.source.sha256,
    teachingRevision: 'T1', contentHash: candidateHash('Hello'), clean: true, readOnly: false, manualLocked: false };
  for (const kind of ['single', 'multiple', 'judge', 'short_answer', 'discussion', 'practice', 'pbl']) {
    const choice = ['single', 'multiple', 'judge'].includes(kind);
    const response = { kind, options: choice ? ['Hello', 'Bye'] : [], answerIndices: choice ? [0] : [] };
    const { write } = await generateNarrationWrite({ project, pageId: 'page', baseline, pageText: 'Hello', instruction: 'Sing and discuss', getCurrentBaseline: async () => baseline,
      generate: async () => ({ blocks: [{ type: 'speech', text: 'Listen to this song.' },
        { type: 'music', title: 'Hello song', prompt: 'A greeting song' },
        { type: 'interaction', question: 'Which greeting did you hear?', response, referenceAnswer: { summary: 'Hello', keyPoints: ['Hello'] } },
        { type: 'speech', text: 'Say hello together.' }] }) });
    expect(write.actions.map(a => a.type)).toEqual(['speech', 'music_slot', 'interaction_checkpoint', 'speech']);
    expect(write.actions[1].id).toBe('existing-song');
    expect(write.actions[2].response).toEqual(response);
    expect(project.pages[0].actions[0].type).toBe('audio_clip');
  }
});


it("rejects unapproved music with actionable feedback before saving narration", async () => {
  const project: CoursewareProject = { schemaVersion: COURSEWARE_CONTRACT_VERSION, projectId: "project", taskType: "scene", title: "Greetings",
    source: { revision: "R1", sha256: candidateHash("pptx") }, teachingRevision: "T1",
    pages: [{ pageId: "page", locked: false, reviewState: "review", actions: [] }] };
  const baseline = { projectId: "project", documentId: "doc", pageId: "page", sourceRevision: "R1", sourceHash: project.source.sha256,
    teachingRevision: "T1", contentHash: candidateHash(""), clean: true, readOnly: false, manualLocked: false };
  const input = { project, pageId: "page", baseline, pageText: "", instruction: "Explain", getCurrentBaseline: async () => baseline,
    coursePlan: { teaching: { pageType: "slide", phase: "opening", objective: "Greet", durationSeconds: 30, requiredObjects: [] } },
    generate: async () => ({ blocks: [{ type: "speech", text: "Hello." }, { type: "music", title: "Extra song", prompt: "Sing Hello" }] }) };
  await expect(generateNarrationWrite(input)).rejects.toMatchObject({ code: "INVALID_OUTPUT", message: expect.stringContaining("not approved") });
  await expect(generateNarrationWrite({ ...input, generate: async () => ({ blocks: [{ type: "speech", text: "Hello." }] }) })).resolves.toMatchObject({ write: { actions: [expect.objectContaining({ type: "speech" })] } });
});

it.each([{ visualCues: undefined }, { visualCues: [] }])("repairs focus with saved cues=$visualCues without returning text or audio through the model", async ({ visualCues }) => {
  const speech = { id: "speech", type: "speech", text: "Monkey Munchy！", source: "generated", audioAssetId: "tts-" + "b".repeat(64), pauseAfterMs: 1000,
    ...(visualCues ? { visualCues } : {}) };
  const project: CoursewareProject = { schemaVersion: COURSEWARE_CONTRACT_VERSION, projectId: "project", taskType: "scene", title: "Greeting",
    source: { revision: "R1", sha256: candidateHash("pptx") }, teachingRevision: "T1",
    pages: [{ pageId: "page", locked: false, reviewState: "review", actions: [speech] }] };
  const baseline = { projectId: "project", documentId: "doc", pageId: "page", sourceRevision: "R1", sourceHash: project.source.sha256,
    teachingRevision: "T1", contentHash: candidateHash(""), clean: true, readOnly: false, manualLocked: false };
  const result = await generateNarrationWrite({ project, pageId: "page", baseline, pageText: "", instruction: "Repair focus", repairRequiredTeaching: true,
    evidence: { notes: "", visualSummary: "A monkey and its name label", objects: [
      { objectId: "monkey", kind: "image", text: "", aliases: ["Monkey Munchy"], bbox: [0,0,100,100] },
      { objectId: "label", kind: "image", text: "Monkey Munchy", aliases: [], bbox: [0,100,100,20] },
    ] }, coursePlan: { teaching: { pageType: "slide", phase: "explore", objective: "Greet", durationSeconds: 30, requiredObjects: ["Monkey Munchy"] } },
    getCurrentBaseline: async () => baseline, generate: async () => { throw new Error("No model needed for existing exact identities"); } });
  const { visualCues: _, ...preserved } = speech;
  expect(result.write.actions).toEqual([{ ...preserved, attention: { type: "spotlight", objectIds: ["monkey"] } }]);
  expect(project.pages[0].actions).toEqual([speech]);
});


it("adds missing highlight and animation while retaining existing spotlight and speech audio", async () => {
  const speech = { id: "speech", type: "speech", text: "Look at grandfather.", source: "generated", audioAssetId: "tts-" + "b".repeat(64),
    visualCues: [{ id: "focus-speech", atMs: 0, endMs: 1234, effect: { type: "spotlight", elementId: "portrait", elementIds: [] } }] };
  const project: CoursewareProject = { schemaVersion: COURSEWARE_CONTRACT_VERSION, projectId: "project", taskType: "plain", title: "Family",
    source: { revision: "R1", sha256: candidateHash("pptx") }, teachingRevision: "T1",
    pages: [{ pageId: "page", locked: false, reviewState: "review", actions: [speech] }] };
  const baseline = { projectId: "project", documentId: "doc", pageId: "page", sourceRevision: "R1", sourceHash: project.source.sha256,
    teachingRevision: "T1", contentHash: candidateHash(""), clean: true, readOnly: false, manualLocked: false };
  const input = { project, pageId: "page", baseline, pageText: "", instruction: "Repair required effects", repairRequiredTeaching: true,
    evidence: { notes: "", visualSummary: "Grandfather portrait and word card", objects: [
      { objectId: "portrait", kind: "image", text: "", aliases: ["grandfather"], bbox: [0,0,100,100] },
      { objectId: "word", kind: "text", text: "grandfather", bbox: [0,100,100,20] },
    ] }, coursePlan: { teaching: { pageType: "slide", phase: "explore", objective: "Name grandfather", durationSeconds: 30,
      requiredObjects: [], requiredEffects: ["spotlight", "highlight", "animation"] } },
    getCurrentBaseline: async () => baseline, generate: async () => { throw new Error("Retain existing speech and paid audio"); } };
  const result = await generateNarrationWrite(input);
  const { visualCues: _, ...preserved } = speech;
  expect(result.write.actions).toEqual([{ ...preserved, attention: { type: "highlight", objectIds: ["word"], animation: "pulse" } }]);
  expect(project.pages[0].actions).toEqual([speech]);
  await expect(generateNarrationWrite({ ...input, evidence: { ...input.evidence, objects: [] } }))
    .rejects.toMatchObject({ code: "INVALID_OUTPUT", message: expect.stringContaining("could not safely bind") });
  project.pages[0].actions = [{ ...speech, visualCues: [...speech.visualCues,
    { id: "highlight", atMs: 0, endMs: 1234, effect: { type: "highlight", elementIds: ["word"] } },
    { id: "motion", atMs: 0, endMs: 600, effect: { type: "element_animation", elementId: "word", effect: "pulse" } },
  ] }];
  expect((await generateNarrationWrite(input)).write.actions).toEqual(project.pages[0].actions);
});

it("repairs all sixteen captured page-six focus omissions with the original speech audio", async () => {
  const captured = JSON.parse(await readFile(new URL("./fixtures/greetings-focus.json", import.meta.url), "utf8"));
  const actions = captured.speeches.map((text: string, i: number) => ({ id: `speech-${i}`, type: "speech", text,
    audioAssetId: "tts-" + "b".repeat(64), source: "generated" }));
  const project: CoursewareProject = { schemaVersion: COURSEWARE_CONTRACT_VERSION, projectId: "project", taskType: "scene", title: "Greeting",
    source: { revision: "R1", sha256: candidateHash("pptx") }, teachingRevision: "T1",
    pages: [{ pageId: "page", locked: false, reviewState: "review", actions }] };
  const baseline = { projectId: "project", documentId: "doc", pageId: "page", sourceRevision: "R1", sourceHash: project.source.sha256,
    teachingRevision: "T1", contentHash: candidateHash(""), clean: true, readOnly: false, manualLocked: false };
  const result = await generateNarrationWrite({ project, pageId: "page", baseline, pageText: "", instruction: "Repair captured focus", repairRequiredTeaching: true,
    evidence: { notes: "", visualSummary: "Five characters with name labels", objects: captured.objects },
    coursePlan: { teaching: { pageType: "slide", phase: "practice", objective: "Greet", durationSeconds: 120, requiredObjects: [] } },
    getCurrentBaseline: async () => baseline, generate: async () => { throw new Error("No new narration or audio"); } });
  expect(result.write.actions).toHaveLength(16);
  for (const [i, action] of result.write.actions.entries()) {
    const { attention, ...preserved } = action;
    expect(preserved).toEqual(actions[i]);
    expect(attention).toBeDefined();
  }
});

it.each(["plain", "import", "scene"] as const)("adds focus to supplied %s speech without requiring generated teaching metadata or a speech model", async taskType => {
  const speech = { id: "original", type: "speech", text: "Circle. 1.25 cm.", source: "external", audioAssetId: "tts-" + "b".repeat(64) };
  const project: CoursewareProject = { schemaVersion: COURSEWARE_CONTRACT_VERSION, projectId: "project", taskType, title: "Shapes",
    source: { revision: "R1", sha256: candidateHash("pptx") }, teachingRevision: "T1",
    pages: [{ pageId: "page", locked: false, reviewState: "review", actions: [speech] }] };
  const baseline = { projectId: "project", documentId: "doc", pageId: "page", sourceRevision: "R1", sourceHash: project.source.sha256,
    teachingRevision: "T1", contentHash: candidateHash("Circle"), clean: true, readOnly: false, manualLocked: false };
  const result = await generateNarrationWrite({ project, pageId: "page", baseline, pageText: "Circle", instruction: "Bind existing exact words",
    repairRequiredTeaching: true, evidence: { notes: "", visualSummary: "Circle", objects: [
      { objectId: "label", kind: "text", text: "Circle", bbox: [0,0,100,30] },
    ] }, getCurrentBaseline: async () => baseline, generate: async () => { throw Error("Speech model must not run"); } });
  expect(result.write.actions[0]).toEqual({ ...speech, attention: { type: "highlight", objectIds: ["label"] } });
});
