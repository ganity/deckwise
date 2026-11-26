import type { CoursewareOnlineDeployment } from "@pi-desktop/shared";

declare const __DECKWISE_DOCS_PUBLIC_BASE_URL__: string;

const docsApiPath = "/web-apps/apps/api/documents/api.js";
export function isCoursewareDocsApiPath(path: string): boolean {
  return path === docsApiPath || path === "/deckwise-office" + docsApiPath;
}

/** Installation-owned pins only; project responses and renderer input cannot select an editor origin. */
export function coursewareOnlineDeployment(environment: NodeJS.ProcessEnv = process.env): CoursewareOnlineDeployment | null {
  let host = environment.DECKWISE_DOCS_ONLINE_ENTRY_URL?.trim();
  let api = environment.DECKWISE_DOCS_API_URL?.trim();
  let plugin = environment.DECKWISE_DOCS_PLUGIN_CONFIG_URL?.trim();
  if (!host && !api && !plugin) {
    const base = typeof __DECKWISE_DOCS_PUBLIC_BASE_URL__ === "string" && __DECKWISE_DOCS_PUBLIC_BASE_URL__;
    if (!base) return null;
    host = base + "/client/courseware-online.html";
    api = base + docsApiPath;
    plugin = base + "/client/modules/config.json";
  }
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
  if (!isCoursewareDocsApiPath(new URL(apiUrl).pathname) ||
      (communityPluginConfigUrl && new URL(communityPluginConfigUrl).origin !== new URL(hostUrl).origin))
    throw new Error("COURSEWARE_ONLINE_INVALID_DEPLOYMENT");
  return { hostUrl, apiUrl, ...(communityPluginConfigUrl ? { communityPluginConfigUrl } : {}) };
}
