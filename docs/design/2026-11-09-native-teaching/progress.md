# Native teaching: delivered code and validation

Date: 2026-11-09. The new local document mode is implemented in both paired
worktrees. General old-data migration was explicitly excluded. Changes are local
and uncommitted; the running original application/profile were not modified.

## Worktrees and usable resources

| Repository | Worktree | Local Part A base |
| --- | --- | --- |
| DeckWise | `/home/jhz/orca/workspaces/deckwise-desktop/native-teaching-implementation` | `c87a0e8a166bc7d46361cbb2c27f9c8d63e7ddc6` |
| document | `/home/jhz/orca/workspaces/document/native-teaching-implementation` | `285f04c8df2336edd6ca6fc067d00a9627ac1b2a` |

Both use `feat/native-teaching-implementation`. The matching transformed editor
is built and staged at DeckWise `apps/desktop/resources/wiseoffice` (2,858 files).
The current parser/converter is staged at `apps/desktop/resources/pptx-worker`
(155 files). These are generated resources in the new worktree, not replacements
in the user's installed app. Host debug binary and runtime bundles are built.

See [implementation](implementation.md) for operation routes and ownership. The
new mode stores teaching and all adopted audio/video inside the PPTX. Sidebar,
Desktop panel, Chat narration/media/assessment tools, adoption, save/copy and fixed
builds use the native document boundary. Private task journals remain in Host.

## Real Part A copy

Durable local fixture:
`/home/jhz/deckwise-validation/native-teaching-complete-20261109`.

- `native.pptx`: converted real course, six pages, 24 teaching actions and all 22
  adopted audio assets, including the Quiz question. Decoded audio totals 808,350
  bytes. Source page 3 had no teaching actions; its native animations remain.
- `original.pptx`: unmodified source recovery copy. SHA-256:
  `40d53872113418691a02874b76c67bd8e9485edbaaeef48accafba094c94b84d`.
- `validated-roundtrip.pptx`: actual SDK export/reopen result after edits, Undo /
  Redo, one validation delay, group highlight and spotlight associations.
- `playback/`: independently built, validated fixed package from that SDK output.
- `teaching.json`, `report.json`, `README.md`: inventory and reproduction context.

Only the explicitly selected project's data and its adopted assets were copied.
The source PPTX digest is unchanged. No user profile, credentials or paid task
receipts are distributed. The copy script is
`scripts/native-teaching/copy-real-fixture.py`; it verifies source/media hashes
and refuses missing referenced classroom audio rather than silently dropping it.

## Final checks

| Check | Result / evidence |
| --- | --- |
| Desktop targeted integration/unit suites | 242 passed, 1 fixture-conditional skip; `/tmp/native-desktop-tests-v79.log` |
| Native-save suite with the real SDK lineage fixture enabled | 6/6 passed, no skip; covers the conditional case above; `/tmp/native-save-tests-final.log` |
| document native model/sidebar/preview/identity/lineage suites | 89 passed; `/tmp/native-document-tests-v71.log` |
| Runtime conversion, mapping, groups, native timeline, strict player load, timing and audio suites | 144 passed; `/tmp/native-runtime-tests-v81.log` |
| Rust immutable snapshot tests | 16 passed; `/tmp/native-host-groups-v62.log` |
| Rust save/recovery tests | 13 passed; `/tmp/native-host-save-tests-final.log` |
| TypeScript: Desktop, document, runtime | Passed; `/tmp/native-{desktop,document,runtime}-types-final.log` |
| Current paired editor build and stage | Passed; `/tmp/native-paired-{build,stage}-final.log` |
| Real course through current transformed Desktop editor in Chromium | Passed in 1.8 minutes; `/tmp/native-paired-real-final.log` |
| Real PPTX -> Host snapshot -> fixed package -> Host restart | Passed; `/tmp/native-real-fixed-final.log` |
| Actual compiled player in Chromium, strict autoplay policy | Passed; `/tmp/native-real-playback-final.log` |
| Whitespace/conflict check in both repos | `git diff --check` passed |

The staged-editor real test decodes and verifies every embedded audio asset,
rejects a stale mutation, edits/undoes/redoes, hears real local audio, associates
highlights/spotlights to a group, exports and reopens, and preserves question
nodes and target UUIDs. It rejects unexpected legacy teaching requests.

The compiled-player run navigates all six pages, plays real adopted audio,
executes 17 native group wrappers, checks highlight/spotlight visibility,
pause/resume, question response controls and final assessment. No page errors
occurred; unmount stopped audio. Its checked-in reproduction entry is
`scripts/native-teaching/verify-real-playback.mjs <absolute-build-directory>
<new-absolute-evidence-directory>`. Screenshots and report are retained with the
durable fixture's validation evidence.

## Qualification bounds

These are Linux development and real-browser checks, not a newly packaged release
installed into the user's application. No paid provider was called: generation,
submission uncertainty/recovery and late-result adoption use fake-provider tests.
The real sample's already adopted audio is played and decoded in Chromium.

Fixed playback accepts verified finite whole-object native presets, including
this sample's automatic/delayed/parallel and grouped effects. Unsupported timing
fails explicitly. Native ONLYOFFICE editing/slideshow remains the broader native
presentation path. Fixed visual fidelity is reported `NOT_VERIFIED`; the sample
has a reviewed notes-master warning. Do not promise pixel-identical Office
rendering, arbitrary Office effects, or preservation by unqualified external
PowerPoint/WPS versions.

Windows/macOS crash/power-loss, cross-process simultaneous writers and
cross-document teaching clipboard transfer are not qualified here. File save
uses digest checks and same-folder rename, with Linux directory sync. General
legacy migration and server-owned classroom authoring are outside the requested
new local document mode.

## Editing latency correction, 2026-11-10

The first preview exposed a missed acceptance criterion: selecting slides could
block the native editor for seconds despite the functional tests passing.
Profiling the running isolated Desktop against the same real course measured a
9,426 ms main-thread timer gap on page 2 and 1,327–1,481 ms on empty page 3.
Metadata lookup used `GetAll().map(GetXml)`, repeatedly serializing all 22 media
parts. Per-object native-presence guards also serialized the 99 KB teaching part.

The document adapter now locates metadata using SDK `GetByNamespace` and checks
presence without serializing XML. Content validation and revision checks still
run on actual reads/writes. The two regression tests failed before their
respective fixes. Current targeted suites pass 91 tests; document TypeScript
passes. The rebuilt and staged Desktop editor passes the real six-page E2E,
including new navigation budgets, narration edit/undo, embedded audio, attention
associations, export and reopen (1.4 minutes).

The running preview has been reopened on the corrected staged bundle. Replaying
the original Desktop harness measured page 2 at 137 ms and page 3 at 133–170 ms
maximum timer gaps. Narration selection measured 145–349 ms end to end, local
audio began in 544 ms, and a normal Desktop save completed in 3,002 ms with
`saved to original file` status. Navigation harness wall time includes a deliberate
400 ms observation window and must not be reported as pure rendering time.
Evidence lives outside Git in the copied fixture's
`validation/performance-20261110/`. These numbers qualify this Linux six-page
sample, not arbitrary large presentations or other operating systems.

## Original nested-target playback correction, 2026-11-10

The preview's first slide failed before playback with `提示对象已删除或不在当前页`.
Its saved target, `album-cover-01`, was present inside `album-scene-01`; the
legacy preview guard only accepted top-level objects. Native attention and
speech-motion resolution now retain exact nested object identity and validate
membership in the requested slide. The chooser includes these valid targets;
lookups remain scoped to that slide to avoid scanning every slide per object.
Deleted/moved objects still reject, and legacy identity checks remain unchanged.

The real lesson also contains finite automatic native effects and delays that
the legacy click-only guard rejected. The native adapter accepts the qualified
presets from this lesson and waits for actual SDK completion. Its first preview
entry uses native slideshow when speech animation cues require it. Preview
timing is temporary and restored on exit; no parent-group substitution or
destructive ungrouping is used.

Following the original cue to the second narration exposed a separate runtime
bug: `AudioPlayer` cleared the audio before animation completion could read its
duration, producing `SPEECH_TIMING_AUDIO_REQUIRED`. It now retains the measured
completed duration until the next playback or stop. Active-audio and stale-event
semantics remain unchanged.

Regression tests reproduced the missing nested object, automatic-effect
rejection and zero-duration completion before their fixes. Final document suites
pass 94 tests and runtime audio/timeline/core suites pass 64. TypeScript passes
for document, runtime and Desktop. The paired real-course E2E passes in 2.3
minutes, including six-page latency budgets, all three original playback entries,
actual second-narration spotlight, edits, native Undo/Redo, audio, export/reopen.
The running Electron preview independently passes the same three playback
entries through the original nested spotlight and returns to editing afterwards.
Local debug evidence is retained with the copied fixture under
`validation/nested-playback-20261110/`. No provider call or paid generation was
needed. This qualifies the copied Linux lesson and supported finite native
presets, not arbitrary Office effects or external Office save compatibility.

## Quiz playback correction, 2026-11-10

The original grandmother Quiz failed before playback because preview required
nonempty `referenceAnswer.summary` and `keyPoints`. Its saved options and answer
index (B) were intact; the canonical course contract permits empty explanatory
text. Preview now accepts that representation while retaining structured
question/answer validation. Regression cases reproduce the failure for single,
multiple and judge questions and verify answer scoring and explicit continuation.

Whole-lesson verification then exposed an empty-timeline error on page 3. The
lesson coordinator now skips pages without teaching actions before constructing
the runtime. It retains page/revision checks and does not write teaching data.
A sidebar regression proves it reaches the next authored page and restores the
starting editor page.

Runtime audio/timeline/core/response suites pass 68 tests; document sidebar and
preview suites pass 63. Both projects pass TypeScript. The staged Electron
preview passes all three entry points with the original Quiz, including empty
selection, incorrect answer, correct answer B, continuation and the following
teacher-led activity in whole-lesson mode. It is left on page 5 for manual use.
Debug evidence is stored outside Git with the copied fixture under
`validation/quiz-playback-20261110/`.
The real-course E2E passes in 3.3 minutes, including three Quiz entries,
whole-lesson continuation, original nested spotlight playback, edit/undo/redo,
all embedded audio and export/reopen. An independent package comparison confirms
the original Quiz/checkpoint payloads, answer index and empty explanation remain
unchanged in the exported PPTX. This qualifies the copied Linux lesson only.
