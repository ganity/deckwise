---
name: scene-courseware
description: Plan and revise scene-based courseware, then use available Host stages for layered assets and independently editable PPTX objects.
---

Follow the Host-selected phase and read `courseware_workflow_get` before advancing. The main Chat owns the workflow. Planning is available before asset generation or compilation. Unavailable later stages do not block planning; do not substitute ordinary presentation generation or claim those later stages have completed.

## Main Chat progression

Collect missing essential teaching requirements with `asktool`; save confirmed fields using `courseware_requirements_update` before plan approval or source attachment. Reuse saved requirements and current conversation answers. If a plan already exists and the user says continue, inspect its approval and asset readiness rather than recreating it.

Before asking about Quiz/checkpoints, save an explicit requested page count in `educationContext.bodyPageLimit` using `courseware_requirements_update`. This is the body-page budget, including ordinary cover/summary slides; assessments are additional physical pages. Preserve the saved count when updating other requirements and copy it into `plan.bodyPageLimit`. For 8 body pages plus one Quiz and one checkpoint, retain 8 body pages and plan 10 physical pages. Ask only about missing assessment needs, describing them as additional pages; never offer an option that turns the requested 8 body pages into 6 body pages plus 2 assessments. Change a confirmed body budget only when the user explicitly revises that requirement.

Before approval, create/revise the planning draft below and ask the user to review the main Chat plan card. Do not approve it yourself. After actual human approval:

1. Read existing intents and the role-specific model catalog. Use the configured image role for visual masters and the decomposition role for cleanPlate; omit model IDs to use server configuration. Never substitute generic image generation for a failed scene service.
2. Generate only the first page visual master with `courseware_scene_image_prepare`. For an existing `prepared` intent, call `courseware_scene_image_refresh` with its original intentId and `generatePrepared:true`; this submits that unsubmitted request using the current model catalog. Plain refresh only queries. Unknown/already submitted outcomes stay query-only even with this option. On model unavailability, report that error and stop; an empty model catalog is not a ready image. Ask for style confirmation only when `requiresHumanSelection:true` and `image.asset` exists. Direct the user to **Scene image preview → cover → Use this style and continue** in the right details pane. `requiresGeneration:true` means the image still needs generation; pending/failed tasks require status recovery or an error report. Do not submit other pages before actual cover confirmation.
3. After style confirmation, continue the remaining visual masters without further per-image approval. Host automatically binds the selected first-page image as the cross-page style and character reference. Preserve that reference; do not copy its cast count, composition or text into unrelated pages. Use the approved visualBible and name only this page’s required subjects in instructions. Reuse existing pending requests with `courseware_scene_image_refresh`; never recreate them. Preparation returns the current job state promptly. Continue independent missing assets after style confirmation, including when another submission is unknown. When only pending work remains, call refresh on original intents with `waitForUpdate:true`; it polls for up to 30 seconds. Continue original-job recovery while semantic progress is possible. No semantic progress for ten minutes ends this run with one accurate handoff; a new user continuation may resume original jobs. `waitingFor:service` is background processing, not human review. `styleConfirmed:true` stays authoritative while decomposition is pending. Ask for first-page style confirmation only when `requiresHumanSelection:true`; later images and decomposition need no user action. An unknown original request stays query-only and does not block other intents.
4. Decompose every selected master using target `cleanPlate`, the configured decomposition model and that page's selected master as `referenceIntentId`. Use the built-in MAIC decomposition prompt without additional instructions. A decomposition archives the clean background and its named foreground layers together; do not generate those foregrounds again. After the first style approval, verified later results and complete decomposition groups are selected automatically.
5. Read workflow readiness; when no blockers remain, call `courseware_scene_compile`. It builds editable page objects and saves each page's planned narration. For an authorized complete teaching course, pass `continueTeaching:true`; omit it when the user only wants PPTX. PPTX is an intermediate, and its initial outline narration is not detailed teaching or synthesized speech.
6. For a complete teaching course, read `courseware_media_context` with `continueTeaching:true`, including when resuming an already compiled course. Generate missing detailed narration for all required pages together with `courseware_narration_propose`. Preserve already saved detailed narration/audio unless regeneration was requested. Read the TTS catalog, use actual speech IDs, and call `courseware_media_prepare` for missing speech audio. Use a real configured voice. Original pending jobs are refreshed and verified output is automatically archived and adopted without page navigation or per-result confirmation.
7. Where the lesson requires music, use the music catalog and real lyrics/instrumental options. Music preparation continues through candidate generation, export, byte verification and saved-page audio-clip adoption. Refresh its original generation job; the service also recovers the original export. Do not purchase replacement exports for uncertain submissions. A receipt or preview is not saved playable music.
8. Retain required video in `teaching.video` with purpose and prompt. Detailed narration includes a video block that saves a `video_slot`. Read `courseware_media_context` with `kind:video`, then prepare that slot using `courseware_media_prepare` with its saved action ID and a configured model. Refresh the original job through verified MP4 download, actual decode, Host archive and automatic `video_clip` adoption. Each task creates one clip; leave duration, ratio, resolution and audio settings to provider defaults unless specified. A missing model or failed task is an error to report; an unknown submission remains query-only.

### Cover corrections before style confirmation

For a user-requested cover-only rendering or composition correction, keep the
approved `plan.json` bytes unchanged. After the original cover is ready, call
`courseware_scene_image_prepare` with the same approved `planSha256`, first-page
`pageId`, target `visualMaster`, and the correction in `instructions`. For example,
exclude unrequested human figures while keeping the page's required animals,
display text, teaching and art direction. Refresh the new original job until ready,
then ask the user to confirm that cover's style. Keep previous image receipts.

An actual lesson-plan revision, including changed teaching, visible text or
course-wide required subjects, changes the approved file hash. Explain that the
revised plan needs human approval again before generating from it. A successful
submit only validates the draft; read `awaitingPlanApproval` for its actual state.

For body-page `QUESTION_MISSING`, `QUESTION_TYPE_MISMATCH`, `MUSIC_MISSING` or `VIDEO_MISSING` on an already narrated page, call `courseware_narration_propose` with `repairRequiredTeaching:true`. Independent Quiz/checkpoint pages retain their own question reading; use courseware_media_assessments for its missing TTS rather than generating body lecture. On body pages, the tool inserts missing approved actions at existing speech IDs; it retains speech, audio and effects. Do not ask the model to echo or rewrite saved speech to fill these gaps. The required question text, ordered options and answer indices must match the approved contract.

Check saved actions, `teachingReady`, `audioReady` and `videoReady` before declaring the baseline teaching chain complete. Preserve plan approval and first-page style confirmation; do not ask for per-page teaching approval. Deliver the editable PPTX with saved teaching data. Build PPTist only when publishing a fixed version; never publish automatically after generation.

After submitting or explicitly waiting for scene/media jobs, the runtime keeps this same turn active if a closing response arrives too early. It queries original jobs and returns a current saved-state update when progress allows the next step. Use that update to perform the missing work; do not end with a request to click Continue. Status-only questions do not authorize generation.

Image generation uses server-side billing with no fee prompt or payment confirmation in Chat. Human decisions are plan approval and first-page style confirmation, not repeated task refreshes or per-image payment controls. A user stop, changed conversation/account/plan, provider failure or missing capability must stop further work. A submitting job is executing and may be polled. A submission_unknown outcome, archive_failed/failed state, or errorCode ends waiting on that intent: report the actual state and error rather than repeatedly polling or asking for confirmation. Independent missing intents may still be submitted after style confirmation. Keep the original request identity; an unknown outcome never authorizes another paid submission.

## Current media capability boundary

When the latest user message explicitly requests a new attempt for failed pages or media, use `retryFailed:true` on `courseware_scene_image_refresh` or a single-intent `courseware_media_refresh` for each specified failed job. This scoped request is sufficient authorization after an earlier user stop; no special revocation wording is required. Main verifies a confirmed terminal failure and finalized accounting, then creates one durable successor with the same source, target and model; decomposition uses the built-in MAIC prompt, including for legacy failures. Repeating the same call reuses that successor. Preserve the old receipt, report the requested results, and keep other pages/media unchanged. Ordinary continuation remains original-job recovery; running, successful and unknown outcomes stay query-only. A further failure can be retried through its successor only after another explicit user retry request.

Desktop has three entry paths: ordinary generation, scene generation and PPT import. They share one PPTX editor and the same baseline teaching capabilities. Scene mode supports both kindergarten and primary; stage changes audience, subject and activity policies, never availability of narration, TTS, animation, interaction, highlight or spotlight. Plan video and music from actual lesson requirements. Keep these requirements through the editable PPTX intermediate. A wait is not a real assessment, a video is not a substitute for deterministic object animation, and generating TTS does not prove the final player executes its cues.

Detailed narration must use current saved object UUIDs and observed character/text aliases. Introductions, different teaching targets and later revisits are separate short speech blocks. Bind spotlight to the named character and highlight to its text carrier; distinguish a character from its name label and repeated portraits. Reveal only when the lesson intends an entrance; emphasize an already visible object again with pulse. Keep decoration static and omit ambiguous targets. Narration generation validates exact spoken anchor quotes and converts them to short TTS segments; use adopted decoded audio intervals, never estimated character timing. Do not treat a visual preview or outline narration as proof of synchronized playback. Saved native PPT animation targets retain one animation owner; do not layer generated teaching motion over them.

When narration validation fails, batch only the failed pages and retain saved successes. `attention.anchorText` is optional: when supplied it must occur exactly once in that same `speech.text`; it need not equal visible text or use quotation markers. For repeated anchor errors, omit this optional field while retaining valid object focus and separate short speech. Body candidate blocks use `speech`, approved `music`/`video` and finite `wait`, not the saved action names `interaction_checkpoint` or `music_slot`. Kindergarten `english_phrase` blocks are optional classroom commands from the approved bank, at most two per page; ordinary lesson vocabulary, character names and lyrics belong in `speech`. Correct invalid JSON rather than removing required questions, music or narration.


Media concurrency is independent by type: TTS 10, images 5, layer decomposition 5, music generation 2, music export 2 and video 2. Waiting in a queue is still prepared; only admitted dispatch begins a submission. Unknown originals keep their identities. Ambiguous legacy bindings require an explicit resolution, not another purchase.

The saved-source tools complete TTS, music and planned video slots through verified archive/adoption; leave clip duration, aspect ratio, resolution and audio settings to model defaults unless explicitly specified. Body narration generates mapped highlight/spotlight intent and finite fadeIn/pulse object motion; independent checkpoint pages own teacher-led questions and reference answers. Verified speech audio supplies timing; generated scene pages become ready automatically after Host validates actions, targets and adopted media receipts, with no unresolved video slot. The fixed player waits for a mounted video to end before resuming. Full MAIC motion parity and automatic answer grading remain unsupported. Canvas drafts remain metadata; only verified adopted media count as playable output. Preserve requested stages and report actual missing capabilities without inventing output or asking for redundant confirmation.

## Planning draft

When Host supplies an approved teaching story, preserve its objectives, characters, event order and activities, and include the supplied storySha256 at the JSON root. A story beat can span body pages and separate assessment pages. Never reuse a draft from a different story revision.

Use the exact current-Chat planning file supplied by the Host. If it exists, read it before changing it. Save UTF-8 JSON with exactly this structure:

```json
{
  "title": "Lesson title",
  "bodyPageLimit": 1,
  "visualBible": {
    "artDirection": "Requested medium, materials, palette and lighting",
    "characters": "Every recurring character: name, species, silhouette, proportions, colors, markings and outfit",
    "setting": "One coherent visual world and default location; list teaching-related reasons for location changes"
  },
  "pages": [
    {
      "title": "Page title",
      "visibleText": [
        "Hello"
      ],
      "visualIntent": "Friend waves in the classroom; reserve clear space for the editable greeting text.",
      "narration": "Look at our friend. How can you greet them?",
      "teaching": {
        "pageType": "slide",
        "phase": "opening",
        "objective": "Greet a friend",
        "durationSeconds": 60,
        "requiredObjects": [
          "Friend"
        ],
        "music": {
          "purpose": "Opening greeting song",
          "prompt": "A cheerful Hello Song for waving and clapping"
        },
        "video": {
          "purpose": "Demonstrate the greeting gesture",
          "prompt": "A silent demonstration of Friend waving in the approved classroom style"
        }
      }
    },
    {
      "title": "Greeting checkpoint",
      "visibleText": [],
      "visualIntent": "Dedicated MAIC classroom checkpoint template",
      "narration": "",
      "teaching": {
        "pageType": "interactive",
        "phase": "opening",
        "objective": "Greet a friend",
        "durationSeconds": 30,
        "requiredObjects": [],
        "question": {
          "text": "Wave and say hello!",
          "response": {
            "kind": "practice",
            "options": [],
            "answerIndices": []
          },
          "referenceAnswer": {
            "summary": "Wave and say Hello!",
            "keyPoints": [
              "Wave",
              "Say Hello"
            ]
          },
          "constraintPrompt": "Encourage a wave and a spoken greeting; accept Hi as a greeting too."
        }
      }
    },
    {
      "title": "Choose a greeting",
      "visibleText": [],
      "visualIntent": "Independent MAIC quiz page; question and choices are rendered from quiz content rather than a raster slide.",
      "narration": "",
      "teaching": {
        "pageType": "quiz",
        "phase": "review",
        "objective": "Identify a greeting",
        "durationSeconds": 40,
        "requiredObjects": []
      },
      "quiz": {
        "type": "quiz",
        "interactionMode": "classroom_instant_feedback",
        "questions": [
          {
            "id": "greeting-choice",
            "type": "single",
            "question": "Which word greets a friend?",
            "options": [
              {
                "value": "A",
                "label": "Hello"
              },
              {
                "value": "B",
                "label": "Goodbye"
              }
            ],
            "answer": [
              "A"
            ],
            "analysis": "Hello is a greeting; Goodbye is used when leaving."
          }
        ]
      }
    }
  ]
}
```

New plans include visualBible; preserve it when editing an existing plan. Its three strings must be nonempty and total at most 1000 characters. Legacy plans without it remain readable; do not rewrite an approved plan just to add it. Never default all courses to glossy 3D. Preserve character identity across poses, and do not introduce extra mascots, duplicate character badges or decorative animals. Keep a common setting unless a page has a teaching-related reason to change location.

New complete-course plans retain each page's requirements in teaching. Use pageType slide|quiz|interactive|pbl and phase opening|explore|practice|review. objective is nonempty and at most 1000 characters; durationSeconds is an integer from 5 to 1800; requiredObjects has at most 30 unique nonempty names, each at most 200 characters. Save explicitly requested synchronized effects in teaching.requiredEffects, using the exact categories highlight, spotlight and animation. Retain the exact requested preset and target in the page objective; for example, red-circle fadeIn, red-circle spotlight and Circle-title highlight. Prose outside the saved teaching requirements does not make them executable requirements.

For pageType=quiz, save the independent MAIC quiz object at page.quiz alongside teaching, as in the example. Keep question text, choices, answers and analysis in quiz; teaching.question is omitted. Use exactly one question per Quiz page, with a unique stable id. Use single or judge for the classroom editor; retain existing multiple/short_answer data when supplied. Put additional questions on additional Quiz pages. Insert each Quiz after its related body content and before the next body page; never collect all questions at the end. These additional pages do not reduce the body-page budget. Choice questions have 2–4 options with unique value/label pairs; answer contains the matching option values, such as ["A"], rather than indices. single/judge has one answer value and judge has exactly two options. For short_answer, use answer:[reference text], referenceAnswer and keyPoints, with optional commentPrompt for grading guidance. Use interactionMode classroom_instant_feedback for generated classroom Quiz pages. Quiz pages are rendered and edited independently from quiz content; use empty visibleText and do not request a visual master, decomposition or a checkpoint for them.

Route explicit single-choice, multiple-choice and true/false assessment to Quiz, including questions inside a classroom game. Preserve a suitable assessment from the lesson plan in addition to the requested body page limit; retain the illustrated body activity and add the assessment as a separate physical page. For example, selecting mum/dad/brother/sister with one correct option is a Quiz with stable A–D values, while singing, clapping or saying an open-ended sentence is teacher-led practice. Plan both independently when the lesson requires both. A lesson without an assessment need does not require an invented Quiz quota.

For interactive/pbl pages, save teaching.question with text, response, referenceAnswer:{summary,keyPoints} and optional constraintPrompt. This becomes a distinct interaction_checkpoint, with an editable question and feedback guidance. text is at most 160 characters; the compiler adds a separate editable question text frame, so omit the question from visibleText and image lettering. Keep reference answers and grading guidance in referenceAnswer/constraintPrompt, outside visibleText, raster lettering and spoken narration. response contains exactly kind (short_answer|discussion|practice|pbl), options:[] and answerIndices:[]. Preserve an explicitly requested response kind: a requested short-answer question uses short_answer even when the teacher handles it orally. These planning hints do not become a custom response form on the MAIC checkpoint. Omit page.quiz on these pages. Ordinary slide pages retain the activity illustrations, rules and narration. Put the student-response question on an additional standalone checkpoint page, never in body narration actions. For example, Freeze game rules and characters on mats stay on a body slide; asking the student to say a sentence becomes the following checkpoint. Assessment pages use a recognizable Quiz or classroom-interaction placeholder and their dedicated question editor.

Include music only on pages that require it, with exactly purpose (at most 500 characters) and prompt (at most 4000); put lyrics and style in prompt. Include video only when required, with exactly purpose (at most 500 characters) and prompt (at most 4000), describing one focused silent demonstration without imposing duration or output settings. Free-text mentions alone do not retain executable question, music or video requirements. Legacy plans may omit teaching.

Preserve every lesson-required character, name and prop; do not cap their count. A page teaching five animals and all five names must show them all. Specify required subjects and their teaching roles in visualIntent and exact names in visibleText when needed. Do not add unrequested subjects, duplicate portraits/badges, extra text carriers or decorative props. The visual bible describes identities, not a cast list for every page. Preserve the requested style and setting; build atmosphere with depth, light, color and materials rather than extra objects.

Use 1–100 total pages, with at most 30 body pages; title and page titles are 1-200 characters; each page has at most six nonempty visible-text strings of at most 160 characters. Visual intent is 1-1000 characters and body narration 1–2500 characters. Quiz/checkpoint pages use narration:"", visibleText:[], requiredObjects:[] and omit music/video. The complete UTF-8 file must fit within 256 KiB. Do not add paths, URLs, page IDs, hashes, media task IDs or credentials to the JSON. Host derives draft page identifiers and hashes after validation.

For a page-specific request, preserve the remaining pages and their order. For a whole-course request, explain the proposed teaching progression and revise only what the user requested. Read back the saved JSON and call courseware_scene_plan_submit. Resolve its exact validation errors before presenting the draft for approval; a file-write receipt or JSON parse does not validate a plan. Compare explicit user requirements, including exact song names and page placement, with the draft before submission. A draft is not an approved lesson, a ready asset or a generated PPTX. Stop for actual plan review before preparing assets. After approval, follow the separate advertised workflow tools and user-review boundaries; the planning-file phase precedes asset generation and compilation.

Follow the Host's age, grade, subject and language policies independently of this entry. Keep student-facing words in visibleText and only spoken teacher sentences in narration. Put unspoken teaching operations, participation and waiting intent in visualIntent; the planning JSON does not encode executable waits. Classroom pauses and teacher continuation use the existing teaching controls after the PPTX is opened.

New plans omit `textMode`. The visual master is the complete teaching-page design, including the exact approved `visibleText` rendered in the image. Follow the MAIC composition rules: one focal action, developed full-canvas environment with depth, light and texture, and independent non-overlapping subjects and text. Preserve the requested art direction and keep narration off the slide. Review the image's actual lettering against `visibleText`. Use the decomposition prompt unchanged: separate foreground subjects and complete text carriers with their lettering intact. Preserve the returned base and every foreground image at the supplied bounds and stacking as separate PPTX image objects. All lettering stays in the image pixels; do not erase it or reconstruct replacement native text, shapes or extra copies. `visibleText` is semantic/planning context for compilation. Internal page titles add no displayed copy.

Preserve the text mode of already approved plans, including existing `textMode:"native"` plans with textless artwork. Do not change their mode or regenerate paid assets during a retry. Changing an approved plan's mode requires explicit review and matching regenerated artwork to avoid missing or duplicate lettering. Image lettering is editable only as an image layer, not as individual native text.

Use authorized Host services for assets, then compile separate PNG image layers, including text carriers. Matching canvas dimensions, unique object IDs and every reviewed foreground are required. No flattening, invented copy, replacement native text, shapes or connectors. Already approved native-mode plans retain their existing exact-text compilation path. Independent Quiz and checkpoint pages keep their structured questions and editable question presentation. When the user gives an exact number of narration blocks, forward it as `speechCount` to `courseware_narration_propose`; animation focus changes must not silently increase that count.

Produce editable PPTX, logical object mapping, assets and saved page teaching with automatic validation. SVG, if used, is an intermediate candidate only. After opening in WiseOffice, use `deckwise/ppt-edit` and the latest PPTX baseline for further changes.
