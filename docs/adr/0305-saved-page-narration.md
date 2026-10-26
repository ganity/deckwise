# ADR 0305: Saved-page narration independent of Office preview

Date: 2026-10-25
## Status

Accepted for this task

## Context

The current-selection narration tool requires a visible native Office binding.
This forced users to navigate between pages for deck-wide narration. The user
requested generation independent of preview, and a simpler tabbed human sidebar.

## Decision

Add finite saved-page tools to the existing authorized courseware workflow.
Main resolves the persisted task source and uses the existing revision/archive,
parser and generation helpers; Rust remains the sole owner of teaching and
candidate persistence. No new renderer authority or provider client is added.
The alternative of driving a hidden Office view would preserve a dependency on
selection, visibility and page timers, so it is not used for narration.

Generation saves directly into authoritative teaching. The current-selection and
saved-page tools retain their existing names for caller compatibility, but return
saved receipts instead of candidates. Host compares the complete expected project
and write revisions, checks the current saved source and target-page draft/lock,
then archives old teaching and replaces the requested page in one transaction.
Main serializes batch writes while allowing at most three model calls in parallel;
its expected project advances after each successful save. Other pages stay intact.
A failed page does not roll back completed pages. Regeneration replaces the target
page's narration and clears speech audio/cues while retaining independent music.

The rejected alternative was candidate review and explicit adoption: it left
completed narration outside teaching and added a step the user did not want.
Old candidate records and Host APIs remain available for compatibility without a
visible narration-candidate UI. No existing record is deleted or auto-adopted.
Native source-edit candidates retain their existing review behavior.

## Consequences

The sidebar groups existing controls into tabs, retaining mounted input state.
Saved-source narration also uses background page rasterization, bounded visual
observations and a whole-deck plan. Local LibreOffice/Poppler rendering uses a
sanitized disposable copy; embedded images provide a diagnostic fallback.
Object-bound focus intent is validated against saved identities and becomes
timed highlight/spotlight cues only when decoded TTS audio is explicitly adopted.
The scope excludes automatic audio synthesis and hidden Office editor automation. Real-provider quality requires separate acceptance.
