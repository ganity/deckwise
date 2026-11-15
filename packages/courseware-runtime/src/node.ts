export { preflightNativePlayback, buildFixedCourseware, validateFixedMapping, FixedBuildError, sha256, canonicalJson } from './conversion/lib/courseware/fixed-build';
export { adaptCanonicalSnapshot } from './conversion/lib/courseware/adapt-canonical-snapshot';
export { fixedBuildInputSchema, type FixedBuildInput } from './conversion/lib/courseware/fixed-build-input';
export { validateSavedSourceIdentity, exportSavedSourceIdentity, bindSavedSourceIdentity, reconcileSavedSources, type SavedSourceIdentity } from './conversion/lib/import/pptx/saved-source-identity';
export { parseMaicClassroom, maicClassroomSchema, type MaicClassroom } from './maic-classroom';
export { exportMaicClassroom } from './conversion/lib/courseware/export-maic-classroom';
export { mapSlideIrToScenes as mapMaicSlideIrToScenes } from './conversion/lib/import/mappers/import-ir-to-classroom';
export type { SlideIR as MaicSlideIR } from './conversion/lib/import/types';
export { sniffMaicMime } from './maic-resources';
export { decodeHtmlEntities } from './conversion/lib/import/narration/text-normalizer';
export { nativeMotionPreset } from "./generated-native-motion";
export { detachLinkedSpeechAnimations } from "./conversion/lib/courseware/native-click-animations";
export { prepareMaicAssessmentSpeech } from './maic-assessment-speech';

export { validSpeechAnimationSequence } from "./speech-animation-sequence";

export { inspectNativePlayback } from './conversion/lib/courseware/native-playback-preflight';
