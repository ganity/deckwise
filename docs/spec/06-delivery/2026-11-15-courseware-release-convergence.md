# Courseware release convergence: first delivery slice

## Scope

This implements the first stabilization slice after the architecture review:
paired build inputs, fail-closed packaging and repeatable local evidence. It
continues the existing isolated Desktop courseware worktree and preserves the
earlier uncommitted Desktop/Document changes. It does not replace the native
editor, rewrite workflow ownership, publish a release or submit paid media jobs.

## Findings and changes

1. The staged worker really differed from the current runtime build:
   `pptx-worker.mjs` was `96e36be7…`, while the current compiler build was
   `148c6473…`. The new input check rejected it. Preserve the old directory in
   evidence and restage the current worker with the existing staging script.
   Remove packaging's separate compiler overwrite and use one inventoried worker
   source on every platform. Normalize native worker inventory paths to POSIX.
2. Packaging previously did not consume the editor's per-file receipt. Both
   hooks now check actual WiseOffice and worker bytes, architecture, required
   integration resources, and current compiler agreement. Release mode requires
   a matching frozen input lock and clean paired sources. Recheck the copied
   bundles and the release lock after packing; create an unaccepted unpacked-app
   identity receipt covering Electron/runtime resources, ASAR, Host and Agent.
   The integrated editor now records its embedded Desktop revision too; an older
   or dirty shared Quiz integration cannot qualify as a clean paired release.
   Rebuild and stage the paired editor after the shared answer-color repair.
3. Release verification omitted the courseware workflow gate already present in
   ordinary CI. Add it and protect that configuration with tests.
4. The native background test reused the Master fixture as its Scene fixture and
   compared its reopened page count with the Master page count. Accept a separate
   Scene fixture, compare with its own snapshot, verify every input is unchanged,
   and retain successful reports/logs. The combined runner requires three distinct
   fixtures, each 1–6 pages, and rejects missing evidence or source/build/input
   drift. Its strongest result is `LOCAL_REGRESSION_PASS`, never release approval.
5. The MAIC journey still expected an obsolete saved-status label and removed
   inline Quiz preview. Follow the current saved-status region and separate
   course player, start playback before answering, and use the actual failed-voice
   skip control where system speech is unavailable. Wait for initial navigation
   before the authentication fixture reloads the renderer. Find checkpoints by
   action type because generated question narration can precede them. Use answer
   buttons and individual key-point fields, and expand context settings before
   editing. Seed the existing three-question assessment fixture at initial Host
   creation, then author its types/answers through the current UI; the removed
   add-question control is not recreated or claimed as tested functionality.
6. Real screenshots exposed white text on the white selected-answer badge in the
   dark theme. A real browser test fails on those identical colors before the
   one-property fix. Use the existing foreground-on-accent convention and check
   both light and dark themes. No document content or answer identity changes.
7. The combined consumer check correctly failed when reference dependencies were
   absent. Frozen installation then exposed a real management-web lock defect:
   npm 9, 10 and 11 reject two missing transitive entries; the alternative pnpm
   lock is also behind the declared dependencies. Preserve the original checkout
   and use branch `fix/courseware-validation-lock` in
   `/home/jhz/code/train/cloud-web-trainwise-worktrees/courseware-release-convergence`.
   Add only the missing `@emnapi/core` and `@emnapi/runtime` records (22 lines)
   to its npm lock. A fresh `npm ci --ignore-scripts --no-audit --no-fund` succeeds.
   No other locked versions change. MAIC uses its unchanged frozen pnpm lock.
   Add a dependency preflight before expensive regression starts, with a test
   proving failure starts no Electron process or evidence directory.

## Evidence

Evidence root: `/home/jhz/deckwise-validation/release-convergence-20261115`.

- `inputs-initial.log`: real stale-worker rejection, before repair.
- `worker-before-integrity-fix/`: preserved previous worker; `worker-current/`
  contains the new native dependency inventory (155 files).
- `wiseoffice-check.log`: all 2,858 staged editor files verify.
- `inputs-final.json`: pinned Linux x64 paired inputs after rebuilding the editor
  with embedded Desktop provenance. Both source worktrees are dirty; these are
  local inputs only. Earlier input snapshots remain preserved separately.
- `release-block-final.log`: the actual dirty paired sources are rejected in release
  mode, not just in a synthetic fixture test.
- `unit-tests-complete.log`: 40 focused tests pass, including builder hook loading,
  inventory tampering, escaping symlinks, stale compilers, target mismatch,
  missing/mismatched release locks, dirty sources, clean paired success,
  mismatched embedded Desktop revision, evidence non-overwrite and dependency
  preflight failure.
- `quiz-contrast-red.log` reproduces the visual defect; `quiz-editor-browser.log`
  passes the real renderer journey and light/dark badge checks after repair.
- `desktop-build.log` and `desktop-lint.log`: Desktop production build and style
  token checks pass. Vite's existing large-chunk warning remains.
- `regression-1/`: scene transport and all four actual native background checks
  pass. The combined result correctly fails on the stale MAIC test selectors.
  The subsequent `parity-retry-*` directories retain diagnosis, including the
  system speech failure and its real player controls.
- `regression-final/`: all 17 scene checks, four native checks and ten
  Desktop/Main/Host journeys pass; the overall result is correctly `FAIL` because
  the reference MAIC dependency was missing. It remains preserved as a failure.
- `cloud-minimal-lock-install.log`: a fresh installation from the minimal npm
  lock repair succeeds. The original cloud-web and MAIC source checkouts remain
  clean. The alternate pnpm lock was not repaired or used for cloud-web.
- `reference-inputs.json`: exact reference revisions, source/lock hashes and the
  isolated cloud-web lock change used for the final local rerun.
- `workflow-gate/report.json`: the actual provider-free courseware gate passes
  with 639 Main/Host, 44 shared, 540 Agent and 302 Rust tests; the existing two
  ignored Rust tests remain ignored. This gate does not run a native editor;
  the separate combined regression supplies that coverage. Rust tests still
  contact the public plugin catalog during Host startup, so provider-free does
  not mean network-isolated; that dependency contributes to the five-minute
  Rust stage and remains a test-isolation limitation.

- `regression-final-2/report.json`: `LOCAL_REGRESSION_PASS`,
  `releaseReady:false`, `paidCalls:false`. The distinct Master, Scene and Import
  fixtures contain four, four and two pages. All 17 scene transport checks, four
  native foreground/background checks and ten real Desktop/Main/Host journeys
  pass. All seven parity steps pass, including the real MAIC package projector,
  management-web image/assessment consumers and geometry at 1844×908 and
  1280×800. The seven steps include the Desktop journey, not seven additional
  end-user scenarios. Source/build/paired-input and fixture identities match at
  the end. A separate post-run comparison also confirms the reference source
  and dependency-lock hashes in `reference-inputs.json` remain unchanged.
  Reviewed the final reference/runtime screenshots; the deterministic white
  image fixtures and matching geometry are expected, not generated-image proof.

## Delivery limits

- No final installer was built or qualified in this slice. The identity receipt
  is produced before signing. A signed/repacked deliverable needs qualification
  against its final bytes and chosen production model.
- No fresh production-provider generation, new media purchase, billing retry or
  full natural playback of all three lessons was performed here.
  Quiz upload/parity checks use a deterministic one-pixel PNG; they verify asset
  binding, persistence, loading and layout, not generated-image subject quality.
- Release runners do not yet have an approved supply step for the ignored paired
  editor/worker inputs and matching lock. The new gate deliberately blocks that
  unprovisioned release path; it must not be bypassed to ship.
- Existing changes need review and clean paired commits before the strict release
  gate can pass. Historical passing slice tests do not establish release readiness.
- Host-owned deterministic workflow advancement, durable stage/status semantics
  and full production interruption recovery remain later stabilization work.

## Commit build follow-up

On the subsequent request to check builds and commit, a fresh `pnpm build:js`
initially exposed ten dead documentation links. Preserve repository-plan paths
as source references outside the site, and identify absent historical trial/ADR
records explicitly. Dead-link validation remains enabled. The complete JS/site
build, Desktop typecheck, locked release Host build, Document typecheck and
Document module build now pass. The Desktop's existing large-chunk warning
remains. Generated editor/worker backup directories stay local and are ignored.

Logs: `/home/jhz/deckwise-validation/commit-build-check-20261115-nJDbHY`.
The 40 release checks and 64 Document tests pass. An additional full runtime
suite is **not green**: 501 passed, 29 failed and 12 skipped. Twenty-eight
failures require absent historical `.worker-desktop-02` or absolute-path C2b
asset fixtures; the lineage suite also cannot initialize without that worker.
Those fixture-dependent test files are unchanged. The remaining large-resource
test timed out during concurrent builds; its complete 18-test compiler file
passes separately in 3.29 seconds without changing its timeout or assertions.
Do not substitute current assets for the historical pinned hashes or claim
those missing-fixture checks passed. `cargo fmt --check` also fails on both the
unchanged HEAD archive and the current tree; no repository-wide formatting
rewrite was included. These are local source commits, not a release approval.
