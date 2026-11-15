import { createRoot } from 'react-dom/client';
import type { ComponentProps } from 'react';
import { FixedCoursewarePlayer } from './components/courseware/FixedCoursewarePlayer';
import { loadFixedBuild, type FixedAssetResolver } from './lib/courseware/load-fixed-build';

/** Mount in Host's isolated preview surface; caller owns authorization and selected build identity. */
export async function mountFixedBuild(
  container: HTMLElement,
  bytes: Uint8Array,
  selectedBuildId: string,
  resolveAsset: FixedAssetResolver,
  props: Omit<ComponentProps<typeof FixedCoursewarePlayer>, 'build'>,
  signal?: AbortSignal,
): Promise<() => void> {
  const build = await loadFixedBuild(bytes, selectedBuildId, resolveAsset, signal);
  try {
    signal?.throwIfAborted();
    const root = createRoot(container);
    root.render(<FixedCoursewarePlayer {...props} build={build} />);
    return () => { root.unmount(); build.dispose(); };
  } catch (error) {
    build.dispose();
    throw error;
  }
}
