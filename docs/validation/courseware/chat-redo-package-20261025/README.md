# Packaged main Chat page redo — 2026-10-25

Status: **21/21 packaged main Chat/WiseOffice groups pass**.
`acceptance.json` pins the exact artifact, matching Office and reports. This
is local fixture acceptance, not the complete Plan 007 release.

## Candidate

This increment packages the previously verified [main Chat redo repairs](../chat-source-visuals-20261025/integrated/README.md).
Ordinary exports expose saved-page visual preparation in Chat. WiseOffice can
render supported ordinary nested groups without native text; idle visual mounts
no longer trigger a competing teaching read. The teacher reviews the background,
requests a separate redo, previews it and explicitly adopts it. Notes and
logical-page narration are preserved. Team collaboration, collaborative
publication and virtual classroom remain deferred.

Desktop trial:
`apps/desktop/release/chat-redo-20261025/DeckWise-0.17.7.AppImage`.
Its release directory is a symlink to
`/mnt/docker-disk/deckwise-delivery/chat-redo-20261025/release` because the root
filesystem had less than 1 GB free. Build and test temporary files also use that
data disk. No previous artifact or test evidence was removed to make space.

The AppImage is 340,991,166 bytes, SHA-256
`3b1bb4b62f69447a0276d6840fab1efcdefcbfbb6d62d861a3b5caae982f4154`.
`artifact-identity.json` pins both paths and verifies the previous AppImage
remains unchanged.

Matching separate Office output:
`/home/jhz/code/train/document-worktrees/courseware-par-A-preview/dist-chat-source-groups-20261025`.
All 2,893 files match the retained inventory, aggregate SHA-256
`e52176bdc9673c4b38d3ab17fdc24dcbb0571ea57229c360a663d2e96ee660ab`.
See `office-check.json` and its original source patch/inventory links. Updating
Desktop alone does not update a separately served old Office build. Office is
not embedded in this AppImage and is not a newly deployed service.

## Checks

| Check | Evidence |
| --- | --- |
| Full packaged Chat/Office scenarios | **21 passed**; `chat-e2e/report.json` |
| AppImage itself starts; five runtime hashes match linux-unpacked | `appimage-smoke.json` |
| Current ASAR and changed staged resources match package | `package-check.json` |
| Worker provenance check | `worker-check.txt`; also checked in the package |
| New release Host upgrade/refusal/recovery | Five actual checks; `host-upgrade/report.json` |
| Packaged credential scan | 18,969 files, 1,047 symlinks; zero findings; `package-credentials.json` |
| Matching separate Office output | 2,893 files; `office-check.json` |
| Product source unchanged through packaging and gates | 1,125 identical inputs; `source-before.json` / `source-after.json` |

The AppImage launch smoke is distinct from full scenarios on linux-unpacked.
Its runtime payload hashes bind the launcher to the tested package. The full
gate uses actual packaged Main/Host/Agent/worker/Python/PPT Master and actual
separate Office. Identity, model choices and external media are loopback
fixtures, not real supplier output or teacher/deployment acceptance.

The Host was rebuilt from the current mechanically formatted sources and has a
different binary hash. Five upgrade checks therefore ran on this exact new
packaged executable: retained schema18 rows and six backups through schema24,
safe old-version refusal, failure rollback/corrected retry, opening a separate
backup, and refusing unknown schema25. Physical power loss and SIGKILL were not
repeated. Previous interruption evidence remains scoped to its original binary.

The Agent and worker/authoring bundles are byte-identical to the preceding
package (`prior-runtime-comparison.json`). Python and PPT Master dependency
acceptance is inherited, with current package presence and actual ordinary
generation/export exercised here. No unrelated dependency rebuild or repeated
whole-repository suite is performed. The prior source increment's targeted
tests, types/build/lint/architecture and Office tests remain separate evidence.
Credential scanning has its recorded signature/compressed-payload limits.

## Reproduce

Serve the exact separate Office output on a free loopback port, then run:

```sh
TMPDIR=/mnt/docker-disk/deckwise-delivery/chat-redo-20261025/tmp \
DECKWISE_E2E_PACKAGE_ROOT="$PWD/apps/desktop/release/chat-redo-20261025/linux-unpacked" \
DECKWISE_E2E_OUTPUT=/absolute/new/output \
DECKWISE_EDITOR_URL=http://127.0.0.1:4370 \
xvfb-run -a node scripts/e2e-courseware-chat-first.mjs
```

The evidence directory must not exist. Do not supply development Host, worker,
Node or Python overrides. The launcher rejects them for package validation.
The test creates a private profile/workspace and uses the authorized
`--no-sandbox`; existing user Desktop data and services are untouched. The
temporary preview service is stopped after verification.

## Remaining acceptance

This is an uncommitted manifest-pinned local Linux trial on `f9600d629`, with
known `origin/main` at `58a9c4f`; remote main was not refreshed. No commit, push,
PR integration, signing, deployment or update publication occurs. Do not treat
this package as a complete Plan 007 release. Normal teacher/target-service
acceptance, representative scene/voice quality and an approved managed text
budget/settlement policy remain open. Windows/macOS and normal-sandbox portable
installation are not qualified. Deferred features remain deferred.
