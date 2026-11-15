# Upgrade recovery and late-login failure notice — 2026-10-25

Status: **current local fixture AppImage; full W17.2 remains IN_PROGRESS**.
No paid supplier call, user database, production service, remote write or
deployment is involved. All databases and login profiles are disposable.

## Host upgrade and recovery

[`host/report.json`](host/report.json) records five checks using actual packaged
schema-18 and schema-24 Host binaries:

1. Upgrade 18 to 24, preserving sessions, messages and KV rows; six intermediate
   backups have the correct schema and pass SQLite integrity checks.
2. The old Host refuses schema 24 without changing the database or retained asset.
3. An injected migration-table conflict rolls back to 18 and leaves a readable
   backup. Correcting only the injected conflict allows a subsequent upgrade.
4. The old Host can open a separate pre-upgrade backup while the upgraded data
   and asset remain intact. This does not downgrade the live database.
5. The current Host refuses unknown future schema 25 without rewriting it.

Reproduce with `python3 scripts/check-courseware-upgrade.py CURRENT_HOST
OLDER_SCHEMA18_HOST NEW_EVIDENCE_DIRECTORY`. Exact binary paths and hashes are
in the report. This is a deterministic SQL-error rollback, not an OS-kill or
power-loss interruption exercise. The KV fixture is not a restored player pointer.

## Actual migration interruption

[`sigkill/report.json`](sigkill/report.json) adds **three passing checks** using
the same packaged Host hashes. The fixture contains 24,001 sessions so the real
v18→v19 table rebuild exceeds the Host's cache. The harness waits for a valid
v18 backup and actual migration WAL writes, then stops the child. It verifies
23 complete WAL frames, zero commit markers and the still-visible schema18
before sending SIGKILL. It does not merely kill a process before migration starts.

SQLite reopen retains every session, message and KV fingerprint, passes integrity
and foreign-key checks and leaves no partially renamed sessions table. The same
packaged Host then completes upgrade to24, leaves six valid intermediate backups
and reopens again with unchanged retained data and fixture asset bytes.

Reproduce with `python3 scripts/check-courseware-upgrade-interruption.py
CURRENT_HOST OLDER_SCHEMA18_HOST NEW_EVIDENCE_DIRECTORY`. Only this harness's
temporary child is stopped/killed, and its temporary data is removed on exit.
This is Linux process-death recovery, not physical power-loss or Windows/macOS
qualification. No product code or package contents change in this increment.

The plan's publication pointers belong to the separately deferred team
shared/formal channels. They remain open and are not replaced by a new local
pointer feature. The existing local fixed-preview token intentionally expires
on Host exit or Desktop restart; a teacher rebuilds from the saved input.

## Confirmed UI defect and repair

The previous trial package recognized schema 25/support 24 in Main but showed
only `host unavailable` after login. The shell mounted after the one-shot boot
event. [`electron-preload-ready/report.json`](electron-preload-ready/report.json)
retains that failure. The earlier `electron/` failure was a harness timing issue.
[`host-status-before-fix.txt`](host-status-before-fix.txt) retains the failing
renderer subscription regression run.

Main now retains the latest runtime status, exposed through the read-only
`appHostStatus` IPC. The renderer subscribes before reading it. A newer live
event supersedes an in-flight read, disposal fences the result, and retained
recovery never repeats the success toast/checkpoint refresh. Failed reads keep
the live subscription and emit a generic console diagnostic. No database schema
or persisted data format changes.

[`electron-final/report.json`](electron-final/report.json) exercises the actual
fresh Linux package, local identity fixture and future-schema database. It
checks retained failure before login, the specific fatal notice after login,
the same notice after renderer reload, and unchanged rejected database bytes.
[`artifact-identity.json`](artifact-identity.json) pins the initial focused
candidate. The subsequent complete Chat gate and AppImage promotion are pinned
by [`acceptance.json`](acceptance.json); product sources and package payloads
remain unchanged between those gates.

## Current Linux trial artifact

The same repaired package now passes **17/17 main Chat/real WiseOffice groups**
in [`chat-e2e/report.json`](chat-e2e/report.json): all three task entrances,
plan/asset review, actual official PPT Master generation/export, saved native
editing, per-page narration review, fade-candidate adoption and full restart.
Identity/model/media output use loopback fixtures, with no paid calls.

`apps/desktop/release/schema-notice-20261025/DeckWise-0.17.7.AppImage` is
**341,003,728 bytes**, SHA-256
`be879f7ff15175936a3b48aef9c1adb2fe34b4a8493eb264c030343f7016520e`.
The actual AppImage starts and its five runtime payloads match the tested
unpacked package ([launcher check](appimage-smoke.json)). All packaged build
outputs and selected resources match ([package check](package-check.json)).
Non-ASAR resources are unchanged from the earlier trial; existing Python/PPT
Master dependency acceptance is inherited rather than rerun.

The separate pinned Office output still matches all 2,899 files
([Office check](office-check.json)). All 1,179 inventoried product sources remain
unchanged from the mid-gate inventory capture to promotion, and affected source
hashes match the pre-gate package identity. The package remains `f9600d629` plus
working changes; remote main was not refreshed and no merge/release is claimed.
The historical single trial entry, `docs/validation/courseware/parallel/A/current-trial.md`,
pointed to this artifact; that entry is not included in this checkout.
Earlier AppImages and failed reports remain historical.

## Validation and limits

- Subscription/boot tests: **11/11**, [`host-status-tests.txt`](host-status-tests.txt).
- Shared IPC protocol tests: **16/16**, [`protocol-tests.txt`](protocol-tests.txt).
- Desktop typecheck, build and style-token check pass; corresponding logs are
  alongside this file. The attempted path-limited Biome run processed no files
  because these paths are outside its configured scope; it is not a lint pass.
- Packaged credential scan passes; its signature/obfuscation and archive limits
  remain as stated in [`package-credentials.json`](package-credentials.json).
- Actual Electron runs with `--no-sandbox` in Xvfb and local identity only.
  `scripts/e2e-courseware-schema-refusal.mjs` is the repeatable focused gate.

The previous source-Electron results remain tied to the previous source;
the current 17 packaged groups above are a separate new run. This does not accept real
teacher authentication, deployment settings, supplier output/teaching quality,
managed text billing policy, physical power-loss recovery or team publication
pointer recovery. The separate Linux SIGKILL gate above closes only the scoped
process-death migration check. W17.2 and the original full Plan 007 remain open.
