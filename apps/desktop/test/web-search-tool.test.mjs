import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  parseDuckDuckGoResults,
  parseSoResults,
} from "../resources/plugins/pi.web-search/main.js";

test("DuckDuckGo results become bounded source records", () => {
  const html = `
    <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fguide&amp;rut=x">
      Example &amp; guide
    </a>
    <a class="result__snippet"><b>Useful</b> current information.</a>
    <a class="result__a" href="javascript:alert(1)">Unsafe</a>
  `;

  assert.deepEqual(parseDuckDuckGoResults(html, 1), [
    {
      title: "Example & guide",
      url: "https://example.com/guide",
      snippet: "Useful current information.",
    },
  ]);
});

test("360 results use the destination URL and strip result markup", () => {
  const html = `
    <li class="res-list">
      <h3 class="res-title"><a href="https://www.so.com/link?m=x" data-mdurl="https://example.cn/news">
        <em>人工智能</em>教育
      </a></h3>
      <p class="res-desc"><span>今天</span>发布的<em>教育</em>信息。</p>
    </li>
  `;

  assert.deepEqual(parseSoResults(html, 1), [
    {
      title: "人工智能 教育",
      url: "https://example.cn/news",
      snippet: "今天 发布的 教育 信息。",
    },
  ]);
});

test("the composer flag gates the bundled search tool for the next turn", async () => {
  const [composer, toolbar, queue, agentIpc, sessionLaunch] = await Promise.all([
    readFile(new URL("../src/components/Composer.tsx", import.meta.url), "utf8"),
    readFile(
      new URL("../src/features/chat/composer/ComposerToolbar.tsx", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../src/stores/slices/queue-slice.ts", import.meta.url), "utf8"),
    readFile(new URL("../electron/main/ipc/agent-ipc.ts", import.meta.url), "utf8"),
    readFile(
      new URL("../electron/main/runtime/session-launch.ts", import.meta.url),
      "utf8",
    ),
  ]);

  assert.match(composer, /webSearchEnabled=\{webSearchEnabled\}/);
  assert.match(toolbar, /aria-pressed=\{webSearchEnabled\}/);
  assert.match(queue, /webSearchEnabled: true/);
  assert.match(agentIpc, /webSearchEnabled: req\.webSearchEnabled === true/);
  assert.match(sessionLaunch, /BUILTIN_WEB_SEARCH_PLUGIN_ID = "pi\.web-search"/);
  assert.match(sessionLaunch, /overrides\.webSearchEnabled === true/);
});
