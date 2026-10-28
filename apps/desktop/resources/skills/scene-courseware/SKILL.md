---
name: scene-courseware
description: Plan and revise scene-based courseware, then use available Host stages for layered assets and independently editable PPTX objects.
---

Follow the Host-selected phase and read `courseware_workflow_get` before advancing. The main Chat owns the workflow. Planning is available before asset generation or compilation. Unavailable later stages do not block planning; do not substitute ordinary presentation generation or claim those later stages have completed.

## Main Chat progression

Collect missing essential teaching requirements with `asktool`; save confirmed fields using `courseware_requirements_update` before plan approval or source attachment. Reuse saved requirements and current conversation answers. If a plan already exists and the user says continue, inspect its approval and asset readiness rather than recreating it.

Before approval, create/revise the planning draft below and ask the user to review the main Chat plan card. Do not approve it yourself. After actual human approval:

1. Read existing intents and the role-specific model catalog. Use the configured image role for visual masters and the decomposition role for cleanPlate; omit model IDs to use server configuration. Never substitute generic image generation for a failed scene service.
2. Generate only the first page visual master with `courseware_scene_image_prepare`. For an existing `prepared` intent, call `courseware_scene_image_refresh` with its original intentId and `generatePrepared:true`; this submits that unsubmitted request using the current model catalog. Plain refresh only queries. Unknown/already submitted outcomes stay query-only even with this option. On model unavailability, report that error and stop; an empty model catalog is not a ready image. Ask for style confirmation only when `requiresHumanSelection:true` and `image.asset` exists. Direct the user to **Scene image preview → cover → Use this style and continue** in the right details pane. `requiresGeneration:true` means the image still needs generation; pending/failed tasks require status recovery or an error report. Do not submit other pages before actual cover confirmation.
3. After style confirmation, continue the remaining visual masters without further per-image approval. Host automatically binds the selected first-page image as the cross-page style and character reference. Preserve that reference; do not copy its cast count, composition or text into unrelated pages. Use the approved visualBible and name only this page’s required subjects in instructions. Reuse existing pending requests with `courseware_scene_image_refresh`; never recreate them. Preparation returns the current job state promptly. Continue independent missing assets after style confirmation, including when another submission is unknown. When only pending work remains, call refresh on original intents with `waitForUpdate:true`; it polls for up to 30 seconds. Keep the turn active and continue recovery until ready, failed or stopped. `waitingFor:service` is background processing, not human review. `styleConfirmed:true` stays authoritative while decomposition is pending. Ask for first-page style confirmation only when `requiresHumanSelection:true`; later images and decomposition need no user action. An unknown original request stays query-only and does not block other intents.
4. Decompose every selected master using target `cleanPlate`, the configured decomposition model and that page's selected master as `referenceIntentId`. A decomposition archives the clean background and its named foreground layers together; do not generate those foregrounds again. After the first style approval, verified later results and complete decomposition groups are selected automatically.
5. Read workflow readiness; when no blockers remain, call `courseware_scene_compile`. It builds editable page objects and saves each page's planned narration. For an authorized complete teaching course, pass `continueTeaching:true`; omit it when the user only wants PPTX. PPTX is an intermediate, and its initial outline narration is not detailed teaching or synthesized speech.
6. For a complete teaching course, read `courseware_media_context` with `continueTeaching:true`, including when resuming an already compiled course. Generate missing detailed narration for all required pages together with `courseware_narration_propose`. Preserve already saved detailed narration/audio unless regeneration was requested. Read the TTS catalog, use actual speech IDs, and call `courseware_media_prepare` for missing speech audio. Use a real configured voice. Original pending jobs are refreshed and verified output is automatically archived and adopted without page navigation or per-result confirmation.
7. Where the lesson requires music, use the music catalog and real lyrics/instrumental options. Music preparation continues through candidate generation, export, byte verification and saved-page audio-clip adoption. Refresh its original generation job; the service also recovers the original export. Do not purchase replacement exports for uncertain submissions. A receipt or preview is not saved playable music.
8. Where the approved lesson requires video, detailed narration includes a video block that saves a `video_slot`. Read `courseware_media_context` with `kind:video`, then prepare that slot using `courseware_media_prepare` with its saved action ID and a configured model. Refresh the original job through verified MP4 download, actual decode, Host archive and automatic `video_clip` adoption. Each task creates one five-second clip. A missing model or failed task is an error to report; an unknown submission remains query-only.

Check saved actions, `teachingReady`, `audioReady` and `videoReady` before declaring the baseline teaching chain complete. Preserve plan approval and first-page style confirmation; do not ask for per-page teaching approval. Deliver the editable PPTX with saved teaching data. Build PPTist only when publishing a fixed version; never publish automatically after generation.

After submitting or explicitly waiting for scene/media jobs, the runtime keeps this same turn active if a closing response arrives too early. It queries original jobs and returns a current saved-state update when progress allows the next step. Use that update to perform the missing work; do not end with a request to click Continue. Status-only questions do not authorize generation.

Image generation uses server-side billing with no fee prompt or payment confirmation in Chat. Human decisions are plan approval and first-page style confirmation, not repeated task refreshes or per-image payment controls. A user stop, changed conversation/account/plan, provider failure or missing capability must stop further work. A submitting job is executing and may be polled. A submission_unknown outcome, archive_failed/failed state, or errorCode ends waiting on that intent: report the actual state and error rather than repeatedly polling or asking for confirmation. Independent missing intents may still be submitted after style confirmation. Keep the original request identity; an unknown outcome never authorizes another paid submission.

## Current media capability boundary

Desktop has three entry paths: ordinary generation, scene generation and PPT import. They share one PPTX editor and the same baseline teaching capabilities. Scene mode supports both kindergarten and primary; stage changes audience, subject and activity policies, never availability of narration, TTS, animation, interaction, highlight or spotlight. Plan video and music from actual lesson requirements. Keep these requirements through the editable PPTX intermediate. A wait is not a real assessment, a video is not a substitute for deterministic object animation, and generating TTS does not prove the final player executes its cues.

The saved-source tools complete TTS, music and planned five-second videos through verified archive/adoption. Narration generates mapped highlight/spotlight intent, finite fadeIn/pulse object motion and teacher-led questions with reference answers. Verified speech audio supplies timing; generated scene pages become ready automatically after Host validates actions, targets and adopted media receipts, with no unresolved video slot. The fixed player waits for a mounted video to end before resuming. Full MAIC motion parity and automatic answer grading remain unsupported. Canvas drafts remain metadata; only verified adopted media count as playable output. Preserve requested stages and report actual missing capabilities without inventing output or asking for redundant confirmation.

## Planning draft

Use the exact current-Chat planning file supplied by the Host. If it exists, read it before changing it. Save UTF-8 JSON with exactly this structure:

```json
{
  "title": "Lesson title",
  "visualBible": {
    "artDirection": "Requested medium, materials, palette and lighting",
    "characters": "Every recurring character: name, species, silhouette, proportions, colors, markings and outfit",
    "setting": "One coherent visual world and default location; list teaching-related reasons for location changes"
  },
  "pages": [
    {
      "title": "Page title",
      "visibleText": ["Student-facing page text"],
      "visualIntent": "Concrete scene and independently editable objects needed on this page",
      "narration": "Direct teacher speech for this page"
    }
  ]
}
```

New plans include visualBible; preserve it when editing an existing plan. Its three strings must be nonempty and total at most 1000 characters. Legacy plans without it remain readable; do not rewrite an approved plan just to add it. Never default all courses to glossy 3D. Preserve character identity across poses, and do not introduce extra mascots, duplicate character badges or decorative animals. Keep a common setting unless a page has a teaching-related reason to change location.

Use 1-30 pages; title and page titles are 1-200 characters; each page has at most six nonempty visible-text strings of at most 160 characters. Visual intent is 1-1000 characters and narration 1-2500 characters. The complete UTF-8 file must fit within 256 KiB. Do not add paths, URLs, page IDs, hashes, media task IDs or credentials to the JSON. Host derives draft page identifiers and hashes after validation.

For a page-specific request, preserve the remaining pages and their order. For a whole-course request, explain the proposed teaching progression and revise only what the user requested. Read back and check the saved JSON. A draft is not an approved lesson, a ready asset or a generated PPTX. Stop for actual plan review before preparing assets. After approval, follow the separate advertised workflow tools and user-review boundaries; the planning-file phase precedes asset generation and compilation.

Follow the Host's age, grade, subject and language policies independently of this entry. Keep student-facing words in visibleText and only spoken teacher sentences in narration. Put unspoken teaching operations, participation and waiting intent in visualIntent; the planning JSON does not encode executable waits. Classroom pauses and teacher continuation use the existing teaching controls after the PPTX is opened.

The visual master is a complete teaching-page design with the exact approved visibleText, title hierarchy, composition and main visual. Follow the MAIC visual-master rules: one focal action, a developed full-canvas environment with depth, light and texture, and independent non-overlapping subjects and text. Preserve requested art direction; avoid stiff lineups, empty header bands and generic slot templates unless the lesson requires them. The preview must show the intended text as part of the image; the separate text list is for checking exact wording. Keep narration off the slide. Use the MAIC decomposition prompt unchanged: separate foreground subjects and complete text carriers with their lettering intact; preserve environment decorations in the base. Compile the returned base and every foreground image at its supplied bounds and stacking as separate PPTX image objects. All lettering remains in image pixels; do not erase it or reconstruct native text, shapes or extra copies. visibleText is semantic/planning context. Internal page titles add no displayed copy. Existing generated images remain unchanged until regeneration is requested.

Request resolved assets through the authorized Host services, then compile the validated scene directly into separate PNG image layers, including text carriers. The current compiler requires PNG assets, matching canvas dimensions and unique object IDs. It rejects missing/duplicated image layers and added native text or other objects. Do not flatten the whole page to claim editability. No advanced chart, master or animation editing is implied.

Produce editable PPTX, logical object mapping, assets and page teaching candidates for review. SVG, if used, is an intermediate candidate only. After opening in WiseOffice, use `deckwise/ppt-edit` and the latest PPTX baseline for further changes.
