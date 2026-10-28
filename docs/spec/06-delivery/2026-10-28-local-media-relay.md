# Local media orchestration, 2026-10-28

## Scope and ownership

TTS and music now use `Desktop → Platform finite relay → MAIC → Doubao / mxapi`.
Platform authenticates, verifies quotes and supplier receipt ownership, and records existing accounting only.
It does not own generation tasks, candidates, audio archives, polling schedules or adoption.
There is no Platform → llm-ha path, and this change adds no production tables/migration.
Existing image/layer generation keeps its Desktop → llm-ha path.

Electron Main sends finite requests; Rust Host persists the principal-scoped
`coursewareMediaRelay.v1` journal in local SQLite with compare-and-swap revisions.
TTS returns audio synchronously. Music/export returns signed supplier receipts;
Desktop polls those receipts, retains all candidates, downloads audio and invokes the existing Host decode/adoption flow.
Main always supplies the Host journal in `DesktopAuthSession`; a missing/unavailable Host fails before a paid request.
Legacy transport readers are retained for compatibility, while Platform rejects new audio submissions to old task endpoints.

- POST `/courseware/media/relay`: existing signed quote plus request; optional team project and export source receipt.
- GET `/courseware/media/relay/query`: one read of the signed supplier receipt.
- GET `/courseware/media/relay/asset`: read an existing supplier result, never an implicit generation/export.

Music generation remains 2 Platform points (0.40 yuan) per submission, including all candidates.
MP3 export remains free. No retries are hidden behind a query, preview or download.
An ambiguous POST stays unknown locally; the billing idempotency guard cannot issue another supplier POST.
A definite preflight refusal is saved as a failed/released local task.

## Saved real task to resume after deployment

Preserve the same five-page task, rather than starting an 18-page task:

- session: `8dacf595-520c-40c3-8a8f-cd9429352554`
- project: `office-ee525a677067054be22aa306a3ee64a9fba5484c-8414ac4e8f44`
- source SHA-256: `ee525a677067054be22aa306a3ee64a9fba5484c8e0180a44adac1307727953b`
- existing 50 visual assets, 40 foreground objects and 44 narration segments must be reused.

No original project data or images are changed by this architecture correction.
Do not apply the previously prepared media-task/music-candidate SQL migration.
Deploy the matching Platform commit, rebuild/restart Desktop including Host, then resume this exact task.
The running old Desktop process was not replaced during this change.

## Validation and limitations

Targeted Main tests cover the relay lifecycle, real auth over loopback HTTP, local restart,
parallel submissions, failed preflight, unknown receipt, zero-cost export and audio integrity.
An actual Host process restart test confirms durable SQLite records, stale-write rejection and principal isolation.
Desktop typecheck/build and targeted Rust tests are required alongside those checks.

Platform tests cover signed receipts, one-call forwarding, independent read operations,
legacy endpoint rejection and no duplicate bill. A real disposable MySQL test creates only
`billing_usage_event`, `tenant_points_account` and `billing_points_txn`; successful generation charges
once, clears its reservation and is excluded from the generic background settler.

These local checks use supplier stand-ins. This change has not been deployed or accepted against
paid production generation/teaching playback. Network loss after supplier acceptance cannot reconstruct
Doubao's synchronous audio: it remains unknown and requires billing reconciliation rather than automatic recharging.
