import * as electron from "electron";
import { existsSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";

function pythonExecutable(root: string): string {
  return process.platform === "win32"
    ? join(root, "python.exe")
    : join(root, "bin", "python3");
}

export function resolveBundledPython(): string | null {
  const configured = process.env.DECKWISE_PYTHON_RUNTIME_DIR?.trim();
  const appPath = electron.app?.getAppPath();
  const candidates = [
    configured,
    join(process.resourcesPath || "", "runtime", "python"),
    appPath ? join(appPath, "dist", "runtime", "current", "python") : undefined,
  ].filter((value): value is string => Boolean(value));
  for (const root of candidates) {
    const executable = pythonExecutable(root);
    if (existsSync(executable)) return executable;
  }
  return null;
}

export function bundledPythonEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const executable = resolveBundledPython();
  if (!executable) return env;
  const bin = dirname(executable);
  return {
    ...env,
    PATH: [bin, env.PATH].filter(Boolean).join(delimiter),
    DECKWISE_RUNTIME_BIN: bin,
    DECKWISE_PYTHON: executable,
  };
}
