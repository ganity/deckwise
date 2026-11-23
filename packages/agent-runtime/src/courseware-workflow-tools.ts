import type { AgentTool } from "@earendil-works/pi-agent-core";
import { normalizePresentationArguments, coursewarePresentationDefinition, coursewarePresentationPrepareDefinition } from "./courseware-presentation-tool.js";
import { Type, type TSchema, type TObject } from "typebox";
import { Check, Errors } from "typebox/value";
import { isCoursewareStory, coursewareStorySchema } from "@pi-desktop/shared";
import { CoursewareWorkflowError, CoursewareInputError } from "./courseware-workflow-recovery.js";

type Host = { call<T>(method: string, params: unknown): Promise<T> };
const id = Type.String({ minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9._-]+$" });
const hash = Type.String({ pattern: "^[a-f0-9]{64}$" });
const documentHash = Type.String({ pattern: "^[a-f0-9]{64}$", description: "Current saved PPTX sourceSha256 from narration/media context. Not materials.sources[].sourceId or planSha256. Reread context after a save." });
const shortText = () => Type.Optional(Type.String({ maxLength: 500 }));
const education = Type.Object({ schoolStage: shortText(), grade: shortText(), subject: shortText(),
  customSubjectName: shortText(), textbookVersion: shortText(), chapter: shortText(), lessonType: shortText(), visualStyle: shortText(),
  fullEnglishTeaching: Type.Optional(Type.Boolean()), bodyPageLimit: Type.Optional(Type.Integer({ minimum: 1, maximum: 30 })) }, { additionalProperties: false });
const pageNumbers = Type.Array(Type.Integer({ minimum: 1, maximum: 100 }), { minItems: 1, maxItems: 100, uniqueItems: true });
const assessmentTarget = { mode: Type.Union([Type.Literal("prepare"), Type.Literal("refresh")]), projectId: id, sceneId: id,
  expectedRevision: Type.String({ minLength: 1, maxLength: 512 }), expectedSourceRevision: Type.String({ minLength: 1, maxLength: 512 }),
  model: Type.String({ minLength: 1, maxLength: 512 }) };
// Some providers discover arguments from root properties. Keep the exact mode-specific contracts in anyOf.
function mediaParameters(branches: TObject[]) {
  const alternatives = new Map<string, Map<string, TSchema>>();
  for (const branch of branches) {
    for (const [name, schema] of Object.entries(branch.properties)) {
      const variants = alternatives.get(name) ?? new Map<string, TSchema>();
      variants.set(JSON.stringify(schema), schema);
      alternatives.set(name, variants);
    }
  }
  const properties = Object.fromEntries(Array.from(alternatives, ([name, variants]) => [
    name, variants.size === 1 ? [...variants.values()][0] : Type.Union([...variants.values()]),
  ]));
  const required = (branches[0].required ?? []).filter(name => branches.every(b => b.required?.includes(name)));
  return Type.Union(branches, { type: "object", properties, required });
}

const assessmentMediaDefinition = { name: "courseware_media_assessments", label: "Generate shared assessment media", parameters: mediaParameters([
  Type.Object({ mode: Type.Literal("context"), kind: Type.Optional(Type.Union([Type.Literal("tts"), Type.Literal("image")])) }, { additionalProperties: false }),
  Type.Object({ mode: Type.Literal("configure"), projectId: id,
    expectedRevision: Type.String({ minLength: 1, maxLength: 512 }), expectedSourceRevision: Type.String({ minLength: 1, maxLength: 512 }),
    sceneIds: Type.Array(id, { minItems: 1, maxItems: 100, uniqueItems: true }),
    optionImages: Type.Union([Type.Literal("required"), Type.Literal("excluded")]), reason: Type.String({ minLength: 1, maxLength: 1000 }) }, { additionalProperties: false }),
  Type.Object({ ...assessmentTarget, kind: Type.Literal("tts"), actionId: id,
    originalKey: Type.Optional(Type.String({ pattern: "^maic-[a-f0-9]{64}$", description: "For refresh use the key returned by the original question audio order." })),
    voice: Type.Union([Type.String({ minLength: 1, maxLength: 512 }), Type.Null()]) }, { additionalProperties: false }),
  Type.Object({ ...assessmentTarget, kind: Type.Literal("image"), questionId: id,
    visualSettingIds: Type.Optional(Type.Array(hash, { minItems: 1, uniqueItems: true })),
    optionValue: Type.String({ minLength: 1, maxLength: 512 }) }, { additionalProperties: false }),
]), description: "Shared Quiz/checkpoint media for imported, scene and PPT-master courses. Context returns missing required question speech and multiple-choice option images plus current revisions; optional kind loads configured models. Context never starts generation. Only when the user explicitly excludes option pictures or requests text-only choices, use configure with optionImages:excluded, sceneIds from context.configurableQuizSceneIds and a reason quoting that user requirement; this saves the scoped policy in the classroom/PPT. An empty configurableQuizSceneIds list means there is no configurable Quiz scope; do not configure body or interactive pages. Never exclude required images to bypass a failure. Configure required restores a changed user requirement. Existing image and audio bytes are preserved; question speech is always required. Re-read context after configuration. For an authorized complete course, prepare every missing target with those identities/revisions and a configured model (TTS also requires voice, or null for provider default). Prepare uses an internal current quote and reuses the durable original order. Refresh the same target/model/voice to verify, archive and adopt real output. Report an unknown submission after querying its original task; never submit a replacement. Re-read context before each operation because preparing legacy speech and adopting media change saved revisions. Preserve existing audio and option images. Finish all targets before claiming the complete course ready. Editor controls use the same services for individual regeneration." };
const definitions = [
  { name: "courseware_story_begin", label: "Start teaching story", parameters: Type.Object({}, { additionalProperties: false }),
    description: "Only when the user explicitly asks to design a teaching story before making new courseware, enable the saved story stage for this Chat. Do not use for imports or existing courseware. Then read courseware_workflow_get and save a complete story. This does not generate or approve courseware." },
  { name: "courseware_story_save", label: "Save teaching story draft", parameters: Type.Object({ expectedRevision: Type.Integer({ minimum: 0 }), story: coursewareStorySchema }, { additionalProperties: false }),
    description: "Save a complete teaching story for human review. Read current saved revision first. Infer teaching objectives, characters, connected events, learning activities and assessment intentions from the user's topic and saved education settings; ask only for essential missing audience/topic. Each beat objective must exactly match one entry in objectives; beat ids are unique. Preserve user constraints and explicitly list inferred assumptions. Beats are not PPT pages. Revise only requested content. This saves a draft, never human approval. Stop for review after saving. On lost replies reread saved state before retrying. Once production is bound, retain the existing course and propose a new task for story redesign." },
  { name: "courseware_workflow_get", label: "Read courseware workflow", parameters: Type.Object({
    listSettingImages: Type.Optional(Type.Literal(true)),
    visualSettingIds: Type.Optional(Type.Array(hash, { minItems: 1, uniqueItems: true })),
  }, { additionalProperties: false }),
    description: "With {} read this Chat's saved workspace.root, workspace.projectsDirectory and workspace.scenePlanPath, task, teaching settings, current scene plan, approval, image models, jobs and exact missing assets. Use these exact paths; plan:null is normal before the first draft. Write the draft directly to workspace.scenePlanPath without shell directory discovery. Read before continuing. styleConfirmed is the saved first-page style decision; pending decomposition never revokes it. requiresHumanSelection refers only to an unselected cover master. Unapproved plans require human review in the main Chat. After style approval, refresh the latest later-page replacement intent: verified results automatically replace that page's old selection and clear stale layer selections. Do not ask for another per-page confirmation. Handle image failures through saved workflow tools and report exact errors; do not inspect internal databases or application source unless the user explicitly requests application debugging. Never claim an operation completed from prose." },
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
    instructions: Type.Optional(Type.String({ maxLength: 1200 })),
  }, { additionalProperties: false }),
    description: "Submit a missing visual for the approved plan and return its current state without polling. For an explicit cover-only rendering correction before style confirmation, preserve plan.json and its approval hash; prepare the same first-page visualMaster with the user's correction in instructions (for example, exclude unrequested human figures). Retain approved text, teaching and art direction; review the new cover, not the unchanged plan. Changing the actual plan requires renewed human plan approval. After style confirmation, continue independent missing assets while jobs are pending, including when another submission is unknown. When only pending work remains, refresh original jobs with waitForUpdate:true until ready or an actual error; keep the turn active without asking the user to continue. A submission_unknown outcome or errorCode is an actual error: report it and stop automatic waiting on that intent. An explicit new-attempt request for a confirmed failure uses courseware_scene_image_refresh with retryFailed:true. Omit model to use the server catalog for the target role. The desktop resolves every image reference. The first visualMaster may use the page’s approved visualSettingIds. Generate only that master, then pause for human style selection in the right image preview. After style selection, Host automatically uses that selected first-page image as the style and recurring-character reference for later visual masters. Preserve the approved visualBible and page-required subjects. For an authorized whole-course generation after style approval, call courseware_scene_generate_remaining with {}. Main generates missing masters and immediately decomposes each verified selected master, including the first page, using independent image/decomposition queues of five. No all-masters barrier or per-page model calls are needed. For a scoped single-page request, use cleanPlate decomposition. The desktop binds cleanPlate or layer to the selected master on that page. One decomposition supplies its foreground layers. Later verified assets are selected automatically. Reuse existing requests; refresh pending jobs rather than preparing duplicates. Never fall back to generic image tools." },
  { name: "courseware_scene_generate_remaining", label: "Generate remaining approved scene images", parameters: Type.Object({}, { additionalProperties: false }),
    description: "For an authorized whole course after the user selected the cover, continue the existing approved image and decomposition jobs. Call with {}. Main resolves the selected cover. Never use for status, cover-only or single-page work." },
  { name: "courseware_scene_image_refresh", label: "Refresh courseware image", parameters: Type.Union([
    Type.Object({ waitForUpdate: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
    Type.Object({ intentId: Type.Optional(id), generateRemaining: Type.Literal(true), generatePrepared: Type.Optional(Type.Literal(false)),
      retryFailed: Type.Optional(Type.Literal(false)), waitForUpdate: Type.Optional(Type.Literal(false)) }, { additionalProperties: false }),
    Type.Object({ intentId: id, generateRemaining: Type.Optional(Type.Literal(false)), generatePrepared: Type.Optional(Type.Boolean()),
      retryFailed: Type.Optional(Type.Literal(false)), waitForUpdate: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
    Type.Object({ intentId: id, generateRemaining: Type.Optional(Type.Literal(false)), generatePrepared: Type.Optional(Type.Literal(false)),
      retryFailed: Type.Literal(true), waitForUpdate: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
  ], { type: "object", properties: { intentId: id, generateRemaining: Type.Boolean(), generatePrepared: Type.Boolean(),
    retryFailed: Type.Boolean(), waitForUpdate: Type.Boolean() } }),
    description: "Query the original image job. An empty object queries the unique current receipt. For authorized whole-course generation use {generateRemaining:true}; Main resolves the selected cover. For authorized generation of all remaining scene images after human style confirmation, pass the current selected first-page master intentId with generateRemaining:true, alone. Main reuses saved requests and runs masters and per-page decomposition concurrently through the existing limits (five each), verifies/archives/selects each result, and reports pipeline.ready, blockers and per-page failures. It never retries failed/unknown paid jobs or compiles. Continue compilation only when ready; report actual failures. Stop prevents new submissions; resume with the same flag and current selected cover to recover original jobs. Never use this flag for status-only, cover-only, a scoped retry, or single-page work. Set waitForUpdate:true when only pending work remains: poll at three-second intervals for up to 30 seconds, returning sooner when ready or failed. If still waitingFor:service, continue querying original jobs in the active turn without user confirmation. After style confirmation, independent jobs may proceed even if another submission is unknown. Service uncertainty never revokes styleConfirmed. Default: query and archive only. For a saved prepared request that was never submitted, set generatePrepared:true to submit that same intent using the current model catalog; style approval still gates later pages/layers. submitting means the native provider call is running. submission_unknown means its outcome was lost; report its errorCode and stop polling that intent. Normal refresh keeps submitted requests query-only. When the latest user request explicitly asks to retry a failed page/image/layer split or create a new request, set retryFailed:true with the failed intentId. This is sufficient authorization for those targets even after an earlier stop or no-new-requests instruction; do not require the user to repeat it in special wording. Main verifies a terminal failure and finalized accounting, preserves the original, and creates/reuses one new attempt for the same source and target; decomposition uses the built-in MAIC prompt. Never set this flag during automatic continuation, for unknown/running jobs, or for unrelated pages. Do not change prompts to evade deduplication. requiresGeneration:true means no image exists yet; generate or report the actual error. Ask for first-page style confirmation only when requiresHumanSelection:true and image.asset exists. Later verified results are selected automatically after style confirmation." },
  { name: "courseware_scene_compile", label: "Build editable courseware", parameters: Type.Object({ planSha256: hash, continueTeaching: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
    description: "Compile the approved scene plan and selected verified assets into editable PPTX and saved page narration. For an authorized complete teaching course, set continueTeaching:true to keep this turn active through missing narration and audio. Omit it for a PPTX-only request; compilation does not authorize extra media spending. Read workflow readiness first. Does not approve a plan, publish or overwrite Office edits. Never retry uncertain compilation automatically." },
  { name: "courseware_narration_context", label: "Read saved courseware pages", parameters: Type.Object({ pageNumbers: Type.Optional(pageNumbers) }, { additionalProperties: false }),
    description: "Read saved courseware page numbers, logical IDs, teaching policy, locks and text without opening an editor. Specify pageNumbers to inspect just the pages needing work; omitting it returns a compact full-deck status summary. Exact actions are returned only for explicitly selected pages. During TTS generation, read the next page instead of repeatedly reading the whole deck. Human preview and current selection are irrelevant." },
  { name: "courseware_narration_plan", label: "Analyze a supplied lesson plan", parameters: Type.Object({
    sourceSha256: documentHash, apply: Type.Boolean(), instruction: Type.Optional(Type.String({ maxLength: 8000 })),
    lessonPlan: Type.Union([Type.Object({ sourceId: hash }, { additionalProperties: false }),
      Type.Object({ text: Type.String({ minLength: 1, maxLength: 100000 }) }, { additionalProperties: false })]),
  }, { additionalProperties: false }), description: "Analyze and map a supplied lesson-plan attachment to the real native PPT, shared by import, scene and PPT Master. Supply exactly one immutable Host sourceId or user-supplied inline text; never transcribe an attachment. Main reads all live page text/notes, preserves approved teaching requirements, and calls the selected model to extract source-grounded units and stable page bindings. Unmatched stages remain visible. Existing accepted plans are retained without a model call; requiresExplicitReplacement means use the explicit material revision workflow, never overwrite automatically. apply:false previews; apply:true adopts the validated mapping through native material history/save. For an authorized teaching-course request no extra per-page review is needed. Alternatively apply preview units with courseware_narration_import and the same source. This never rewrites a final script, synthesizes audio, adds default assessments, or inserts pages. Reconcile missing quiz/checkpoint units with courseware_activity_insert, respecting explicit user quantities/exclusions and real answer evidence, then use existing narration and assessment-media tools." },
  { name: "courseware_narration_import", label: "Match teaching materials", parameters: Type.Object({
    sourceSha256: documentHash, apply: Type.Boolean(),
    script: Type.Optional(Type.Object({ text: Type.Optional(Type.String({ minLength: 1, maxLength: 500000 })), sourceId: Type.Optional(hash),
      policy: Type.Union([Type.Literal("preserve"), Type.Literal("revise"), Type.Literal("generate-missing")]),
      assignments: Type.Optional(Type.Array(Type.Object({ segmentId: id, pageId: id }, { additionalProperties: false }), { maxItems: 1000 })),
      silentPageIds: Type.Optional(Type.Array(id, { maxItems: 100, uniqueItems: true })),
    }, { additionalProperties: false })),
    lessonPlan: Type.Optional(Type.Object({ text: Type.Optional(Type.String({ minLength: 1, maxLength: 500000 })), sourceId: Type.Optional(hash),
      units: Type.Array(Type.Object({ id, title: Type.String({ minLength: 1, maxLength: 200 }), evidence: Type.String({ minLength: 1, maxLength: 8000 }),
        pageIds: Type.Array(id, { maxItems: 100, uniqueItems: true }), kind: Type.Union([Type.Literal("teaching"), Type.Literal("quiz"), Type.Literal("checkpoint")]),
        activityId: Type.Optional(Type.String({ minLength: 1, maxLength: 128, description: "Only an existing interaction_checkpoint action ID read from the live PPT. Omit for a missing activity that still needs insertion; a lesson-plan unit ID is not an activity ID." })),
      }, { additionalProperties: false }), { minItems: 1, maxItems: 100 }),
    }, { additionalProperties: false })),
  }, { additionalProperties: false }), description: "Adopt optional supplied final script and/or lesson plan into the native PPT, for imported, scene or PPT Master decks. Prefer sourceId from attached material or narration context so Host supplies the exact immutable extracted text. Inline text must quote a user message in this chat. Use courseware_narration_propose with pageNumbers to write a page or repairRequiredTeaching:true to add effects to its saved speech. Use preserve for a final script; choose revise only for explicitly requested rewriting, generate-missing only when authorized to fill gaps. First call apply:false to parse exact words and original page labels without writes or provider calls. Returned segment IDs need explicit assignments only for unlabelled ambiguous paragraphs. Read native page IDs, use exact lesson-plan quotes as evidence, keep unmatched units visible. apply:true atomically saves words and source bindings per page through native history; no speech generator is called. Explicitly silent pages get no filler. Existing media and activities are retained. Lost replies require rereading context; do not regenerate the script. Mapping coverage is separate from audio/effect readiness. Plan activities require actual matching checkpoint identities; inferred matches are not completed activities. Report remaining unmatched segments/units. This tool never creates assessments or starts paid media." },
  { name: "courseware_activity_insert", label: "Add a mapped activity page", parameters: Type.Object({ sourceSha256: documentHash, apply: Type.Boolean(),
    unitId: id, afterPageId: id, question: Type.String({ minLength: 1, maxLength: 160 }),
    referenceEvidence: Type.Optional(Type.String({ minLength: 1, maxLength: 4000, description: "Omit to use the accepted unit evidence verbatim; provide only an exact source quote when a different quote is needed." })), referenceAnswer: Type.Optional(Type.Object({ summary: Type.String({ minLength: 1, maxLength: 4000 }), keyPoints: Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), { maxItems: 20 }) }, { additionalProperties: false })), response: Type.Object({
      kind: Type.Union([Type.Literal("single"), Type.Literal("multiple"), Type.Literal("judge"), Type.Literal("short_answer"), Type.Literal("discussion"), Type.Literal("practice"), Type.Literal("pbl")]),
      options: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { maxItems: 8 }),
      answerIndices: Type.Array(Type.Integer({ minimum: 0, maximum: 7 }), { maxItems: 8, uniqueItems: true }),
    }, { additionalProperties: false }),
  }, { additionalProperties: false }), description: "Insert one missing activity from an accepted lesson-plan unit into a separate native page after a real page ID. If no attachment/plan exists, first preview and apply the user's explicit inline activity requirements as lessonPlan.text/units with courseware_narration_import; a separate attachment is not required. Use an exact accepted quiz/checkpoint unitId, never invent one. Keep original body pages and their narration intact. A visible question on a body slide does not authorize conversion; use a new page. Read teaching context and existing questions first. Reuse an existing activity by mapping its actual ID; never add a second question because wording differs. apply:false previews without editing. apply:true commits visible question, correct answer/reference, source-unit identity and separate question speech in one native Undo transaction, then saves the PPT. Objective questions require a Quiz unit; teacher-led discussion/practice/PBL requires a checkpoint unit. Never change a requested response.kind after validation fails. For short_answer/discussion/practice/pbl supply referenceAnswer:{summary,keyPoints} that actually answers the question and retains requested examples; source evidence alone is not an answer. Prefer omitting referenceEvidence so the program reads the accepted unit quote. If supplied, use exact referenceEvidence from the target page or accepted plan; each selected answer must appear in that evidence. No guessed answers, no student assessment claims. Repeating an acknowledged insertion reuses its saved activity ID. After lost replies reread context before retrying. Original lecture/script anchors do not shift. No media is purchased by insertion; use existing shared assessment media tools afterwards." },
  { name: "courseware_narration_propose", label: "Generate saved page narration", parameters: Type.Object({ pageNumbers: Type.Array(Type.Integer({ minimum: 1, maximum: 100 }), { minItems: 1, maxItems: 5, uniqueItems: true }), sourceSha256: documentHash, instruction: Type.String({ minLength: 1, maxLength: 8000, description: "Forward the user’s teaching and timing request. The generator reads each page’s approved objectives, required effects and current object map itself; do not copy or invent per-page IDs, SVG names or bindings." }), speechCountEvidence: Type.Optional(Type.String({ minLength: 1, maxLength: 500, description: "Verbatim user request specifying the exact number of speech blocks per page. Omit for ordinary narration." })), speechCount: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: "Exact speech blocks per body page when the user specifies a count; waits, Quiz readings and media are separate. Always forward an explicit user count here. Omit when unspecified; never invent a default of one or infer a count from slide/page count." })), repairRequiredTeaching: Type.Optional(Type.Boolean()), repairObjectsOnly: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
    description: "For native body pages, add accepted Quiz/checkpoint activities as separate pages with courseware_activity_insert; narration never converts a body page to an assessment. Spoken learner prompts remain speech. For OBJECT_REQUIREMENT_UNRESOLVED, use repairRequiredTeaching:true and repairObjectsOnly:true: update only verified object semantics, preserve all actions, words, audio and effects; never paste a collective description onto one target. For missing approved music/video or missing unambiguous focus on existing detailed speech (narrationReady:true), set repairRequiredTeaching:true: preserve every current speech verbatim and in order; Host inserts only missing required actions/focus, uses verified saved audio timing, and retains all audio/effects. A mismatching repair is rejected without writes. Otherwise generate and directly save narration for every requested saved page, independently of preview or editor navigation. Use the latest sourceSha256 returned by a saved mutation or courseware_narration_context; saving changes it. Never repeat a rejected stale SHA. For an open native PPT always use these shared teaching tools, not ppt_record_change_plan or a Host shadow project. For a whole deck, call sequential batches of at most 5 pages. Await the saved result, read fresh context/sourceSha256, and request the next unfinished batch. Never submit the full page range or parallel batches; keep working without asking for confirmation between batches. Reports savedPages and per-page failures; retry only retriable failed pages. A per-page retriable:false means stop automatic retries for that unchanged page in this user turn; do not switch to single-page calls or shorten instructions to reset its budget. Continue independent unfinished pages and report the terminal failures. A later explicit user request gets a fresh bounded attempt budget. Native narration re-reads changed content with bounded recovery; selection/navigation alone does not invalidate it. COURSEWARE_PAGE_CONTENT_MISMATCH is terminal for unchanged live content: compare the page requirement with its actual PPT objects, repair the live page or its approved page mapping, and read context again. Changing instruction wording or editing an external SVG alone cannot repair the open PPT. Do not repeatedly regenerate narration to bypass this validation. Preserve pages with narrationReady:true unless the user requests a revision; do not replay an earlier completed generation instruction after context recovery. Never ask the user to turn pages, review candidates or continue between pages. Regeneration replaces only the requested pages and clears their old speech audio. Does not alter PPTX or generate audio. Read saved teaching before retrying an uncertain save." },
  { name: "courseware_media_context", label: "Read saved courseware media", parameters: Type.Object({ kind: Type.Optional(Type.Union([Type.Literal("tts"), Type.Literal("music"), Type.Literal("video")])), continueTeaching: Type.Optional(Type.Boolean()), reviewContent: Type.Optional(Type.Boolean({ description: "Review actual saved page images, narration and all question analyses before final delivery. Generated Quiz analysis corrections are bounded and retain speech/audio; ordinary status reads do not call a model." })) }, { additionalProperties: false }),
    description: "Read actual saved narration, speech IDs, teaching actions/readiness and original pending media jobs without opening Office. Native pages also report per-page effects with target UUIDs and narrationTiming with decoded durationMs (null means unknown), classroom budget and overBudget. Before claiming completion, compare every requested original/body page against the user requirement: all original titles means all original pages, even after inserted activities shift page numbers. Do not narrow a multi-page effect request to the first title. Use scoped narration context to verify target text, and repair missing effects while preserving supplied speech/audio. Treat classroom timing estimates as informational. Only compare speech timing for acceptance when the user explicitly sets a spoken-time limit. Never silently rewrite a preserved user script to fit time. Set continueTeaching:true only when authorized to resume the complete saved teaching course; this keeps the current turn active until its missing teaching and audio finish. Omit it for status-only questions. An initial plan narration is not detailed narration. Optional kind returns the configured model catalog for that media type. Returns a bounded full-deck status summary without speech text or actions; use courseware_narration_context with pageNumbers for exact speech text and actions. Ordinary reading never starts generation. Before final completion of an authorized native course, call with reviewContent:true and require contentReview.ready:true; report unresolved content issues without claiming success. Generate only missing detailed narration, then synthesize missing speech audio; finish music/video required by the user. Pending attention annotations are valid before TTS adoption resolves them into timed visual cues; they do not require narration regeneration. Never treat a draft, submission receipt or compiled PPTX as a completed media product." },
  { name: "courseware_media_prepare", label: "Generate saved courseware media", parameters: mediaParameters([
    Type.Object({ kind: Type.Literal("video"), sourceSha256: documentHash, pageNumber: Type.Integer({ minimum: 1, maximum: 100 }), actionId: id, model: id }, { additionalProperties: false }),
    Type.Object({ kind: Type.Literal("tts"), sourceSha256: documentHash, pageNumber: Type.Integer({ minimum: 1, maximum: 100 }),
      actionId: id, model: id, voice: Type.Optional(Type.Union([Type.String({ pattern: "^[A-Za-z0-9_-]{1,64}$" }), Type.Null()])) }, { additionalProperties: false }),
    Type.Object({ kind: Type.Literal("tts"), sourceSha256: documentHash, pageNumber: Type.Integer({ minimum: 1, maximum: 100 }),
      actionIds: Type.Array(id, { minItems: 1, maxItems: 100, uniqueItems: true }), model: id,
      voice: Type.Optional(Type.Union([Type.String({ pattern: "^[A-Za-z0-9_-]{1,64}$" }), Type.Null()])) }, { additionalProperties: false }),
    Type.Object({ kind: Type.Literal("music"), sourceSha256: documentHash, pageNumber: Type.Integer({ minimum: 1, maximum: 100 }), model: id,
      actionId: Type.Optional(id), prompt: Type.String({ maxLength: 4000 }), music: Type.Object({ title: Type.String({ minLength: 1, maxLength: 100 }),
        tags: Type.Optional(Type.String({ maxLength: 1000 })), negativeTags: Type.Optional(Type.String({ maxLength: 1000 })),
        instrumental: Type.Optional(Type.Boolean()) }, { additionalProperties: false }) }, { additionalProperties: false }),
  ]), description: "Start authorized TTS, music or video for this saved source/page through server quotes and durable idempotent jobs. Reuses the same original request on recovery, never resubmits an unknown job. Use actual source hash, speech ID, models and voices from media context. For multiple TTS speeches on one page, prefer actionIds (up to 100 real speech IDs) instead of separate actionId calls: synthesis and verified archives run in parallel batches of at most ten, with revision-safe adoption. Inspect per-action results, failures and original pending jobs; retry only missing audio, never unknown paid submissions. Full-course narration/TTS and planned media need no per-page confirmation. Video requires a saved video_slot action ID; use a video block in narration to plan it, then quote and submit a configured video model. Music is generated only where requested by the lesson/user. Use the saved music_slot actionId to replace that slot at its exact timeline position; provide real lyrics or an instrumental prompt. Completed music is automatically exported, verified and attached as a separate playable clip, preserving speech. Returns actual saved readiness or a pending job; keep the Chat turn active until original jobs finish." },
  { name: "courseware_media_refresh", label: "Check saved courseware media", parameters: mediaParameters([Type.Object({
    kind: Type.Union([Type.Literal("tts"), Type.Literal("music"), Type.Literal("video")]), sourceSha256: documentHash,
    pageNumber: Type.Integer({ minimum: 1, maximum: 100 }), intentId: id, waitForUpdate: Type.Optional(Type.Boolean()), retryFailed: Type.Optional(Type.Boolean()),
  }, { additionalProperties: false }), Type.Object({ kind: Type.Literal("tts"), sourceSha256: documentHash,
    pageNumber: Type.Integer({ minimum: 1, maximum: 100 }), intentIds: Type.Array(id, { minItems: 1, maxItems: 100, uniqueItems: true }),
    waitForUpdate: Type.Optional(Type.Boolean()),
  }, { additionalProperties: false }), Type.Object({ kind: Type.Literal("tts"), sourceSha256: documentHash, recover: Type.Literal(true),
    pageNumbers: Type.Optional(pageNumbers), model: Type.Optional(id), voice: Type.Optional(Type.Union([id, Type.Null()])),
  }, { additionalProperties: false })]), description: "For native PPT full-deck recovery pass kind:tts,recover:true and sourceSha256; optional pageNumbers scopes pages and model/voice disambiguate original orders. Recovery retains valid audio, queries originals and adopts ready output without quoting or purchasing. Multiple matches require an explicit original intent ID. Missing/prepared/unknown/failed originals remain unfinished. It saves successful pages even when another fails; inspect results, failures and audioReady separately from saved. Check original saved media jobs; for TTS prefer intentIds from one page to refresh, download, decode and archive at most ten concurrently, with revision-safe adoption. Single intentId remains supported. Optionally poll every three seconds for up to 30 seconds per job. Verify, archive and adopt settled real output automatically. Music generation also completes its original export job. Prefer job.intentId for refresh; music also accepts media.intentId from an export result and resolves its original generation job. Returned job.intentId stays the generation ID. Unknown submissions remain query-only. When the latest user explicitly requests a retry/new request for a failed TTS/music/video job, set retryFailed:true with its single original intentId. Main verifies terminal failure and finalized accounting, preserves original receipts and content, and creates/reuses one fresh attempt. This scoped request is sufficient after a previous stop/no-new-requests instruction. Music-export failures retry the export, retaining successful music. Automatic continuation never sets retryFailed; it does not authorize unrelated work or replacement of unknown/running/successful jobs. Continue querying in the active Chat while waitingFor:service. Inspect batch results and failures. saved:true means bytes and adoption succeeded; terminal failures must be reported, never described as awaiting user confirmation." },
  assessmentMediaDefinition,
  coursewarePresentationPrepareDefinition,
  coursewarePresentationDefinition,
];

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

function allowedValues(schema: TSchema, segments: string[]): string[] {
  if ("anyOf" in schema && Array.isArray(schema.anyOf))
    return schema.anyOf.flatMap(branch => allowedValues(branch as TSchema, segments));
  if (segments.length) {
    const properties = "properties" in schema ? schema.properties : undefined;
    const next = record(properties) ? properties[segments[0]!] : undefined;
    return record(next) ? allowedValues(next as TSchema, segments.slice(1)) : [];
  }
  return "const" in schema && typeof schema.const === "string" ? [schema.const] : [];
}

function invalidInput(schema: TSchema, input: unknown, toolName: string): CoursewareWorkflowError {
  if (toolName === "courseware_scene_image_refresh" && record(input) &&
      (input.generateRemaining === true && [input.generatePrepared, input.retryFailed, input.waitForUpdate].includes(true) ||
       input.generatePrepared === true && input.retryFailed === true))
    return new CoursewareWorkflowError("COURSEWARE_INVALID_REFRESH", "generateRemaining:true must be used alone with intentId; generatePrepared and retryFailed cannot both be true.", toolName);
  const collect = (branch: TSchema) => {
    const errors: Array<ReturnType<typeof Errors>[number]> = [];
    for (const error of Errors(branch, input)) {
      errors.push(error);
      if (errors.length === 16) break;
    }
    return errors;
  };
  const errors = "anyOf" in schema && Array.isArray(schema.anyOf)
    ? schema.anyOf.map(branch => collect(branch as TSchema)).sort((a, b) => a.length - b.length)[0] ?? []
    : collect(schema);
  const hints: string[] = [];
  const path = (value: string) => /^\/(?:[A-Za-z0-9_-]+\/?)*$/u.test(value) && value.length <= 160 ? value || "/" : "/";
  const add = (hint: string) => { if (!hints.includes(hint) && hints.length < 3) hints.push(hint); };
  const enumPaths = new Set(errors.filter(error => error.keyword === "const").map(error => error.instancePath));
  for (const field of enumPaths) {
    const segments = field.split("/").slice(1);
    const allowed = [...new Set(allowedValues(schema, segments))];
    const current = segments.reduce<unknown>((value, segment) => record(value) ? value[segment] : undefined, input);
    if (allowed.length && !allowed.includes(current as string)) add(`${path(field)} must be one of: ${allowed.join(", ")}`);
  }
  for (const error of errors) {
    if (["minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems"].includes(error.keyword)) {
      const limit = "limit" in error.params ? error.params.limit : undefined;
      if (typeof limit === "number") add(`${path(error.instancePath)} ${error.message}`);
    } else if (error.keyword === "uniqueItems") add(`${path(error.instancePath)} must contain distinct items`);
    else if (error.keyword === "pattern") add(`${path(error.instancePath)} must match the required format`);
    else if (error.keyword === "type" && "type" in error.params &&
      ["string", "integer", "number", "boolean", "array", "object"].includes(String(error.params.type))) {
      const expected = String(error.params.type);
      add(`${path(error.instancePath)} must be ${["integer", "object", "array"].includes(expected) ? "an" : "a"} ${expected}`);
    }
  }
  if (!hints.length) for (const error of errors) {
    if (error.keyword !== "required") continue;
    const names = error.params.requiredProperties;
    if (Array.isArray(names)) for (const name of names) {
      if (typeof name === "string" && /^[A-Za-z][A-Za-z0-9_]*$/u.test(name)) add(`${path(error.instancePath).replace(/\/$/u, "")}/${name} is required`);
    }
  }
  if (!hints.length) add("check the tool's required fields and allowed shape");
  return new CoursewareInputError(toolName, hints.join("; "));
}

function invalidStory(story: unknown): CoursewareWorkflowError {
  let hint = "check story references and size";
  if (Check(coursewareStorySchema, story)) {
    if (new TextEncoder().encode(JSON.stringify(story)).length > 65536) hint = "/story exceeds 65536 bytes";
    else {
      const duplicate = story.beats.findIndex((beat, index) => story.beats.findIndex(other => other.id === beat.id) !== index);
      const unmatched = story.beats.findIndex(beat => !story.objectives.includes(beat.objective));
      if (duplicate >= 0) hint = `/story/beats/${duplicate}/id must be unique`;
      else if (unmatched >= 0) hint = `/story/beats/${unmatched}/objective must reference /story/objectives`;
    }
  }
  return new CoursewareInputError("courseware_story_save", hint);
}

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
      const { pageId, pageNumber, code, repair, repairable, message } = issue;
      grouped.set(JSON.stringify([pageId, pageNumber, code]), { pageId, pageNumber, code, repair, repairable,
        ...(typeof message === "string" ? { message } : {}) });
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

// Some DeepSeek calls append the next typed parameters to the saved document hash.
function restoreCoursewareArguments(schema: TSchema, args: unknown) {
  if (!record(args) || typeof args.sourceSha256 !== "string") return args;
  const hash = /^([a-f0-9]{64})<\/sourceSha256>\s*/.exec(args.sourceSha256);
  if (!hash) return args;
  const restored: Record<string, unknown> = { ...args, sourceSha256: hash[1] };
  let tail = args.sourceSha256.slice(hash[0].length);
  while (tail) {
    const item = /^<｜｜DSML｜｜ parameter name="(apply|lessonPlan|speechCount|repairObjectsOnly|voice|waitForUpdate)" string="(false|true)">([^<]+)(?:<\/(?:parameter|\1)>)?\s*/.exec(tail);
    if (!item) return args;
    let value: unknown;
    try { value = item[2] === "true" ? item[3] : JSON.parse(item[3]); } catch { return args; }
    if (item[1] === "apply" && value !== false) return args;
    if (Object.hasOwn(restored, item[1]) && restored[item[1]] !== value) return args;
    restored[item[1]] = value;
    tail = tail.slice(item[0].length);
  }
  return Check(schema, restored) ? restored : args;
}

export function createCoursewareWorkflowTools(host: Host, sessionId: string, getTurnId: () => string | undefined, getUserRequests?: () => string): AgentTool[] {
  let teachingAdoptionTurn: string | undefined;
  return definitions.map(definition => ({ ...definition, executionMode: "sequential",
    ...(definition.name === "courseware_scene_image_prepare" ? {
      prepareArguments: (args: unknown) => {
        // Older model turns can echo a reference for a master. The approved cover owns that choice.
        if (!record(args) || !record(args.target) || args.target.kind !== "visualMaster" || !Object.hasOwn(args, "referenceIntentId")) return args;
        const { referenceIntentId: _, ...master } = args;
        return master;
      },
    } : {}),
    ...([coursewarePresentationPrepareDefinition.name, coursewarePresentationDefinition.name].includes(definition.name) ? { prepareArguments: normalizePresentationArguments } : {}),
    ...(["courseware_narration_plan", "courseware_narration_propose", "courseware_media_prepare", "courseware_media_refresh"].includes(definition.name) ? {
      prepareArguments: (args: unknown) => restoreCoursewareArguments(definition.parameters, args),
    } : {}),
    async execute(toolCallId, input, signal) {
      if (!Check(definition.parameters, input)) throw invalidInput(definition.parameters, input, definition.name);
      const story = record(input) ? Reflect.get(input, "story") : undefined;
      if (definition.name === "courseware_story_save" && !isCoursewareStory(story)) throw invalidStory(story);
      const turnId = getTurnId();
      if (!turnId) throw new Error("Courseware tools require an active Chat turn");
      signal?.throwIfAborted();
      const abort = () => { void host.call("tools.abort", { sessionId, toolCallId }).catch(() => undefined); };
      signal?.addEventListener("abort", abort, { once: true });
      try {
        const args: unknown = structuredClone(input);
        if (definition.name === "courseware_narration_propose" && record(args) && !args.repairRequiredTeaching) {
          // The agent selects pages. Saved page plans and the user's words authorize teaching requirements.
          const requests = getUserRequests?.().trim();
          if (requests) args.instruction = requests.length <= 8000 ? requests : requests.slice(0, 4000) + "\n" + requests.slice(-3999);
          if (getUserRequests && !(typeof args.speechCountEvidence === "string" && requests?.includes(args.speechCountEvidence)))
            delete args.speechCount;
        }
        if (definition.name === "courseware_narration_propose" && record(args)) delete args.speechCountEvidence;
        if (definition.name === "courseware_presentation_adopt" && record(args)) {
          if (args.continueTeaching !== false) teachingAdoptionTurn = turnId;
          else if (teachingAdoptionTurn === turnId) args.continueTeaching = true;
        }
        const result = await host.call<{ ok: boolean; content: unknown; errorCode?: string }>("tools.execute", {
          sessionId, turnId, toolCallId, toolName: definition.name, mode: "agent", args,
          ...(["courseware_presentation_adopt", "courseware_scene_image_prepare", "courseware_scene_image_refresh", "courseware_scene_generate_remaining", "courseware_scene_compile", "courseware_narration_context", "courseware_narration_propose", "courseware_narration_plan", "courseware_narration_import", "courseware_activity_insert", "courseware_media_prepare", "courseware_media_refresh", "courseware_media_context", "courseware_media_assessments"].includes(definition.name) ? { timeoutMs: 16 * 60_000 } : {}),
        });
        signal?.throwIfAborted();
        if (getTurnId() !== turnId) throw new Error("Courseware Chat turn changed; read saved workflow before continuing");
        if (!result || result.ok !== true) {
          const nested = result?.content && typeof result.content === "object" && "error" in result.content ? result.content.error : undefined;
          const code = typeof nested === "string" ? /^([A-Z][A-Z0-9_]+)(?: \(scene-\d{3}\))?(?::|$)/u.exec(nested)?.[1] : undefined;
          const phase = record(result?.content) ? result.content.phase : undefined;
          throw new CoursewareWorkflowError(code ?? result?.errorCode ?? "COURSEWARE_WORKFLOW_FAILED", `${result?.errorCode ?? "COURSEWARE_WORKFLOW_FAILED"}: ${JSON.stringify(result?.content)}`,
            undefined, phase === "opening" || phase === "saving" || phase === "focus" ? { cause: { phase } } : undefined);
        }
        return { content: [{ type: "text", text: JSON.stringify(["courseware_media_context", "courseware_narration_context"].includes(definition.name) && record(result.content) ? coursewareStatusSummary(result.content, definition.name === "courseware_narration_context" && Array.isArray(Reflect.get(input as object, "pageNumbers"))) : result.content) }], details: result.content };
      } finally { signal?.removeEventListener("abort", abort); }
    },
  }));
}
