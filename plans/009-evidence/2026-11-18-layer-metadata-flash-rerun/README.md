# Layer metadata analysis and exact Flash model rerun

## Conclusion

The real decomposition service returned both `name` and `description` for all 11 foreground layers in the two water-cycle pages. Background rows had neither. This was verified by authenticated GETs of the two existing task assets; no new generation was submitted for this inspection. URLs and credentials are excluded from the attached metadata extract.

Using this metadata to avoid repeating object identification is feasible. It does not independently prove that the lesson or narration is correct. The recommended change is to preserve and use the existing object evidence, while retaining the current final content-review requirement. No such product change was made in this analysis/rerun.

## What is actually lost

1. `decodeSceneImageItems` in `courseware-scene-image-assets.ts` reads `item.name`, sanitizes/truncates it, and stores it as a prefixed layer target name. It never reads `item.description`.
2. `courseware-scene-generation.ts` passes this target name as a foreground `semanticRole`. Compilation has semantic mapping, but exported object names are technical asset identifiers.
3. The generated native teaching package stores pages, actions, identities, and planning requirements. Its identity only records logical ID, source shape ID, and technical source object name; supplier layer descriptions are absent.
4. The live native narration path supplies a whole-page preview and `imageBindings: []`. In the actual narration context, the objects were named `scene-image-…-layer-1`, etc., without supplier names/descriptions. It therefore asks the vision model to rediscover layer identities from the whole slide and bounding boxes.
5. The returned observations become evidence for later narration generation and semantic review. A wrong identity can consequently cause repeated rejection and repair of otherwise usable narration.

Relevant source files:

- `apps/desktop/electron/main/courseware-scene-image-assets.ts`
- `apps/desktop/electron/main/courseware-scene-generation.ts`
- `apps/desktop/electron/main/courseware-native-generation.ts`
- `apps/desktop/electron/main/courseware-native-narration.ts`
- `apps/desktop/electron/main/courseware-narration-batch.ts`
- `apps/desktop/electron/main/courseware-content-review.ts`

## Concrete wrong identification in this run

The supplier name and description identify three separate foregrounds: evaporation, rain, and condensation. Both the archived supplier PNGs and the final PPT-embedded PNGs were visually inspected:

- Layer 1: upward vapor arrows and the evaporation label, with no sun.
- Layer 2: rain lines, a downward arrow, and the rain label, with no condensation label.
- Layer 3: cloud, curved arrow, and the condensation label, with no rain label.
- Layer 4: sun only.

The narration semantic-review diagnostics instead described layer 1 as including the sun, layer 2 as containing both condensation and rain labels, and layer 3 as the whole background diagram. The current object-to-image mapping in the saved PPT matches the four correct layers above. The claim that condensation and rain were inseparably decomposed is therefore false for this fixture. It came from model evidence/review, not from a demonstrated decomposition defect. The generated agent's suggestion that the user must accept simultaneous highlighting should not be treated as a necessary limitation.

The third physical page also has genuine background content: the river is in the base image, with separate arrows and labels. Whole-region reveal/spotlight support remains necessary for that case. Metadata alone does not create an independently focusable river object.

## Recommended smallest design

### Preserve the evidence once

Carry bounded, sanitized supplier `name` and `description` through archive, compilation, native save/reopen, and narration context. Bind them to the immutable source task, master hash, layer asset hash, z-index, box, and native logical object ID. Keep technical IDs stable. Treat descriptions as external data, never as instructions or exact OCR: the actual descriptions in this run use extraction-instruction wording, so they are not independent verification of the output pixels.

### Reuse metadata for object identity

For unchanged generated Scene layers with intact provenance and complete metadata, use those identities to construct narration targets instead of requiring a fresh whole-slide object-discovery call. Preserve the existing effect rules, saved-ID checks, page budgets, semantic checks, and final `reviewContent:true` gate. Do not derive literal text by assuming that a descriptive caption is exact OCR.

If metadata is missing, ambiguous, conflicting, or the image has changed after Office editing, inspect only the affected layer with its actual PNG and stable UUID. Mark fallback evidence explicitly. Coordinate-only guessing from a whole-page screenshot should not overwrite a known layer identity without conflicting pixel evidence.

### Keep a separate content check

Review whether narration, arrows, facts, questions, answers, and effects agree with the actual page. This is different from asking every layer what it is again. Preserve the user's accepted complete-region presentation behavior: a connected diagram may be revealed/focused as a region; background content need not become a separately editable object. Do not block on harmless rephrasing, background inclusion, or small drawing imperfections. Require an actual teaching contradiction or wrong target before rejection.

Implementation should be checked with this real fixture: distinct condensation/rain/sun layers, metadata absent on the background, edited layer invalidating only its own evidence, and the river remaining in the background. Verify save/reopen provenance and check that using valid metadata removes the redundant paid discovery call without removing final content review.

## Exact-model rerun

Both existing tasks were resumed with `deepseek-v4-1-flash`, not `deepseek-v4.1-flash-1017`. The candidate executable fingerprints remained unchanged. This is a recovery rerun with retained successful work, not a fresh generation of new lessons. Each lesson remains four physical pages, below the five-page limit.

| Route | Result | Verified evidence |
| --- | --- | --- |
| PPT Master | Failed native teaching adoption | The agent changed the explanation ordering on page 2 and exported again. The new file still contains two native OMML fractions. Running the actual PPTX worker again reproduced empty text without `sourceShapeId` on pages 1 and 2. The Host rejected adoption. No TTS was started. |
| Scene | Failed body narration | Preliminary visual evidence returned parseable output this time. Page 1 exhausted bounded narration repairs against wrong layer identities. Page 3 had a real region-target gap and subsequently invalid semantic-review output. Neither body page was saved. Existing four-page PPT, images, layers, and two activity audios were preserved byte-for-byte. No new image or TTS task was created. |

Master's model-generated claim that the failure was unrelated to formulas is not supported: the repeated parser reproduction still isolates the two formula carriers. The application must fix formula content and identity handling together, rather than relaxing Host verification.

## Evidence and limits

- `supplier-layer-metadata.json`: actual existing task metadata, without URLs or image payloads.
- `supplier-layers.png` and `saved-ppt-layers.png`: visually inspected foregrounds from the archive and final PPT.
- `scene-rerun-result.json`: narration diagnostics and bounded terminal failures.
- `master-binding-mismatch.json`: new export parsed by the production worker.
- `summary.json`: route outcomes and scope.
- Full local session evidence: `/home/jhz/deckwise-validation/three-path-paid-20261118/deepseek-flash-rerun`.

No product source was changed, no gate was disabled, and no platform publication occurred. Full playback of these two reruns was not attempted because neither reached a complete teaching state. One fixture cannot establish general supplier-metadata accuracy or a model reliability rate.
