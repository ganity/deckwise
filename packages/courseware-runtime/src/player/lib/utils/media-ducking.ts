/** Narration caps page media to 20%; native mute stays authoritative and user volume is restored. */
export function bindMediaDucking(media: HTMLMediaElement): () => void {
  let normalVolume = media.volume;
  let applied = normalVolume * 0.2;
  const change = () => {
    if (media.volume === applied) return;
    normalVolume = media.volume;
    applied = normalVolume * 0.2;
    media.volume = applied;
  };
  media.addEventListener("volumechange", change);
  media.volume = applied;
  return () => {
    media.removeEventListener("volumechange", change);
    media.volume = normalVolume;
  };
}
