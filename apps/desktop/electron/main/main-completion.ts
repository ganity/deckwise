import type { Context } from "@earendil-works/pi-ai";
import {
  completeOneShot,
  visionFromModelConfig,
  type RuntimeProviderConfig,
} from "@pi-desktop/agent-runtime";
import { DECKWISE_MANAGED_PROVIDER_ID, OAUTH_AUTH_KIND } from "@pi-desktop/shared";
import type { PluginCompleteInput, PluginCompleteResult } from "@pi-desktop/plugin-sdk";
import {
  asPluginThinkingLevel,
  parsePluginModelKey,
  pluginCompleteContext,
  pluginSessionContextFromSession,
} from "./plugin-agent-complete";
import type { PluginServicesDependencies } from "./services/plugin-services";
import { coursewareSceneContext, type CoursewareSceneCompleteInput } from "./courseware-scene-context";
import {
  createCoursewareSceneGenerator,
  type CoursewareSceneGeneratorInput,
} from "./courseware-scene-generator";
import { createSceneCoursePlan } from "./courseware-scene-plan";
import { buildSceneCourseDeck } from "./courseware-scene-deck";
import { coursewareAuthoringUrl } from "./courseware-runtime";
import { stageGeneratedSceneCourse } from "./courseware-scene-staging";
import { resolveSceneCourseVisuals } from "./courseware-scene-assets";
import { assembleSceneCourse } from "./courseware-scene-workflow";
import { resolveCoursewareLlmAuth } from "./courseware-llm-auth";

type MainCompleteInput = PluginCompleteInput & {
  sessionId?: string;
  signal?: AbortSignal;
  stripToolName?: string;
};
type Dependencies = Pick<
  PluginServicesDependencies,
  "getHost" | "resolveAgentRuntimeLaunch" | "vendorOAuth" | "resolvePlatformAccessToken" | "resolveTeamSceneImages"
>;

/** Main owns provider credentials; plugins may only call the text wrapper. */
export function createMainCompletion({
  getHost,
  resolveAgentRuntimeLaunch,
  vendorOAuth,
  resolvePlatformAccessToken,
  resolveTeamSceneImages,
}: Dependencies) {
  const resolveSceneModel = async (sessionId: string) => {
    const host = getHost();
    if (!host) throw new Error("Host is unavailable");
    const [{ session }, settings] = await Promise.all([
      host.call<{ session?: { mode?: string } }>("session.get", { id: sessionId, messageLimit: 1 }),
      host.call<any>("settings.get"),
    ]);
    if (session?.mode !== "agent") throw new Error("Scene completion model or mode changed");
    const launch = await resolveAgentRuntimeLaunch(sessionId, session, settings, { mode: "agent", captureEditor: false });
    if (getHost() !== host) throw new Error("Scene completion Host changed");
    return { modelKey: `${launch.providerId}/${launch.modelId}`, thinkingLevel: launch.sidecarParams.thinkingLevel };
  };
  const completeWithContext = async (
    input: MainCompleteInput,
    sceneContext?: Context,
  ): Promise<PluginCompleteResult> => {
    const host = getHost();
    if (!host) {
      throw Object.assign(new Error("host unavailable"), { code: "UNSUPPORTED" });
    }
    const parsed = parsePluginModelKey(input.modelKey);
    if (!parsed) {
      throw Object.assign(new Error("modelKey must be providerId/modelId"), {
        code: "INVALID_ARGUMENT",
      });
    }
    const thinkingLevel = asPluginThinkingLevel(input.thinkingLevel);
    const settings = await host.call<any>("settings.get");
    const launchSessionId = input.sessionId || `plugin-complete:${crypto.randomUUID()}`;
    const session = input.sessionId
      ? (await host.call<{ session?: any }>("session.get", { id: input.sessionId, ...(input.includeSessionContext ? {} : { messageLimit: 1 }) })).session
      : {};
    const checkSceneSession = async () => {
      input.signal?.throwIfAborted();
      if (getHost() !== host) throw new Error("Scene completion Host changed");
      const current = (
        await host.call<{
          session?: { mode?: string; providerId?: string; modelId?: string; thinkingLevel?: string };
        }>("session.get", { id: input.sessionId, messageLimit: 1 })
      ).session;
      const model = current?.providerId && current.modelId
        ? { modelKey: `${current.providerId}/${current.modelId}`, thinkingLevel: current.thinkingLevel }
        : await resolveSceneModel(String(input.sessionId));
      if (
        current?.mode !== "agent" ||
        model.modelKey !== `${parsed.providerId}/${parsed.modelId}` ||
        asPluginThinkingLevel(model.thinkingLevel) !== thinkingLevel
      )
        throw new Error("Scene completion model or mode changed");
      if (getHost() !== host) throw new Error("Scene completion Host changed");
      input.signal?.throwIfAborted();
    };
    if (sceneContext) await checkSceneSession();
    const launch = await resolveAgentRuntimeLaunch(launchSessionId, session ?? {}, settings, {
      mode: "agent",
      providerId: parsed.providerId,
      modelId: parsed.modelId,
      thinkingLevel,
      captureEditor: false,
    });
    if (launch.providerId !== parsed.providerId || launch.modelId !== parsed.modelId)
      throw new Error("Requested completion model is unavailable");
    if (sceneContext) {
      if (!visionFromModelConfig(launch.sidecarParams.provider.modelConfig))
        throw new Error("Selected scene model does not support image input");
      await checkSceneSession();
    }
    input.signal?.throwIfAborted();
    const runtimeProvider = {
      ...launch.sidecarParams.provider,
      ...(launch.sidecarParams.provider.authKind === OAUTH_AUTH_KIND
        ? {
            resolveAuth: () =>
              launch.providerId === DECKWISE_MANAGED_PROVIDER_ID
                ? resolveCoursewareLlmAuth(getHost, input.sessionId, resolvePlatformAccessToken)
                : vendorOAuth.resolveAuth(launch.providerId),
          }
        : {}),
    } as RuntimeProviderConfig;
    const sessionContext = input.includeSessionContext
      ? pluginSessionContextFromSession(String(input.sessionId ?? ""), session, input.stripToolName)
      : undefined;
    const context =
      sceneContext ??
      pluginCompleteContext({
        modelKey: input.modelKey,
        thinkingLevel: input.thinkingLevel,
        system: input.system,
        messages: input.messages,
        includeSessionContext: input.includeSessionContext,
        sessionContext,
      });
    const result = await completeOneShot(runtimeProvider, context, launch.sidecarParams.thinkingLevel, {
      signal: input.signal,
      sessionId: launchSessionId,
      // Spec 07-plugins/03-plugin-api.md: empty model output answers the
      // plugin with INVALID_ARGUMENT, not the runtime's internal code.
      emptyErrorCode: "INVALID_ARGUMENT",
      emptyErrorMessage: "The model returned no text.",
    });
    if (sceneContext) await checkSceneSession();
    return {
      text: result.text,
      modelKey: `${launch.providerId}/${launch.modelId}`,
      thinkingLevel: launch.sidecarParams.thinkingLevel,
      usage: result.usage,
    };
  };
  const complete = (input: MainCompleteInput) => completeWithContext(input);
  const completeScene = async (input: CoursewareSceneCompleteInput) => {
    const request = {
      sessionId: input.sessionId,
      modelKey: input.modelKey,
      thinkingLevel: input.thinkingLevel,
      signal: input.signal,
    };
    const context = coursewareSceneContext(input);
    return completeWithContext(request, context);
  };
  const createSceneGenerator = (input: CoursewareSceneGeneratorInput) =>
    createCoursewareSceneGenerator(input, completeScene);
  const planSceneCourseware = (input: Parameters<typeof createSceneCoursePlan>[0]) =>
    createSceneCoursePlan(input, complete);
  const buildSceneCourseware = async (input: Parameters<typeof buildSceneCourseDeck>[0]) => {
    const url = coursewareAuthoringUrl();
    if (!url) throw new Error("Installed courseware compiler is unavailable");
    const authoring = await import(/* @vite-ignore */ url) as typeof import("@pi-desktop/courseware-runtime/authoring");
    return buildSceneCourseDeck(input, completeScene, authoring);
  };
  const stageSceneCourseware = (input: Omit<Parameters<typeof stageGeneratedSceneCourse>[0], "host">) => {
    const host = getHost();
    if (!host) throw new Error("Host is unavailable");
    return stageGeneratedSceneCourse({ ...input, host });
  };
  const resolveSceneCourseAssets = (input: Parameters<typeof resolveSceneCourseVisuals>[0]) =>
    resolveSceneCourseVisuals(input, resolveTeamSceneImages);
  const assembleSceneCourseware = async (input: Parameters<typeof assembleSceneCourse>[0]) => {
    const host = getHost();
    if (!host) throw new Error("Host is unavailable");
    const read = async () => {
      if (getHost() !== host) throw new Error("Host changed during scene generation");
      const [{ session }, { task }] = await Promise.all([
        host.call<{ session?: { projectPath?: string; providerId?: string; modelId?: string } }>("session.get", { id: input.sessionId, messageLimit: 1 }),
        host.call<{ task?: { taskType?: string; generatedPath?: string; importPath?: string } }>("courseware.task.get", { sessionId: input.sessionId }),
      ]);
      if (!session || session.projectPath !== input.workspace || task?.taskType !== "scene" || task.generatedPath || task.importPath)
        throw new Error("Scene generation requires an unchanged new scene task");
      return JSON.stringify({ task, workspace: session.projectPath, provider: session.providerId, model: session.modelId });
    };
    const baseline = await read();
    return assembleSceneCourse(input, { resolve: resolveSceneCourseAssets, build: buildSceneCourseware, stage: stageSceneCourseware }, async () => {
      if (await read() !== baseline) throw new Error("Scene task or model changed during generation");
    });
  };
  return { complete, completeScene, resolveSceneModel, createSceneGenerator, planSceneCourseware, resolveSceneCourseAssets, buildSceneCourseware, stageSceneCourseware, assembleSceneCourseware };
}
