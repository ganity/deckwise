---
name: ppt-import
description: Initialize courseware from an existing PPTX while preserving its pages and choosing the source of page narration.
---

Keep the imported PPTX as the document source. Use the Host's import report and logical page mapping; surface unsupported content and diagnostics without claiming full fidelity. Age, grade and subject tune teaching policy and do not change this task into topic-based generation.

Before an Office binding exists, read `courseware_workflow_get`, collect missing requirements in the main Chat and save confirmed teaching settings before source attachment. Use the main Chat's authorized file picker for selection; an already imported source can be opened from the main Chat. Use `courseware_narration_context` to inspect the saved courseware without opening Office. Native selection edits still require a fresh editor binding. File/shell tools and local converters are not an alternative import or editing path.

Offer original speaker notes, external narration or newly generated page narration as explicit choices. Preserve existing page teaching locks and bind direct narration saves to the source and teaching revisions. Notes are an import source, not a parallel teaching database.

Once the document opens in WiseOffice, use the shared `deckwise/ppt-edit` skill for changes. Generate previews from a fixed current snapshot through the Host conversion route. Saving does not continuously rebuild previews. Do not regenerate the imported deck from a title or restore old SVG intermediates over it.

## Saved-page narration

For reading saved pages or generating narration, use `courseware_narration_context` and `courseware_narration_propose` through ToolSearch. No editor binding, visible preview or manual navigation is required. Read the deck outline, then request every user-authorized page in one call using its sourceSha256. Generation saves each successful page directly to teaching; report savedPages and per-page failures. Successful pages remain saved when another page fails. Regenerate only the requested pages to replace their narration and clear old speech audio. Never ask for candidate review or adoption. Read current saved teaching before retrying an uncertain save.
