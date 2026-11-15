import type { CoursewareOnlineDeployment } from "@pi-desktop/shared";

/** Installation-owned pins only; project responses and renderer input cannot select an editor origin. */
export function coursewareOnlineDeployment(environment: NodeJS.ProcessEnv = process.env): CoursewareOnlineDeployment | null {
  const host = environment.DECKWISE_DOCS_ONLINE_ENTRY_URL?.trim();
  const api = environment.DECKWISE_DOCS_API_URL?.trim();
  const plugin = environment.DECKWISE_DOCS_PLUGIN_CONFIG_URL?.trim();
  if (!host && !api && !plugin) return null;
  const pin = (value: string | undefined, suffix: string): string => {
    if (!value) throw new Error("COURSEWARE_ONLINE_INVALID_DEPLOYMENT");
    let url: URL;
    try { url = new URL(value); } catch { throw new Error("COURSEWARE_ONLINE_INVALID_DEPLOYMENT"); }
    if (!(url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) ||
        url.username || url.password || url.search || url.hash || !url.pathname.endsWith(suffix))
      throw new Error("COURSEWARE_ONLINE_INVALID_DEPLOYMENT");
    return url.href;
  };
  const hostUrl = pin(host, "/courseware-online.html"), apiUrl = pin(api, "/api.js");
  const communityPluginConfigUrl = plugin ? pin(plugin, "/config.json") : undefined;
  if (new URL(apiUrl).pathname !== "/web-apps/apps/api/documents/api.js" ||
      (communityPluginConfigUrl && new URL(communityPluginConfigUrl).origin !== new URL(hostUrl).origin))
    throw new Error("COURSEWARE_ONLINE_INVALID_DEPLOYMENT");
  return { hostUrl, apiUrl, ...(communityPluginConfigUrl ? { communityPluginConfigUrl } : {}) };
}
