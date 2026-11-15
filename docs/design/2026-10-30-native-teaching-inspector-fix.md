# Native teaching inspector follow-up

Date: 2026-10-30

## Recovery buffers after source repair

Page 2 retained an old-source recovery buffer after saved-source recovery. The
sidebar disabled the whole page and had no discard action; its error also leaked
across page navigation. Host now archives/continues only unchanged-page edits
with verified identities and retires already-saved buffers. Actual conflicts
remain intact with a bordered Delete draft action, using existing revision CAS.
Clearing restores saved teaching; normal edits continue automatic saving.

The affected page 2 buffer was replayed from a read-only live-profile snapshot
in an isolated Host profile: identity rebasing, spotlight/audio retention,
teaching save and obsolete-buffer retirement all passed. Focused checks passed:
52 WiseOffice unit tests, 11 Host identity tests, one draft RPC regression and
93 Desktop authority tests. The actual Chromium SDK scenario passed (3.3 minutes),
including conflicting-buffer discard without a teaching write, then normal
editing, playback and saving. WiseOffice type checking/production build and the
local Host build passed. No live-profile edits or paid-provider calls ran.

## Timeline recovery after older animation saves

The affected lesson's Revision 4 contains a new animation on page 2; all ten
parsed page content fingerprints match Revision 1. Office renumbered native
shapes and changed a few geometry fingerprints, while names and object content
still match. Teaching remained bound to Revision 1 with no native-save journal.
The previous exact-byte-only reopen guard therefore rejected the whole sidebar.

The shared Host open path now recovers complete unambiguous named inventories
transactionally. It preserves canonical page/object UUIDs and teaching, reuses
adopted-audio rebinding, archives the baseline, and keeps source/native-save
barriers. Uncertain inventories and native-animation teaching bindings retain
the existing conflict rather than guessing. Real-file validation uses a
disposable database snapshot; it does not edit the user's live database or PPTX.

The real Revision 4 parser/attach/openSaved replay first failed with the reported
conflict, then passed with all ten page action lists, ten adopted audio receipts
and all logical object IDs retained; repeat open was idempotent. The focused
identity, native-save, source-review and TTS suites pass (51 tests). The Host
debug binary is rebuilt locally; the running Desktop still needs a full restart.
No paid generation, live-profile mutation or packaged GUI acceptance is claimed.

## Cue buttons, narration segmentation and animation owner follow-up

- Cue forms now use localized short Add/Save/Cancel labels, a filled primary
  action and a bordered secondary action. Chromium verified their rendered
  colors, visibility and the actual cue editing/save path at sidebar width.
- Background prompt dispatch previously published null as the viewing session
  when it had no foreground hint. That cleared the owner shared by native
  teaching and animation saves. Missing, null and mismatched hints now preserve
  the foreground owner; explicit shell navigation still clears it.
- This lesson retained initial single-paragraph narration after detailed
  generation failures. New initial narration and subsequent generated/selected
  narration now keep sentence actions. Consecutive focus on the same object
  cannot collapse those actions. Existing audio/manual teaching is retained;
  regeneration uses the existing invalidation and TTS path.
- Focused Host identity, native-save, TTS and task checks passed (34 tests), as
  did the narration runtime, Main orchestration, native-authority and WiseOffice
  regressions. WiseOffice, runtime, Host and Desktop builds/type checks passed.
  The actual SDK Chromium scenario passed again in 3.1 minutes. All 2,894 staged
  resource hashes/sizes match. No user profile restart or paid generation ran.
- The broad Host suite was stopped in favor of the affected checks; it is not
  a full-suite pass. Whole-repository Rust formatting still reports unrelated
  existing files; the changed Rust files pass formatting. Clippy completes with
  existing warnings and no new warnings in the changed files.

## Scope and ownership

The user explicitly requested direct edits on the existing
`feat/courseware-par-A` checkouts in Desktop and WiseOffice, with no new
worktree. Existing scene-teaching and Chat changes were already present and
remain in place. This follow-up does not commit or publish those changes.

## Reported defects and fixes

1. A selection-generation change during a saved read rejected the Host request
   and left the inspector empty. The native reader now renews only same-page
   writable contexts, at most twice. Each read retains all Host source, page,
   workspace and session fences. Stable failures remain visible; mutations and
   paid operations are never retried. Projection cleanup resumes context events.
2. Voice task provider IDs and internal states were rendered outside the closed
   settings disclosure. Technical information now stays inside that disclosure;
   the inspector shows voice readiness and audition separately.
3. Cue controls disappeared when audio or mappings were missing. Entries now
   remain visible with precise automatic prerequisites and no per-page
   confirmation operation. Spotlight, highlight
   and native animation share one action row. Existing cue targets, times and
   the Edit action are readable. Native animation editing opens the SDK editor
   even when there is no bound animation step or the preset cannot synchronize
   with teaching playback; it never replaces a manual native sequence.
4. Adopted audio/video steps had no content in their inspector. Selected clips
   now read verified local media into controls with decoded duration, play,
   seek and recorded gain. Loading never autoplays or generates media. Stop,
   selection, navigation and disposal release the player and object URL; late
   bytes cannot resurrect playback. Error recovery uses an explicit reload.
5. Generic imported interaction labels hid their meaning. Teacher-continue
   checkpoints now explain that playback waits for the teacher, remain
   deletable, and are distinguished from an existing question. New pauses still
   belong to narration tails.

The actual native browser scenario also exposed a pending number-field change
being overwritten by an earlier autosave response. A newer local timeline now
survives the acknowledgement, is rebased onto the returned saved teaching view,
keeps its recovery draft and is saved in the next round.

## Validation and delivery boundary

Regressions first failed for interrupted reads, hidden entries, empty music
inspectors and the autosave race. Targeted WiseOffice tests, Desktop authority
and media tests, runtime timing tests, TypeScript checks and the real SDK browser
scenario cover the changed behavior. Native SDK browser checks use a fixture
Host message transport; they do not claim real paid-provider generation.

The existing editor source pin remains the last committed base. The local
staged bundle inventories the current tested branch working tree with
`dirty: true`; it must not be represented as a clean published release. The
previous Desktop editor resources are retained under `.cache/` before replacement.
The Desktop production renderer/main build is local. No running user profile is
restarted and no installer or cross-platform release is produced.


## Completed local checks

- WiseOffice: 117 focused unit checks across sidebar, flow, preview, native
  slideshow, generated native motion and seven-locale message parity; TypeScript,
  targeted oxlint and formatting checks passed.
- Desktop: 134 focused native sidebar, teaching authority, native media and TTS
  checks passed. Stale page/generation and document rejection remain intact. Desktop TypeScript and production build passed.
- Runtime: 25 timing-preview and generated-native-motion checks passed.
- Actual Chromium SDK teaching scenario passed (3.5 minutes), including real
  music decode/play/seek, hidden provider details, animation-panel navigation,
  focus editing, lesson playback and saves.
- Isolated Electron local protocol probe passed with a real three-page PPTX,
  native teaching and shared preview enabled, saved/reopened bytes and zero
  remote requests. All 2,894 staged resource sizes and SHA-256 values match.

No paid generation, installer build or Windows/macOS device acceptance ran.
The running Desktop main and Host processes must restart to load the updated
teaching rules; save user documents before restarting. Native animation changes remain
PPTX edits; this follow-up does not add automatic reverse synchronization into
canonical generated speech cues. Unsupported or differing animation/timing still
requires the existing native playback/review path rather than silent replacement.

## Per-page confirmation correction

The earlier inspector fix exposed a button for an obsolete Host readiness gate;
that was the wrong product behavior. The current correction removes that native
operation and all page/effect-confirmation controls, including the Desktop fallback
and online association's separate teaching-ready checkbox. The old ppt-edit skill
and contract reinforced the gate even though scene-courseware already required
only plan and first-page style approval. Those instructions now agree. v1 flags
remain readable for compatibility, with readiness derived from saved actions/media.
Source/identity/lock/CAS and verified media boundaries stay authoritative. Chat
receipts remain audit history rather than a second approval gate.

### Confirmation-removal verification

- 218 focused Desktop Node checks pass, covering local/online effect editing,
  repeated saves, native binding fences, snapshot admission and playback controls.
- 149 Host database courseware checks pass (one existing ignored test), plus all
  eight fixed-share RPC checks, including unclosed audit history without approval.
- Shared workflow/source-receipt checks: 10 pass; Desktop locale checks: 28 pass.
- WiseOffice sidebar/seven-locale checks: 94 pass. Real Chromium teaching flow
  passes using legacy review pages without confirmation.
- Desktop/shared/i18n and WiseOffice TypeScript checks, Desktop production build
  and local Host build pass. Biome excludes these paths; no Biome coverage claim.
- Staged editor inventory verifies all 2,894 files. Isolated Electron opens, saves
  and reopens a three-page PPTX with zero remote requests.

No paid-provider generation, installer or cross-platform hardware acceptance ran.
The existing user application was not restarted. No commit or push was performed.
