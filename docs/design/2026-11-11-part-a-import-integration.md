# Part A / C import integration — 2026-11-11

Checkpoint before integration: Desktop `0201f2750`, paired Document `1a68b6bc`.
Sources: Desktop `local/zpj_deck` at `fd3cbb26f`; Document at `edd68ec4`.

## Integrated

Document cherry-pick `edd68ec4` -> `f66bb35f`: font aliases, eligible Hans theme
fallback, punctuation/line metrics/vertical Han drawing, image transparency and soft
edges, read-only selection adapter, optional loopback Windows font service. The
Part A slide source identity guard and all native teaching/material persistence stay.
A newer Part A embed test fixture additionally needs the new selectedObjects field;
this compatibility follow-up is committed as Document `b5a0a626`.

Desktop takes the asset registry pending-write deduplication and import realpath
patches with their regressions, and the native-fade workspace spelling fix. Sidebar
polling and page-local draft recovery are adapted to Part A native autosave; only
opens retry known races, never generic writes. Script heading recognition borrows
Slide/bracket syntax while retaining Chinese numerals and exact body lines. Existing
voice choices survive model reload. Legacy archive reads are bounded; native portable
media stays first. No new IPC, Host namespace or playback protocol is introduced.

## Deliberately not imported

The two large Desktop commits are not cherry-picked. Host supplemental activities,
second material/reference authority, relay submission/payment changes, 512 MiB quotas,
incomplete-preview policy and version-2/3 animation protocol are excluded. The A
fade/skip fallback stays. Geometry/index-based effect prefill does not replace object
identity. Lesson classification/planning and cross-page archive recovery require a
separate adapter into A's existing enrichment/native-media services; copying their
old Host write paths is not valid. They are not claimed implemented by this change.
The prior import automatic-effect and English-only template gaps remain open.

## Verification

See final validation results appended below. Local source and build integration
is distinct from installer deployment or Windows/PowerPoint fidelity qualification.


- Document: 213 focused unit tests passed, 3 Windows-only skipped. Typecheck and
  module build passed. Browser font substitution: 8 passed, including Calibri
  regular/bold/italic/bold-italic. Native material script/plan/both adoption and
  assessment Undo/Redo/save/reopen: 4 passed. Native generated edit/media/effects/
  slideshow/save/reopen/Quiz: 1 passed with the current teaching-preview bundle.
- The first native-generated E2E invocation omitted the Desktop preview asset;
  its request returned 404 and the highlight check failed. Rebuilt the current
  runtime preview and supplied DECKWISE_TEACHING_PREVIEW_FILE; rerun passed.
- Desktop focused Node tests: 169 passed, 1 optional legacy receipt integration
  skipped. Runtime alias/fallback/fixed-build tests: 28 passed. Shared focused
  recovery/parser tests: 15 passed. Shared, runtime and Desktop typechecks passed;
  runtime isolated bundle and Desktop production builds passed.
- Mandatory workflow gate results are recorded below once complete. This gate
  uses local fixtures and zero paid provider calls. Fresh three-path AI generation,
  Windows installed-font runtime and installer deployment are not qualified here.
- Existing ignored resource bundles were not replaced. Build outputs include the
  current runtime and editor; restaging packaged editor/worker resources is required
  when preparing an installer. Four prior resource backup directories remain intact.


Mandatory workflow gate: **PASS**, zero provider calls. Evidence:
`/tmp/deckwise-workflow-gate-WQ7NDL/report.json`.

- host-build: exit 0
- main-host: exit 0, 587 passed, 0 skipped
- shared: exit 0, 43 passed, 0 skipped
- agent-runtime: exit 0, 491 passed, 0 skipped
- host-contracts: exit 0, 297 passed, 2 ignored
