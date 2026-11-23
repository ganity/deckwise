# Companion source delivery

The Desktop and embedded editor fixes form one tested candidate. Desktop source is in `courseware-stage-aware-scene` (see candidate.json for the actual worktree path). The editor companion is in `document-worktrees/courseware-par-A-playback`; its exact five-file source diff is included as `editor-companion.patch`. Do not ship Desktop with an older editor bundle: that reintroduces audio adoption, Quiz title/reference and stale-template bugs.

The patch is for review/integration into the matching editor base, not an instruction to overwrite a dirty checkout. Source hashes, base heads and the running bundle inventory hash are recorded in candidate.json. No commit, merge, remote write or installer release was requested.

Rebuild the companion with the existing `scripts/build-wiseoffice-maic.mjs <editor source> <new build directory>`, stage with `scripts/stage-wiseoffice.mjs <build> <new destination>`, and verify with its `--check` mode. Build the changed Host and Desktop from the same source candidate. The closeout run uses the rebuilt Host, Desktop and the previously verified companion editor bundle.
