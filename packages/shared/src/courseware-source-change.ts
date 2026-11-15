import { isCoursewareProject, type CoursewareProject } from "./courseware-contract.js";

/** A saved-source association receipt; never authority to replay an Office edit. */
export type CoursewareSourceChange = {
  changeGroupId: string;
  phase: "source-review" | "teaching-review" | "complete" | "superseded";
  stale: boolean;
  baselineSource: string;
  baselineTeachingRevision: string;
  targetSource: string;
  expected: string[];
  completed: string[];
  associationTeachingRevision: string | null;
  currentTeachingRevision: string;
  pendingPageIds: string[];
};

export type CoursewareChatCandidate = {
  candidateId: string;
  status: "needs-review" | "stale" | "adopted" | "superseded" | "rejected" | "unknown";
  sourceSha256?: string;
  teachingRevision?: string;
  pageIds?: string[];
};
export type CoursewareChatChange = { changeGroupId: string; acknowledged: number; uncertain: number; pending: number;
  candidates?: CoursewareChatCandidate[];
  receiptSha256?: string;
  resolution?: { note: string; sourceSha256: string; teachingRevision: string };
  plan?: { pageId: string; pageNumber: number; items: {
    label: string; toolName: string; status: CoursewareChatCandidate["status"] | "not-recorded" | "native-unsaved" | "saved";
    toolCallId?: string;
  }[] } };

/** Tool outcomes show acknowledgement; separate candidate records prove adoption, never semantic completion. */
export function chatChangesForTeaching(raw: unknown): CoursewareChatChange[] | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid Chat change context");
  const changes: unknown = Reflect.get(raw, "chatChanges");
  if (changes === undefined) return undefined;
  if (!Array.isArray(changes) || changes.length > 10) throw new Error("Invalid Chat change list");
  const seen = new Set<string>();
  return changes.map(change => {
    if (!change || typeof change !== "object" || Array.isArray(change) || typeof change.changeGroupId !== "string" ||
        !/^[\w.-]{1,128}$/u.test(change.changeGroupId) || seen.has(change.changeGroupId) ||
        !Array.isArray(change.operations) || (!change.operations.length && change.plan === undefined) || change.operations.length > 100)
      throw new Error("Invalid Chat change receipt");
    seen.add(change.changeGroupId);
    const summary: CoursewareChatChange = { changeGroupId: change.changeGroupId, acknowledged: 0, uncertain: 0, pending: 0 };
    for (const operation of change.operations) {
      if (!operation || typeof operation !== "object" || Array.isArray(operation) || !Object.hasOwn(operation, "outcome"))
        throw new Error("Invalid Chat operation");
      if (operation.outcome === null) summary.pending++;
      else if (operation.outcome && typeof operation.outcome === "object" && !Array.isArray(operation.outcome) &&
          (operation.outcome.saved === false || (operation.outcome.saved === true &&
            operation.toolName === "ppt_propose_page_narration" && operation.outcome.state === "acknowledged")) &&
          ["acknowledged", "uncertain"].includes(operation.outcome.state)) {
        if (operation.outcome.state === "acknowledged") summary.acknowledged++;
        else summary.uncertain++;
      } else throw new Error("Invalid Chat outcome");
      if (operation.candidate !== undefined) {
        const candidate = operation.candidate;
        const id = (value: unknown): value is string => typeof value === "string" && /^[\w.-]{1,128}$/u.test(value);
        if (!candidate || typeof candidate !== "object" || Array.isArray(candidate) || !id(candidate.candidateId) ||
            operation.outcome?.state !== "acknowledged" || candidate.candidateId !== operation.outcome.candidateId ||
            !["needs-review", "stale", "adopted", "superseded", "rejected", "unknown"].includes(candidate.status))
          throw new Error("Invalid Chat candidate result");
        const adopted = ["adopted", "superseded"].includes(candidate.status);
        if (Object.keys(candidate).length !== (adopted ? 5 : 2) || (adopted &&
            (typeof candidate.sourceSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(candidate.sourceSha256) ||
             !id(candidate.teachingRevision) || !Array.isArray(candidate.pageIds) || !candidate.pageIds.length ||
             candidate.pageIds.length > 100 || !candidate.pageIds.every(id) || new Set(candidate.pageIds).size !== candidate.pageIds.length)))
          throw new Error("Invalid Chat adoption reference");
        (summary.candidates ??= []).push(structuredClone(candidate));
      }
    }
    if (change.plan !== undefined) {
      const plan = change.plan;
      const id = (value: unknown): value is string => typeof value === "string" && /^[\w.-]{1,128}$/u.test(value);
      if (!plan || typeof plan !== "object" || Array.isArray(plan) || Object.keys(plan).length !== 3 ||
          !id(plan.pageId) || !Number.isSafeInteger(plan.pageNumber) || plan.pageNumber < 1 ||
          !Array.isArray(plan.items) || !plan.items.length || plan.items.length > 20) throw new Error("Invalid declared Chat plan");
      const used = new Set<string>();
      for (const item of plan.items) {
        if (!item || typeof item !== "object" || Array.isArray(item) || typeof item.label !== "string" ||
            !item.label.trim() || item.label.length > 200 || typeof item.toolName !== "string" ||
            !/^ppt_[a-z_]{1,80}$/u.test(item.toolName)) throw new Error("Invalid declared Chat step");
        if (item.status === "not-recorded") {
          if (Object.keys(item).length !== 3) throw new Error("Unexecuted Chat step has an operation");
          continue;
        }
        const operation = change.operations.find((operation: { toolCallId?: unknown }) => operation.toolCallId === item.toolCallId);
        if (typeof item.toolCallId !== "string" || !item.toolCallId.length || item.toolCallId.length > 256 ||
            used.has(item.toolCallId) || Object.keys(item).length !== 4 ||
            !operation || operation.toolName !== item.toolName) throw new Error("Chat step has no matching operation");
        used.add(item.toolCallId);
        const expected = !operation.outcome || operation.outcome.state !== "acknowledged" ? "unknown"
          : operation.candidate ? operation.candidate.status
          : operation.toolName === "ppt_propose_page_narration" && operation.outcome.saved === true ? "saved"
          : operation.outcome.page === plan.pageNumber ? "native-unsaved" : null;
        if (item.status !== expected) throw new Error("Chat plan progress differs from its actual operation");
      }
      summary.plan = structuredClone(plan);
    }
    if (change.receiptSha256 !== undefined || change.resolution !== undefined) {
      const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
      if (!summary.plan || !hash(change.receiptSha256)) throw new Error("Invalid declared Chat receipt hash");
      summary.receiptSha256 = change.receiptSha256;
      if (change.resolution !== undefined) {
        const r = change.resolution;
        if (!r || typeof r !== "object" || Array.isArray(r) || Object.keys(r).length !== 7 ||
            r.changeGroupId !== change.changeGroupId || r.receiptSha256 !== change.receiptSha256 ||
            r.sessionId !== change.sessionId || typeof r.sessionId !== "string" || !r.sessionId.length ||
            typeof r.note !== "string" || !r.note.trim() || r.note.length > 500 ||
            !r.source || typeof r.source !== "object" || Array.isArray(r.source) || Object.keys(r.source).length !== 2 ||
            typeof r.source.revision !== "string" || !/^[\w.-]{1,128}$/u.test(r.source.revision) || !hash(r.source.sha256) ||
            typeof r.teachingRevision !== "string" || !/^[\w.-]{1,128}$/u.test(r.teachingRevision) || !hash(r.projectSha256))
          throw new Error("Invalid reviewed Chat resolution");
        summary.resolution = { note: r.note, sourceSha256: r.source.sha256, teachingRevision: r.teachingRevision };
      }
    }
    return summary;
  });
}

export function sourceChangeForTeaching(raw: unknown, project: CoursewareProject): CoursewareSourceChange | undefined {
  const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
  const id = (value: unknown): value is string => typeof value === "string" && /^[\w.-]{1,128}$/u.test(value);
  const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/iu.test(value);
  if (!record(raw) || !isCoursewareProject(raw.project) || raw.project.projectId !== project.projectId ||
      raw.project.source.sha256 !== project.source.sha256 || raw.project.teachingRevision !== project.teachingRevision)
    throw new Error("Source change context changed; reload teaching");
  if (raw.sourceChange === undefined) return undefined;
  const change = raw.sourceChange;
  if (!record(change) || Object.keys(change).length !== 11 || !id(change.changeGroupId) ||
      !["source-review", "teaching-review", "complete", "superseded"].includes(String(change.phase)) || typeof change.stale !== "boolean" ||
      !hash(change.baselineSource) || !hash(change.targetSource) || change.baselineSource === change.targetSource ||
      !id(change.baselineTeachingRevision) || change.currentTeachingRevision !== project.teachingRevision ||
      (change.associationTeachingRevision !== null && !id(change.associationTeachingRevision)) ||
      JSON.stringify(change.expected) !== JSON.stringify(["source-associated", "teaching-review"]) ||
      !Array.isArray(change.pendingPageIds) || !Array.isArray(change.completed)) throw new Error("Invalid source change receipt");
  const associated = change.associationTeachingRevision !== null;
  const phase = !associated ? "source-review" : change.targetSource !== project.source.sha256 ? "superseded" : "complete";
  const completed = ["source-saved", ...(associated ? ["source-associated"] : []), ...(phase === "complete" ? ["teaching-review"] : [])];
  if (change.phase !== phase || (associated && change.stale !== (phase === "superseded")) ||
      change.pendingPageIds.length !== 0 || JSON.stringify(change.completed) !== JSON.stringify(completed))
    throw new Error("Inconsistent source change receipt");
  return structuredClone(change) as CoursewareSourceChange;
}
