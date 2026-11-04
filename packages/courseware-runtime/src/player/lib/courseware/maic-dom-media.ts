import type { Action } from '../types/action';

/** DOM media is driven by the same action cursor, including pause/resume/stop. */
export function createMaicDomMedia(surface: () => HTMLElement | null) {
  let active: HTMLMediaElement | null = null;
  let cancel: (() => void) | undefined;
  return {
    async execute(action: Action): Promise<void> {
      if (action.type === 'spotlight' || action.type === 'laser' || action.type === 'highlight') return;
      if (action.type !== 'play_video' && action.type !== 'play_audio') throw new Error(`MAIC preview action is not supported offline: ${action.type}`);
      let media: HTMLMediaElement | null = null;
      // A scene-change callback commits React's new surface on the next frame.
      for (let attempt = 0; attempt < 3 && !media; attempt++) {
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        const target = [...surface()?.querySelectorAll<HTMLElement>('[data-slide-render-element-id]') ?? []].find(node => node.dataset.slideRenderElementId === action.elementId);
        media = target?.querySelector<HTMLMediaElement>(action.type === 'play_video' ? 'video' : 'audio') ?? null;
      }
      if (!media) throw new Error(`Missing MAIC media element: ${action.elementId}`);
      cancel?.(); active = media; media.currentTime = 0;
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => { media!.removeEventListener('ended', ended); media!.removeEventListener('error', failed); cancel = undefined; active = null; };
        const ended = () => { cleanup(); resolve(); };
        const failed = () => { cleanup(); reject(new Error(`MAIC media playback failed: ${action.elementId}`)); };
        cancel = () => { media!.pause(); cleanup(); resolve(); };
        media!.addEventListener('ended', ended, { once: true }); media!.addEventListener('error', failed, { once: true });
        media!.play().catch(error => { cleanup(); reject(error); });
      });
    },
    pauseActiveVideo() { if (!active || active.paused) return false; active.pause(); return true; },
    resumeActiveVideo() { if (!active || !active.paused) return false; void active.play().catch(() => {}); return true; },
    stopActiveVideo() { if (!active) return false; cancel?.(); return true; },
  };
}
