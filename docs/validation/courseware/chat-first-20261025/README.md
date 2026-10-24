# Main Chat generation and import acceptance

Date: 2026-10-25
Branch: `feat/courseware-par-A` (local changes, uncommitted)

## Evidence

`report.json` records nine passing source Desktop scenarios from
`scripts/e2e-courseware-chat-first.mjs`. The actual Electron application, Rust
Host, Agent tool dispatch, image request journal, asset verification, scene
compiler, PPTX parser, teaching initialization and WiseOffice were used. The
right generation form was never mounted; opening artifacts used the retained
editor panel. Electron ran with the requested `--no-sandbox`.

- The creation dialog handed its reviewed brief to Chat without auto-send.
- Chat wrote a real plan. Its exact human approval advanced the same task.
- Quotation and image selection both required unchecked human consent.
- A complete process restart recovered approval and the prepared intent without
  model replay or image submission.
- Three explicit fixture submissions supplied a reviewed page reference, a
  different clean background and an independent transparent foreground.
- Each image adoption continued the same Chat; the final one invoked the actual
  compiler without a separate next-step prompt or generation form.
- The saved PPTX contained native text and an independent picture. Real
  WiseOffice opened those objects, and the page retained its planned narration
  (`Look! A circle. Good!`) outside the visible slide text.
- Import requirements were discussed before source selection. Cancelling the
  native picker retained the same task; the next selection copied the original
  bytes and opened Office with the same source hash.
- Ordinary-task creation kept its brief unsent. This does not prove its complete
  PPT Master generation path.

The image API, identity, model responses and native picker answer were controlled
loopback fixtures. There were exactly three fixture image submissions and no
external paid requests. The visual assets deliberately use simple fixture shapes;
the screenshots prove the editing handoff, not generated design quality.

`chat-compiled.png` shows the main Chat result and `wiseoffice.png` shows the
actual native editor. The output report includes the generated source hash and
the identical imported source hash. Temporary paths in that report describe the
disposable test profile, not user data or committed courseware.

## Root causes fixed

1. Compilation rejected sessions inheriting the application model even though
   Chat could already use that model. Main now resolves inheritance through its
   existing launch resolver, without writing session configuration. Default
   changes during capture/completion reject before adoption.
2. Source launches looked only in packaged resources, overlooking the staged
   local compiler/worker. Installed resources retain priority; explicit invalid
   overrides still fail closed. No runtime is downloaded automatically.
3. Main Chat image rows omitted submission/task/fee states and provider errors.
   These are now shown using existing translations. Unknown receipts stay
   query-only, and a refused request cannot silently retry a paid submission.

## Checks

- 92 targeted Node tests passed, covering the shared workflow, image journal,
  model capture, resource discovery, creation, import routing, scene staging and
  PPT Master/notification regressions.
- `scene-completion-report.json`: 15 Electron tests passed using the real PNG
  decoder, pi-ai HTTP transport and bundled compiler. Includes inherited-model
  execution and invalidation on a changed effective default.
- Desktop typecheck, repository lint and Desktop build passed.

Reproduction from the worktree after current dependencies, Host and Desktop
builds, with staged source worker resources and a running isolated WiseOffice:

```sh
DECKWISE_E2E_OUTPUT=/tmp/deckwise-chat-first-new-run \
DECKWISE_EDITOR_URL=http://127.0.0.1:4352 \
PI_DESKTOP_HOST_BIN="$PWD/target/debug/pi-desktop-host-core" \
xvfb-run -a node scripts/e2e-courseware-chat-first.mjs
```

The output directory must not exist. This source gate deliberately does not set
a worker override, exercising discovery of the staged Desktop resources.

## Remaining acceptance

This is a bounded core-path result, not completion of the entire roadmap. With
the ordinary extension below, all three entry paths reach actual Office locally.
It does not certify production model/media behavior or charges, longer or complex
ordinary decks, audio generation/playback, publication, or packaged releases.
Existing editing capabilities and their older
acceptance records are not recertified here. Team sharing/collaboration and the
virtual classroom remain outside the resumed core work.

## Ordinary Chat refresh and repair follow-up

Idle **Refresh status** now reaches the ordinary-project inspector. A failed or
stale quality gate offers **Repair current pages in Chat** with the same existing
repair request as the workbench. No repair operation or provider loop is added to
the renderer. Export remains a separate explicit Chat request and still depends
on saved planning, narration and final-report inspection.

The new interaction regression first failed against the old component: changing
the saved report then refreshing left export enabled. After the fix, 33 targeted
tests pass across `courseware-chat-workflow-ui.test.mjs`,
`ppt-master-quality.test.mjs` and `ppt-master-flow.test.mjs`. They cover preview,
failed inspection, same-Chat repair with the real diagnostic excerpts, successful
inspection, explicit export request, editor opening, invalidation after a further
input edit, stale task clicks and recovery after a refused send. The actual
inspector is used; filesystem APIs and the send/editor boundary are fixtures.

Desktop typecheck/build, repository lint, all 28 i18n tests and `git diff --check`
also pass. `ordinary-refresh-regression-report.json` records a fresh nine-case
source Electron/Host/Agent/compiler/WiseOffice regression after the build.
It uses the same isolated loopback provider/media fixtures, not paid services.
An initial launch started before the renderer build finished and was rejected
by the build preflight; the recorded rerun started after the build succeeded.

At this follow-up, the nine-case Electron gate covered ordinary creation/handoff only. The
new ordinary repair/export behavior is covered at component/inspection level;
neither test establishes a complete model-driven PPT Master generation/repair
or an actual ordinary SVG-to-PPTX export through the new Chat flow. The pending
acceptance boundaries above were unchanged at that point; the next extension
adds actual ordinary-tool and Office evidence.

## Ordinary full source path

`ordinary-full-report.json` records twelve passing scenarios from the extended
`scripts/e2e-courseware-chat-first.mjs`. Its added ordinary path uses the existing
loaded PPT Master skill, actual Agent file/shell tools, bundled Python and
unchanged official tools. The loopback model supplies one fixed page and its
tool choices; it does not supply an exported PPTX or a passing quality report.

1. Author the complete planning pair, one SVG page and `notes/total.md` through
   the actual Write tool. Run official project validation and the final SVG
   quality checker, both exit 0. Start the official preview server and navigate
   it using the advertised Browser plugin tool.
2. Deliberately damage the saved page's title size. Idle Chat refresh invalidates
   export. Its repair action makes the same Chat replace that page and rerun the
   official checks successfully, retaining the project and narration.
3. Explicitly request export from Chat. Run the official notes splitter,
   finalizer and native SVG-to-PPTX exporter, serially and successfully.
4. Open that exported file in actual WiseOffice. Independent ZIP inspection
   verifies the source SHA-256, visible native text and speaker notes. Actual
   Office readback descends group shapes and verifies three native leaf objects,
   including `A circle has no corners.`; exact narration is page-bound outside
   visible slide text. See `ordinary-native-office.png` and `ordinary-preview.png`.

The output source SHA-256 is
`5ff2635c8aed94b20942a53becd6543d62de84533030bdf723e9299acab2b739`.
There were 47 loopback model requests, three explicitly confirmed fixture image
submissions in the retained scene scenarios and no ordinary/paid media requests.
The project-owned preview server was shut down after acceptance; no test daemon
remains. All 35 targeted Chat/quality/skill/flow tests pass, as do repository lint,
script syntax and diff checks. Product source was unchanged in this extension;
the preceding Desktop build/typecheck remain applicable.

Intermediate test failures were in the new test fixture: missing mandatory SVG
module bounds, using the Browser display name rather than its advertised plugin
namespace, and inspecting only top-level Office groups. The final run uses the
correct real boundaries; no product gate was bypassed to make it pass.

This closes the deterministic one-page ordinary integration gap. It does not
establish real-model visual quality or reliable authoring of arbitrary decks.
The existing core finish conditions and higher-level plan are not marked complete.

## Actual stage feedback

The ordinary task card previously stayed at requirements even after a valid PPTX
was exported: the parent read only the generic task attachment flags, while the
ordinary generation project is inspected separately. Its initial topic hint also
remained beside completed artifact controls.

The ordinary project component now owns its single heading/status and initial
hint, reusing its actual saved-project inspection. It shows requirement collection
before a project reference, checking, incomplete pages, repair for a failed/stale
quality gate, changed pages requiring export, preview readiness, or a current
editable PPTX. An active Agent takes precedence as working. No second readiness
store, filesystem inspector or generation path is introduced; scene/import keep
their existing task/plan stages.

Three regression tests failed on the former presentation and pass after the fix.
All 38 targeted Chat/project-quality/flow/skill tests and all 28 i18n tests pass.
Desktop typecheck/build, repository lint, script syntax and diff checks pass.

`stage-feedback-report.json` records a fresh twelve-scenario source Electron run,
including assertions on one ordinary status through requirements -> preview-ready
-> repair -> preview-ready -> editable, and no repeated topic hint after project
creation. It retains actual official export, source hash/notes checks and three
native leaf objects in actual Office. `stage-feedback.png` shows the final editable
stage beside the editor entrance. All model/media/identity calls remain isolated
loopback fixtures, no paid requests were made, and the test preview was stopped.
This adds accurate interaction feedback; it does not close the production-model,
complex-deck or release acceptance gaps above.

## Post-generation Chat editing

The extended gate now continues the same ordinary generation task into existing
Office editing. It loads `ppt-edit`, adds native text, explicitly saves using the
editor button and reviews the saved source's logical page association. It then
requests a narration rewrite using that saved page, reviews/adopts the pending
candidate and restarts Desktop/Host to read both results back. The test keeps
native save, teaching association and narration adoption as separate human
decisions; a tool acknowledgement is not a saved or adopted result.

This exposed a real defect: candidate generation required nonempty session
provider/model fields, although Chat and ordinary generation could already inherit
application defaults. The coordinator now reuses the Main launch resolver already
used by scene compilation. Captured effective model/thinking and saved session
configuration are rechecked before candidate persistence. Narration, page redo
and reviewed style batches share that check; no provider/model configuration is
written to a session as a workaround. Trusted selected narration and the existing
fade path retain their prior delegates.

The new regression failed with `An active Agent model is required` before the
fix. All 37 narration/redo/inspection tests pass afterward, including inherited
resolution, changed default model/thinking, unavailable resolution, cancellation,
source/teaching conflicts and existing source selection. Desktop typecheck,
Desktop build and repository lint pass. The 16 Chat UI/skill tests also pass.

Test-development corrections included using the native editor's session identity
for direct readback, the actual **Save to original** button and its correct
scope, and inspecting the completion's user data rather than treating a message
array as content blocks. The parsed page preserves HTML and encoded spaces, so
the fixture compares visible text after normalizing that rich text. An independent
worker parse of the saved PPTX confirmed the inserted text. A direct fixture check
accepts that actual parsed page and rejects one without the requested edit.

`post-generation-edit-report.json` records fifteen passing real source Electron
scenarios after the fix; `post-generation-chat-edit.png` shows the same main
Chat after adopting its rewritten narration. Native text changed before save
while the original file hash stayed unchanged. Explicit save changed the PPTX
hash, and reviewed page association retained the previous narration. The next
Chat completion received the new saved text. Explicit narration adoption retained
the logical page ID, saved short speech, a 4000 ms pause and simple English
encouragement without rewriting the PPTX. A full process restart reopened Office
with that native text and exactly the adopted teaching; no model request replayed.

There were 59 loopback model requests and exactly three explicitly confirmed
fixture image submissions. All identity/model/media calls remained isolated,
with no paid requests. This extends ordinary post-generation editing acceptance
only; it does not certify real-model quality, arbitrary multi-page editing,
audio, publication or packaged releases. No product UI or candidate-review
ownership was relocated in this follow-up.
