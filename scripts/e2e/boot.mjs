import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function repositoryRoot() {
  return join(dirname(fileURLToPath(import.meta.url)), "../..");
}

export function desktopPaths(root = repositoryRoot()) {
  const appDir = join(root, "apps", "desktop");
  const electronBinary =
    process.platform === "win32"
      ? join(appDir, "node_modules", "electron", "dist", "electron.exe")
      : join(appDir, "node_modules", ".bin", "electron");
  return { appDir, electronBinary };
}

export function resolveElectronBinary(root = repositoryRoot()) {
  const { appDir } = desktopPaths(root);
  const electronDir = join(appDir, "node_modules", "electron");
  const pathFile = join(electronDir, "path.txt");
  const relativeBinary = existsSync(pathFile)
    ? readFileSync(pathFile, "utf8").trim()
    : process.platform === "win32"
      ? "electron.exe"
      : "electron";
  const binary = join(electronDir, "dist", relativeBinary);
  if (!existsSync(binary)) {
    throw new Error("Electron binary missing: " + binary);
  }
  return { appDir, electronBinary: binary };
}

export function assertDesktopBuild(root = repositoryRoot()) {
  const { appDir } = desktopPaths(root);
  const mainPath = join(appDir, "out", "main", "index.js");
  const rendererPath = join(appDir, "out", "renderer", "index.html");
  if (!existsSync(mainPath)) {
    throw new Error("desktop app main is not built: " + mainPath);
  }
  if (!existsSync(rendererPath)) {
    throw new Error("desktop app renderer is not built: " + rendererPath);
  }
  return { appDir, mainPath, rendererPath };
}

export function coursewareLaunch(root = repositoryRoot(), env = process.env) {
  if (env.DECKWISE_E2E_PACKAGE_ROOT) {
    for (const key of ["ELECTRON_EXECUTABLE", "PI_DESKTOP_HOST_BIN", "DECKWISE_PPTX_WORKER", "DECKWISE_PPTX_NODE", "DECKWISE_PYTHON_RUNTIME_DIR", "PI_DESKTOP_DEV", "ELECTRON_RENDERER_URL", "ELECTRON_RUN_AS_NODE"]) {
      if (env[key]) throw new Error(`Packaged validation must not override ${key}`);
    }
    const cwd = resolve(env.DECKWISE_E2E_PACKAGE_ROOT);
    const executablePath = join(cwd, "deckwise");
    if (!existsSync(executablePath) || !existsSync(join(cwd, "resources", "app.asar"))) {
      throw new Error("Linux unpacked Desktop is missing: " + cwd);
    }
    return { executablePath, cwd, args: [], packaged: true };
  }
  const { appDir } = assertDesktopBuild(root);
  return {
    executablePath: env.ELECTRON_EXECUTABLE || resolveElectronBinary(root).electronBinary,
    cwd: appDir, args: [appDir], packaged: false,
  };
}

export function createTempDataDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function retainCoursewareWorkspace({ recovery, mediaEnabled, passed }) {
  return recovery || (mediaEnabled && !passed);
}
