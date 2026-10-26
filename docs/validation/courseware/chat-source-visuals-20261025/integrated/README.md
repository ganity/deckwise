# Integrated main Chat page redo — 2026-10-25

A [subsequent matched Linux trial](../../chat-redo-package-20261025/README.md)
now packages these repairs and passes all 21 packaged Chat/Office scenarios.
The source-only and old-artifact limits below record this earlier checkpoint.

## Scope

The teacher prepares and approves saved-page visuals in the main Chat, requests
a redo there, previews its separate PPTX candidate, explicitly adopts it and
reopens the editable native result. This continues the existing ordinary PPT
generation, native editing and narration workflow. It does not resume team
collaboration or virtual-classroom work.

## Repairs

Ordinary PPT tasks have no scene-generation attachment. Their existing project
inspector now mounts the shared visual reviewer when a current PPTX export
exists. Refreshing messages or starting an Agent turn preserves that mount and
its explicit approval. Project changes reset inspection; Main still validates
the actual saved source, page, teaching and ownership. The sidebar keeps native
and teaching editing; it no longer has a second source-visual reviewer. Only an
active visual operation ending emits the teaching refresh hint; an idle mount
or clear does not trigger an unnecessary concurrent teaching read.

The actual PPT Master exporter creates ordinary groups. WiseOffice previously
rejected those when omitting native text, which blocked the Chat redo entrance.
Its preview now recursively validates nested groups across slide, layout and
master before drawing on temporary graphics. The existing unsupported-object,
transparency, shadow and warped-text refusals remain. Depth and total-object
limits bound malformed/cyclic trees. The original PPTX is never edited by this
rendering operation. Images may still contain text and require teacher review.

The independent A Office source snapshot is not a Git worktree. Its three-file
source/doc change is retained as `wiseoffice-grouped-preview.patch`, with exact
before/after hashes in `wiseoffice-source.json`. The new independent output is
`/home/jhz/code/train/document-worktrees/courseware-par-A-preview/dist-chat-source-groups-20261025`.
`office-build-inputs.json` inventories its 2,893 files and confirms all 2,899
files of the original pinned output remain unchanged. Existing Office output
and the current AppImage were preserved.

The obsolete visual-panel E2E command now calls the single Chat React/DOM gate.
The Electron extension uses a loopback model fixture, but actual Main/Host/Agent,
official PPT Master tools, Office rendering, scene compilation, source adoption
and process restarts. It checks saved-source identity, approved image hashes,
native text readback, original notes and logical-page teaching. A fixture now
normalizes the existing formatted page text before checking the saved edit;
production text handling was unchanged.

## Checks

| Check | Result / evidence |
| --- | --- |
| Desktop targeted tests | 87 passed; `tests.txt` |
| Final model-fixture regressions | 3 passed, including formatted text and wrong-source/image refusals; `fixture-tests.txt` |
| Actual React/Chromium interaction groups | 9 passed; `visual-panel-canonical/report.json` |
| Desktop types, build, configured lint, architecture | Passed; corresponding `.txt` files |
| Office native preview and embed contract tests | 114 passed; `office-tests-final.txt` |
| Office types and scoped formatting | Passed; `office-typecheck.txt`, `office-format.txt` |
| Independent Office production build | Passed with existing bundler warnings; `office-build.txt` |
| Complete Electron/Office redo and restart | **21 passed**; `electron-idle-fixed/report.json` |

The final 36-test focused rerun, Desktop types/build/configured lint/architecture
and nine React/DOM groups also pass after the idle-notification repair. The 3
fixture tests are included in these counts, not extra product tests.
The final fixture-only extension has its own passing rerun. Syntax and scoped
diff checks also pass. Earlier successful checks were not repeated without
changes to their product inputs.

## Failed attempts retained

- `electron`: ordinary tasks lacked the scene-only generated attachment and
  could not reach source visuals.
- `electron-ordinary`: the test's extra teaching read overlapped the sidebar's
  read. The observer now waits only for that explicit read-in-progress result;
  writes and uncertain outcomes are not retried.
- `electron-observer`: real grouped ordinary content was refused by Office.
  Three new group regressions failed before the fix (`office-before-fix.txt`).
- `electron-grouped`: actual visual preparation passed, but the model fixture
  expected plain text while the existing Host returns formatted page content.
  `fixture-html-before-fix.txt` records that failing regression before its fix.
- `electron-final`: candidate compilation, preview, adoption, native text,
  saved hash, logical-page teaching and notes checks passed, but the observer
  expected a visible narration field after restart without first initializing
  the teaching panel. The final scenario explicitly opens that existing panel
  before source-visual preparation, then checks automatic adoption refresh;
  it does not add an automatic product-side load or hide a failed write.
- `electron-teaching`: opening teaching exposed an actual competing read from
  an idle visual-component mount. `idle-refresh-before-fix.txt` records the
  failing regression. The callback now emits a refresh only on an active-to-idle
  transition; Main concurrency protection remains unchanged. The final 36
  focused tests, Desktop types/build/lint/architecture and nine React/DOM groups
  passed again after this additional product change.
- The initial Office type check caught a possible undefined tree item and was
  corrected before the final build. The final type check exits successfully.
- The obsolete panel fixture timed out before its replacement; its earlier
  logs are not claimed as successful runs.

## Reproduction and limits

After staging/building the current Desktop resources and serving the exact new
Office output separately on loopback:

```sh
DECKWISE_E2E_OUTPUT=/tmp/chat-redo-new-run \
DECKWISE_EDITOR_URL=http://127.0.0.1:4369 \
PI_DESKTOP_HOST_BIN="$PWD/target/debug/pi-desktop-host-core" \
xvfb-run -a node scripts/e2e-courseware-chat-first.mjs
```

`electron-idle-fixed` is the final successful run. All 21 groups pass, including
automatic refresh of the initialized teaching panel and full restart after redo.
Approved native image hashes matched the model request; original notes and
logical-page actions survived adoption. Its 75 loopback model requests are not
paid provider requests. `report.json` and `source-inputs.json` pin scope/identity.

The output directory must not already exist. The test creates an isolated
profile/workspace and uses the authorized `--no-sandbox`. Identity, text/model
choices and external media are fixtures; no paid supplier calls occur. The
scope is the uncommitted A source on `f9600d629`, not refreshed remote main or
a PR integration candidate. The old AppImage does not contain this interaction
or grouped-preview repair. No installer rebuild, commit, push or deployment
is claimed. Teacher/target-service acceptance, representative lesson quality,
approved text-budget policy and Plan 007 release criteria remain open.
