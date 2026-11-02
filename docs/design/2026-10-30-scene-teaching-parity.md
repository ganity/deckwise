# Scene teaching parity: implementation and device acceptance

Date: 2026-10-30

This records the current `feat/courseware-par-A` implementation in Desktop and
the WiseOffice worktree. It supplements the October 28 native-editor design and
supersedes the October 29 statement that generated motions remain fade/pulse-only
and cannot become native animations. It is not a claim of full MAIC equivalence.

## Ownership and user workflow

Desktop owns generation, job polling, local assets and saved teaching. The Host
owns persistence and source/revision checks. Platform remains a provider relay.
This change introduces no platform-to-llm-ha path and changes neither service.
The planning approval and first-page style approval remain the human gates.
Individual image layers, audio and teaching actions require no new approval.

Teaching authoring lives in the WiseOffice native right sidebar. Narration,
speech settings, focus cues, question responses and sequential music use that
same saved-page context. No second teaching editor or full-course copy command
is introduced. PPTX retains editable visual objects; local teaching data retains
speech, media references, focus intervals and interaction semantics. Decomposed
lettering remains image layers, not reconstructed native text.

## Implemented behavior

| Area | Current implementation | Boundary |
| --- | --- | --- |
| Planning | Per-page type, phase, objective, duration, required objects, question and music requirements | Existing approved plans without these optional fields remain valid |
| Narration | Whole-course arc plus current logical-page requirements; short focus-specific speech and exact spoken anchors | Segment-level timing, not provider word timestamps |
| Object semantics | Observed role, spoken aliases, text carrier and target eligibility persisted against saved UUIDs | Unknown, ambiguous, decorative or changed objects do not acquire inferred bindings |
| Motion language | fadeIn, fadeOut, pulse, zoomIn, slideInLeft, slideInRight and gentleRotate in validated teaching/runtime contracts | Generated narration proposes entrances and emphasis; existing fadeOut remains supported, not automatically added everywhere |
| Native animation | Generated speech motion projects into native WiseOffice timing and survives PPTX save/reopen | Projection occurs when the corresponding saved page's teaching sidebar loads; unopened pages are not headlessly rewritten |
| Focus | Highlight and spotlight resolve current mapped objects and follow each speech audio clock in canvas preview and teaching slideshow | They are teaching overlays, not ordinary PPTX shapes/effects; standalone PowerPoint cannot run the sidecar |
| Questions | Single, multiple, judge, short answer, discussion, practice and PBL response contracts and player controls | Open responses use teacher evaluation; no AI grading or MAIC HTML activity engine |
| Music | Explicit sequential slot, replaced in place by adopted generated audio | Sequential song/listening playback, not continuous multi-track background mixing |
| Quality | Non-blocking diagnostics and bounded repair for unlocked affected pages | Structural evidence cannot certify pedagogy or supplier output quality |

### Native timing and one animation owner

`lib/deckwise-teaching-native-motion.ts` resolves Host UUIDs to current native
shapes and uses the SDK animation API. It appends only to an empty sequence;
existing manual timing is preserved. Each speech starts one click group, with
additional target effects running with that group. Durations, presets, selection,
current page, source generation and geometry are checked. The sidebar then uses
the existing save/open path to refresh the saved source and teaching view.

The supported presets are fade entrance/exit (10), pulse (26), zoom (53/16),
fly from left/right (2/8 and 2/2), and teeter (32). Native teaching slideshow starts
the matching group at speech audio progress and waits for both audio completion
and SDK effect completion. Pause/resume affects both clocks. Canvas clicks cannot
advance slides outside the teaching scheduler. Ordinary WiseOffice slideshow
remains a PPT-only playback path; use the teaching sidebar's slideshow controls
for TTS, music, focus and interaction.

The fixed compiler recognizes the exact saved SDK behavior tree before treating
native timing as a mirror of canonical speech cues. Target, timing, group, scale,
rotation, formulas and visibility must match; preset IDs alone are insufficient.
An exact mirror executes once through the fixed speech renderer. A modified or
unrecognized sequence retains normal native validation and cannot silently
discard an animation owner. Native manual edits are not automatically copied
back to canonical generated cues; mismatches require review/rebinding.

### Stable planning and object evidence

Saved scene teaching metadata follows logical page IDs, including after reorder.
Both vision evidence and detailed narration receive the current page's typed
teaching requirements. The original approved course plan remains whole-course
context, not an ordinal source of the current question or music requirement.
Vision annotations cover supplied object UUIDs exactly once. Persistence cannot
change geometry or invent object identity. Only certain teaching targets enter
automatic focus selection; explicit static/decorative evidence is retained.

### Interaction and music placement

Planning includes the visible question and choices in the actual PPT page content.
Saved question actions retain `{kind, options, answerIndices}` and reference
answers. The native sidebar identifies page type and lets the teacher edit the
response kind, choices and correct indices. Objective responses compare the
selected index set with the saved answer set; open responses remain ungraded.
Teacher continuation never implies a correct answer.

A `music_slot` has its own stable action ID. Generation, polling, export and local
adoption retain that ID and replace the slot at its exact sequential position.
Repeated preparation/refresh reuses the completed result. Different slots may
legitimately share identical bytes without being mistaken for the same position.
Narration regeneration keeps existing music assets rather than paying to recreate
them. Missing music prevents a technical-ready claim while retaining the editable
artifact and allowing generation to continue.

### Advisory quality and repair

`inspectCoursewareTeaching` reports missing narration/audio/focus/question/music
and question type mismatch. It returns `blocking:false`, with page IDs, action IDs
where applicable, suggested repair and lock eligibility. It never rewrites a
lesson or discards a generated artifact. Main exposes the current saved evidence
through narration context. The Agent can repair affected unlocked pages with the
existing tools and then reread state. Unchanged diagnostic signatures receive at
most two automatic repair attempts; remaining or locked-page diagnostics are
reported honestly and automatic continuation stops. Media job journaling remains
responsible for pending requests; this does not submit replacement paid requests
for an unknown result.

## Automated evidence

These local runs completed without provider calls or connecting to the user's
running Desktop profile:

| Check | Result |
| --- | --- |
| Host courseware persistence/readiness regressions | 148 passed, 1 existing ignored |
| Desktop scene plan, saved narration, saved media and teaching tests | 115 passed before the final logical-page regression; saved narration rerun: 13 passed |
| Agent narration and continuation tests | 38 passed |
| Shared planning/quality/workflow tests | 16 passed |
| Runtime import, native parsing, questions, preview and loading | 106 passed |
| Fixed-build compiler tests including actual SDK timing | 22 passed |
| WiseOffice native-motion, slideshow and sidebar tests | Last tested snapshot: 58 passed, including the draft-edit/loading race; later concurrent edits are not covered |
| Isolated Chromium with actual WiseOffice SDK | 1 passed: 14 effects, seven grouped presets, save/reopen and real slideshow completion |
| Type checks | Desktop, Agent, shared/runtime and WiseOffice passed |

The browser test uses two native shapes and seven two-effect groups. It verifies
600 ms durations, click/with-previous start types, saved OOXML, reopen persistence
and every actual effect reaching its SDK end state. The extracted XML fixtures
exercise compiler parsing; mutated scaling/rotation/formulas reject mirror
classification. This is not a real-provider generation or Desktop device test.

Local execution logs are retained under `/tmp/scene-*-final.log`,
`/tmp/scene-narration-logical-page.log`, `/tmp/fixed-build-tests-final.log`,
`/tmp/courseware-host-tests-final.log`, `/tmp/wise-scene-tests-final.log` and
`/tmp/wise-native-browser.log`. These temporary paths are local evidence, not
portable repository artifacts.

## Staged resources and manual acceptance

Desktop worktree:
`/home/jhz/code/train/deckwise-desktop-worktrees/courseware-par-A`.
WiseOffice worktree:
`/home/jhz/code/train/document-worktrees/wiseoffice-native-teaching`.
Both use `feat/courseware-par-A`.

An earlier snapshot of the local built-in WiseOffice and PPTX worker resources
was rebuilt and staged in Desktop's `apps/desktop/resources/wiseoffice` and `pptx-worker`.
Their manifest inventories and SHA-256 values were checked. The production
WiseOffice bundle contains no test probe. These ignored generated resources are
local worktree outputs; a source checkout elsewhere must build and stage them.
Previous resources remain in
`/tmp/deckwise-courseware-par-A-before-parity-20261030`.

During final packaging, another active session changed the WiseOffice sidebar.
The user confirmed that session is still editing and requested preserving source
changes. Final packaging and resource replacement therefore stopped. The staged
editor does not contain the last draft-loading guard or all concurrent UI changes.
Revalidate and rebuild/stage after that session finishes, before treating the
following manual checks as acceptance of the latest source. Existing resource
verification applies only to the earlier staged snapshot.

After rebuilding/staging, start from the Desktop worktree with:

```sh
env -u DECKWISE_EDITOR_URL pnpm dev -- --no-sandbox
```

`DECKWISE_EDITOR_URL` is still supported and takes priority. A value pointing to
an older development server will display that server's old implementation.

1. Open the existing lesson and its native teaching sidebar. Confirm page type,
   narration, saved audio and mapped teaching objects load automatically.
2. For newly generated teaching, inspect the same page's native animation menu.
   Save, close and reopen; presets and target objects must remain editable.
3. Start teaching slideshow from the sidebar. Verify the named object focuses
   during its corresponding speech; native entrance/emphasis executes once.
   Pause/resume, continue an interaction, exit and reopen the timeline.
4. On question pages, choose an incorrect and then correct objective response.
   Test multiple choice as an index set. An open response must show teacher
   evaluation rather than pretend to be automatically marked.
5. For a planned song, verify introduction -> song -> follow-up speech. Reopen
   or refresh and confirm no second generation request or appended duplicate.
6. Reorder pages and regenerate only one selected unlocked page. Its logical
   question/music requirements must remain attached; peer pages and existing
   successful media must remain intact.

Existing saved lessons do not acquire new narration, semantic observations or
audio merely by opening. Use a targeted generation request to exercise the new
authoring behavior, then generate changed speech audio. Existing compatible
generated cues can project to native timing when their teaching page opens.

Video was not extended. Provider output quality, full Desktop device playback,
packaged offline startup and arbitrary advanced native animations remain outside
this round's verified evidence. No commit, push, deployment or publication was
performed in this round.
