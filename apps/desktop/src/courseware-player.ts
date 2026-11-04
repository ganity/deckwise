import { chinesePlayerLabels, englishPlayerLabels, FixedCoursewarePlayer, loadTeamFixedBuild, loadMaicClassroom, mountFixedBuild } from "@pi-desktop/courseware-runtime/player";
import "@pi-desktop/courseware-runtime/player.css";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import "./styles/courseware-player.css";

declare global {
  interface Window {
    deckwiseFixedPlayer: {
      readPackage(): Promise<{ bytes?: Uint8Array; classroom?: unknown; buildId: string; locale: string }>;
      readAsset(id: string): Promise<Uint8Array>;
      readTeamSelection(): Promise<{ selection: unknown; expected: { buildId: string; snapshotId: string; packageSha256: string }; locale: string }>;
      readTeamFile(path: string): Promise<Uint8Array>;
    };
  }
}

const abort = new AbortController();
let unmount: (() => void) | undefined;
window.addEventListener("pagehide", () => { abort.abort(); unmount?.(); unmount = undefined; }, { once: true });

// Local font resources are copied by the Desktop build; no management app CSS is loaded.
const fontNames = ["dynapuff", "comic-neue", "lxgw-wenkai", "@fontsource-variable/arimo", "@fontsource-variable/inter",
  "@fontsource-variable/noto-sans-sc", "@fontsource-variable/noto-serif-sc", "@fontsource/tinos",
  "@fontsource/caladea", "@fontsource/carlito", "@fontsource/cousine"];
const loadFonts = () => Promise.all(fontNames.map((name) => new Promise<void>((resolve, reject) => {
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = new URL(`./courseware-fonts/fonts/${name}/index.css`, location.href).href;
  link.onload = () => resolve(); link.onerror = () => reject(new Error("Bundled courseware fonts unavailable"));
  document.head.append(link);
})));

async function start() {
  if (new URLSearchParams(location.search).has("team")) {
    const selected = await window.deckwiseFixedPlayer.readTeamSelection();
    const build = await loadTeamFixedBuild(selected.selection, selected.expected,
      (path) => window.deckwiseFixedPlayer.readTeamFile(path), abort.signal);
    const labels = selected.locale === "zh-CN" ? chinesePlayerLabels : englishPlayerLabels;
    document.documentElement.lang = selected.locale;
    document.title = labels.player;
    await loadFonts();
    abort.signal.throwIfAborted();
    const root = createRoot(document.getElementById("root")!);
    root.render(createElement(FixedCoursewarePlayer, { build, labels, width: Math.max(320, Math.min(960, innerWidth - 40)) }));
    unmount = () => { root.unmount(); build.dispose(); };
    return;
  }
  const selected = await window.deckwiseFixedPlayer.readPackage();
  const labels = selected.locale === "zh-CN" ? chinesePlayerLabels : englishPlayerLabels;
  document.documentElement.lang = selected.locale;
  document.title = labels.player;
  await loadFonts();
  abort.signal.throwIfAborted();
  if (selected.classroom) {
    const urls: string[] = [];
    try {
      const build = await loadMaicClassroom(selected.classroom, selected.buildId, async (asset, signal) => {
        const bytes = await window.deckwiseFixedPlayer.readAsset(asset.assetId);
        signal?.throwIfAborted();
        const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: asset.mimeType }));
        urls.push(url); return url;
      }, abort.signal);
      abort.signal.throwIfAborted();
      const root = createRoot(document.getElementById("root")!);
      root.render(createElement(FixedCoursewarePlayer, { build, labels, width: Math.max(320, Math.min(960, innerWidth - 40)) }));
      unmount = () => { root.unmount(); build.dispose(); urls.forEach(url => URL.revokeObjectURL(url)); };
    } catch (error) { urls.forEach(url => URL.revokeObjectURL(url)); throw error; }
    return;
  }
  if (!selected.bytes) throw new Error("Courseware package is missing");
  unmount = await mountFixedBuild(document.getElementById("root")!, selected.bytes, selected.buildId,
    (asset) => window.deckwiseFixedPlayer.readAsset(asset.id), { labels, width: Math.max(320, Math.min(960, innerWidth - 40)) }, abort.signal);
}
void start().catch((error) => {
  if (!abort.signal.aborted) document.getElementById("error")!.textContent = String(error);
});
