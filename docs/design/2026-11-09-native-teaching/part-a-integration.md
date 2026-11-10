# Local Part A integration, 2026-11-10

The user requested merging both native-teaching worktrees into their local
`feat/courseware-par-A` branches. This integration uses those local branches,
without importing main or writing to a remote.

Inputs:

| Repository | Native implementation | Existing Part A target |
| --- | --- | --- |
| DeckWise Desktop | `5a08609c4` | `cb8b3e636` |
| document | `5017a73d` | `daf16b67` |

Each implementation commit retains the complete previously uncommitted task.
Part A is merged into the implementation branch first; the target branch can
then fast-forward to the validated integration. Four untracked Desktop resource
backup directories in the target are outside the merge and remain untouched.
The original implementation worktrees remain available.

Conflict resolutions preserve native document teaching/media ownership and
revision checks together with Part A's persisted speech-animation scheduling,
shared assessment UI, media-read recovery and presentation workflow. A saved
group entrance still gates attention on its children. Logical native identities
take precedence over generated display names. The two audio-end fixes share one
retained measured duration, reset at the next playback or stop.

Part A's unbound native animations run alongside narration; bound speech effects
still wait for actual SDK completion. The previous test that required narration
to wait for every unbound effect is updated to this existing Part A behavior.
SDK animation patterns added by native teaching are retained in Part A's shared
export/import pattern helper, rather than duplicating the helper.

Validation logs are local in `/tmp/native-teaching-merge-20261110/`:

- document: 135 tests across native carrier/identity, lineage, sidebar, previews,
  slideshow, object choices and persisted scheduling. The DOM-heavy undo test
  uses a 15-second runner timeout; assertions and history limits are unchanged.
- runtime: 102 targeted timeline, audio, mapping, native group and animation
  tests; 22 fixed-build tests use a freshly staged worker. Fourteen historical
  lineage/formatting tests use the original pinned worker retained in Part A.
- Desktop: 203 tests pass, four environment-dependent real Host/fixture cases
  skip. Shared bridge checks pass 30 tests. Rebuild shared/agent/runtime output
  before consuming package exports; old output does not contain Part A exports.
- Host: 14 native-save tests and 19 snapshot tests pass.
- TypeScript: document, runtime and Desktop; editor/runtime/worker builds pass.

The real-course browser fixture checks six-page navigation, the original Quiz
through three playback entries, wrong/correct answers, teacher continuation,
whole-lesson empty-page handling, nested attention, local audio, native history
and PPTX export/reopen. Its demo host log is hidden: that unrelated `pre` renders
complete native protocol payloads and otherwise distorts editor navigation
timing. The editor's 1,500 ms budget is unchanged.
The final paired real-course E2E passes in 2.6 minutes against the staged merged
editor and runtime, without skipping the copied fixture.

Generated editor/worker bundles are validation artifacts outside Git. This
integration does not certify other operating systems, arbitrary Office effects
or external Office save compatibility, and makes no paid provider calls.

## Local validation-resource incident

After the historical checks passed, a temporary absolute symlink to Part A's
ignored `.worker-desktop-02` directory was mistakenly included in the integration
commit. Git replaced that ignored historical test cache when the target advanced.
The link was immediately removed in `ff773e248`; no absolute worker link remains
in the final source tree. The application's `apps/desktop/resources/pptx-worker`,
the four pre-existing resource backups and the real courseware were untouched.

The pinned cache's original manifest hash is
`1eb6dd1479dffca96620281d74243bfab738d8115884dcdc633956c78247339a`.
It could not be recovered byte-for-byte from local resource backups or historical
source/compiler/dependency reconstruction. The 14 historical tests did pass
before this incident; rerunning them now requires restoring that exact converter
cache. The freshly built integration worker remains independently qualified by
22 fixed-build tests at `/tmp/native-teaching-merged-worker-20261110`. Do not
replace the historical hash assertion or rebaseline its fixtures to hide this
limitation. No source or application data was discarded.
