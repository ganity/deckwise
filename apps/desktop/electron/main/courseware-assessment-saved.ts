import { CoursewareAssessmentMedia } from "./courseware-assessment-media";
import { CoursewareClassroomCoordinator } from "./courseware-classroom";
import { CoursewareClassroomImages } from "./courseware-classroom-images";
import { CoursewareClassroomTts } from "./courseware-classroom-tts";
import { refreshNativeMaicClassroom } from "./courseware-classroom-native";
import { writeSavedAssessmentClassroom } from "./courseware-classroom-save";
import type { CoursewareSavedNarration } from "./courseware-saved-narration";
import type { DesktopAuthSession } from "./auth-session";

type Host = { call<T>(method: string, params: unknown): Promise<T> };

/** Saved generation is owned by the Agent turn, independently of the visible Chat or Office page. */
export async function executeSavedAssessmentMedia(input: {
  sessionId: string; args: unknown; canDispatch(): boolean; getHost(): Host | null;
  saved: CoursewareSavedNarration; auth: Pick<DesktopAuthSession, "getCoursewarePrincipal" | "coursewareMedia">;
  review: import("./courseware-classroom-images").QuizImageReview;
  decodeAudio(bytes: Buffer, mime: "audio/wav" | "audio/mpeg"): Promise<number>;
}) {
  const { sessionId } = input, host = input.getHost();
  const assertOwned = (id: string) => {
    if (!host || input.getHost() !== host || id !== sessionId || !input.canDispatch()) throw new Error("Saved assessment owner changed");
  };
  assertOwned(sessionId);
  if (!host) throw new Error("Saved assessment runtime unavailable");
  const workspace = async () => {
    assertOwned(sessionId);
    const { session } = await host.call<{ session?: { projectPath?: string; mode?: string } }>("session.get", { id: sessionId, messageLimit: 1 });
    assertOwned(sessionId);
    if (!session?.projectPath || session.mode !== "agent") throw new Error("Saved assessment workspace unavailable");
    return session.projectPath;
  };
  const classroom = new CoursewareClassroomCoordinator({ getHost: input.getHost, getSessionId: () => sessionId,
    getWorkspace: workspace, assertOwned,
    openProject: () => input.saved.withSaved(sessionId, input.canDispatch, async saved => ({ project: { projectId: saved.project.projectId } })),
    refreshNative: (_, projectId) => input.saved.withSaved(sessionId, input.canDispatch, async saved =>
      refreshNativeMaicClassroom({ host, sessionId, projectId, jobId: saved.jobId, workspace: await workspace(),
        assertCurrent: async () => { assertOwned(sessionId); await saved.check(); } })),
    writeNative: args => input.saved.withSaved(sessionId, input.canDispatch, async saved => {
      const { task } = await host.call<{ task?: { importPath?: string; generatedPath?: string } }>("courseware.task.get", { sessionId });
      const sourcePath = task?.importPath ?? task?.generatedPath;
      if (!sourcePath) throw new Error("Saved assessment source unavailable");
      return writeSavedAssessmentClassroom({ args, saved, workspace: await workspace(), sourcePath,
        assertCurrent: () => assertOwned(sessionId) });
    }),
  });
  const tts = new CoursewareClassroomTts({ auth: input.auth, open: () => classroom.open({ sessionId }),
    getHost: input.getHost, getWorkspace: workspace, assertOwned, decodeAudio: input.decodeAudio });
  const images = new CoursewareClassroomImages({ auth: input.auth, classroom, getHost: input.getHost,
    getWorkspace: workspace, assertOwned, review: input.review });
  return new CoursewareAssessmentMedia(classroom, tts, images).execute(sessionId, input.args, input.canDispatch);
}
