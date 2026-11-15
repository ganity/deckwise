# ADR: Portable courseware commits and authority migration

- Status: proposed, 2026-10-29. File transactions and the strict portable teaching/media schema are implemented
  and tested. The Host/Main/editor project-copy path, automatic verified restore,
  local media preview and snapshot capture are mounted on Linux. Normal-save
  authority migration remains disabled.
- Extends [Host-owned courseware](host-owned-courseware-projects.md) and implements
  G5 of the [teaching plan](../design/2026-10-28-wiseoffice-teaching-implementation.md).

## Context

Portable courseware carries both presentation and teaching files. Interrupted writes must not expose a mismatched pair, and recovery must preserve external edits rather than silently replacing them.

## Decision

One Rust Host writer commits the public PPTX/teaching pair. A per-project OS file
lock serializes writers across Host processes; holding that lock is also required
for readers so interrupted multi-file commits cannot appear valid. An immutable,
content-addressed local object archive retains old/new bytes. The durable pending
journal names expected previous and next revisions. It is published only after
new objects are synced. Each changed public file is moved without replacement
into a retained predecessor slot, verified again, then its next bytes are published without replacement.
The current revision index follows, and pending metadata is removed before
acknowledgement. A missing public pathname during that capture/publish gap is
recoverable only when its verified predecessor exists.

Reopen verifies the journal, immutable object hashes and every current public
file. A file may equal only its recorded old or new hash during recovery. Unknown
external changes stop recovery without overwrite. Valid prepared commits roll
forward idempotently; pre-journal interruptions retain the previous commit.
Checks after every logical commit boundary must demonstrate a complete old or
new pair after reopen. A published next index cannot authorize replacing an
external revert to old bytes. A same-hash public file is not rewritten
(teaching-only commits preserve the PPTX). This is recoverable multi-file commit, not a claim of OS atomicity.

The first filesystem implementation is Linux-only and uses directory descriptors,
no-follow file access, regular-file/size checks, file and directory fsync, and
same-filesystem no-replace rename/publication. Directory handles anchor all
operations, so parent symlink swaps cannot redirect file access. No dependency is
added. Cross-platform durable replacement must be proved before enabling this
writer on other operating systems. Archives and displaced predecessors are
retained until reference-aware cleanup is implemented. An external process holding an old file descriptor can continue
writing that retained predecessor; those bytes are preserved, never silently
merged into the committed source. Reconciliation/conflict-resolution UI and
platform/power-loss qualification remain required before user-file activation.

## Authority and rollout

The journal is internal infrastructure, not a second teaching authority. The Linux `courseware.project.copy` operation exports current committed teaching
into a new workspace-local project directory. Existing teaching writes are not
redirected and no legacy record is deleted. The strict `deckwise-teaching/1` schema validates bound logical mappings, the
editable action union, source pins and content-addressed relative media references.
Commit, restart reads and journal recovery all validate it. Media must be hash
and length verified and durable before publishing its sidecar. MIME and measured
duration must originate from the existing authenticated Host/Main decoder flow;
this file transaction layer does not add another decoder or generation path.
The schema accepts unfinished speech and review/lock state, so it is deliberately
separate from the stricter ready-only fixed snapshot model. Private accounts, receipts and signed URLs never enter
portable content.

Migration will be an explicit, non-destructive Host operation derived from the
current authorized workspace/session and saved source. Only after durable file
commit does an idempotent SQLite migration marker change authority; subsequent
reads/writes must use the sidecar, with SQLite retaining private/rebuildable data
and a legacy recovery copy. Copying a project must carry source, teaching and
media, and fresh-profile reopen must work without the source SQLite. Those
behaviors and coherent editor save/undo remain pending, not implied by this ADR.


## Portable content validation

The file header has a persistent project UUID, unique commit UUID and the existing
canonical project. The canonical source hash must equal the journal's exact saved
PPTX hash; the header commit must equal its journal commit. An update or recovery
cannot change either the project UUID or legacy canonical project ID. The legacy
ID remains unchanged because existing `office-*` IDs are not UUIDs.

The bound saved-source identity retains logical page/object IDs, import/native
shape evidence and fingerprints. Ordered pages must equal the canonical project;
cue/attention targets must exist on their own page and have an eligible object
kind. Free-form parser diagnostics are not portable: callers must keep diagnostics
in Host storage and explicitly supply an empty diagnostics array, rather than
exporting a potentially private path or service message. Unknown fields fail;
they are never silently removed by the transaction layer.

Timeline validation reuses Host delay, native-binding, teacher checkpoint and cue
validators. It rejects unknown action types, duplicate page-local node/checkpoint/cue IDs,
stale or reordered native bindings, invalid cross-page checkpoint references and
unsupported cue targets/styles. Speech may remain unfinished without audio;
aligned cues require a referenced audio asset and an interval within its measured
duration. Native effect inventory and cue-versus-native ownership still need the
existing SDK/fixed-build checks: the portable parser does not inspect the PPTX SDK
or claim an arbitrary ordinal exists in the saved file.

Media metadata contains only ID, `media/<sha256>.bin`, SHA-256, MIME, byte length
and measured duration. No absolute/remote URL, account, task intent or receipt is
accepted. Referenced media must exist with the pinned hash/length before commit,
before recovery replaces either public file, and on every verified read. Metadata
for identical bytes must agree. Unused media records reject; archived orphans
remain internal until reference-aware cleanup. Copy tests operate on isolated
fixtures and verified WAV bytes; they do not replace a mounted fresh-profile
Desktop migration/decoding/playback acceptance test.


## First mounted operation: copy saved teaching

The editor toolbar exposes **Copy complete courseware** for a clean saved PPTX.
Main derives the active session, source/teaching revision and live native context;
renderer input contains only `sessionId`, never an output path or manifest. One
existing saved-source parser lock spans the operation. Copy success or a media
failure retains unchanged teaching/sidebar review context; parser cleanup failure
still invalidates it. Session/document/source changes prevent using stale results.

Host resolves the persisted session workspace, checks the fresh parser's identity
against authoritative logical mapping, and reads canonical content in a SQLite
transaction. Existing adopted TTS matching-text/source checks are reused. Music
and video come from already adopted local records, including locked pages. Private
provenance stays in SQLite. Source/media bytes come from bounded, hash-verified
Host archives, without network calls, provider permission refreshes or charges.

The file writer creates `courseware-copies/<new-project-uuid>.deckwise/` under that
workspace with retained directory capabilities. Existing destinations and symlinked
parents refuse; no original source or prior copy is overwritten. Media and the
PPTX/teaching pair are durable and verified before success. Interrupted incomplete
copies remain unacknowledged; reference-aware cleanup remains deferred.

The sidecar also retains strict optional `assetLocks` and `sceneObjects` content.
Scene metadata carries its original bound identity and mapping, so aliases, roles,
regeneration instructions and historical/missing objects are not silently lost.
Image locks reuse their existing validator. Locks pinned to the current source
must agree with its object fingerprints/native proof; historical source pins are
retained as historical, never automatically rebound. Parser diagnostics are removed
explicitly from the copied identity, while the original Host record stays intact.

This operation exports a saved project backup and does not activate sidecar editing
authority. Verified UUID restore, automatic Main attachment and local media
rehydration are mounted as described below. Whole-editor fresh-profile acceptance,
opt-in idempotent authority migration, old-client behavior, normal Save and compound
undo remain required for G5 completion. Source-only copies still need a product
notice distinguishing a PPTX from a complete project backup.

## Verified Host restore into the existing authority

`courseware.project.restore` accepts a persisted session, successful saved parser
job and workspace-contained portable `lesson.pptx` path. It verifies the existing
commit/public pair, strict sidecar, fresh parser evidence and every media hash and
length. Media is archived locally before a single SQLite transaction imports the
canonical project, current/historical identities, scene metadata, image locks and
portable baseline marker. Failed imports can retain immutable media archives but
cannot expose a partial teaching project. Recovery retains the file writer's
existing no-clobber rules.

The imported project uses `portable-<projectUuid>` independently of editor job ID
and old profile paths. After successful import, that saved parser job is bound to
the UUID so normal `openSaved` and project-copy operations address the same
canonical project. Portable parser seeds omit diagnostic messages to match the
portable identity; source hashes, ordered pages, native evidence and object
fingerprints still compare exactly. Original parser output is not rewritten.

The marker retains the strict original portable baseline, separately from current
editable teaching. Repeating an identical import preserves current local edits.
A different baseline with the same UUID, orphan project without its marker or
changed local source rejects instead of overwriting. This is idempotent import,
not migration of normal save authority to files.

`courseware.project.localMedia` derives the project from the session workspace,
checks exact source/teaching revisions, verifies current page/action/asset against
the imported baseline and rechecks archived bytes. Changed speech text cannot
reuse old TTS. Music/video keep their original content references. This proof
authorizes local file reuse only and never fabricates provider receipts or
submits generation. Re-copy can combine valid imported files and newly adopted
provider assets while retaining their separate provenance.

Main now derives the actual source path from the authorized editor snapshot and
calls private `courseware.project.attach` after every original saved parse, before
ordinary open/review/copy/snapshot operations. Plain PPTX files return
`{attached:false}` without creating metadata. A portable baseline is imported
once; subsequent calls verify its unchanged sidecar/commit, source-versus-parser
hash and media before binding the new parser job to the same UUID. A retained
commit with a missing sidecar fails instead of silently opening empty teaching.

For an existing import only, a changed public PPTX may attach to its identical
baseline for the ordinary explicit source-review flow. No baseline or local
teaching is overwritten. Fresh-profile imports still require exact original
PPTX/identity proof. Reviewed logical page/action/type/asset bindings and unchanged
speech text permit imported local media to survive source association; a bare
source-hash edit without a bound identity fails. This reuses local content and
does not create provider authorization. The original backup is not updated by
subsequent SQLite edits or native PPTX saves; another complete copy exports the
current canonical project.

Main opens bounded no-follow regular media files, verifies exact length/hash,
decodes MIME and measured duration in its muted sandboxed Electron decoder, and
returns bytes only to native sidebar preview. Local-only playback/capture has no
account lookup. Snapshot `local:true` is exclusive of path/provider proofs and
Host checks every current reference, not only the shared asset ID, before archival
snapshot creation. Corruption is an error, never a trigger for generation or a
provider fallback. No renderer-selected restore path or manifest route is added.
These component and installed-worker tests do not certify whole-editor acceptance.
