export interface PlaybackSnapshot {
  sceneIndex: number;
  actionIndex: number;
  consumedDiscussions: string[];
  sceneId?: string; // Scene this snapshot belongs to; discard on mismatch
}

