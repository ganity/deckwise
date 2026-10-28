import { describe, expect, it } from "vitest";
import { COURSEWARE_CONTRACT_VERSION, type CoursewareProject } from "@pi-desktop/shared";
import { candidateHash } from "./page-candidate-baseline.js";
import { generateNarrationWrite } from "./narration-write.js";

describe("page narration source", () => {
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
    expect(result.write.actions[1].attention).toEqual({ type: "highlight", objectIds: ["square"] });
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
      expect(prompt).toContain("Allowed block types: speech and wait.");
      expect(prompt).not.toContain('"type":"praise"');
      expect(prompt).toContain("Do not emit english_phrase or praise blocks.");
    }
    expect(prompts[2]).toContain("Allowed block types: speech, english_phrase, wait and praise.");
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
