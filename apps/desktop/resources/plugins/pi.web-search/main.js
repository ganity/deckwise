const DUCKDUCKGO_SEARCH_URL = "https://html.duckduckgo.com/html/";
const SO_SEARCH_URL = "https://www.so.com/s";
const MAX_QUERY_LENGTH = 500;

function decodeHtml(value) {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number.parseInt(code, 10)))
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&");
}

function plainText(value) {
  return decodeHtml(value.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function attribute(attributes, name) {
  return new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, "i").exec(attributes)?.[2] ?? "";
}

function resultUrl(href, baseUrl = DUCKDUCKGO_SEARCH_URL) {
  try {
    const link = new URL(decodeHtml(href), baseUrl);
    const destination = link.searchParams.get("uddg") ?? link.href;
    const url = new URL(destination);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

export function parseDuckDuckGoResults(html, limit = 5) {
  const results = [];
  const snippets = [];
  for (const match of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const classNames = attribute(match[1], "class").split(/\s+/);
    if (classNames.includes("result__snippet")) {
      snippets.push(plainText(match[2]));
      continue;
    }
    if (!classNames.includes("result__a")) continue;
    const url = resultUrl(attribute(match[1], "href"));
    const title = plainText(match[2]);
    if (url && title) results.push({ title, url, snippet: "" });
  }
  return results.slice(0, limit).map((result, index) => ({
    ...result,
    snippet: snippets[index] ?? "",
  }));
}

export function parseSoResults(html, limit = 5) {
  const results = [];
  for (const match of html.matchAll(
    /<h3\b[^>]*class=["'][^"']*\bres-title\b[^"']*["'][^>]*>[\s\S]*?<a\b([^>]*)>([\s\S]*?)<\/a>[\s\S]*?<\/h3>([\s\S]*?)(?=<h3\b[^>]*class=["'][^"']*\bres-title\b|$)/gi,
  )) {
    const url = resultUrl(
      attribute(match[1], "data-mdurl") || attribute(match[1], "href"),
      SO_SEARCH_URL,
    );
    const title = plainText(match[2]);
    const snippetMatch = /<(p|span)\b[^>]*class=["'][^"']*\b(?:res-desc|res-list-summary)\b[^"']*["'][^>]*>([\s\S]*?)<\/\1>/i.exec(
      match[3],
    );
    if (url && title) {
      results.push({ title, url, snippet: plainText(snippetMatch?.[2] ?? "") });
    }
    if (results.length >= limit) break;
  }
  return results;
}

async function searchDuckDuckGo(query, count) {
  const url = new URL(DUCKDUCKGO_SEARCH_URL);
  url.searchParams.set("q", query);
  const response = await pi.net.fetch({
    url: url.href,
    headers: {
      Accept: "text/html",
      "User-Agent": "Mozilla/5.0 (compatible; DeckWise/1.0)"
    },
    timeoutMs: 8000
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`DuckDuckGo returned HTTP ${response.status}`);
  }
  return { provider: "DuckDuckGo", results: parseDuckDuckGoResults(response.bodyText, count) };
}

async function searchSo(query, count) {
  const url = new URL(SO_SEARCH_URL);
  url.searchParams.set("q", query);
  const response = await pi.net.fetch({
    url: url.href,
    headers: {
      Accept: "text/html",
      "User-Agent": "Mozilla/5.0 (compatible; DeckWise/1.0)"
    },
    timeoutMs: 15000
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`360 Search returned HTTP ${response.status}`);
  }
  return { provider: "360 Search", results: parseSoResults(response.bodyText, count) };
}

async function searchWeb(query, count) {
  const providers = /[\u3400-\u9fff]/u.test(query)
    ? [searchSo, searchDuckDuckGo]
    : [searchDuckDuckGo, searchSo];
  let lastError;
  for (const search of providers) {
    try {
      const response = await search(query, count);
      if (response.results.length > 0) return response;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error("web search returned no parseable results");
}

export async function onLoad() {
  await pi.agent.registerTool({
    name: "web_search",
    description:
      "Search the public web for current information and return concise snippets with source URLs. Use only when the user's request benefits from external information.",
    risk: "low",
    schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "A focused web search query.",
          minLength: 1,
          maxLength: MAX_QUERY_LENGTH
        },
        count: {
          type: "integer",
          description: "Number of results to return (1-10).",
          minimum: 1,
          maximum: 10,
          default: 5
        }
      },
      required: ["query"]
    },
    execute: async (args) => {
      const query = String(args?.query ?? "").trim();
      if (!query || query.length > MAX_QUERY_LENGTH) {
        throw new Error(`query must contain 1-${MAX_QUERY_LENGTH} characters`);
      }
      const count = Math.max(1, Math.min(10, Number(args?.count) || 5));
      const { provider, results } = await searchWeb(query, count);
      return {
        query,
        provider,
        results,
        text: results
          .map(
            (result, index) =>
              `${index + 1}. ${result.title}\n${result.snippet}\nSource: ${result.url}`,
          )
          .join("\n\n")
      };
    }
  });
}

export async function onUnload() {
  await pi.agent.unregisterTool("web_search");
}
