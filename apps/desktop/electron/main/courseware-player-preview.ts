import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { BrowserWindow, type IpcMain } from "electron";
import type { CoursewareFixedBuildCoordinator } from "./courseware-fixed-build";
import type { CoursewareMediaClient, CoursewareTeamFixedPlayback } from "./courseware-media";
import { openCoursewareBuildFiles } from "./courseware-build-files";
import type { MaicClassroom } from "@pi-desktop/courseware-runtime/node";

export const COURSEWARE_PLAYER_READ = "deckwise-fixed-player:read";
type TeamMedia = Pick<CoursewareMediaClient, "getTeamFixedPlayback" | "downloadTeamFixedFile">;
type CurrentPlayer = { window: BrowserWindow; previewId?: string; projectId?: string; buildId: string; url: string; locale: string;
  files?: Awaited<ReturnType<typeof openCoursewareBuildFiles>>; teamPlayback?: CoursewareTeamFixedPlayback;
  canonical?: { classroom: MaicClassroom; readAsset(id: unknown): Promise<Uint8Array>; assertCurrent(): Promise<void> } };

/** Dedicated sandboxed surface; only its top frame may read the selected package's finite assets. */
export class CoursewarePlayerPreview {
  private current: CurrentPlayer | null = null;
  private generation = 0;
  private reading = false;

  constructor(private ipcMain: IpcMain, private getParent: () => BrowserWindow | null,
    private builds: Pick<CoursewareFixedBuildCoordinator, "selected">, private teamMedia?: TeamMedia) {
    ipcMain.handle(COURSEWARE_PLAYER_READ, async (event, payload: unknown, ...extra: unknown[]) => {
      const current = this.current;
      if (!current || event.sender !== current.window.webContents || event.senderFrame !== current.window.webContents.mainFrame ||
          event.senderFrame.url !== current.url) throw new Error("Courseware preview sender denied");
      if (extra.length || !payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Invalid courseware preview read");
      const keys = Object.keys(payload);
      const kind = Reflect.get(payload, "kind");
      if (!(kind === "package" && keys.length === 1) && !(kind === "asset" && keys.length === 2 && Object.hasOwn(payload, "id")) &&
          !(kind === "team-selection" && keys.length === 1) && !(kind === "team-file" && keys.length === 2 && Object.hasOwn(payload, "path")))
        throw new Error("Invalid courseware preview read");
      if (this.reading) throw new Error("Courseware preview read already running");
      this.reading = true;
      try {
        if (current.canonical) {
          await current.canonical.assertCurrent();
          const result = kind === "package" ? { classroom: current.canonical.classroom, buildId: current.buildId, locale: current.locale }
            : kind === "asset" ? await current.canonical.readAsset(Reflect.get(payload, "id")) : null;
          if (!result) throw new Error("Invalid canonical preview read");
          await current.canonical.assertCurrent();
          if (this.current !== current || current.window.isDestroyed()) throw new Error("Courseware preview changed");
          return result;
        }
        if (current.teamPlayback) {
          if (kind === "team-selection") return this.teamSelection(current);
          if (kind !== "team-file" || !this.teamMedia) throw new Error("Invalid team preview read");
          const bytes = await this.teamMedia.downloadTeamFixedFile(current.teamPlayback, Reflect.get(payload, "path"));
          if (this.current !== current || current.window.isDestroyed()) throw new Error("Courseware preview changed");
          return bytes;
        }
        if (!current.previewId || !current.files) throw new Error("Courseware preview changed");
        await builds.selected(current.previewId);
        const bytes = kind === "package" ? current.files.packageBytes() : await current.files.assetBytes(Reflect.get(payload, "id"));
        await builds.selected(current.previewId);
        if (this.current !== current || current.window.isDestroyed()) throw new Error("Courseware preview changed");
        if (kind === "package") {
          const pkg = JSON.parse(Buffer.from(bytes).toString("utf8"));
          return pkg.classroom ? { classroom: pkg.classroom, buildId: current.buildId, locale: current.locale } : { bytes, buildId: current.buildId, locale: current.locale };
        }
        return bytes;
      } finally { this.reading = false; }
    });
  }

  async openClassroom(input: { classroom: MaicClassroom; buildId: string; locale: string;
    readAsset(id: unknown): Promise<Uint8Array>; assertCurrent(): Promise<void> }): Promise<void> {
    if (!["en", "zh-CN"].includes(input.locale)) throw new Error("Invalid classroom locale");
    this.close();
    const generation = this.generation, parent = this.getParent();
    if (!parent || parent.isDestroyed()) throw new Error("Main window is unavailable");
    await input.assertCurrent();
    await this.present({ buildId: input.buildId, locale: input.locale, canonical: input }, generation, parent);
  }

  async open(previewId: unknown, locale: unknown): Promise<void> {
    if (typeof previewId !== "string" || !["en", "zh-CN"].includes(String(locale))) throw new Error("Invalid courseware preview selection");
    this.close();
    const generation = this.generation;
    const parent = this.getParent();
    if (!parent || parent.isDestroyed()) throw new Error("Main window is unavailable");
    const selected = await this.builds.selected(previewId);
    const files = await openCoursewareBuildFiles(selected.build.directory, selected.build.buildId);
    await this.builds.selected(previewId);
    await this.present({ previewId, buildId: selected.build.buildId, locale: String(locale), files }, generation, parent);
  }

  async openTeam(projectId: unknown, channel: unknown, locale: unknown): Promise<void> {
    if (typeof projectId !== "string" || !/^[a-f0-9-]{36}$/u.test(projectId) ||
        (channel !== "shared" && channel !== "formal") || !["en", "zh-CN"].includes(String(locale)) || !this.teamMedia)
      throw new Error("Invalid team courseware preview selection");
    this.close();
    const generation = this.generation;
    const parent = this.getParent();
    if (!parent || parent.isDestroyed()) throw new Error("Main window is unavailable");
    const playback = await this.teamMedia.getTeamFixedPlayback(projectId, channel);
    await this.present({ projectId, buildId: playback.pointer.buildId, locale: String(locale), teamPlayback: playback }, generation, parent);
  }

  private async present(source: Omit<CurrentPlayer, "window" | "url">, generation: number, parent: BrowserWindow): Promise<void> {
    if (generation !== this.generation || parent !== this.getParent() || parent.isDestroyed()) throw new Error("Courseware preview owner changed");
    const window = new BrowserWindow({ parent, width: 1100, height: 850, show: false,
      webPreferences: { preload: join(__dirname, "../preload/courseware-player.js"),
        contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true,
        autoplayPolicy: "user-gesture-required", partition: `courseware-preview-${generation}` } });
    const playerUrl = process.env.ELECTRON_RENDERER_URL
      ? new URL("courseware-player.html", process.env.ELECTRON_RENDERER_URL).href
      : pathToFileURL(join(__dirname, "../renderer/courseware-player.html")).href;
    const target = new URL(playerUrl);
    if (source.teamPlayback) target.searchParams.set("team", "1");
    const url = target.href;
    const current = { ...source, window, url };
    this.current = current;
    const invalidate = () => { if (this.current === current) this.close(); };
    parent.webContents.on("did-start-navigation", invalidate);
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event) => event.preventDefault());
    window.webContents.on("will-attach-webview", (event) => event.preventDefault());
    window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    window.webContents.session.webRequest.onBeforeRequest((details, callback) => {
      const target = new URL(details.url);
      const base = new URL(url);
      const dev = base.protocol !== "file:" && target.origin === base.origin;
      const bundled = base.protocol === "file:" && target.protocol === "file:" &&
        target.href.startsWith(new URL("./", base).href);
      callback({ cancel: !(dev || bundled || ["blob:", "data:"].includes(target.protocol)) });
    });
    window.once("closed", () => {
      parent.webContents.removeListener("did-start-navigation", invalidate);
      if (this.current === current) { this.current = null; this.generation++; }
    });
    try {
      await window.loadURL(url);
      if (current.previewId) await this.builds.selected(current.previewId);
      if (this.current !== current) throw new Error("Courseware preview changed");
      window.show();
    } catch (error) {
      if (this.current === current) this.close();
      throw error;
    }
  }

  private teamSelection(current: CurrentPlayer) {
    const playback = current.teamPlayback;
    if (!playback) throw new Error("Team playback is unavailable");
    return {
      expected: { buildId: playback.pointer.buildId, snapshotId: playback.pointer.snapshotId, packageSha256: playback.pointer.packageSha256 },
      selection: {
        build: playback.fixedBuild.build,
        manifestSha256: playback.fixedBuild.manifestSha256,
        expiresAt: playback.fixedBuild.expiresAt,
        files: playback.fixedBuild.files.map(({ file }) => ({ file, downloadUrl: "" })),
      },
      locale: current.locale,
    };
  }

  close(): void {
    this.generation++;
    const current = this.current; this.current = null;
    if (current && !current.window.isDestroyed()) current.window.destroy();
  }
}
