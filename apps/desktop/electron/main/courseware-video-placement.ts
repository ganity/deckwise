import type { SavedVideoIntent } from "./courseware-saved-video";

export function videoPlacementMatches(intent: SavedVideoIntent, pageId: string, actionId: unknown): boolean {
  return intent.pageId === pageId && intent.slotId === actionId ||
    !!intent.placements?.some(p => p.pageId === pageId && p.actionId === actionId);
}
