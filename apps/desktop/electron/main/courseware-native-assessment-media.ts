import type { CoursewareTeachingCoordinator } from "./courseware-teaching";
import type { CoursewareClassroomCoordinator } from "./courseware-classroom";
import type { CoursewareTeachingView } from "@pi-desktop/shared";
import { CoursewareClassroomTts } from "./courseware-classroom-tts";
import { CoursewareClassroomImages } from "./courseware-classroom-images";
import { CoursewareAssessmentMedia } from "./courseware-assessment-media";
import { decodeCoursewareAudio } from "./courseware-audio-decode";

/** Foreground and background adoption use the same native assessment/audio boundary. */
export function createNativeAssessmentMedia(input: {
  teaching: CoursewareTeachingCoordinator; classroom: CoursewareClassroomCoordinator;
  auth: ConstructorParameters<typeof CoursewareClassroomImages>[0]["auth"];
  getHost: ConstructorParameters<typeof CoursewareClassroomImages>[0]["getHost"];
  getWorkspace: ConstructorParameters<typeof CoursewareClassroomImages>[0]["getWorkspace"];
  assertOwned: (sessionId: string) => void;
  review: ConstructorParameters<typeof CoursewareClassroomImages>[0]["review"];
}) {
  const { teaching, classroom, ...services } = input;
  const tts = new CoursewareClassroomTts({ ...services, decodeAudio: decodeCoursewareAudio,
    open: sessionId => classroom.open({ sessionId }), adoptNative: async (args, asset, bytes, durationMs) => {
      const view = (await teaching.native("open"))!.value as CoursewareTeachingView;
      const page = view.project.pages.findIndex(p => p.pageId === args.sceneId) + 1;
      if (!page || view.project.projectId !== args.projectId || view.project.teachingRevision !== args.expectedRevision) throw new Error("Native assessment changed");
      await teaching.native("adopt-audio", { viewId: args.projectId + "." + args.sceneId, expectedTeachingRevision: args.expectedRevision,
        command: { actionId: args.actionId, assetId: "tts-" + asset.sha256, sha256: asset.sha256, mimeType: asset.mime, bytes: Uint8Array.from(bytes).buffer, durationMs } }, page);
      return classroom.open({ sessionId: args.sessionId });
    } });
  const images = new CoursewareClassroomImages({ ...services, classroom });
  return { tts, images, assessments: new CoursewareAssessmentMedia(classroom, tts, images) };
}
