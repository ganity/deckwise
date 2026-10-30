import * as crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import * as shared from "../../../../packages/shared/dist/index.js";

export async function loadCoursewareMedia(name = "courseware-media") {
  const modules = new Map([["node:crypto", crypto], ["@pi-desktop/shared", shared]]);
  for (const name of ["courseware-generation-queue", "courseware-media-contracts", "courseware-media-transport", "courseware-music-request", "courseware-local-media", "courseware-music-media", "courseware-video-media", "courseware-media"]) {
    const source = await readFile(new URL(`../../electron/main/${name}.ts`, import.meta.url), "utf8");
    const output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
    const exports = {};
    new Function("require", "exports", output)(id => {
      if (!modules.has(id)) throw new Error(`Unexpected dependency ${id}`);
      return modules.get(id);
    }, exports);
    modules.set(`./${name}`, exports);
  }
  return modules.get(`./${name}`);
}
