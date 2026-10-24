export { buildFixedCourseware, validateFixedMapping, FixedBuildError, sha256, canonicalJson } from './conversion/lib/courseware/fixed-build';
export { adaptCanonicalSnapshot } from './conversion/lib/courseware/adapt-canonical-snapshot';
export { fixedBuildInputSchema, type FixedBuildInput } from './conversion/lib/courseware/fixed-build-input';
export { validateSavedSourceIdentity, exportSavedSourceIdentity, bindSavedSourceIdentity, reconcileSavedSources, type SavedSourceIdentity } from './conversion/lib/import/pptx/saved-source-identity';
