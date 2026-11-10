import type { AgentTool } from "@earendil-works/pi-agent-core";
import { coursewarePresentationDefinition, coursewarePresentationPrepareDefinition } from "./courseware-presentation-tool.js";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { isCoursewareStory, coursewareStorySchema } from "@pi-desktop/shared";
import { CoursewareWorkflowError } from "./courseware-workflow-recovery.js";

type Host = { call<T>(method: string, params: unknown): Promise<T> };
const id = Type.String({ minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9._-]+$" });
const hash = Type.String({ pattern: "^[a-f0-9]{64}$" });
const shortText = () => Type.Optional(Type.String({ maxLength: 500 }));
const education = Type.Object({ schoolStage: shortText(), grade: shortText(), subject: shortText(),
  customSubjectName: shortText(), textbookVersion: shortText(), chapter: shortText(), lessonType: shortText(), visualStyle: shortText(),
  fullEnglishTeaching: Type.Optional(Type.Boolean()), bodyPageLimit: Type.Optional(Type.Integer({ minimum: 1, maximum: 30 })) }, { additionalProperties: false });
const pageNumbers = Type.Array(Type.Integer({ minimum: 1, maximum: 100 }), { minItems: 1, maxItems: 100, uniqueItems: true });
const assessmentTarget = { mode: Type.Union([Type.Literal("prepare"), Type.Literal("refresh")]), projectId: id, sceneId: id,
  expectedRevision: Type.String({ minLength: 1, maxLength: 512 }), expectedSourceRevision: Type.String({ minLength: 1, maxLength: 512 }),
  model: Type.String({ minLength: 1, maxLength: 512 }) };
const assessmentMediaDefinition = { name: "courseware_media_assessments", label: "Generate shared assessment media", parameters: Type.Union([
  Type.Object({ mode: Type.Literal("context"), kind: Type.Optional(Type.Union([Type.Literal("tts"), Type.Literal("image")])) }, { additionalProperties: false }),
  Type.Object({ ...assessmentTarget, kind: Type.Literal("tts"), actionId: id,
    voice: Type.Union([Type.String({ minLength: 1, maxLength: 512 }), Type.Null()]) }, { additionalProperties: false }),
  Type.Object({ ...assessmentTarget, kind: Type.Literal("image"), questionId: id,
    optionValue: Type.String({ minLength: 1, maxLength: 512 }) }, { additionalProperties: false }),
], { type: "object" }), description: "Shared Quiz/checkpoint media for imported, scene and PPT-master courses. Context returns missing question speech and multiple-choice option images plus current revisions; optional kind loads configured models. Context never starts generation. For an authorized complete course, prepare every missing target with those identities/revisions and a configured model (TTS also requires voice, or null for provider default). Prepare uses an internal current quote and reuses the durable original order. Refresh the same target/model/voice to verify, archive and adopt real output. Report an unknown submission after querying its original task; never submit a replacement. Re-read context before each operation because preparing legacy speech and adopting media change saved revisions. Preserve existing audio and option images. Finish all targets before claiming the complete course ready. Editor controls use the same services for individual regeneration." };
const definitions = [
  { name: "courseware_story_begin", label: "Start teaching story", parameters: Type.Object({}, { additionalProperties: false }),
    description: "Only when the user explicitly asks to design a teaching story before making new courseware, enable the saved story stage for this Chat. Do not use for imports or existing courseware. Then read courseware_workflow_get and save a complete story. This does not generate or approve courseware." },
  { name: "courseware_story_save", label: "Save teaching story draft", parameters: Type.Object({ expectedRevision: Type.Integer({ minimum: 0 }), story: coursewareStorySchema }, { additionalProperties: false }),
    description: "Save a complete teaching story for human review. Read current saved revision first. Infer teaching objectives, characters, connected events, learning activities and assessment intentions from the user's topic and saved education settings; ask only for essential missing audience/topic. Each beat objective must exactly match one entry in objectives; beat ids are unique. Preserve user constraints and explicitly list inferred assumptions. Beats are not PPT pages. Revise only requested content. This saves a draft, never human approval. Stop for review after saving. On lost replies reread saved state before retrying. Once production is bound, retain the existing course and propose a new task for story redesign." },
  { name: "courseware_workflow_get", label: "Read courseware workflow", parameters: Type.Object({}, { additionalProperties: false }),
    description: "Read this Chat's saved task, teaching settings, current scene plan, approval, image models, jobs and exact missing assets. Read before continuing. styleConfirmed is the saved first-page style decision; pending decomposition never revokes it. requiresHumanSelection refers only to an unselected cover master. Unapproved plans require human review in the main Chat. After style approval, refresh the latest later-page replacement intent: verified results automatically replace that page's old selection and clear stale layer selections. Do not ask for another per-page confirmation. Handle image failures through saved workflow tools and report exact errors; do not inspect internal databases or application source unless the user explicitly requests application debugging. Never claim an operation completed from prose." },
  { name: "courseware_scene_plan_submit", label: "Validate scene plan for review", parameters: Type.Object({}, { additionalProperties: false }),
    description: "After writing this Chat's scene plan.json, submit it through the real plan validator. Resolve exact validation errors before claiming the draft is ready. JSON parsing or a file-write receipt is insufficient. Check every explicit user requirement, including exact song names and page placement, against the complete draft before submission. Read awaitingPlanApproval: true means human plan review is required; false means the current bytes are already approved. This tool never approves, compiles or purchases media. For a cover-only rendering correction, keep the approved plan unchanged and use courseware_scene_image_prepare instructions instead." },
  { name: "courseware_requirements_update", label: "Save courseware requirements", parameters: Type.Object({
    expectedEducationContext: education, educationContext: education,
  }, { additionalProperties: false }),
    description: "Save confirmed body-page count in bodyPageLimit (1–30, excluding additional Quiz/checkpoints) and audience/grade/subject/language answers for this task before plan approval or source attachment. Read the saved educationContext first (use {} if absent), preserve fields not requested to change, including bodyPageLimit, and pass the complete replacement. Save explicit page counts before asking about additional assessments; never subtract assessments from the body count. Only an explicit user revision changes that count. Cannot change task type. Refuses stale answers, approved plans or attached PPTX; these require an explicit later revision workflow." },
  { name: "courseware_scene_image_prepare", label: "Prepare courseware image", parameters: Type.Object({
    planSha256: hash, pageId: Type.String({ pattern: "^scene-[0-9]{3}$" }), model: Type.Optional(id),
    target: Type.Union([Type.Object({ kind: Type.Union([Type.Literal("visualMaster"), Type.Literal("cleanPlate")]) }, { additionalProperties: false }),
      Type.Object({ kind: Type.Literal("layer"), name: Type.String({ minLength: 1, maxLength: 80 }) }, { additionalProperties: false })]),
    instructions: Type.Optional(Type.String({ maxLength: 1200 })), referenceIntentId: Type.Optional(id),
  }, { additionalProperties: false }),
    description: "Submit a missing visual for the approved plan and return its current state without polling. For an explicit cover-only rendering correction before style confirmation, preserve plan.json and its approval hash; prepare the same first-page visualMaster with the user's correction in instructions (for example, exclude unrequested human figures). Retain approved text, teaching and art direction; review the new cover, not the unchanged plan. Changing the actual plan requires renewed human plan approval. After style confirmation, continue independent missing assets while jobs are pending, including when another submission is unknown. When only pending work remains, refresh original jobs with waitForUpdate:true until ready or an actual error; keep the turn active without asking the user to continue. A submission_unknown outcome or errorCode is an actual error: report it and stop automatic waiting on that intent. An explicit new-attempt request for a confirmed failure uses courseware_scene_image_refresh with retryFailed:true. Omit model to use the server catalog for the target role. First generate only the first page visualMaster, then pause for human style selection in the right image preview. After style selection, Host automatically uses that selected first-page image as the style and recurring-character reference for later visual masters. Preserve the approved visualBible and page-required subjects. For an authorized whole-course generation after style approval, call courseware_scene_image_refresh once with the selected first-page master intentId and generateRemaining:true. Main generates missing masters and immediately decomposes each verified selected master, including the first page, using independent image/decomposition queues of five. No all-masters barrier or per-page model calls are needed. For a scoped single-page request, use cleanPlate decomposition with that page's selected master as referenceIntentId. One decomposition supplies its foreground layers. Later verified assets are selected automatically. Reuse existing requests; refresh pending jobs rather than preparing duplicates. Never fall back to generic image tools." },
  { name: "courseware_scene_image_refresh", label: "Refresh courseware image", parameters: Type.Object({ intentId: id,
    generatePrepared: Type.Optional(Type.Boolean()), waitForUpdate: Type.Optional(Type.Boolean()), retryFailed: Type.Optional(Type.Boolean()),
    generateRemaining: Type.Optional(Type.Boolean()),
  }, { additionalProperties: false }),
    description: "Query the original image job. For authorized generation of all remaining scene images after human style confirmation, pass the current selected first-page master intentId with generateRemaining:true, alone. Main reuses saved requests and runs masters and per-page decomposition concurrently through the existing limits (five each), verifies/archives/selects each result, and reports pipeline.ready, blockers and per-page failures. It never retries failed/unknown paid jobs or compiles. Continue compilation only when ready; report actual failures. Stop prevents new submissions; resume with the same flag and current selected cover to recover original jobs. Never use this flag for status-only, cover-only, a scoped retry, or single-page work. Set waitForUpdate:true when only pending work remains: poll at three-second intervals for up to 30 seconds, returning sooner when ready or failed. If still waitingFor:service, continue querying original jobs in the active turn without user confirmation. After style confirmation, independent jobs may proceed even if another submission is unknown. Service uncertainty never revokes styleConfirmed. Default: query and archive only. For a saved prepared request that was never submitted, set generatePrepared:true to submit that same intent using the current model catalog; style approval still gates later pages/layers. submitting means the native provider call is running. submission_unknown means its outcome was lost; report its errorCode and stop polling that intent. Normal refresh keeps submitted requests query-only. When the latest user request explicitly asks to retry a failed page/image/layer split or create a new request, set retryFailed:true with the failed intentId. This is sufficient authorization for those targets even after an earlier stop or no-new-requests instruction; do not require the user to repeat it in special wording. Main verifies a terminal failure and finalized accounting, preserves the original, and creates/reuses one new attempt for the same source and target; decomposition uses the built-in MAIC prompt. Never set this flag during automatic continuation, for unknown/running jobs, or for unrelated pages. Do not change prompts to evade deduplication. requiresGeneration:true means no image exists yet; generate or report the actual error. Ask for first-page style confirmation only when requiresHumanSelection:true and image.asset exists. Later verified results are selected automatically after style confirmation." },
  { name: "courseware_scene_compile", label: "Build editable courseware", parameters: Type.Object({ planSha256: hash, continueTeaching: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
    description: "Compile the approved scene plan and selected verified assets into editable PPTX and saved page narration. For an authorized complete teaching course, set continueTeaching:true to keep this turn active through missing narration and audio. Omit it for a PPTX-only request; compilation does not authorize extra media spending. Read workflow readiness first. Does not approve a plan, publish or overwrite Office edits. Never retry uncertain compilation automatically." },
  { name: "courseware_narration_context", label: "Read saved courseware pages", parameters: Type.Object({ pageNumbers: Type.Optional(pageNumbers) }, { additionalProperties: false }),
    description: "Read saved courseware page numbers, logical IDs, teaching policy, locks and text without opening an editor. Specify pageNumbers to inspect just the pages needing work; omitting it returns a compact full-deck status summary. Exact actions are returned only for explicitly selected pages. During TTS generation, read the next page instead of repeatedly reading the whole deck. Human preview and current selection are irrelevant." },
  { name: "courseware_narration_propose", label: "Generate saved page narration", parameters: Type.Object({ pageNumbers, sourceSha256: hash, instruction: Type.String({ minLength: 1, maxLength: 8000 }), repairRequiredTeaching: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
    description: "For missing approved questions/music/video or missing unambiguous focus on existing detailed speech (narrationReady:true), set repairRequiredTeaching:true: preserve every current speech verbatim and in order; Host inserts only missing required actions/focus, uses verified saved audio timing, and retains all audio/effects. A mismatching repair is rejected without writes. Otherwise generate and directly save narration for every requested saved page, independently of preview or editor navigation. Use sourceSha256 from courseware_narration_context. For a whole deck, request all missing pages in one call. Reports savedPages and per-page failures; retry only failed pages. Native narration re-reads changed content with bounded recovery; selection/navigation alone does not invalidate it. COURSEWARE_PAGE_CONTENT_MISMATCH is terminal for unchanged live content: compare the page requirement with its actual PPT objects, repair the live page or its approved page mapping, and read context again. Changing instruction wording or editing an external SVG alone cannot repair the open PPT. Do not repeatedly regenerate narration to bypass this validation. Preserve pages with narrationReady:true unless the user requests a revision; do not replay an earlier completed generation instruction after context recovery. Never ask the user to turn pages, review candidates or continue between pages. Regeneration replaces only the requested pages and clears their old speech audio. Does not alter PPTX or generate audio. Read saved teaching before retrying an uncertain save." },
  { name: "courseware_media_context", label: "Read saved courseware media", parameters: Type.Object({ kind: Type.Optional(Type.Union([Type.Literal("tts"), Type.Literal("music"), Type.Literal("video")])), continueTeaching: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
    description: "Read actual saved narration, speech IDs, teaching actions/readiness and original pending media jobs without opening Office. Set continueTeaching:true only when authorized to resume the complete saved teaching course; this keeps the current turn active until its missing teaching and audio finish. Omit it for status-only questions. An initial plan narration is not detailed narration. Optional kind returns the configured model catalog for that media type. Returns a bounded full-deck status summary without speech text or actions; use courseware_narration_context with pageNumbers for exact speech text and actions. Reading never starts generation. Generate only missing detailed narration, then synthesize missing speech audio; finish music/video required by the user. Pending attention annotations are valid before TTS adoption resolves them into timed visual cues; they do not require narration regeneration. Never treat a draft, submission receipt or compiled PPTX as a completed media product." },
  { name: "courseware_media_prepare", label: "Generate saved courseware media", parameters: Type.Union([
    Type.Object({ kind: Type.Literal("video"), sourceSha256: hash, pageNumber: Type.Integer({ minimum: 1, maximum: 100 }), actionId: id, model: id }, { additionalProperties: false }),
    Type.Object({ kind: Type.Literal("tts"), sourceSha256: hash, pageNumber: Type.Integer({ minimum: 1, maximum: 100 }),
      actionId: id, model: id, voice: Type.Optional(Type.Union([Type.String({ pattern: "^[A-Za-z0-9_-]{1,64}$" }), Type.Null()])) }, { additionalProperties: false }),
    Type.Object({ kind: Type.Literal("tts"), sourceSha256: hash, pageNumber: Type.Integer({ minimum: 1, maximum: 100 }),
      actionIds: Type.Array(id, { minItems: 1, maxItems: 100, uniqueItems: true }), model: id,
      voice: Type.Optional(Type.Union([Type.String({ pattern: "^[A-Za-z0-9_-]{1,64}$" }), Type.Null()])) }, { additionalProperties: false }),
    Type.Object({ kind: Type.Literal("music"), sourceSha256: hash, pageNumber: Type.Integer({ minimum: 1, maximum: 100 }), model: id,
      actionId: Type.Optional(id), prompt: Type.String({ maxLength: 4000 }), music: Type.Object({ title: Type.String({ minLength: 1, maxLength: 100 }),
        tags: Type.Optional(Type.String({ maxLength: 1000 })), negativeTags: Type.Optional(Type.String({ maxLength: 1000 })),
        instrumental: Type.Optional(Type.Boolean()) }, { additionalProperties: false }) }, { additionalProperties: false }),
  ], { type: "object" }), description: "Start authorized TTS, music or video for this saved source/page through server quotes and durable idempotent jobs. Reuses the same original request on recovery, never resubmits an unknown job. Use actual source hash, speech ID, models and voices from media context. For multiple TTS speeches on one page, prefer actionIds (up to 100 real speech IDs) instead of separate actionId calls: synthesis and verified archives run in parallel batches of at most ten, with revision-safe adoption. Inspect per-action results, failures and original pending jobs; retry only missing audio, never unknown paid submissions. Full-course narration/TTS and planned media need no per-page confirmation. Video requires a saved video_slot action ID; use a video block in narration to plan it, then quote and submit a configured video model. Music is generated only where requested by the lesson/user. Use the saved music_slot actionId to replace that slot at its exact timeline position; provide real lyrics or an instrumental prompt. Completed music is automatically exported, verified and attached as a separate playable clip, preserving speech. Returns actual saved readiness or a pending job; keep the Chat turn active until original jobs finish." },
  { name: "courseware_media_refresh", label: "Check saved courseware media", parameters: Type.Union([Type.Object({
    kind: Type.Union([Type.Literal("tts"), Type.Literal("music"), Type.Literal("video")]), sourceSha256: hash,
    pageNumber: Type.Integer({ minimum: 1, maximum: 100 }), intentId: id, waitForUpdate: Type.Optional(Type.Boolean()), retryFailed: Type.Optional(Type.Boolean()),
  }, { additionalProperties: false }), Type.Object({ kind: Type.Literal("tts"), sourceSha256: hash,
    pageNumber: Type.Integer({ minimum: 1, maximum: 100 }), intentIds: Type.Array(id, { minItems: 1, maxItems: 100, uniqueItems: true }),
    waitForUpdate: Type.Optional(Type.Boolean()),
  }, { additionalProperties: false })], { type: "object" }), description: "Check original saved media jobs; for TTS prefer intentIds from one page to refresh, download, decode and archive at most ten concurrently, with revision-safe adoption. Single intentId remains supported. Optionally poll every three seconds for up to 30 seconds per job. Verify, archive and adopt settled real output automatically. Music generation also completes its original export job. Prefer job.intentId for refresh; music also accepts media.intentId from an export result and resolves its original generation job. Returned job.intentId stays the generation ID. Unknown submissions remain query-only. When the latest user explicitly requests a retry/new request for a failed TTS/music/video job, set retryFailed:true with its single original intentId. Main verifies terminal failure and finalized accounting, preserves original receipts and content, and creates/reuses one fresh attempt. This scoped request is sufficient after a previous stop/no-new-requests instruction. Music-export failures retry the export, retaining successful music. Automatic continuation never sets retryFailed; it does not authorize unrelated work or replacement of unknown/running/successful jobs. Continue querying in the active Chat while waitingFor:service. Inspect batch results and failures. saved:true means bytes and adoption succeeded; terminal failures must be reported, never described as awaiting user confirmation." },
  assessmentMediaDefinition,
  coursewarePresentationPrepareDefinition,
  coursewarePresentationDefinition,
];

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** Model text carries the requested scope; internal recovery retains full receipts. */
export function coursewareStatusSummary(value: Record<string, unknown>, detailed = false): Record<string, unknown> {
  const { approvedPlan, pages, completion, quality, ...summary } = value;
  const pageNumbers = new Set(Array.isArray(pages) ? pages.filter(record).map(page => page.pageNumber) : []);
  const report = (value: unknown) => {
    if (!record(value)) return value;
    const { issues, ...status } = value;
    if (!Array.isArray(issues)) return status;
    const scoped = issues.filter(issue => record(issue) && (!detailed || pageNumbers.has(issue.pageNumber)));
    const grouped = new Map<string, Record<string, unknown>>();
    for (const issue of scoped) {
      if (!record(issue)) continue;
      const { pageId, pageNumber, code, repair, repairable } = issue;
      grouped.set(JSON.stringify([pageId, pageNumber, code]), { pageId, pageNumber, code, repair, repairable });
    }
    return { ...status, issues: detailed ? scoped : [...grouped.values()] };
  };
  return { ...summary, ...(completion ? { completion: report(completion) } : {}), ...(quality ? { quality: report(quality) } : {}),
    ...(Array.isArray(pages) ? { pages: pages.map(page => {
      if (!record(page)) return page;
      const { actions, speeches, ...status } = page;
      return { ...status, ...(detailed ? { actions } : {}), ...(Array.isArray(speeches) ? { speeches: speeches.map(speech => {
        if (!record(speech)) return speech;
        const { text, ...identity } = speech;
        return identity;
      }) } : {}) };
    }) } : {}) };
}

export function createCoursewareWorkflowTools(host: Host, sessionId: string, getTurnId: () => string | undefined): AgentTool[] {
  return definitions.map(definition => ({ ...definition, executionMode: "sequential",
    async execute(toolCallId, input, signal) {
      if (!Check(definition.parameters, input)) throw new Error("Invalid courseware workflow input");
      if (definition.name === "courseware_story_save" && (!input || typeof input !== "object" || !isCoursewareStory(Reflect.get(input, "story")))) throw new Error("Invalid teaching story references or size");
      const turnId = getTurnId();
      if (!turnId) throw new Error("Courseware tools require an active Chat turn");
      signal?.throwIfAborted();
      const abort = () => { void host.call("tools.abort", { sessionId, toolCallId }).catch(() => undefined); };
      signal?.addEventListener("abort", abort, { once: true });
      try {
        const result = await host.call<{ ok: boolean; content: unknown; errorCode?: string }>("tools.execute", {
          sessionId, turnId, toolCallId, toolName: definition.name, mode: "agent", args: structuredClone(input),
          ...(["courseware_presentation_adopt", "courseware_scene_image_prepare", "courseware_scene_image_refresh", "courseware_scene_compile", "courseware_narration_context", "courseware_narration_propose", "courseware_media_prepare", "courseware_media_refresh", "courseware_media_context", "courseware_media_assessments"].includes(definition.name) ? { timeoutMs: 16 * 60_000 } : {}),
        });
        signal?.throwIfAborted();
        if (getTurnId() !== turnId) throw new Error("Courseware Chat turn changed; read saved workflow before continuing");
        if (!result || result.ok !== true) {
          const nested = result?.content && typeof result.content === "object" && "error" in result.content ? result.content.error : undefined;
          const code = typeof nested === "string" ? /^([A-Z][A-Z0-9_]+)(?::|$)/u.exec(nested)?.[1] : undefined;
          throw new CoursewareWorkflowError(code ?? result?.errorCode ?? "COURSEWARE_WORKFLOW_FAILED", `${result?.errorCode ?? "COURSEWARE_WORKFLOW_FAILED"}: ${JSON.stringify(result?.content)}`);
        }
        return { content: [{ type: "text", text: JSON.stringify(["courseware_media_context", "courseware_narration_context"].includes(definition.name) && record(result.content) ? coursewareStatusSummary(result.content, definition.name === "courseware_narration_context" && Array.isArray(Reflect.get(input as object, "pageNumbers"))) : result.content) }], details: result.content };
      } finally { signal?.removeEventListener("abort", abort); }
    },
  }));
}
