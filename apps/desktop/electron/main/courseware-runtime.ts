import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

/** Only main resolves executables; RPC callers cannot supply launch paths. */
export function coursewareWorkerPath(): string {
  if (process.env.DECKWISE_PPTX_WORKER) return process.env.DECKWISE_PPTX_WORKER;
  const installed = join(process.resourcesPath || '', 'pptx-worker/pptx-worker.mjs');
  if (typeof __dirname === 'string' && !existsSync(installed)) {
    const staged = join(__dirname, '../../resources/pptx-worker/pptx-worker.mjs');
    if (existsSync(staged)) return staged;
  }
  return installed;
}

export function coursewareRuntimeEnvironment(): Record<string, string> {
  const worker = coursewareWorkerPath();
  if (!existsSync(worker)) return {};
  return { DECKWISE_PPTX_NODE: process.execPath, DECKWISE_PPTX_WORKER: worker };
}

export function coursewareAuthoringUrl(): string | undefined {
  const worker = coursewareRuntimeEnvironment().DECKWISE_PPTX_WORKER;
  const authoring = worker && join(dirname(worker), "authoring.mjs");
  return authoring && existsSync(authoring) ? pathToFileURL(authoring).href : undefined;
}
