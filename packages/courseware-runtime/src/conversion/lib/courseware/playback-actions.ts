/** Strip only known authoring metadata; playback validation rejects everything else. */
export function playbackActions(actions: ReadonlyArray<Record<string, unknown>>) {
  return actions.map(action => {
    // Derived authoring duration and provenance do not belong to playback actions.
    if (['speech', 'audio_clip', 'video_clip'].includes(String(action.type))) {
      const { durationMs: _duration, ...playback } = action;
      if (action.type === 'speech' && ['notes', 'external', 'original', 'light_rewrite', 'generated'].includes(String(action.source))) {
        const { source: _source, ...speech } = playback;
        return speech;
      }
      return playback;
    }
    return action;
  });
}
