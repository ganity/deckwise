# Stability verification — 2026-11-17 follow-up

**Historical pre-fix result.** The subsequent [durable repair](../2026-11-17-durable-repairs/README.md) addresses this issue. The original probe source/log remain archived; the executable probe now runs the new durable-store regression and should exit zero.

**Result: existing regression checks pass; a shared runtime-recreation defect is confirmed and remains unresolved.** This round verifies stability without modifying product code, changing business gates or purchasing provider work. It does not supersede the preceding successful three-lesson playback results.

## Executed checks

| Check | Result | Meaning |
|---|---:|---|
| Agent Runtime complete suite | 1,842 passed across 120 files | Includes continuation, interruption, retry and recovery contracts. |
| Targeted continuation/recovery subset | 92 passed across three files | Already included in the full suite; do not add again. |
| Desktop native tools, narration batches, assessment media, content review | 170 passed | Includes 56-page batching, retained peers, protected scripts, bounded format/content repairs and acknowledged-lost writes. |
| Desktop original audio, document ownership, delivery/export recovery and stale lifecycle events | 46 passed | Includes cancellation, uncertain saves blocking handoff and original-task query/recovery without replacement purchase. |
| Additional recreation probe | Three failed route configurations; one shared defect | Known failed required repair can disappear when the native tools runtime is rebuilt. |

The first Runtime invocation through the package script unexpectedly selected the complete suite; it completed successfully. A direct targeted invocation also passed. The counts are recorded separately rather than double counted. Test logs and source fingerprints are included. All provider-facing boundaries in this round use existing test doubles; no actual payment, publication or service outage was induced.

## Confirmed defect: previously failed repair can become ready after recreation

The deterministic probe drives the real `CoursewareNativeTools` implementation:

1. Start with saved speech and audio. Required whole-diagram effect repair fails semantic review because connecting arrows have no verified layer.
2. Save another page (change package SHA). A deliberately broad passing content-review verdict must **not** erase that known failure. The current runtime correctly reports incomplete and keeps the saved content unchanged.
3. Recreate the native tools runtime against the same saved project, without repairing the failed page.
4. Request final content review again. Expected: still incomplete. Actual: `completion.ready === true`. The original successful content remains intact; the lost information is the blocking repair failure.

The probe fails for `plain`, `scene` and `import`. These are three fixtures of one shared lifecycle defect, not three independent live-generation failures. The LLM verdict is deliberately stubbed to pass to check whether the deterministic guard can withstand an imperfect reviewer; this does not measure the real model's miss rate.

Run from the Desktop repository:

```sh
node plans/009-evidence/2026-11-17-stability/probe-runtime-recreation.mjs
```

Exit 1 is the current **expected defect reproduction**, not a passing acceptance check. The script derives a probe from the existing regression fixture, writes a uniquely named temporary test beside that fixture so module resolution stays intact, runs only the new cases, and removes the temporary file in `finally`. It does not patch product code or change the normal suite's expected outcomes.

## Why switching documents matters

`CoursewareNativeTools.unresolvedRepairs` belongs to one instance. `createCoursewareDocumentRuntime` constructs a new tools instance. `CoursewareDocumentTools.execute` replaces its runtime when the editor, session, path or Host no longer matches; releasing the background worker also discards it. Consequently, runtime recreation can occur during a normal document/session handoff, not only an application restart. This trigger is established by source tracing and the passing document-router lifecycle tests; this round did not reproduce the complete failing sequence through Electron UI.

Existing cross-restart continuation-budget tests use the canonical checkpoint path. The native path excludes that checkpoint read/write branch. A green canonical recovery test therefore does not prove native failed-repair continuity.

## Recommended next repair and acceptance

Highest priority is to retain a failed required repair in the existing durable courseware recovery/document state, keyed to its owning session/project/stable page identity and applicable content. Re-read it when constructing a native runtime. Only a verified successful repair of that page should clear it; peer autosaves, broad review success, status reads, document switching and restart must not clear it. Preserve original scripts/media and bounded retry budgets. Do not remove the final LLM review: deterministic failure memory and semantic review serve different purposes.

Before implementation, confirm the existing durable storage contract can represent this state without writing native state into a stale canonical mirror. Avoid adding a separate generic workflow engine or treating a process-global Map as restart persistence. Acceptance must cover same-runtime behavior, switch away/back, full restart, page reorder/deletion, peer save, source replacement, successful affected-page repair, exhausted retries and failed persistence. The stored failure must not contaminate a different document or silently reset paid-work budgets.

The recent Scene ten-minute stop remains a separate observation. Existing bounded polling tests pass, but this round does not establish why the live Agent delayed adoption or prove that all such stalls are resolved. Preserve the original-task continuation strategy and do not increase the timeout simply to obtain a green result.

## Scope and limits

No product source, business validation, model configuration or paid task was changed. The new probe and this evidence are local verification artifacts. The requested stability check is complete for this round; P1/P7 remain open. No new real-model/image/TTS generation, UI crash injection, large-deck paid stress run, matched par-A comparison, installer release or publication was performed. Previous fresh 12-page/28-audio playback evidence remains valid for those artifacts, but does not certify cross-runtime failed-repair safety.
