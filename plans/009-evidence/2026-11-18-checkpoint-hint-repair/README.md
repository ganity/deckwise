# Checkpoint hint repair — partial follow-up

The preceding real water-cycle run exposed two independent issues. This change
closes the missing generated-checkpoint hint correction path, not the missing
river foreground layer or the earlier Electron startup timeout.

The regression initially failed because `checkpointHintCorrections` was not an
accepted verdict field. Final review now receives canonical checkpoint details,
validates exact current action IDs and modifies only an existing hint through
the existing classroom CAS/save. It then rereads and reviews the saved result.
Questions, answers, speech/audio, original imports, locks, source checks and
bounded retries retain their existing protections. The hint lives in native
checkpoint metadata, not in the strict playback action.

Validation:

- Desktop: 114 tests across saved-content review, native tools and classroom
  persistence passed. This includes correction/recheck, separate visual failure,
  original/locked/read-only protection, malformed/invented corrections, budget
  exhaustion and concurrent source/model/owner changes.
- Companion editor: 39 native-teaching tests passed, including hint-only writes
  followed by canonical readback with identical speech/audio/reference keys.
  The companion change in this round is a regression test, not new editor logic.
- Desktop typecheck and both worktree diff checks passed.

No real provider call or product build was repeated for this field-only change.
The earlier paid-run evidence is unchanged and remains a Scene failure; its
artifact has not been repaired by these tests. No commit, publication or release
qualification is claimed.

The subsequent user decision accepts a complete rectangular teaching region,
including some surrounding background. The supported local repair and its
native save/reopen/playback evidence are recorded in the
[region follow-up](../2026-11-18-background-region/README.md). This does not
retroactively turn the original paid run into a pass.
