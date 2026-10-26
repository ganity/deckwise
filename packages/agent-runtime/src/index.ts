export * from "./ppt-editor-tools.js";
export * from "./courseware-route.js";
export * from "./host-client.js";
export * from "./custom-system-prompt.js";
export * from "./model-capabilities.js";
export * from "./mode-prompts.js";
export * from "./runtime.js";
export * from "./parent-host-proxy.js";
export * from "./plugin-skills.js";
export * from "./plugin-skills-prompt.js";
export * from "./plugin-session-context.js";
export * from "./one-shot-complete.js";
export * from "./prompt-templates.js";
export * from "./provider-headers.js";
export * from "./project-instructions.js";
export * from "./project-instructions-prompt.js";
export * from "./project-memory-prompt.js";
export * from "./subagent.js";
export { classifySidecarCrash, sidecarCrashErrorCode } from "./sidecar-crash.js";
export type { SidecarCrash, SidecarCrashKind } from "./sidecar-crash.js";
export * from "./subagent-definitions.js";
export * from "./stream-coalescer.js";
export * from "./extensions/index.js";
export { startAuthenticatedProxyRelay } from "./authenticated-proxy-relay.js";
export type { AuthenticatedProxyRelay } from "./authenticated-proxy-relay.js";

export * from "./speech/index.js";

export { generateNarrationWrite } from "./courseware/narration-write.js";
export { buildStagePromptContext, resolveGenerationProfile } from "./courseware/generation-profile-registry.js";
export { candidateHash } from "./courseware/page-candidate-baseline.js";
export { pageNarrationOutputSchema } from "./courseware/page-narration-candidate.js";
export { narrationPreviewSource } from "./courseware/narration-preview-source.js";
export { createAuthorizedPptCandidateTools } from "./ppt-candidate-host.js";
export type { PptCandidateBaseline, PptCandidateContext } from "./ppt-candidate-tools.js";

export { generatePageFadeCandidate, resolvePageFadeTarget } from "./courseware/page-fade-candidate.js";
export { resolveCoursewareOriginalNotes } from "./courseware/original-notes.js";
export * from "./image-generation/index.js";

export * from "./prompt-enhancement.js";
export * from "./session-title-summarize.js";
