# Part A generation repairs and interruption analysis

## Scope

This follows the six-case real generation matrix in
`2026-11-11-part-a-real-generation-matrix.md`. The original evidence directory
is unchanged. Repairs use WiseOffice's native PPT teaching carrier and existing
shared tools; no second teaching database or alternate Office converter is added.
The dirty Part A worktrees and earlier changes are retained. No commit or push
is part of this repair.

New evidence: `/home/jhz/deckwise-validation/part-a-repair-20261111`.

## Causes and fixes

| Failure | Cause | Repair |
| --- | --- | --- |
| Existing audio with unresolved attention blocks snapshot | Recovery returned immediately for valid audio; the write path only resolved attention during fresh audio adoption | Resolve attention using retained, verified embedded audio duration in the native write transaction; recover valid audio without purchasing replacement TTS |
| Final script cannot receive all three effects | One intent per speech cannot express every target/effect when an entire original page is one preserved speech | Effect-only planning can bind several verified targets to the same saved speech and create bounded cues from actual saved duration, retaining words, IDs, media and unrelated cues |
| Equal speech IDs on separate pages can borrow another page's timing | The duration lookup was keyed only by speech ID | Scope verified durations by page and speech ID; a two-page regression checks different durations for the same speech ID |
| Scene focus rejects unnamed image layers | Visual observations allowed teaching targets without spoken aliases; exact-name matching could not connect the spoken noun to a unique verified picture | Reject incomplete visual observations and repair once; allow unique verified picture aliases, retaining ambiguity/container checks and excluding machine IDs from spoken text |
| Master passes native acceptance but fixed playback rejects an entrance target | Native evidence described groups as ordinary shapes; visual grounding selected a group containing both a decorative panel and an ellipse | Preserve group identity in native evidence so generation binds leaf objects. Repair this saved fixture's group cues to its verified red ellipse through the native write API, retaining speech/audio; do not silently guess a child in playback conversion |
| Repeated stale source SHA | Saving mutates the source hash; mutation responses did not consistently return the post-save hash | Read back after save, return current source SHA/revision, and include current context in stale-write errors; stale writes still fail |
| Recovery/save stops despite successful native mutation | Automatic save raced an outstanding native read; subsequent context reads raced an in-progress save | Automatic save waits for bridge commands, context joins pending save, and both verify document ownership afterwards |
| First generated PPT cannot automatically enter teaching | The automatic opener required a save even when no editor document existed | Only this opening path permits the closed-editor save to be a no-op; ordinary saves, foreign documents and unreadable documents still fail |
| Master native write succeeds but its save reports editor inactive | Shared teaching save used the foreground-only Office edit guard while the SVG preview remained visible | Require native document/conversation ownership for shared teaching saves, preserving the foreground guard for direct Office selection commands |
| Refused close breaks subsequent saves | The close IPC cleared conversation ownership and review state before the controller rejected closing during an outstanding save | Close the controller first; a refused close leaves ownership, review state and the in-flight save intact. A behavioral regression executes the actual IPC callback for both refusal and success |
| Cross-page automatic recovery reports a settled original as failed | Several page refreshes reused a pre-save SHA; any refresh exception permanently blocked that original for the turn | Reread native state after every adoption and reconcile an exception once against current state, querying only the original orders. Repeated exceptions stop with the local stage identified; a local error is not proof of provider failure |
| Wrong activity kind or reference answer | Validation lumped fields together; source evidence was reused as the oral answer | Field-specific guidance preserves requested kind; teacher-led activities require a separate referenceAnswer, including explicit expected examples |
| No-plan import stops before adding explicitly requested activities | Agent inferred a missing attachment was a capability blocker and confused teaching effects with Office selection edits | Built-in shared workflow maps explicit inline user activity requirements before insertion and uses shared native teaching tools independently of Office selection capabilities |
| Import body adds an extra question despite two standalone activities | Independent-assessment validation excluded imports | Native imports with accepted separate activity units use the same body-only narration guard and bounded output correction |
| Same saved course alternates between ready and unfinished | Narration and media context used different optional assessment-image gates | Both read the same assessment state; optional image targets remain visible while required question audio still gates completion |
| Automatic continuation asks for excluded option images after native acceptance | The continuation treated assessmentMedia.ready as a separate mandatory gate even after native completion.ready | Native saved completion governs the continuation; optional missing images do not restart generation after acceptance |
| Preview/apply planning can repeat model work | Applying could regenerate a different proposal | Reuse the exact preview proposal while source/session/instruction are unchanged |
| Planning repeatedly rejects paraphrased evidence | Model output validation stopped without a bounded corrective pass | Retry malformed mappings once with the precise error, previous output and unchanged source/pages; reject a second invalid result and do not retry provider failures |
| Scene Quiz fails only after image generation | Noncanonical option keys were accepted during planning | Validate canonical A–D or judge T/F keys before assets are generated |
| English decks contain Chinese helper text | Quiz/interaction templates hard-coded Chinese text | English question templates use English helpers; Chinese templates retain their existing copy |

## Why operator interventions happened

- **Required workflow decisions:** plan approval and first-page style confirmation
  are deliberate review steps. Master preview/export approval is likewise distinct
  from recovering a failed teaching operation.
- **Product failures:** the save race, stale-SHA handling, missing retained-audio
  effect resolution and misleading shared-tool guidance caused actual failed tool
  calls. Repeating a user instruction could sometimes work around these but did
  not fix their causes.
- **Model behavior:** the original script-only first turn spent roughly three
  minutes without tools; its isolated turn was aborted and retried. This records
  provider/model delay, not proof of a local editor deadlock. Some prior models
  attempted the legacy edit checklist or changed an activity kind after failure.
- **Test harness:** an already-used session could answer a duplicate prompt by
  reciting history with no new tools. Fresh generation tests therefore use fresh
  sessions. Candidate rebuild/relaunch is a development step between tests, not
  evidence that a successful generation needs a restart.
- **Original test environment:** the preceding matrix also exhausted local disk
  space and crashed the isolated app's log writer. Its recovery and retained decks
  are documented in the original matrix report. This is separate from teaching
  validation and from provider generation failures.
- **Harness packaging correction:** an early repair run still loaded the old
  staged authoring bundle although source/build tests passed. The model correctly
  detected the remaining Chinese Quiz hint. A new inventoried worker bundle was
  staged and verified before fresh tests; this early run is preserved separately.
  One early launcher also started before its candidate directory existed. Neither
  harness mistake is attributed to the generation engine.
- **Repair-run session switching:** the harness initially selected Master while
  Scene was still compiling. Compilation saved its PPT, then native teaching
  correctly refused to run under another selected conversation. This was a
  harness-induced stop, not an uninterrupted Scene success. Subsequent native
  teaching runs are serialized and preserve the compiled image/layer assets.
- **Final repair verification:** an immediate close after a manual save correctly
  hit the save-in-progress guard, but exposed the ownership-clearing defect above.
  This was a harness timing trigger with a product consequence. The failed save
  was not accepted as persisted evidence: disk/carrier revision comparison failed,
  the exported repair metadata was preserved, and verification resumed with a
  corrected candidate and an acknowledged save.

A model's final prose is never acceptance evidence. Checks read the actual native
carrier, PPTX ZIP, audio hashes and runtime playback. The original top-level shape
text auditor missed grouped Master text; the replacement reads all slide OOXML
text, including groups. The prior report now explicitly records that correction.

The repaired Scene run also exposed a false terminal report for its third-page
TTS. A direct read of original intent
`a1627b76-14bb-4a55-98ba-0be1facbf85a` returned `ready`, `settled`, no provider
error, and audio not yet adopted. This is preserved in
`scene/original-third-tts-status.json`. The failure was local reconciliation,
not failed provider synthesis; its original output is recovered without a new
purchase.

## Verification

All six final artifacts pass the saved-carrier audit, immutable playback build,
real audio playback, Quiz submission, teacher-led activity continuation, all three
visible effects, and full application restart readback. The final matrix contains
22 pages and 64 embedded speech audio assets; none has pending attention.

| Route / attachments | Pages | Saved and naturally ended speech | Three effects | Restart |
| --- | ---: | ---: | --- | --- |
| Scene | 3 | 6 / 6 | Pass | Pass |
| PPT Master | 3 | 7 / 7 | Pass | Pass |
| Imported PPT + plan + final script | 4 | 4 / 4 | Pass | Pass |
| Imported PPT + plan | 4 | 18 / 18 | Pass | Pass |
| Imported PPT + final script | 4 | 4 / 4 | Pass | Pass |
| Imported PPT only | 4 | 25 / 25 | Pass | Pass |

Validation reads complete slide OOXML text, including nested groups. All six decks
have English visible text. Imports retain original page IDs, order, shape text and
geometry; script-bearing imports retain exact original narration. Accepted lesson
units reference the source plan hash and verbatim evidence. Requested import Quiz
and short-answer kinds, answers and the oral example “ball” are preserved.

Full-course and page-1 original-order recovery leave saved actions/audio unchanged.
The previously blocked both-attachment fixture additionally has its own retained
original-audio repair and playback proof under `import-both/recovery-proof/` and
`import-both/recovery-playback/`. Four alternating narration/media context reads of
the PPT-only import agree on readiness and source SHA while optional excluded
option images remain absent (`import-none/readiness-check.json`). No replacement
TTS was purchased for the retained-audio repairs.

Master's final target metadata and cues both identify the actual red ellipse,
excluding its containing decorative group. The final immutable build is
`9c38c40cb9e21f7af173a6a6f3b3f8cf0e3385b306bd448e5f940f402716af76`.
Its three pages and seven original audio assets play successfully. The earlier
failed binding and successful intermediate builds remain preserved; final audit
binds the played build to the final PPTX SHA, rather than accepting an older build.
Spotlight screenshots were also inspected for complete circle coverage.
`master/refused-close-save-proof.json` records a deliberately refused close followed
by a successful save with the correct persisted teaching revision and ellipse
metadata. All six restart checks compare pages/actions, revision and source.

### Intervention accounting

These final artifacts are **not evidence of six uninterrupted generations**.

- Four final import sessions each completed their enrichment generation from one
  request, without an appended corrective generation prompt. Initial import/open,
  original-order recovery verification and restart readback are separate test
  steps. Model tool-argument self-corrections occurred. Earlier failed or superseded
  sessions remain in the evidence directory and operator journal; they are not
  counted as successful fresh runs.
- Scene retains its real generated images/layers after the harness selected a
  different conversation during compilation. It then received an explicit teaching
  continuation and original-order recovery instruction after the source fixes.
  Plan and first-page style approvals are normal; those repair instructions are
  operator interventions. No replacement image or TTS was bought to hide the stop.
- Master used a preview/export decision and a later teaching request. Its saved
  group-targeted cues and target metadata were repaired through the public native
  teaching write API using the verified PPT ellipse identity. These are guided
  repairs, preserving every speech, audio asset and other action. Source regressions
  prove group containers are now excluded from generation targets; a second fresh
  paid Master generation under the final candidate was not run.
- Rebuilds/restarts between candidate versions are development operations. The
  final restart verification itself performs no generation. The failed-close
  regression was discovered and repaired during this final verification, rather
  than silently ignored.

### Code checks

| Check | Result | Evidence log |
| --- | --- | --- |
| Desktop targeted suites (save, native tools, narration batch, Scene plan, skills, chat and contract) | 186 passed | `/tmp/part-a-combined-fix-tests.log` |
| Agent narration write, workflow tools, native planning and continuation suites | 139 passed / 5 files | `/tmp/part-a-agent-final-tests.log` |
| Document native teaching suite | 29 passed | `/tmp/part-a-group-evidence-green.log` |
| Quiz/interaction authoring suite | 8 passed | `/tmp/part-a-quiz-fix-tests.log` |
| Desktop + Document TypeScript | Pass | `/tmp/part-a-desktop-typecheck.log`, `/tmp/part-a-document-typecheck.log` |
| Desktop production build and integrated MAIC editor build/staging | Pass | `/tmp/part-a-desktop-build.log`, `/tmp/part-a-editor-build.log`, `/tmp/part-a-editor-stage.log` |
| Relocated authoring bundle acceptance | Pass, inventoried 155 files | `/tmp/part-a-authoring-verify.log` |
| Refused-close ownership regression | Failed before fix; passes after fix | `/tmp/part-a-close-owner-red.log`, `/tmp/part-a-close-owner-green.log` |

Build fingerprints, transcripts, operator journals, native readback, saved carriers,
media hashes, screenshots, played build IDs and restart checks live under the new
evidence root. Offline reproduction (no paid calls):

```bash
python3 /home/jhz/deckwise-validation/part-a-repair-20261111/audit-artifacts.py
```

`results.json` and each case's `artifact-audit.json` contain zero failed checks.
The isolated application and preview server are stopped. Copied test credentials
and the private environment backup were removed. Normal login refresh was retained
only after checking the original token had not changed concurrently; see
`cleanup.json`. Source, fixtures, decks and preexisting backups remain intact.

### Limits

This is local dirty-candidate validation, not installer/release certification or
arbitrary PowerPoint fidelity verification. It covers a small circle lesson and
four import attachment combinations, not every complex deck, provider failure,
media type or editing race. No full-repository suite, unsupported original-animation
fallback matrix, generated option images, music or video matrix was run for this
repair. In particular, Scene and Master final playback success does not establish
that a future fresh generation will need no operator intervention. No commit,
push, merge or deployment was performed.
