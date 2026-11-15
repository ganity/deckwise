---
name: ppt-import
description: Initialize courseware from an existing PPTX while preserving its pages and choosing the source of page narration.
---

Keep the imported PPTX as the document source. Use the Host's import report and logical page mapping; surface unsupported content and diagnostics without claiming full fidelity. Age, grade and subject tune teaching policy and do not change this task into topic-based generation.

Before an Office binding exists, read `courseware_workflow_get`, collect missing requirements in the main Chat and save confirmed teaching settings before source attachment. Use the main Chat's authorized file picker for selection; an already imported source can be opened from the main Chat. Use `courseware_narration_context` to inspect the saved courseware without opening Office. Native selection edits still require a fresh editor binding. File/shell tools and local converters are not an alternative import or editing path.

Offer original speaker notes, external narration or newly generated page narration as explicit choices. Preserve existing page teaching locks and bind direct narration saves to the source and teaching revisions. Notes are an import source, not a parallel teaching database.

Once the document opens in WiseOffice, use the shared teaching workflow in `deckwise/ppt-edit` for narration, final scripts, plan activities, audio and synchronized effects. User-supplied inline activity requirements work without a lesson-plan attachment. Use its Office editing workflow only for changing slide content. Generate previews from a fixed current snapshot through the Host conversion route. Saving does not continuously rebuild previews. Do not regenerate the imported deck from a title or restore old SVG intermediates over it.

## Saved-page narration

For reading saved pages or generating narration, use `courseware_narration_context` and `courseware_narration_propose` through ToolSearch. No editor binding, visible preview or manual navigation is required. Read the deck status, then request at most 5 unfinished pages per call using its current sourceSha256. Process batches sequentially: wait for saved results, reread current context/sourceSha256, then submit the next unfinished batch. Never submit the full deck or concurrent batches. Continue without user confirmation between batches, preserving successful pages. Generation saves each successful page directly to teaching; report savedPages and per-page failures. Successful pages remain saved when another page fails. If a page returns retriable:false, stop automatic retries for that unchanged page in this user turn; do not shorten instructions or use single-page calls to reset its budget. Continue independent unfinished pages and report the failed pages. A later explicit user request permits a fresh bounded attempt budget. Regenerate only the requested pages to replace their narration and clear old speech audio. Never ask for candidate review or adoption. Read current saved teaching before retrying an uncertain save.
