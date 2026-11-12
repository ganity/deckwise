# Imported PPT teaching entry

Implemented on `feat/courseware-par-A` without changing the generation engine,
public IPC schema, native document ownership or publishing permissions.

## User flow

1. Import an existing PPT through the courseware workspace.
2. Replace the generic Chat welcome with a session-owned import card. Read the
   saved page/narration/audio counts when the matching editor is ready and saved.
3. Automatically request missing narration, audio, focus and teaching animations,
   preserving existing narration and matching audio. Do not show feature checkboxes,
   activity-count inputs or a replacement option. Infer Quiz/activity counts and
   positions from actual content, objectives, existing activities and the lesson plan;
   respect explicit requirements and page limits, reuse suitable activities and add
   only missing activities as independent pages. Bring forward the task audience
   and allow edits. Attach a plan or final script
   through the existing file picker/importer and label its role.
4. Start sends the teaching request and actual attachments directly through the
   existing Chat submission path, then hides the setup card. A send
   failure keeps audience/files. No provider call starts merely from importing,
   reading status, attaching a document or expanding settings.
5. Once accepted, Chat owns progress, stopping, continuation and later errors.
   Existing user or tool-message history keeps the setup hidden after reopening the session.
   A failed initial submission retains the setup and attachments for retry.
6. Preview/check uses the existing immutable snapshot/build/playback and inspection
   UI, including warning review and existing publishing gates. Counts do not mean
   content quality or real playback acceptance has passed.

## Implementation

- `CoursewareWorkspaceEntry.tsx`: observe import/task and editor events; display the
  import card and notify Chat that its generic welcome is no longer appropriate.
- `ChatSurface.tsx`: replace only the active imported task's empty welcome.
- `CoursewareImportStart.tsx`: form, attachments, explicit submission, scope fences,
  pre-start saved counts and preview integration, followed by handoff to Chat.
- `import-start.ts`: saved-data summaries and matching
  absolute task paths with workspace-relative editor event paths.
- Existing theme tokens and locale catalogs supply styling and user-visible copy.

The component has no local completion authority. Unsaved audience and attachment choices are draft UI
state; accepted requirements and material references are retained in normal Chat history.
Draft form choices are not recovered across full renderer restart. Existing saved
teaching is reread after restart. Local prototype/preview state is not a publish
permission and no automatic publishing request is sent.

## Verification

- 73 workflow/component/model regression tests passed, covering the workflow and
  import summary/path behavior.
- 29 i18n catalog/key tests passed; desktop typecheck, style-token validation,
  desktop build and diff whitespace checks passed.
- `courseware-import-start.browser.mjs`: real React entry/card, with external
  IPC/store boundaries controlled, passed import detection, direct submission,
  automatic teaching requirements/inferred activities, attachments, duplicate clicks, optimistic send failure, accepted dispatch hiding,
  stopped/reopened conversation hiding,
  late picker/session change, account invalidation, existing snapshot/build/play
  wiring, Chinese/English and a 430 px layout without horizontal overflow.
- Actual isolated Electron: a new empty Chat imported the real two-page subset of
  the user's decimal lesson using the visible import button. The import card
  showed 2 pages, 0 narration, 0 audio; Start became enabled; the generic welcome
  disappeared and no card error appeared. After the automatic-default update,
  reload verified zero checkboxes, zero numeric inputs, no extra-settings section,
  no card errors and an enabled Start button (`result-auto-final.json` and
  `import-auto-final.png`). Reload recovery was checked separately.
  Evidence: `/home/jhz/deckwise-validation/part-a-import-ui-20261112/`.
- The actual Electron check caught relative editor paths that the first simulated
  fixture missed. Matching now resolves only against the task's own workspace;
  regression cases reject a different workspace and traversal.

No new model/TTS generation or publication was performed for this UI change.
Earlier real-generation results do not certify this button's full provider flow.
No full repository suite or release installer qualification was run. The existing
Master label and independent-activity content defects remain outside this UI change.

## Native attachment picker incident

The isolated real-import test had replaced Electron's `dialog.showOpenDialog`
without restoring it. A later manual attachment click returned the earlier PPTX
instead of opening a picker, so the document-format check correctly rejected it.
This was test-process contamination, not a missing upload endpoint.

The external validation script `part-a-topics-20261112/scripts/import-start.js`
now restores the native picker in `finally` immediately after consuming the test
selection. A targeted check verifies restoration on success and picker failure.
The contaminated client was restarted with its saved session intact. The real OS
file dialog opened and canceled without a card error. Desktop automation could
not reliably select a file in that dialog; a one-shot selection then exercised the
real IPC importer and card with a TXT attachment, switched its role to script,
confirmed zero errors and restored the native picker. The test attachment was
removed from the card. No generation request was sent.
Evidence: `part-a-import-ui-20261112/attachment-import-result.json` and
`attachment-import-verified.png` in the external validation directory.
