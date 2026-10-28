import { isTeachingWrite, isCoursewareAttentionCue, isCoursewareAttentionIntent, isCoursewareInteractionCheckpoint, type CoursewareProject, type TeachingWrite } from "@pi-desktop/shared";
import { generatePageNarrationCandidate } from "./page-narration-candidate.js";

function speechParts(text: string): string[] {
  const parts: string[] = [];
  while (text.length > 4000) {
    const prefix = text.slice(0, 4000);
    const boundary = Math.max(...Array.from(prefix.matchAll(/[。！？.!?;；\n]\s*|\s+/gu), m => m.index! + m[0].length));
    let end = boundary >= 2000 ? boundary : 4000;
    if (/[\uD800-\uDBFF]/u.test(text[end - 1])) end--;
    parts.push(text.slice(0, end)); text = text.slice(end);
  }
  if (text) parts.push(text);
  return parts;
}

/** Normalize B's structured blocks at the canonical teaching boundary. */
export async function generateNarrationWrite(input: Omit<Parameters<typeof generatePageNarrationCandidate>[0], "educationContext" | "existingNarration"> & { project: CoursewareProject; pageId: string }) {
  const { project } = input;
  const page = project.pages.find((page) => page.pageId === input.pageId);
  if (!page || page.locked || page.actions.some((action) => {
    if (action.type === "video_slot") return Object.keys(action).sort().join(",") !== "id,prompt,type" || typeof action.prompt !== "string" || !action.prompt.trim() || action.prompt.length > 4000;
    if (action.type === "video_clip") return Object.keys(action).sort().join(",") !== "id,type,videoAssetId" || typeof action.videoAssetId !== "string" || !/^video-[a-f0-9]{64}$/u.test(action.videoAssetId);
    if (action.type === "audio_clip") return typeof action.id !== "string" || !/^[\w.-]{1,128}$/u.test(action.id) ||
      [".", ".."].includes(action.id) || typeof action.audioAssetId !== "string" || !/^music-[a-f0-9]{64}$/u.test(action.audioAssetId) ||
      Object.keys(action).length !== 3;
    if (action.type === "interaction_checkpoint") return !isCoursewareInteractionCheckpoint(action);
    return action.type !== "speech" || typeof action.text !== "string" ||
      (action.attention !== undefined && !isCoursewareAttentionIntent(action.attention)) ||
      (action.visualCues !== undefined && (!Array.isArray(action.visualCues) || !action.visualCues.every(isCoursewareAttentionCue))) ||
      Object.keys(action).some((key) => !["id", "type", "text", "pauseAfterMs", "source", "audioAssetId", "visualCues", "attention"].includes(key));
  })) throw new Error("Unsupported or locked teaching; retain current narration");
  const educationContext = project.educationContext ? { ...project.educationContext,
    schoolStage: project.educationContext.schoolStage?.trim().toUpperCase(), subject: project.educationContext.subject?.trim().toUpperCase() } : undefined;
  const candidate = await generatePageNarrationCandidate({ ...input, educationContext, sceneTeaching: project.taskType === "scene", existingNarration: page.actions.filter((action) => action.type === "speech").map((action) => action.text).join("\n") });
  // Host merges retained music from the baseline; the model may propose narration only.
  const actions: TeachingWrite["actions"] = [];
  const animated = new Set<string>();
  for (const block of candidate.narration.blocks) {
    if (block.type === "video") {
      if (!page.actions.some(action => action.type === "video_slot" || action.type === "video_clip"))
        actions.push({ id: `video-${candidate.candidateId}-${actions.length}`, type: "video_slot", prompt: block.prompt });
      continue;
    }
    if (block.type === "interaction") {
      const checkpointId = `question-${candidate.candidateId}-${actions.length}`;
      actions.push({ id: checkpointId, type: "interaction_checkpoint", checkpointId, checkpointKind: "chapter_summary",
        chapterId: page.pageId, chapterTitle: (input.pageText.trim() || project.title || page.pageId).slice(0, 1000),
        question: block.question, referenceAnswer: block.referenceAnswer,
        context: { chapterSummary: block.referenceAnswer.summary, sourceSceneIds: [page.pageId] } });
      continue;
    }
    if (block.type === "speech" && block.attention?.animation) {
      // The fixed player accepts one animation per object; repeated focus remains independent.
      if (block.attention.objectIds.some(id => animated.has(id))) delete block.attention.animation;
      else block.attention.objectIds.forEach(id => animated.add(id));
    }
    if (block.type === "wait") {
      if (block.mode === "teacher_continue") {
        const checkpointId = `wait-${candidate.candidateId}-${actions.length}`;
        actions.push({ id: checkpointId, type: "interaction_checkpoint", checkpointId, checkpointKind: "teacher_continue" });
        continue;
      }
      const previous = actions.at(-1);
      if (!previous || previous.type !== "speech" || Number(previous.pauseAfterMs ?? 0) + block.durationMs > 30000) throw new Error("Waiting requires preceding speech and at most 30 seconds per speech");
      previous.pauseAfterMs = Number(previous.pauseAfterMs ?? 0) + block.durationMs;
    } else for (const [index, text] of speechParts(block.text).entries()) actions.push({ id: `speech-${candidate.candidateId}-${actions.length}`, type: "speech", text,
      ...(block.type === "speech" && block.attention ? { attention: index === 0 ? block.attention :
        { type: block.attention.type, objectIds: block.attention.objectIds } } : {}) });
  }
  const write = { projectId: project.projectId, pageId: page.pageId, expectedSourceRevision: project.source.revision, expectedTeachingRevision: project.teachingRevision, actions };
  if (!isTeachingWrite(write)) throw new Error("Invalid canonical teaching proposal");
  return { candidateId: candidate.candidateId, write };
}
