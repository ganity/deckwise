import { DECKWISE_MANAGED_BASE_URL } from "@pi-desktop/shared";

type Host = { call<T>(method: string, params: unknown): Promise<T> };

/** Resolve per request so binding a running Chat takes effect on its next model call. */
export async function resolveCoursewareLlmAuth(
  getHost: () => Host | null,
  sessionId: string | undefined,
  resolveToken: () => Promise<string>,
): Promise<{ apiKey: string; baseUrl?: string }> {
  const host = getHost();
  if (!host) throw new Error("COURSEWARE_LLM_HOST_UNAVAILABLE");
  const apiKey = await resolveToken();
  if (getHost() !== host) throw new Error("COURSEWARE_LLM_HOST_CHANGED");
  if (!sessionId) return { apiKey };
  const { session } = await host.call<{ session?: { projectPath?: string | null } }>("session.get", { id: sessionId, messageLimit: 1 });
  if (!session) throw new Error("COURSEWARE_LLM_SESSION_MISSING");
  let projectId: unknown;
  if (session.projectPath) {
    const result = await host.call<{ task: Record<string, unknown> | null }>("courseware.task.get", { sessionId });
    if (!result || !Object.hasOwn(result, "task") || (result.task !== null &&
        (typeof result.task !== "object" || Array.isArray(result.task))))
      throw new Error("COURSEWARE_LLM_INVALID_SCOPE");
    projectId = result.task?.teamProjectId;
    if (projectId !== undefined && (typeof projectId !== "string" ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(projectId)))
      throw new Error("COURSEWARE_LLM_INVALID_SCOPE");
  }
  if (getHost() !== host) throw new Error("COURSEWARE_LLM_HOST_CHANGED");
  if (projectId === undefined) return { apiKey };
  const url = new URL(process.env.DECKWISE_LLM_BASE_URL?.trim() || DECKWISE_MANAGED_BASE_URL);
  if (url.username || url.password || url.search || url.hash ||
      !(url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))))
    throw new Error("COURSEWARE_LLM_INVALID_GATEWAY");
  if (!url.pathname || url.pathname === "/") url.pathname = "/v1";
  url.pathname = `${url.pathname.replace(/\/+$/u, "")}/courseware/team/projects/${projectId}`;
  return { apiKey, baseUrl: url.toString().replace(/\/$/u, "") };
}
