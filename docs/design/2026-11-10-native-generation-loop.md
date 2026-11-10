# Native generation loop

## Delivered behavior

Both local generators publish `deckwise-native-teaching/1` PPTX files by default.
Scene generation, ordinary official PPT Master exports and assessment-only decks
share one packaging/publication boundary. Native page actions include narration,
Quiz grading, teacher-led response/reference/constraints and required music/video
slots. Logical shape identities come from actual physical Office slides. Original
native objects, timing, notes and unrelated package parts remain intact.

Generation attaches a verified file path and document identity to the Host task.
It creates neither an editable Host teaching project nor a canonical classroom.
The original ordinary export is preserved beside the content-addressed new source.
Host revalidates source/parser identity, official export gates, approved scene
proof and page budgets. Deterministic packaging makes identical retries safe.

After opening, sidebar and Chat use the existing native command route. Logical
teaching requirements and education settings remain available after reorder and
save/reopen; narration generation uses live objects and notes, preserves adopted
clips and skips independent assessment pages. TTS adoption converts pending focus
and animation intents into audio-timed cues in the same native history action.
Chat waits for a complete PPTX save before returning durable adoption success.
Quiz question speech is reused rather than duplicated when it already reads the
question and options. The configured TTS/music/video catalogs remain available.

Continuation uses native completion and the actual saved source. Legacy workflow
checkpoints need an editable database project, so native continuation does not use
that API. Original provider journals retain uncertain-submit recovery. A new
continuation resumes authored course state from the PPTX; automatic repair budgets
are scoped to the current Chat continuation. This deliberately does not create a
second editable teaching authority.

Fixed publication consumes an immutable snapshot. Its export adapter normalizes
clip asset IDs and removes derived clip duration from the fixed action envelope;
verified media remains packaged and native source bytes remain unchanged.

## Implementation map

- `packages/courseware-runtime/src/authoring/native-teaching-pptx.ts`: bounded
  Office packaging, real shape IDs, notes and deterministic bytes.
- `apps/desktop/electron/main/courseware-native-generation.ts`: shared native
  publication and verified Host attachment for both generators.
- `crates/host-core/src/rpc/courseware_projects/native_generation.rs`: generation
  ownership, source identity and approved requirement checks.
- Native candidates/tools/services, the document router/model and Agent
  continuation complete editing, media, save and resume.
- Native immutable snapshot import adapts clip IDs/duration for fixed playback.

## Validation environment

Changes are isolated on `ligang/native-generation-loop`, based on local Part A:
DeckWise `bc7d6aab611f0fa6b5915f0917ba8d54fd95a899`, document
`a36c9c83ee03772fe09679eb489b64bd9d6564c4`.

The generated body/Quiz/practice fixture passes the actual Host/parser, editor
save/reopen and native Quiz playback paths. Local PCM and MP4 responses exercise
real media adoption without paid APIs. Unit/contract checks cover rejection,
cancellation, retries, requirements, original-job recovery and automatic saves.
See the dedicated E2E scenario for reproduction entry points.

Validation completed on 2026-11-10:

- Desktop production build, Host build and both projects' TypeScript checks pass.
- Host generation integration: 7 passed, 1 skipped. The skipped assessment
  export test requires an installed official PPT Master skill, unavailable here.
- Native services: 45 passed; generation/workflow regressions: 62 passed;
  continuation regressions: 53 passed; new packer and Host validators: 2 each.
- Document native model/preview: 23 passed; sidebar: 66 passed; actual paired
  editor generation/save/reopen/playback E2E: 1 passed.
- The real Host imports the edited PPTX, archives all embedded media, builds a
  fixed package and retrieves the same immutable snapshot after restart.
- Real browser fixed playback verifies advancing speech/music/video clocks,
  pulse animation, highlight, spotlight, the correct Quiz answer and the practice
  page, with no runtime errors and no audio remaining after unmount.

Retained evidence: `/home/jhz/deckwise-validation/native-generation-loop-20261110`.
The fixed build ID is
`61621b48ed97206cc43b1861478b91554b3986b915b807b4bbede57087fb44e7`.
`scripts/native-teaching/verify-generated-playback.mjs` accepts the absolute
fixed-package directory and a new evidence directory to replay the final check.

This qualifies Linux development builds. Paid providers and an installed release
are not exercised. Old-data migration and server-owned classroom generation are
outside this local-generation change. Fixed visual fidelity retains its existing
`NOT_VERIFIED` status and explicit notes-master review warning.

## PPT Master narration correction

PPT Master body pages start without speech actions. Their speaker notes remain in
Office notes and feed the existing structured narration generator with live page
evidence. Only assessment pages receive ready question-reading speech during
packaging. Treating a whole note as generated speech incorrectly marked narration
ready and skipped the structured generation step; commit c2173081 introduced that
regression. The adoption integration test now covers missing narration acceptance,
notes evidence and multiple generated speech blocks through the native tools.

## Parity audit correction

The validation above did not prove native animation persistence or full legacy
workflow parity. See `2026-11-10-native-teaching-parity-audit.md` for reproduced
regressions, the scoped corrections, and the remaining visual-grounding,
whole-course planning and assessment/media UI differences. Scene planning speech
also remains generation evidence; it is not marked completed during packaging.
