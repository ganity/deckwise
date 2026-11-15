# 课件 PPTX 解析

> **原文镜像说明：** 本页保留完整英文规范，尚未提供全文中文译文。协议字段、约束和验收条件以 [英文源规格](/spec/03-runtime/21-courseware-parser) 为准。

The optional Linux x64 PPTX worker runs beneath Rust Host Core. Electron main
supplies its own executable and the trusted packaged worker entry at host
startup. The worker parses locally; it does not call models or adopt results
into the current editable PPTX. Parsing alone leaves SQLite and project revisions unchanged.
The separate verified `courseware.project.openSaved` coordinator can persist teaching.

Main resolves `<resources>/pptx-worker/pptx-worker.mjs`; a development launch
may supply `DECKWISE_PPTX_WORKER`. Host startup receives `DECKWISE_PPTX_NODE`
and `DECKWISE_PPTX_WORKER`. Neither is an RPC parameter. The worker is optional:
without it, existing app boot remains available and parsing rejects the request.

All methods require the existing protocol 11 handshake. They are host-internal
and are not registered directly as renderer IPC, agent tools or plugin capabilities.
The saved-revision inspection UI below is a narrow Main-owned caller.

| Method | Params | Result |
| --- | --- | --- |
| `courseware.parseStart` | `{ path: string }` | `{ jobId, status: "RUNNING" }` |
| `courseware.parseStatus` | `{ jobId: string }` | RUNNING, SUCCEEDED with page count/output directory/bounded summary, or FAILED with message/cleanupFailed |
| `courseware.parseCancel` | `{ jobId: string }` | Current state; caller polls until terminal |
| `courseware.parseRelease` | `{ jobId: string }` | `{ released: true }`; only after terminal |

Unknown fields, unknown job IDs, no selected workspace, paths outside the
canonical workspace (including symlink escapes), non-files, non-PPTX and
oversized files are rejected. One retained job is admitted per host, including
completed jobs: release before starting another. Output paths are host-selected
under `cache/courseware/<host UUID>/output`. No request chooses an executable,
command line, job directory or output path. Paths are arguments, never shell text.

On Linux the source is opened with no-follow/nonblocking flags and its actual
file descriptor target is checked against the canonical workspace. A bounded
copy of that open descriptor becomes the worker input under the job directory,
preserving the original basename. Replacing the source path after admission
cannot redirect the worker. Concurrent in-place writes to the same open file
are not an atomic document snapshot; editing revision fences belong to the
later adoption workflow. Each diagnostic stream retains at most 64 KiB while
remaining output is drained; the returned IR is limited to 64 MiB before read.

The host owns cancellation and waits for process exit before cleanup. Closing
stdin cancels the active job, waits for it and removes the retained job directory.
Release removes temporary results; it never modifies the source PPTX. No job
is replayed after restart. Abrupt host termination recovery and automatic orphan
cleanup are not implemented yet. Durable project teaching initialization is a separate verified RPC; asset adoption remains unimplemented.

The child inherits no provider credentials or Node path injection. It receives
only Electron's Node-mode switch and a locale. This is not an OS sandbox.
The Linux local pilot now admits at most 50 MiB compressed PPTX input, 100
slide parts/results, 256 MiB declared ZIP expansion and 256 MiB total worker
output (IR, metadata, assets and report). One retained job and the 90-second
worker deadline remain. The server import API keeps its original defaults.
The trusted local worker checks ZIP expansion before parsing, reserves asset
bytes before concurrent writes, rejects a latched asset budget failure even
when a parser fallback caught it, and checks IR plus assets before writing.
The final report reserves up to the Host's 128 KiB report limit.

Host samples the child process's `/proc/<pid>/status` RSS/high-water mark and
output file lengths every 100 ms. Exceeding 1 GiB process RSS (including native
allocations), the output budget or the deadline terminates and reaps the child
before removing failed-job files. Final output/page checks reject a worker
that finishes between samples; the worker-reported peak RSS is checked too.
Linux can expose a non-zombie process status after its memory fields disappear.
Only the specific missing-RSS condition allows a bounded 100 ms wait for the
actual child exit. Confirmed success proceeds to the normal output/report/peak
checks; nonzero exit remains failure, and a still-running child retains the
missing-RSS failure and is terminated/reaped. Malformed RSS, memory/output limits
and cancellation do not use this exception. No blind worker retry is added.
Symlink/non-regular/excessive output entries are rejected. The input copy and
bounded logs are separate, so 256 MiB output is not a cap on the whole job's
source-plus-output directory size. Host error messages forward only allowlisted
limit codes with fixed text, never arbitrary worker stack traces or paths.

These are local pilot guards, **not kernel-enforced hard quotas**. A child can
overshoot memory or disk limits between samples; declared ZIP metadata is not
proof of actual expanded allocation. This installer has no delegated writable
cgroup/filesystem quota, so no cgroup or system setting is changed. The monitor
covers this worker process, not arbitrary descendant trees. Whole-application
memory, minimum hardware, deadline-boundary calibration, abrupt-termination
recovery, source changes during parsing, output compatibility, installer
verification, visual fidelity and Windows/macOS remain separate gates.

See the Plan 007 W02.4 evidence outside this repository for the exact source
combination tested. This internal transport does not complete the full W02.4
desktop or installation gate.

## Saved-revision inspection

The existing PPTX editor tab offers **Check saved version**. It checks the
editor's last successfully saved PPTX revision, excluding unsaved changes and
archived exports whose source replacement failed. Start rejects throughout
export, source writing and Office's host-commit acknowledgement, and after an
uncertain save outcome. Later native edits remain dirty while a completed save
provides its own snapshot for inspection. Other formats and
read-only documents do not enable this action. A save or editor close cancels
an active inspection. Main captures the revision path and expected SHA-256;
the renderer cannot select a path, executable, output or worker job ID.

Three main-window-only, allowlisted IPC channels start, poll and cancel this
inspection. Main retains one check and binds its opaque `checkId` to the
captured Host process and revision. Status/cancel reject unknown IDs and extra
fields. Start rejects all arguments. These handlers are not available through
the external Agent IPC dispatch map. Shared `PptxInspection` describes results.

The Rust Host derives a bounded summary after successful parsing: page count,
source SHA-256, total diagnostic count (`warningCount` for compatibility), full
`errorCount`, and up to 20 diagnostics (100 code characters, 500 message
characters each). Counts cover the entire report, before display truncation.
Errors are displayed first, retaining order within error/non-error groups.
Each diagnostic includes `severity` (`info`, `warning`, `error`, or `unknown`)
and an optional zero-based `pageIndex` only when it is an integer in page range.
Missing/unrecognized severity becomes `unknown`; invalid/missing page indices
are omitted, never assigned to page zero. Existing optional warning metadata
does not imply an absence of loss. The worker report is limited to 128 KiB before
reading. Main verifies the source hash against the captured revision, waits for
the worker's terminal state and releases temporary results before publishing
success/cancellation. Cleanup failure stays a visible failure. No IR, asset
bytes, output directory or command path is returned to this UI.

The panel presents a content-error alert outside the collapsed report when
`errorCount > 0`, including when some errors exceed the display cap. It labels
individual severities and displays page numbers starting at one or explicitly
unspecified. With zero errors, the panel says only that this parser detected
none; visual/publication readiness remains unverified. Missing/invalid counts
from an incompatible Host fail inspection rather than implying zero errors.
Parser `SUCCEEDED` is an execution state, not compatibility approval. The check
does not prevent ordinary PPTX editing/saving and adds no publication endpoint.
Publication/adoption must enforce its own snapshot-bound policy in W07/W04.

The report identifies its saved revision and explicitly states that parser
completion is not visual-fidelity or publication approval. Closing/unmounting
the panel or replacing its revision suppresses late UI results. The current
implementation is an inspection, not a durable import, teaching-data sidecar,
publication conversion or claim that all necessary content is supported.

## Saved-source identity admission

Workers may additionally emit `identity.json` with schema
`maic-saved-source-identity/1`, plus `identitySchemaVersion` and
`identitySha256` in `result.json`. Both report fields must be absent for a legacy
worker, or both valid. Host rejects malformed/partial metadata, identity files
over 16 MiB, digest/source mismatches, duplicate identifiers, more than 10,000
objects, incomplete page/object coverage of the parsed IR, and already-bound
worker exports. The strict envelope follows D2f; fingerprints are generated by
the trusted worker, not recomputed or invented by Host.

Host pins the verified identity digest in its completed-job summary. Before
`openSaved` it reopens the identity file with the existing no-follow/containment
checks and verifies that pinned digest, as well as rechecking the actual saved
PPTX bytes. Rewriting `result.json` after completion cannot replace the pin.
The bounded digest is transport metadata; identity content, fingerprints and
mapping authority are not returned to the inspection UI or supplied by a model.
Project and identity persistence is specified in `22-courseware-contract-v1.md`.
Legacy workers keep their existing behavior; this is not cross-save adoption.

## Linux package preparation

`stage:pptx-worker` accepts absolute bundle and new destination paths. It checks
the Linux x64 manifest, exact file inventory, regular files, safe relative paths,
byte lengths and SHA-256 before staging. It refuses an existing destination.
`--check <absolute bundle>` runs the same checks without copying or changing it.
The manifest must include `pptx-worker.mjs`; a manifest is integrity metadata,
not a signature or evidence that its source is trusted.

Stage the approved MAIC worker into `apps/desktop/resources/pptx-worker` before
running `pack:courseware:linux` or `dist:courseware:linux` from `apps/desktop`.
These explicit courseware targets verify the staged bundle before invoking the
existing complete `pack` or `dist:linux` resource build. Ordinary package targets
keep their current behavior. The Linux extraResources filter copies the worker
and its nested native dependencies from the parent resources directory.

Successful worker validation alone does not prove that the app includes its
other runtimes, boots, renders fonts correctly or passes the courseware UI gate.

`courseware.parseStart` additionally accepts optional `sessionId`; when supplied,
the workspace comes only from that persisted session. Existing diagnostics omit
it and retain current-workspace behavior. Successful jobs retain their admitted
workspace/input identity internally for `courseware.project.openSaved`; callers
cannot substitute a path or page count in the adoption request.
