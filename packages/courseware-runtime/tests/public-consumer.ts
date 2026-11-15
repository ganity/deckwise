import { adaptCanonicalSnapshot, buildFixedCourseware, type FixedBuildInput } from '@pi-desktop/courseware-runtime/node';
import { compileSceneToPptx, compileScenesToPptx, editablePptxSceneSchema, generatePagePptxCandidate, createPageCandidateLineage, candidateHash, pageCandidateBaselineSchema, PageCandidateError, type PageCandidateBaseline } from '@pi-desktop/courseware-runtime/authoring';
import { mountFixedBuild, loadFixedBuild, loadTeamFixedBuild, FixedCoursewarePlayer, chinesePlayerLabels, type FixedAssetResolver } from '@pi-desktop/courseware-runtime/player';
const input: FixedBuildInput = adaptCanonicalSnapshot({}, {}, {});
const resolver: FixedAssetResolver = async () => new Uint8Array();
const build = (signal: AbortSignal) => buildFixedCourseware(input, { workerDirectory: '/host/worker', outputDirectory: '/host/builds', signal });
void [input, resolver, build, mountFixedBuild, loadFixedBuild, loadTeamFixedBuild, FixedCoursewarePlayer, chinesePlayerLabels];

const presentation: Parameters<typeof mountFixedBuild>[4] = {
  labels: chinesePlayerLabels,
  onSpeechStart: text => void text.toUpperCase(),
  onSpeechEnd: () => {},
  onSpeechProgress: position => { if (position) void [position.actionId, position.timeMs, position.durationMs]; },
  onInteractionStart: checkpoint => void checkpoint.checkpointId,
  onInteractionComplete: checkpointId => void checkpointId.toUpperCase(),
};
const teamDownload: Parameters<typeof loadTeamFixedBuild>[2] = async (path, signal) => {
  signal?.throwIfAborted();
  void path.toUpperCase();
  return new Uint8Array();
};
void [presentation, loadTeamFixedBuild, teamDownload];
const authoringRequest: Parameters<typeof generatePagePptxCandidate>[0]['generate'] = async request => ({
  scene: editablePptxSceneSchema.parse({ slideId: request.pageId, sourceHash: request.sourceHash, canvas: request.canvas }),
  assets: {},
});
const baseline: PageCandidateBaseline = pageCandidateBaselineSchema.parse({});
void [authoringRequest, baseline, compileSceneToPptx, compileScenesToPptx, createPageCandidateLineage, candidateHash, PageCandidateError];
