# Paid three-route validation — 2026-11-18

Status: concluded; Import passed, Master blocked, Scene incomplete. This is a fresh test of the existing candidate, not a product-code change.

## Scope and candidate

- Candidate: `5cbd7cb44de14d6cb5f1e478ff9f57b63bd7d05d` plus existing local fixes; local origin/main had the same commit at preparation.
- Runtime artifacts and fingerprints: `candidate-fingerprint.json`.
- Four physical pages per course (two body pages, one quiz, one short-answer activity); hard user limit: five.
- Master: grade-three mathematics, meaning of fractions. Scene: grade-seven geography, water cycle. Import: grade-one Chinese, Quiet Night Thought, preserving original content and final teacher scripts.
- Real managed model, image/decomposition, and TTS services; isolated authenticated desktop. No platform publication.
- Evidence workspace: `/home/jhz/deckwise-validation/three-path-paid-20261118`.

## Results

- Import passed saved-source and real fixed-player checks. All four audio clips ended naturally; highlight, spotlight, and fade-in were observed; wrong/correct quiz feedback and teacher continuation worked. Original six text shapes/geometry/style were preserved after normal exporter normalization. Both final scripts survived exactly on pages 1 and 3.
- Master exported four editable pages but failed native teaching adoption. Native OMML fractions were parsed as empty text without sourceShapeId. Host correctly rejected unbound parsed objects. No Master TTS was bought. Original SVG previews alone do not establish exported formula fidelity.
- Scene images, decomposition, and compilation succeeded after model fallback. DeepSeek visual-grounding output failed the required JSON contract on both body pages after one repair attempt. Repeating the narration tool in that turn reused the terminal failure without further model calls. Both activity audio clips succeeded. Two subsequent gpt-6.1-sol body-narration calls remained pending for more than five minutes each and were aborted; body narration, TTS, and saved effects remain incomplete. The original generated images, layers, and activity audio remain preserved.

## Assistance and failures

This run is not an uninterrupted autonomous-success demonstration.

1. Test harness startup was initially blocked because sibling `candidate.json` shadowed the `candidate` Electron application directory. Renaming the fingerprint record fixed launch; no product code changed.
2. Master/Scene repeated requirements conflicts by adding absent optional empty/default fields to expectedEducationContext. Existing settings were preserved. Scene received operator guidance to stop rewriting those settings.
3. Scene plan review removed an internal `chapter_summary:` prefix from a learner title before approval.
4. Terra returned repeated 502/503 unavailable-upstream errors. The user authorized gpt-5.6-sol, then gpt-6.1-sol/DeepSeek. gpt-5.6-sol was absent from the managed catalog. GPT 6.1 sol repeatedly supplied an invalid first-image reference; DeepSeek successfully omitted the optional field and created the original image job.
5. Master recovered its own malformed animation JSON, but stopped at the reproducible native-equation integration defect.
6. Normal reviewed plan/style/export and notes-master-warning approvals were exercised. No unknown warning or content gate was waived.
7. The validation harness initially failed native opening because viewing-session state was unset; using the existing notificationSetViewingSession IPC resolved it. An old assertion requiring a quiz-rendered short-answer hint was corrected to validate the actual teacher-checkpoint contract, including saved title, question, answer and key points; the application output was not edited.
8. Import completed the remaining verification and actual playback after the initial agent completion omitted that final check. Scene's gpt-6.1-sol fallback calls stayed pending without producing tool results; both were cancelled and the saved course was reread to confirm no body speech had been persisted.

## Required follow-up

- Fix native equation parsing/identity together, with the actual exported fraction fixture. Do not weaken Host binding checks or silently discard equations.
- Address optional-field tool calls and requirements comparisons using provider-visible schemas and real managed calls; current recovery prose did not prevent repeated bad GPT calls.
- Retain bounded visual-output repair and truthful terminal error classification. Investigate visual-grounding prompt/output contract compatibility separately from payment or image quality.

## Limits

One course per route is a smoke sample, not a reliability-rate estimate. Original paid media and all transcript/operator receipts remain in the evidence workspace. No unsupported paid-order retry, database patch, product rebuild, publication or source edit was used to make this run pass. Notes-master layout fidelity is not claimed.
