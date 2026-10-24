import { describe, expect, it } from "vitest";
import { COURSEWARE_CONTRACT_VERSION, type CoursewareProject } from "@pi-desktop/shared";
import { candidateHash } from "./page-candidate-baseline.js";
import { generateNarrationWrite } from "./narration-write.js";

describe("page narration source", () => {
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
