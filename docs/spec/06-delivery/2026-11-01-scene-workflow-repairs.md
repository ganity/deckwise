# Scene workflow repair delivery — 2026-11-01

## Result and scope

Implemented plans 001–006 in the existing `feat/courseware-par-A` worktree,
based on HEAD `1ff749805` plus the 204 pre-existing dirty-tree entries. Those
entries were preserved. No new worktree, commit, deployment, user-profile write
or paid generation was performed. The implementation closes the audited local
workflow defects; it does not establish live supplier availability.

## Delivered behavior

| Plan | Implemented behavior and primary evidence |
| --- | --- |
| 001 | Host atomically rebinds unchanged logical music/video targets on verified native saves; original request/key/hash/account stay fixed. The native-save regression performs two saves for pending/adopted video and legacy music, preserves portable video, and exposes ambiguous originals instead of purchasing replacements. Main covers logical page reorder and changed-lyrics deduplication. |
| 002 | Queue admission precedes Host begin. Quote expiry while queued leaves the intent prepared with zero POSTs. Actual Host scope/restart tests cover account routing and lost responses. Concurrent original-task reads share reconciliation; CAS conflicts reread committed state. Healthy queue capacity remains usable when another original cannot reconcile. Video validates the original begin receipt through the existing scope validator. |
| 003 | Shared recovery normalizes real image/media/video envelopes. Unknown originals are queried once per run, independent healthy work continues, and unchanged semantic image progress is bounded at ten minutes. Completed/advisory and blocked runs permit one report and then close; a new user run can resume. |
| 004 | Required repair emits insertions at existing speech IDs, retaining full original speech/audio/effects/source values. Shared and Rust consume the same question fixtures and compare exact text, ordered options and answers. Lost committed-save responses are reconciled without another model repair or duplicate actions. |
| 005 | Optional structured `teaching.video` survives parsing, canonical hashing and compiled mapping; Host reports missing/pending video until verified original adoption. A pre-repair parser comparison pins the legacy no-video page hash. Old absent fields round-trip unchanged. |
| 006 | `pnpm test:courseware-workflow` builds the current checkout's Host and runs mandatory real Main/compiler/parser/Host and Runtime boundaries. CI invokes the same gate. Reports expose mock POSTs, concurrency peaks, repair/adoption counts and terminal events. |

Skill instructions, tool descriptions, shared contracts, Runtime, Main, Host,
regressions and compatibility documentation were updated together. Persistent
changes are additive optional v1 KV fields; SQL tables are unchanged. See the
[binding/requirement ADR](../../adr/courseware-media-bindings-and-requirements.md).
Older strict readers can reject new fields: upgrade matching components together;
downgrade requires a compatible profile backup, never receipt deletion.

## Validation

The checked-in `plans/validation-report.json` records:

| Check | Result |
| --- | --- |
| Mandatory Main/Host suites, 17 files | 413 passed; zero skipped/cancelled |
| Shared question/video/recovery contracts | 27 passed; zero pending |
| Runtime continuation, writer, tool and full Runtime suites | 413 passed; zero pending |
| Host DB/RPC courseware project regression | 250 passed; 2 existing optional fixture cases ignored |
| Final instruction/tool continuation checks | 31 passed after the last description update |
| `pnpm -r --filter '!@pi-desktop/docs' --if-present build` | Passed, including production Desktop and current shared/runtime/worker builds |
| Final Desktop build; Desktop typecheck; Runtime build | Passed |
| `cargo clippy -p host-core --all-targets --locked` | Passed; existing warnings remain |
| Whole `pnpm build:js` | Blocked by seven pre-existing documentation dead links |
| Whole `cargo fmt --all -- --check` | Existing dirty-tree formatting differences remain; formatting was applied only to repair regions |
| Whole `git diff --check` | Existing extra EOF blank line in untouched `courseware-video-placement.ts` |

The two ignored Rust tests require `DECKWISE_LOCKED_IMAGES_FIXTURE` and explicit
execution of the portable-parser fixture respectively. They are not the mandatory
new regressions; those executed. The cross-layer fixture itself runs the real
compiler/parser and Host without requiring an installed native editor.

Observed independent concurrency peaks: TTS **10**, image **5**, layers **5**,
music **2**, export **2**, video **2**. Queued expired-quote POST count: **0**.
Original music/export fixture: **2** mock POSTs, **2** recovered originals and
**1** archived export. Required video fixture: **1** model repair, **1** saved
question, **1** original video adoption, **4** preserved speeches and **1**
terminal Runtime event. Real paid provider calls: **0**.

The complete gate took approximately 5.1 minutes locally; its Rust stage took
276 seconds. The first gate attempt had a four-minute harness timeout despite
progressing tests. The bounded Host-test timeout is now ten minutes; this changes
only the verification harness, not production retry or generation limits.

## Reproduction and evidence

From the worktree root:

```bash
pnpm -r --filter '!@pi-desktop/docs' --if-present build
pnpm test:courseware-workflow
pnpm --filter @pi-desktop/desktop typecheck
cargo clippy -p host-core --all-targets --locked
```

The gate report and detailed logs are also in
`/tmp/deckwise-workflow-gate-pgsSEl/`. Pre-edit source snapshots are in
`/tmp/deckwise-repair-baseline-5llw78r1/`. Captured failing regressions include
`/tmp/deckwise-plan003-red.log`, `/tmp/deckwise-plan004-red.log`,
`/tmp/deckwise-plan004-writer-red.log` and `/tmp/deckwise-video-red.log`.
Not every added interruption/compatibility case has a captured pre-fix red log;
those rely on baseline comparison plus the current executed regression rather
than a manufactured revert of the dirty worktree. Raw temporary logs are local
artifacts, not durable CI storage; the runner regenerates them on each invocation.

## Remaining acceptance and risks

No fresh paid ten-page run, packaged native-editor/player acceptance, subjective
slide/audio review or provider outage diagnosis was performed. The headless
fixture uses synthetic model/supplier results and decoded metadata; it does not
claim actual Electron media decoding or native Office save serialization.

Historical originals already stranded before a verified binding existed may need
explicit resolution. The fix does not infer legacy free-text video requirements,
reconstruct supplier audio that was never saved, or resolve the earlier original
TTS service HTTP 500. Independent limits are process-local, not a cross-process
supplier scheduler. External outages can still cause an honest bounded handoff.
The existing documentation/formatting baseline issues remain release blockers.
