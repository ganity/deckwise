---
name: scene-courseware
description: Plan and revise scene-based courseware, then use available Host stages for layered assets and independently editable PPTX objects.
---

Follow the Host-selected phase and read `courseware_workflow_get` before advancing. The main Chat owns the workflow. Planning is available before asset generation or compilation. Unavailable later stages do not block planning; do not substitute ordinary presentation generation or claim those later stages have completed.

## Main Chat progression

Collect missing essential teaching requirements with `asktool`; save confirmed fields using `courseware_requirements_update` before plan approval or source attachment. Reuse saved requirements and current conversation answers. If a plan already exists and the user says continue, inspect its approval and asset readiness rather than recreating it.

Before approval, create/revise the planning draft below and ask the user to review the main Chat plan card. Do not approve it yourself. After actual human approval, prepare only missing assets using `courseware_scene_image_prepare`: visual masters first, then distinct clean-plate backgrounds and named foreground layers using the selected master and a reference-capable model. Check existing intents first; prepared/submitted/unknown requests must not be recreated automatically.

The main Chat supplies exact paid quote confirmation and human preview/selection controls. A prepared image is not submitted, a ready image is not selected, and an approved plan is not a completed deck. Query existing jobs with `courseware_scene_image_refresh` when continuing; do not busy-poll. When readiness has no blockers, use `courseware_scene_compile` and report only its real result. Never send the user to the right control form to advance. Reviewable artifacts may be opened there.

## Planning draft

Use the exact current-Chat planning file supplied by the Host. If it exists, read it before changing it. Save UTF-8 JSON with exactly this structure:

```json
{
  "title": "Lesson title",
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

Use 1-30 pages; title and page titles are 1-200 characters; each page has at most six nonempty visible-text strings of at most 160 characters. Visual intent is 1-1000 characters and narration 1-2500 characters. The complete UTF-8 file must fit within 256 KiB. Do not add paths, URLs, page IDs, hashes, media task IDs or credentials to the JSON. Host derives draft page identifiers and hashes after validation.

For a page-specific request, preserve the remaining pages and their order. For a whole-course request, explain the proposed teaching progression and revise only what the user requested. Read back and check the saved JSON. A draft is not an approved lesson, a ready asset or a generated PPTX. Stop for actual plan review before preparing assets. After approval, follow the separate advertised workflow tools and user-review boundaries; the planning-file phase does not itself authorize paid work or compilation.

Follow the Host's age, grade, subject and language policies independently of this entry. Keep student-facing words in visibleText and only spoken teacher sentences in narration. Put unspoken teaching operations, participation and waiting intent in visualIntent; the planning JSON does not encode executable waits. Classroom pauses and teacher continuation use the existing teaching controls after the PPTX is opened.

Request resolved assets through the authorized Host services, then compile the validated scene into native text, supported shapes, lines and PNG image layers. The current compiler requires PNG assets, matching canvas dimensions and unique object IDs. It reports text styling limits and rejects unsupported objects or missing assets. Do not flatten the whole page to claim editability. No advanced chart, master or animation editing is implied.

Produce editable PPTX, logical object mapping, assets and page teaching candidates for review. SVG, if used, is an intermediate candidate only. After opening in WiseOffice, use `deckwise/ppt-edit` and the latest PPTX baseline for further changes.
