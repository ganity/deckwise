# Complete courseware platform delivery acceptance

The course workspace and structured classroom editor expose separate **Sync to platform** and **Publish** actions. Neither asks for the original PPT or lesson plan. The original PPT import API remains available for legacy clients.

Acceptance sequence:

1. Finish native courseware and narration. Click Publish before any sync: show a prompt to sync, without submitting publication.
2. Click Sync to platform: export complete PPTist scenes/actions/audio/media. Confirm that a narration spotlight targeting a grouped PPT object covers the same group in platform playback as in local playback. The platform contains one draft course. Repeating the action without edits keeps the binding and revision.
3. Publish: wait for the signed package to be prepared, then list the course. Playback uses archived narration without regenerating TTS. For objective native questions the original visual page precedes a standard graded Quiz; a saved native Quiz keeps its question configuration, feedback mode, answers and question/option images. Discussions and short-answer teaching checkpoints remain teacher-led unless the saved lesson plan explicitly marks the page as a Quiz.
4. Edit text, slides, audio or teaching steps locally. Publish prompts sync first. Synchronize again: same course/classroom, new draft revision, old online URL and version unchanged. Publish explicitly to switch the online package once.
5. Edit the cloud draft in management web, then synchronize locally. Display a conflict and an explicit Replace cloud draft action. Cancel preserves cloud content; confirm replaces only the displayed revision; any subsequent cloud edit conflicts again. Online content remains unchanged until publication.
6. Interrupt after submission or restart the desktop after a response is lost. Repeating the action recovers the original receipt; no duplicate course or extra publication version is created. If newer local edits exist, recovering an earlier publication leaves those edits unsynchronized.
7. Change account, workspace, session or native source during export: reject stale adoption. Packages with missing/corrupt resources, non-MAIC teaching, or incomplete narration cannot synchronize/publish. Explicitly silent pages are allowed only when the saved script policy marks those page IDs silent. A native sync fingerprint includes the saved PPTX bytes and verified converter manifest, so changing the conversion worker requires a new sync before publication.
8. A conversion with warnings displays their actual diagnostics and needs explicit approval. Editing the source expires approval. Blocking conversion errors never permit publication.
9. Verify a legacy PPT import/course publication still uses its original behavior.

Implementation rationale and deployment prerequisites: [delivery ADR](../../adr/courseware-platform-delivery.md).
