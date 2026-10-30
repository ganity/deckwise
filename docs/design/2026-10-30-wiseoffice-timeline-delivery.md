# Native teaching timeline delivery

The desktop courseware branch integrates the native teaching sidebar and its
required Host save, saved-object identity, local-media and shared playback paths.
The native sidebar replaces the outer teaching form in the PPTX editor. Its
ordered list expands the selected editor inline, gives spotlight a direct entry,
keeps native animation editing and full-lesson playback available, and resizes
the native property pane with the canvas.

Narration owns its following pause. The editor offers no wait, a short pause,
or a timed wait of 3–30 seconds. Host and fixed playback retain raw milliseconds;
cloud-web's multiplier is not part of this protocol. Existing independent delay
and interaction nodes remain readable. New authoring does not offer them.

Native PPT autosave is committed through a prepared Host receipt before Office
acknowledges the save. Saved page/object lineage and animation continuity govern
teaching reattachment; missing or ambiguous targets retain history and warnings.
This integration includes the existing local media and portable-project readers
needed by native preview. It excludes the separate Chat workspace redesign,
provider continuation changes and scene-generation prompt work.

## Editor source and local resources

`apps/desktop/resources/wiseoffice-source.json` pins the editor repository and
commit. Build that exact revision in a clean WiseOffice worktree, using its
workspace package builds and production build script. Then run from this repo:

```sh
node scripts/stage-wiseoffice.mjs /absolute/wiseoffice/dist /absolute/new-wiseoffice
```

The staging script bundles the current desktop teaching-preview entry under
`.deckwise/teaching-preview.mjs` and inventories its exact bytes with the editor.
The installed directory is `apps/desktop/resources/wiseoffice`; retain the old
directory before replacing it with the staged one. The manifest must name the
pinned editor commit, report `dirty: false`, and match every file size and SHA-256.
Generated Office and parser resources remain ignored by Git. Packaging uses
these staged resources; a source checkout must build/stage them first.

## Acceptance

Use isolated local fixtures and profiles, with network requests blocked. The
Electron local-editor probe opens a real PPTX over `deckwise-editor:`, imports
the shared preview, mounts the redesigned sidebar, verifies its width and inline
inspector, saves and reopens the document, and checks the original bytes remain
unchanged. The native teaching fixture transport never submits paid generation.

Targeted Desktop tests cover teaching authority, stale requests, saved source
receipts, native media and local-media integrity. Runtime tests cover narration
waits, cues and fixed conversion; Host project tests cover identity, drafts,
source replacement, portable media and restart recovery. The WiseOffice browser
scenario covers native selection, animation navigation, spotlight persistence,
lesson playback and media transitions.

This is a feature-branch integration, not an installer release. Cross-platform
packaging and paid-provider generation are separate acceptance work.

## Verification results

The delivery candidate passed 207 Desktop tests (2 environment-gated cases
skipped), 225 Host project tests (2 environment-gated cases ignored), 15 shared
contract tests and 124 runtime tests. The 3 focused native-save Host tests also
passed. Desktop and runtime TypeScript checks passed. The clean pinned editor
passed 248 targeted unit tests earlier in this delivery and its real browser
teaching scenario passed before staging.

The Electron offline round trip passed with a real three-page fixture, a native
teaching pane at least 350 pixels wide, shared preview imports, save/reopen and
zero remote requests. The probe now accepts Electron switches without mistaking
its script path for the fixture.

A root `build:js` attempt stopped at 7 pre-existing VitePress dead links outside
this change. Package dependency builds and the targeted Desktop production build
are the relevant executable validation; documentation-site link repair is not
included. Paid generation, the running user profile and installer release were
not exercised.
