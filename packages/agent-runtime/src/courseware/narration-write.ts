import { isTeachingWrite, isCoursewareAttentionCue, isCoursewareAttentionIntent, type CoursewareProject, type TeachingWrite } from "@pi-desktop/shared";
import { generatePageNarrationCandidate } from "./page-narration-candidate.js";

/** Normalize B's structured blocks at the canonical teaching boundary. */
export async function generateNarrationWrite(input: Omit<Parameters<typeof generatePageNarrationCandidate>[0], "educationContext" | "existingNarration"> & { project: CoursewareProject; pageId: string }) {
  const { project } = input;
  const page = project.pages.find((page) => page.pageId === input.pageId);
  if (!page || page.locked || page.actions.some((action) => {
    if (action.type === "audio_clip") return typeof action.id !== "string" || !/^[\w.-]{1,128}$/u.test(action.id) ||
      [".", ".."].includes(action.id) || typeof action.audioAssetId !== "string" || !/^music-[a-f0-9]{64}$/u.test(action.audioAssetId) ||
      Object.keys(action).length !== 3;
    if (action.type === "interaction_checkpoint") return action.checkpointKind !== "teacher_continue" ||
      typeof action.checkpointId !== "string" || !/^[\w.-]{1,128}$/u.test(action.checkpointId) ||
      Object.keys(action).some((key) => !["id", "type", "checkpointId", "checkpointKind"].includes(key));
    return action.type !== "speech" || typeof action.text !== "string" ||
      (action.attention !== undefined && !isCoursewareAttentionIntent(action.attention)) ||
      (action.visualCues !== undefined && (!Array.isArray(action.visualCues) || !action.visualCues.every(isCoursewareAttentionCue))) ||
      Object.keys(action).some((key) => !["id", "type", "text", "pauseAfterMs", "source", "audioAssetId", "visualCues", "attention"].includes(key));
  })) throw new Error("Unsupported or locked teaching; retain current narration");
  const educationContext = project.educationContext ? { ...project.educationContext,
    schoolStage: project.educationContext.schoolStage?.trim().toUpperCase(), subject: project.educationContext.subject?.trim().toUpperCase() } : undefined;
  const candidate = await generatePageNarrationCandidate({ ...input, educationContext, existingNarration: page.actions.filter((action) => action.type === "speech").map((action) => action.text).join("\n") });
  // Host merges retained music from the baseline; the model may propose narration only.
  const actions: TeachingWrite["actions"] = [];
  for (const block of candidate.narration.blocks) {
    if (block.type === "wait") {
      if (block.mode === "teacher_continue") {
        const checkpointId = `wait-${candidate.candidateId}-${actions.length}`;
        actions.push({ id: checkpointId, type: "interaction_checkpoint", checkpointId, checkpointKind: "teacher_continue" });
        continue;
      }
      const previous = actions.at(-1);
      if (!previous || previous.type !== "speech" || Number(previous.pauseAfterMs ?? 0) + block.durationMs > 30000) throw new Error("Waiting requires preceding speech and at most 30 seconds per speech");
      previous.pauseAfterMs = Number(previous.pauseAfterMs ?? 0) + block.durationMs;
    } else actions.push({ id: `speech-${candidate.candidateId}-${actions.length}`, type: "speech", text: block.text,
      ...(block.type === "speech" && block.attention ? { attention: block.attention } : {}) });
  }
  const write = { projectId: project.projectId, pageId: page.pageId, expectedSourceRevision: project.source.revision, expectedTeachingRevision: project.teachingRevision, actions };
  if (!isTeachingWrite(write)) throw new Error("Invalid canonical teaching proposal");
  return { candidateId: candidate.candidateId, write };
}
