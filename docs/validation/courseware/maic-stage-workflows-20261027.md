# MAIC stage workflow comparison

Reference: `evo-trainwise-maic-server` committed revision `ed1a4c87`, inspected
2026-10-27. This is a source comparison, not evidence of deployed provider output.

## Shared teaching chain

Both kindergarten and primary plan teaching objectives and activities, generate
page objects and teaching actions, then synthesize speech and execute the actions
against real saved objects/audio. Kindergarten is not an image/video/song-only
workflow. Primary is not a narration-only workflow.

The shared `lib/generation/scene-generator.ts::generateSceneActions` receives
actual page content, course context, education policy and teaching-process
guidance. It generates and validates spoken turns, object focus and executable
participation/media actions. `processActions` validates target IDs and supplies
student-turn pauses. A spoken invitation to interact is not itself an interaction
result, and a fixed pause is not assessment.

## Kindergarten

`lib/generation/kindergarten/workflow.ts` calls:

1. Prepare the age/subject/language policy, course design and visual references.
2. Generate the course through the shared classroom generator. Native editable
   elements, semantic objects, teaching actions and incremental TTS belong here.
3. Generate eligible scene videos through the kindergarten video runtime.
4. Generate planned song slots and mount their real audio artifacts.
5. Prepare song animation when enabled; the current prepare node sets
   `enableSongAnimation:false`, so this is not evidence of an active animation
   song pipeline. Ordinary page animation remains a separate required capability.
6. Verify the resulting classroom canvas (16:10).

During course generation, `lib/server/classroom-generation.ts` invokes
`lib/generation/kindergarten/motion-composer.ts::planKindergartenSpeechCues` with
the semantic element index and planned independent objects. This aligns focus
with real visible targets, plans entrances and repeated emphasis, and binds exact
speech anchors to objects. It also prevents focus before entrance. The speech
cue contract includes fade/scale/slide entrances, pulse, path movement, gentle
rotation and feedback motion. Model-generated milliseconds are not authoritative
word timing. Teaching-process delivery also inserts actual discussion/activity
actions where required. These are not primary-only features.

Video planning uses the approved course design, reference characters/environment,
page assets and actual teaching audio. The pipeline submits/polls Seedance,
persists checkpoints and original assets, postprocesses audio/subtitles/poster and
mounts accepted output. Native generated MP4 alone is not this complete chain.
Music uses planned song placements and persists/mounts exported audio. No eligible
video or song slot can be a documented skip; provider degradation must be reported
as degradation, not silently counted as generated media.

## Primary

`lib/server/classroom-generation.ts` uses primary subject policies, teaching
progression, chapter-interaction injection and the shared page action generator.
It preserves exact native teaching content, stages reveals and answer exposure,
generates real interaction packs/checkpoints and queues speech synthesis.
`lib/server/classroom-media-generation.ts` splits long speeches for the selected
provider, preserves existing audio and waits for real output. Missing speech
audio is surfaced through repair state, not described as a completed course.
The kindergarten generated-video route is not enabled for primary by default.

## Desktop target and verified gaps

Desktop modes are ordinary generation, scene generation and existing PPT import.
They converge on the same editable PPTX and teaching data, then one editor.
Kindergarten and primary are stage strategies within scene mode, not two desktop
entry paths. Editing retains PPTX; only explicit publication freezes page/teaching
versions and builds the PPTist teaching package. Generation never auto-publishes.

The editable PPTX is an intermediate between page-asset compilation and saved
teaching/media continuation. It must not remove animation, interaction, highlight,
spotlight, audio timing or playback verification from either school stage.

| Area | Desktop implementation inspected | Remaining parity requirement |
| --- | --- | --- |
| Editable objects | Masters, clean backgrounds, foreground PNGs and native visible text | Verify actual supplier quality and mapped identities |
| Detailed narration | Saved-page evidence, whole-deck arc and per-page actions | Preserve complete stage-specific teaching activity design |
| Highlight/spotlight | Narration attention targets become fixed cues on verified TTS adoption | Verify final snapshot/build/player execution; not just JSON presence |
| Animation | Fixed converter supports fadeIn/fadeOut/pulse cues and native PPTX animation paths | Finite mapped fadeIn/pulse planning and audio-clock cue adoption added; richer MAIC motion/word anchors remain |
| Interaction | Narration supports fixed pauses and teacher-continue checkpoints | These do not reproduce MAIC discussion, quiz and activity delivery |
| TTS | Saved-source tools reuse original intents, verify/archive and mount audio | Speech normalization splits to the current 4000-unit transport limit; live-provider/full-course playback checks remain |
| Music | Saved-source tools generate, export and adopt separate playable audio clips | Durable lesson song-slot planning, placement and timing parity |
| Video | Draft metadata only in this automatic path | Real planner/provider/checkpoint/postprocess/archive/playback chain |
| Completion | Original-job waiting works for images and submitted TTS/music | Full stage requirements and executable playback must own completion |

No full-parity or release acceptance claim follows from the current transport and
saved-media regression tests. Only cover style needs human style selection;
automatic stages must not be relabeled as awaiting user confirmation. Teaching-plan approval remains by explicit user direction; first-page style is the
only visual selection. Automatic teaching readiness follows adopted-audio and
object validation, without a new per-page confirmation.
