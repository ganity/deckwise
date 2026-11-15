# Plan 007 — local implementation and acceptance

## 2026-11-05 follow-up — independent physical pages

Implemented directly in `courseware-par-A` (`feat/courseware-par-A`, base `e46d2870e311d1106c6fe0afb600dfbe198dff92`). Changes are local and uncommitted. This section supersedes the earlier statement that Quiz is excluded from native PPT compilation.

- The requested page count is a **body-page** budget. Quiz and checkpoint pages are planned separately and excluded from that budget, visual-master generation and paid image preparation. Physical courses may contain up to 100 pages; the body limit remains 30. Fixed the Host plan deserializer to retain `bodyPageLimit`.
- Every generated scene now has its own physical PPT page and stable page binding. Quiz uses a local navigation placeholder; its exported MAIC content remains `type: "quiz"` with questions, without a canvas. A checkpoint has a separate standard MAIC slide and a `chapter_summary` `interaction_checkpoint`, rendered with the MAIC template. Body slides contain neither form of assessment.
- The PPT toolbar's “编辑当前页题目” opens the editor at the current physical page. Quiz edits question, type, options, correct answers, analysis and question/option images. Checkpoint edits question, reference, key points, constraint and chapter context. Native surfaces are hidden while the form is open.
- A native-backed edit uses one verified Main/Host save receipt to commit physical PPT identity and canonical content together. Adding, copying, ordering and deleting pages updates both. Undo can restore a deleted body page from an immutable saved revision. Bound question writes preserve the existing OOXML formatting and geometry, including clearing and refilling the text. Native question edits reconcile back by stable object identity; ambiguous duplicate anchors fail explicitly.
- Exports strip local page bindings, native baselines and Quiz placeholders. Saved native narration and archived media remain associated with the correct scene. Native dependencies load from the staged worker through the existing runtime resolver; a static authoring import that broke Electron startup through bundled Sharp was removed.

### Fresh verification

[Fresh P7 report](007-maic-courseware-parity-evidence/2026-11-05-native-pages/parity-report.json): **PASS**, seven aggregate checks. [Fresh Electron report](007-maic-courseware-parity-evidence/2026-11-05-native-pages/electron/report.json): **PASS**, all ten editing/playback/restart/export journeys. These use the current desktop build and real Host, plus the actual MAIC package projector, asset normalizer and cloud-web Quiz display/grading code. Card geometry passed at 1844×908 and 1280×800.

Additional native integration gates, separate from that canonical-course P7 journey:

- [Main/Host test log](007-maic-courseware-parity-evidence/2026-11-05-native-pages/main-host-tests.log): 2 passed. Real approved-plan generation, PPT compiler/parser and Host proof validation; native-backed question edits, clear/refill, copy, reorder, delete, undo, canonical-only edits, Host restart and export.
- [Runtime test log](007-maic-courseware-parity-evidence/2026-11-05-native-pages/runtime-tests.log): 10 passed. Actual PPT reimport, unchanged peer XML/formatting and independent-page operations; MAIC export/load checks.
- Targeted desktop regressions: 190 passed, 1 skipped. Host courseware-project suite: 272 passed, 2 ignored. Shared package suite: 1428 passed. Editor browser gate passed. Desktop typecheck and desktop/runtime/Host builds passed.
- [Four-page native PPT](007-maic-courseware-parity-evidence/2026-11-05-native-pages/independent-pages.pptx) opened successfully in LibreOffice; its [PDF](007-maic-courseware-parity-evidence/2026-11-05-native-pages/independent-pages.pdf) has four pages in the expected order. Corrected the template's invalid PNG CRC.
- Relocated authoring-bundle verification and staged worker manifest verification passed. The provenance file retains upstream hashes, records the newly exported package helper, and corrects an already-stale hash for the unchanged committed canonical contract.

After the P7 source fingerprint was captured, a narrow follow-up made Quiz title changes refresh the native placeholder too. Only `classroom-pptx.ts` and its test changed; the native integration and 10 runtime tests above were rerun after that fix. The original P7 fingerprint is preserved. Final source/build hashes are recorded separately in [final verification](007-maic-courseware-parity-evidence/2026-11-05-native-pages/final-verification.json).

No legacy migration, paid provider request, production publication or live user-app restart was performed. Real visible WiseOffice editing/reordering remains outside this automated acceptance: its lifecycle is exercised with a test controller while actual PPT bytes and Main/Host persistence are checked. The older full-runtime-suite failures documented below are not reported as resolved by these targeted gates.

## Historical acceptance — 2026-11-04


## Implementation

Source worktree: `/home/jhz/code/train/deckwise-desktop-worktrees/maic-courseware-parity`, branch `feat/maic-courseware-parity`, base commit `845295e9505bf55003542f2886f738e29779e0e0`. Changes are uncommitted. The currently running user editor was not restarted or replaced.

MAIC authority: `d8cde962d01d6722b710b32c11b161c54732c6e0`; cloud-web presentation authority: `9cea9d86a0fc8286a6fbe548eab580d6e3352ac2`. Contract and presentation provenance is recorded in `packages/courseware-runtime/src/maic-types/provenance.json`. Both reference repositories remain unchanged.

- New generation saves MAIC Classroom/Stage/Scene content. Quiz is an independent `quiz` scene, excluded from native PPT page compilation. A classroom interaction remains a slide with an `interaction_checkpoint` action; no Quiz answer/options extension is embedded into it.
- The dedicated editor supports the four Quiz question types, stable option values, answers, question/option images, analysis, reference/key points, grading guidance, playback settings, scene ordering, undo/redo and autosave. The interaction form separately edits the question, canvas binding, reference/key points, constraint prompt and chapter context.
- Main/Host own asset staging and revision-checked writes. Native-slide reconciliation preserves independent Quiz scenes and reports conflicting edits instead of replacing author content by array position. Canonical-only courses need no fake PPT file.
- The common player supports instant feedback, assessment review/retry, configured feedback speech, interaction pauses and explicit recovery from failed narration. Assessment short answers are explicitly ungraded offline and excluded from the objective-score denominator.
- Export emits MAIC `meta.json`, archived manifest resources and the conditional kindergarten playback bundle. It applies exactly one pass of the pinned MAIC interaction export projection, preserves the editable draft and removes local native reconciliation fields. It does not silently erase unsupported local actions or missing assets.

Key source files are `apps/desktop/src/components/workpanel/CoursewareClassroomEditor.tsx`, `apps/desktop/electron/main/courseware-classroom*.ts`, `crates/host-core/src/db/courseware_projects/classroom.rs`, and `packages/courseware-runtime/src/{maic-classroom.ts,player/components/courseware/MaicQuiz.tsx,conversion/lib/courseware/export-maic-classroom.ts}`.

## Actual integrated acceptance

The [preserved P7 report](007-maic-courseware-parity-evidence/parity-report.json) is PASS. It records the tested working-file hashes, reference revisions and seven aggregate consumer checks. The [Electron report](007-maic-courseware-parity-evidence/electron/report.json) is PASS with all ten journeys and no renderer page errors:

1. Create an all-Quiz course through real Main and Host.
2. Edit question, stable options and answers; upload question and option images; verify autosave.
3. Undo and redo without losing image ownership.
4. Preview image choices, retry a wrong answer, then answer correctly.
5. Add and edit a separate interaction slide/checkpoint.
6. Author multiple-choice, judge and short-answer assessment content.
7. Submit the actual assessment player, inspect objective results and ungraded short answers, then retry with cleared inputs.
8. Complete Quiz feedback and reach the interaction pause. The unavailable Linux system voice was explicitly skipped using the real player control; speech completion was not fabricated.
9. Restart Electron and Host; compare saved content and exported content exactly.
10. Clear Quiz and interaction display fields, save, restart again and verify the blank drafts remain intact.

The exported mixed course was consumed by the actual MAIC asset normalizer/package projector and actual cloud-web Quiz display/grading helpers. Quiz values, images, reference guidance, checkpoint fields and context were checked explicitly. Instant card geometry matched within two pixels at 1844×908 and 1280×800.

The initial strict consumer run exposed MAIC's chapter-context completion rule. That failed run was not accepted or normalized away in the checker. The exporter was fixed to use the actual reference projection, then the strict check passed with fresh artifacts. A separate differential command, `node scripts/verify-maic-interaction-export.mjs`, compares three context cases against the real authority and verifies the authoring draft remains unchanged. An upstream mismatched canvas/action question case is non-idempotent on repeated publication; the implementation follows the actual single-pass export behavior rather than inventing another normalization pass.

The actual editor screenshot review exposed application control styles overriding the Quiz styles. The scoped controls and reference 16px scale were fixed, and source browser gates now load the real desktop tokens/base/editor CSS after the Quiz CSS. They compare geometry, background, padding, radius, color and opacity, including disabled controls and textareas. This covers the embedded editor in addition to a clean standalone page.

After the ten-journey P7 run, the CSS dark variant was aligned with the actual cloud-web global rule (`.dark`, not OS preference). The [supplemental host-style gate](007-maic-courseware-parity-evidence/host-style-reference/report.json) passed OS light/dark × explicit `.dark` absent/present × enabled/disabled controls. It also checks assessment card layout at both widths. The original P7 source fingerprint remains preserved; this CSS follow-up is recorded separately rather than pretending that the earlier run used later source.

The [final build supplement](007-maic-courseware-parity-evidence/final-build-supplement.json) records the subsequent successful runtime/desktop rebuild and final source/artifact hashes. Root independently verified all 88 recorded source-file hashes and all five recorded built-artifact hashes against disk after the build. No editor, Host, export or playback logic changed after the accepted ten-journey run; subsequent production changes were confined to the reference dark-variant CSS.

## Regression and build evidence

- Main/editor/assets/native synchronization/TTS/build/preview: 46 tests passed, rerun after the export projection change.
- Generation/planning/staging/workflow: 71 tests passed, including mixed and all-Quiz generation.
- Shared workflow: 13 tests passed.
- Runtime MAIC export/loading and playback: 31 tests passed, including failed browser speech retry/skip; assessment grading and narration regression: another 5 tests passed.
- Earlier full Host courseware-project suite: 268 passed, 2 ignored. After the final required-string/blank-draft corrections, all 8 classroom tests, `cargo check -p host-core` and the Host rebuild passed; the real ten-journey test used that updated Host.
- Desktop and runtime TypeScript checks passed. Runtime and desktop builds passed. Style-token and whitespace checks passed.
- Assessment browser gates: `node packages/courseware-runtime/scripts/verify-maic-assessment.mjs` and `node packages/courseware-runtime/scripts/verify-maic-assessment-reference.mjs`. These verify weighted results, explicit ungraded short answers, review guidance, retry/reset, score-ring geometry and the actual cloud-web question cards at 1280 and 1844 widths.

With this worktree's linked dependencies, prefix pnpm commands with `pnpm_config_verify_deps_before_run=false`; otherwise pnpm 11 attempts a dependency reinstall before running the command.

## Boundaries

- This is a local MAIC **content** ZIP, not a trusted server-signed published package. Production signing keys remain on MAIC server. The legacy team fixed-build endpoint does not accept canonical MAIC packages, so that route explicitly rejects them. Authenticated MAIC publication/upload has not been implemented or exercised here.
- No paid provider generation, TTS or image request was made during acceptance. Main/Host service integration is covered with deterministic service fixtures; real supplier success is not claimed.
- Offline short answers do not invoke AI grading or microphone services. Assessment motion uses the reference's final static layout.
- Real WiseOffice native edit/reorder was not exercised inside this P7 run. Native save/reorder/conflict behavior is covered by the separate generation and native-reconciliation tests; this is not a claim of a full visible WiseOffice round trip.
- The full runtime suite was also attempted earlier: 395 passed, 30 failed, 41 skipped. The failures involved missing packaged PPT-worker resources and external audio-fixture paths. The full suite is not reported green; the relevant targeted gates above passed.
- Legacy courseware migration remains excluded as requested. No existing development/test courseware was deleted. No merge, deployment, installer release or replacement of the user's running app was performed.

## Preserved examples

Acceptance uses valid small PNG fixture images. The blank-looking white image areas in the screenshots are test image content, not missing image requests.

- [All-Quiz MAIC content ZIP](007-maic-courseware-parity-evidence/electron/all-quiz.zip)
- [Mixed MAIC content ZIP with assessment and interaction](007-maic-courseware-parity-evidence/electron/mixed.zip)
- [Actual editor Quiz preview](007-maic-courseware-parity-evidence/electron/quiz-image-options.png)
- [Interaction editing](007-maic-courseware-parity-evidence/electron/interaction-editor.png)
- [Actual assessment review](007-maic-courseware-parity-evidence/electron/assessment-player-review.png)
- [Actual interaction pause](007-maic-courseware-parity-evidence/electron/interaction-player.png)
