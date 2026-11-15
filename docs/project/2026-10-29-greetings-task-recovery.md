# Greetings course recovery (2026-10-29)

Original Chat: `654c94e7-a536-401c-ac9c-aea19cabfc81`.
Recovered Codex context: `01a1868b-2a90-72c1-877f-06b8777c1ccd`.

## Findings

The approved 14-page scene plan and all 135 selected assets remained saved.
Earlier compilation still executed the stale staged authoring worker and hit
`Scene assets exceed 32 MiB`, despite removal of that aggregate ceiling in
source. Rebuilding and staging the actual worker resolved that failure; its
155-file integrity check passed.

The screenshot's subsequent `Courseware conversation changed or turn ended`
merged three distinct guards: replaced Host, another visible Chat, and ended or
cancelled turn. The old record cannot establish which guard fired. A new turn
in the owning Chat read the saved state and compiled successfully. Scope guards
remain enforced; their diagnostics now distinguish those conditions. Returning
to the owning Chat restores reads when the runtime and turn are still current.

Detailed narration then stalled on repeated metadata checks. A live default
`session.get` returned 852 messages / 33,384,478 bytes in 6,781 ms. The same read
with `messageLimit: 1` returned 193,551 bytes in 344 ms. Saved narration, Main
completion and managed-model authorization now bound these metadata reads.
Explicit text completions requesting conversation context retain full history.

Live per-page generation also exposed a dropped output-schema argument in the
Main batch adapter. Per-page requests now carry the canonical JSON schema,
while strict validation remains in place. Subset-retry instructions no longer
implicitly narrow the required whole-deck planning outline. Successful pages
are retained and only missing pages are retried.

## Validation

- 42 targeted Chat workflow, saved narration and authorization tests passed.
- 16 isolated Electron native image/model transport checks passed; these use a
  local provider stand-in and do not certify live model quality.
- Desktop TypeScript check passed.
- Staged worker integrity: 155 files verified.
- Live new compilation: 14 slide XML entries, ZIP integrity passed, 27,327,066
  bytes; no images were regenerated.
- After restart, live media-context read completed in 18,628 ms (previously
  approximately 60 seconds).

## Saved output and continuation

PPTX SHA-256:
`65ea1c133a5850eabf0a9c960aa3775d2c8abe719a9c98f0a21c3cde8dacdaa7`.

Saved at the original workspace's `.deckwise-ppt/generated/<sha256>.pptx`.
The original Chat resumed against this source. All 14 pages now have detailed generated narration. A live TTS call returning upstream outcome unknown
(`COURSEWARE_MEDIA_PLATFORM_46016`) exposed punctuation-only speech fragments
after quoted focused phrases. That original uncertain job was preserved without
resubmission. Focus splitting now appends trailing punctuation
to the preceding speech, preserving all text and waits; 16 targeted runtime tests
pass and the runtime build succeeds. Eight unspoken punctuation-only actions
were removed through Host teaching writes with revision checks; all 57 already
adopted audio assets and valid speech text were preserved. The remaining deck
has 255 speech actions. Pre-cleanup teaching is backed up at
`/tmp/deckwise-before-punctuation-cleanup.json`.

All 255 speech actions now have adopted real Doubao TTS audio. Every unique
file passed SHA-256, byte-length and ffprobe-duration checks: 5,293,587 bytes,
660.264 seconds in total.

The one Hello Song generation and its original export completed. Exported MP3:
784,185 bytes, 32.640 seconds, SHA-256
`a3b72ebfb925d43203344a665845761f2d9830b53008ad69d1411108c3a703e4`.
The same archived song was adopted on pages 1 and 13 through Host provenance
checks, with no second paid generation. On page 13 it plays after movement
instructions and before the follow-up questions.

The page-13 video slot came from an extra instruction invented by the Chat
agent. Neither the original user messages nor the approved scene plan requires
video. Video-catalog reads returned `COURSEWARE_MEDIA_PLATFORM_46001`; no video
was submitted. Removed the unnecessary slot through a revision-checked teaching
write, retaining all speech, adopted audio and other actions.

Final teaching revision: `7097c891-e52c-4c62-9ce7-582c6f91f6d2`.
All 14 pages are ready. No publication snapshot, platform publication, source
image regeneration or replacement PPTX compilation was performed. The detailed
teaching/audio live in the original local project; the PPTX alone does not
contain those teaching assets. Full-course player playback was not run because
that path requires a publication build; individual audio files were decoded.

After the final application restart, the original Chat independently reread
media context: all 14 pages have `narrationReady`, `audioReady` and
`teachingReady` true, `videoReady` true, and `jobs: []`. The visible Office
workspace shows audio **14/14** and teaching review **14/14**. The final isolated
Electron gate was rerun after the runtime build and passed all 16 checks.
