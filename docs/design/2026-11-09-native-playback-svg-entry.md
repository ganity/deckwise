# Native teaching playback and PPT Master SVG entry

## Changes

Native slideshow admission previously applied the legacy speech-binding subset
to every animation on a page. The latest PPT Master export contains automatic
starts, delays, zoom/stretch presets and a final click effect. These are valid
native rendering inputs, but failed that narrower synchronization check.

Separate native admission from legacy binding admission. Start narration when
the canvas/transition is ready and let native page-entry effects run alongside
it. Automatically advance idle unbound click effects without navigating slides.
Pause/resume also controls native effects without explicit speech bindings.
Explicit bindings retain their own checks and temporary timing is restored.

Keep the SVG component mounted after adoption, prefer the persisted source's
project over retained chat messages, auto-open the first available draft SVG
once, and retain its manual entry after export. Fence stale asynchronous replies
when the session/project changes. Export remains subject to its existing gates.

WiseOffice owns desktop native PPT rendering. Quiz grading and interaction
responses/reference answers reuse shared runtime components, removing the
Desktop adapter's handwritten Quiz implementation. The shared playback core and
audio clock remain in use. Preserve portable/team playback; removing that player
would break those consumers. See the matching host-owned-courseware ADR entry.

## Evidence

- Latest real six-page source, unchanged SHA-256:
  `04ff3e5e68beb8b9742bc481a5ab3eea7e698ca4e77569101d93a383afcc8f9e`.
- Real native SDK: pages 1/2/3/4/5/6 and page 1 again each became ready once.
  One archived speech per page completed through the shared audio runtime;
  all native unbound effects completed, including delayed effects and the final
  click effect. This samples existing audio; it is not a full 46-clip lesson run.
  Evidence: `<validation-dir>/player-path-audit-20261109.json`.
- Three real-browser native schedule tests passed for legacy/generated/linked
  speech cues, group effects, automatic unbound playback and timing restoration.
  Log: `<validation-dir>/three-fixes-native-schedule-e2e.log`.
- Native iframe integration covers wrong/correct Quiz choices, explicit teacher
  continuation, source-less checkpoints, repeated start/stop and read failures.
- SVG/project, preview authorization and adapter checks passed. Runtime teaching
  and core checks: 52 passed; WiseOffice sidebar/motion/slideshow checks: 90 passed.
  Desktop and WiseOffice typechecks passed, as did the runtime build and integrated
  WiseOffice build/staging.
- Fresh portable fixture passed the browser narration/wait/navigation check:
  `<validation-dir>/three-fixes-portable-browser-20261109/result.json`.
- Historical team-loader tests cannot run: their pinned D17 build directory is
  absent on this machine. The authorization regression passed; this does not
  certify the missing historical team fixture.

The rebuilt native resources are installed in the Desktop worktree. The previous
bundle is preserved at
`<validation-dir>/wiseoffice-before-three-fixes-20261109`.
An already open editor must reload to use the new bundle. No provider generation,
paid task submission, user courseware rewrite or application restart was performed.
