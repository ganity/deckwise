export const COURSEWARE_CONTRACT_VERSION = "deckwise-courseware/1" as const;
export const COURSEWARE_MAX_BYTES = 2 * 1024 * 1024;

export type CoursewareTaskType = "plain" | "scene" | "import";
export type CoursewareSource = { revision: string; sha256: string };
export type CoursewareEducationContext = {
  schoolStage?: string;
  grade?: string;
  subject?: string;
  customSubjectName?: string;
  textbookVersion?: string;
  chapter?: string;
  lessonType?: string;
  visualStyle?: string;
  fullEnglishTeaching?: boolean;
};
export type CoursewarePage = {
  pageId: string;
  actions: Array<Record<string, unknown>>;
  locked: boolean;
  reviewState: "ready" | "review";
};
export type CoursewareProject = {
  schemaVersion: typeof COURSEWARE_CONTRACT_VERSION;
  projectId: string;
  taskType: CoursewareTaskType;
  title: string;
  source: CoursewareSource;
  teachingRevision: string;
  pages: CoursewarePage[];
  educationContext?: CoursewareEducationContext;
};
export type TeachingWrite = {
  projectId: string;
  pageId: string;
  expectedSourceRevision: string;
  expectedTeachingRevision: string;
  actions: Array<Record<string, unknown>>;
};
export type CoursewareCandidate = {
  candidateId: string;
  projectId: string;
  source: CoursewareSource;
  teachingRevision: string;
  targetPageIds: string[];
  outputSha256: string;
};
export type CoursewareSnapshot = {
  snapshotId: string;
  projectId: string;
  source: CoursewareSource;
  teachingRevision: string;
  mappingRevision: string;
  assetIds: string[];
};
export type CoursewareBuildRef = {
  buildId: string;
  snapshotId: string;
  packageSha256: string;
};
export type CoursewareTeamProject = {
  projectId: string;
  ownerUserId: number;
  role: "OWNER" | "EDITOR" | "VIEWER";
  createdAt: string;
};
export type CoursewareTeamMember = { userId: number; role: "OWNER" | "EDITOR" | "VIEWER" };
export type CoursewareTaskRef = {
  taskId: string;
  idempotencyKey: string;
  requestHash: string;
};

export const COURSEWARE_MAX_MEDIA_ASSET_BYTES = 16 * 1024 * 1024;
export type CoursewareTeamAssetRef = {
  projectId: string;
  assetRef: {
    assetId: string;
    sha256: string;
    mime: "image/png" | "image/jpeg" | "image/webp" | "audio/wav" | "audio/mpeg";
    byteLength: number;
    downloadPath: string;
    width?: number;
    height?: number;
    durationMs?: number;
  };
};

const id = (value: unknown): value is string =>
  typeof value === "string" && /^[\w.-]{1,128}$/u.test(value);
const sha256 = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f\d]{64}$/iu.test(value);
const revision = (value: unknown): value is string => id(value);
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const fields = (value: unknown, keys: string[], optional: string[] = []): value is Record<string, unknown> =>
  record(value) && Object.keys(value).every((key) => keys.includes(key) || optional.includes(key)) && keys.every((key) => Object.hasOwn(value, key));
const source = (value: unknown): value is CoursewareSource =>
  fields(value, ["revision", "sha256"]) && revision(value.revision) && sha256(value.sha256);
const withinBudget = (value: unknown): boolean => {
  try {
    const json = JSON.stringify(value);
    return typeof json === "string" && new TextEncoder().encode(json).byteLength <= COURSEWARE_MAX_BYTES;
  } catch {
    return false;
  }
};
const actions = (value: unknown): value is Array<Record<string, unknown>> =>
  Array.isArray(value) && value.length <= 1000 && value.every((action) => record(action) && id(action.id) && id(action.type)) &&
  new Set(value.map((action) => action.id)).size === value.length && withinBudget(value) &&
  value.filter(action => action.type === "native_animation").every((action, index) =>
    isCoursewareNativeAnimation(action) && action.stepIndex === index);

export type CoursewareNativeAnimation = {
  id: string; type: "native_animation"; version: 1; sourceSha256: string; stepIndex: number;
};
export function isCoursewareNativeAnimation(value: unknown): value is CoursewareNativeAnimation {
  return fields(value, ["id", "type", "version", "sourceSha256", "stepIndex"]) && id(value.id) &&
    value.type === "native_animation" && value.version === 1 && typeof value.sourceSha256 === "string" &&
    /^[a-f0-9]{64}$/u.test(value.sourceSha256) && Number.isInteger(value.stepIndex) &&
    Number(value.stepIndex) >= 0 && Number(value.stepIndex) < 200;
}

function educationContext(value: unknown): value is CoursewareEducationContext {
  const texts = ["schoolStage", "grade", "subject", "customSubjectName", "textbookVersion", "chapter", "lessonType", "visualStyle"];
  return fields(value, [], [...texts, "fullEnglishTeaching"]) &&
    texts.every((key) => !Object.hasOwn(value, key) || (typeof value[key] === "string" && value[key].length <= 500)) &&
    (!Object.hasOwn(value, "fullEnglishTeaching") || typeof value.fullEnglishTeaching === "boolean");
}

export function isCoursewareProject(value: unknown): value is CoursewareProject {
  if (!fields(value, ["schemaVersion", "projectId", "taskType", "title", "source", "teachingRevision", "pages"], ["educationContext"]) ||
      !withinBudget(value) || value.schemaVersion !== COURSEWARE_CONTRACT_VERSION || !id(value.projectId) ||
      typeof value.taskType !== "string" || !["plain", "scene", "import"].includes(value.taskType) || typeof value.title !== "string" ||
      value.title.length > 500 || !source(value.source) ||
      !revision(value.teachingRevision) || !Array.isArray(value.pages) || value.pages.length < 1 || value.pages.length > 100 ||
      (Object.hasOwn(value, "educationContext") && !educationContext(value.educationContext))) return false;
  const pageIds = new Set<string>();
  const sourceSha256 = value.source.sha256;
  return value.pages.every((page) => {
    if (!fields(page, ["pageId", "actions", "locked", "reviewState"]) || !id(page.pageId) || pageIds.has(page.pageId) || !actions(page.actions) ||
        typeof page.locked !== "boolean" || typeof page.reviewState !== "string" || !["ready", "review"].includes(page.reviewState)) return false;
    if (page.actions.some(action => action.type === "native_animation" && action.sourceSha256 !== sourceSha256)) return false;
    pageIds.add(page.pageId);
    return true;
  });
}

export function isTeachingWrite(value: unknown): value is TeachingWrite {
  return fields(value, ["projectId", "pageId", "expectedSourceRevision", "expectedTeachingRevision", "actions"]) &&
    withinBudget(value) && id(value.projectId) && id(value.pageId) && revision(value.expectedSourceRevision) &&
    revision(value.expectedTeachingRevision) && actions(value.actions);
}

export function isCoursewareCandidate(value: unknown): value is CoursewareCandidate {
  return fields(value, ["candidateId", "projectId", "source", "teachingRevision", "targetPageIds", "outputSha256"]) &&
    id(value.candidateId) && id(value.projectId) && source(value.source) && revision(value.teachingRevision) &&
    Array.isArray(value.targetPageIds) && value.targetPageIds.length > 0 && value.targetPageIds.length <= 100 && value.targetPageIds.every(id) &&
    new Set(value.targetPageIds).size === value.targetPageIds.length && sha256(value.outputSha256);
}

export function isCoursewareSnapshot(value: unknown): value is CoursewareSnapshot {
  return fields(value, ["snapshotId", "projectId", "source", "teachingRevision", "mappingRevision", "assetIds"]) &&
    id(value.snapshotId) && id(value.projectId) && source(value.source) && revision(value.teachingRevision) &&
    revision(value.mappingRevision) && Array.isArray(value.assetIds) && value.assetIds.length <= 10000 && value.assetIds.every(id) &&
    new Set(value.assetIds).size === value.assetIds.length;
}

export function isCoursewareBuildRef(value: unknown): value is CoursewareBuildRef {
  return fields(value, ["buildId", "snapshotId", "packageSha256"]) && id(value.buildId) && id(value.snapshotId) && sha256(value.packageSha256);
}

export function isCoursewareTeamProject(value: unknown): value is CoursewareTeamProject {
  return fields(value, ["projectId", "ownerUserId", "role", "createdAt"]) &&
    id(value.projectId) && typeof value.ownerUserId === "number" && Number.isSafeInteger(value.ownerUserId) && value.ownerUserId > 0 &&
    ["OWNER", "EDITOR", "VIEWER"].includes(String(value.role)) &&
    typeof value.createdAt === "string" && Number.isFinite(Date.parse(value.createdAt));
}

export function isCoursewareTeamMember(value: unknown): value is CoursewareTeamMember {
  return fields(value, ["userId", "role"]) && typeof value.userId === "number" && Number.isSafeInteger(value.userId) && value.userId > 0 &&
    ["OWNER", "EDITOR", "VIEWER"].includes(String(value.role));
}

export function isCoursewareTaskRef(value: unknown): value is CoursewareTaskRef {
  return fields(value, ["taskId", "idempotencyKey", "requestHash"]) && id(value.taskId) && id(value.idempotencyKey) && sha256(value.requestHash);
}

/** Structural pins only; current team membership is checked by the server on every read. */
export function isCoursewareTeamAssetRef(value: unknown): value is CoursewareTeamAssetRef {
  const uuid = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(v);
  const integer = (v: unknown, min: number, max: number) => Number.isSafeInteger(v) && Number(v) >= min && Number(v) <= max;
  if (!fields(value, ["projectId", "assetRef"]) || !uuid(value.projectId) ||
      !fields(value.assetRef, ["assetId", "sha256", "mime", "byteLength", "downloadPath"], ["width", "height", "durationMs"])) return false;
  const asset = value.assetRef;
  if (!uuid(asset.assetId) || typeof asset.mime !== "string" || typeof asset.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(asset.sha256) ||
      !integer(asset.byteLength, 1, COURSEWARE_MAX_MEDIA_ASSET_BYTES) ||
      asset.downloadPath !== `/courseware/team/projects/${value.projectId}/assets/${asset.assetId}/content`) return false;
  if (["image/png", "image/jpeg", "image/webp"].includes(String(asset.mime))) {
    return !Object.hasOwn(asset, "durationMs") && ["width", "height"].every(key => !Object.hasOwn(asset, key) || integer(asset[key], 1, 2147483647));
  }
  return ["audio/wav", "audio/mpeg"].includes(String(asset.mime)) &&
    !Object.hasOwn(asset, "width") && !Object.hasOwn(asset, "height") &&
    (!Object.hasOwn(asset, "durationMs") || integer(asset.durationMs, 0, Number.MAX_SAFE_INTEGER));
}

export function checkCoursewareCandidate(
  project: CoursewareProject,
  candidate: CoursewareCandidate,
  editorDirty: boolean,
): "accepted" | "stale" | "missing-page" | "editor-dirty" {
  if (project.projectId !== candidate.projectId || project.source.revision !== candidate.source.revision ||
      project.source.sha256.toLowerCase() !== candidate.source.sha256.toLowerCase() ||
      project.teachingRevision !== candidate.teachingRevision) return "stale";
  if (candidate.targetPageIds.some((id) => !project.pages.some((page) => page.pageId === id))) return "missing-page";
  return editorDirty ? "editor-dirty" : "accepted";
}

export function checkTeachingWrite(project: CoursewareProject, write: TeachingWrite): "accepted" | "stale" | "locked" | "missing-page" {
  if (project.projectId !== write.projectId || project.source.revision !== write.expectedSourceRevision ||
      project.teachingRevision !== write.expectedTeachingRevision ||
      write.actions.some(action => action.type === "native_animation" && action.sourceSha256 !== project.source.sha256)) return "stale";
  const page = project.pages.find(({ pageId }) => pageId === write.pageId);
  return !page ? "missing-page" : page.locked ? "locked" : "accepted";
}
