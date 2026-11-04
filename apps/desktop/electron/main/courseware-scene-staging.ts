import { createHash } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { resolveRealOpenablePath, resolveRealPathForCreateWithinRoot } from "./fs-panel";
import { validateOfficeBytes } from "./office-file";
import { jobIdFor, listRevisions, publishRevision } from "./ppt-editor-files";

type Host = { call<T>(method: string, params: unknown): Promise<T> };

/** Persist compiled bytes before parsing; the content-addressed file survives a failed handoff. */
export async function stageGeneratedSceneCourse(input: {
  workspace: string;
  sessionId: string;
  title: string;
  pptx: Uint8Array;
  canonicalClassroom?: unknown;
  teaching: Array<{ pageId: string; narration: string }>;
  sceneMapping?: Awaited<ReturnType<typeof import("@pi-desktop/courseware-runtime/authoring").compileScenesToPptx>>["mapping"];
  host: Host;
  signal?: AbortSignal;
  sceneProof?: { planSha256: string; principalKey: string; selectedIntentIds: string[] };
  assertCurrent?: () => Promise<void>;
}) {
  // Archive each generated image once; canonical JSON contains managed resource references only.
  let canonicalClassroom = input.canonicalClassroom && structuredClone(input.canonicalClassroom);
  if (canonicalClassroom && typeof canonicalClassroom === "object") {
    const document = canonicalClassroom as { mediaManifest?: Array<{ src: string; originalSrc: string; mimeType: string }> };
    const replacements = new Map<string, string>();
    for (const asset of document.mediaManifest ?? []) {
      const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(asset.src);
      if (!match) continue;
      const image = Buffer.from(match[2], "base64");
      if (!image.length || image.length > 50 * 1024 * 1024 || image.toString("base64") !== match[2]) throw new Error("Invalid generated image");
      const suffix = match[1] === "image/jpeg" ? "jpg" : match[1].slice(6);
      const relative = `.deckwise-ppt/classroom-assets/${createHash("sha256").update(image).digest("hex")}.${suffix}`;
      const destination = await resolveRealPathForCreateWithinRoot(input.workspace, relative);
      if (!destination) throw new Error("Generated image escapes workspace");
      await fs.mkdir(dirname(destination), { recursive: true });
      if (await resolveRealPathForCreateWithinRoot(input.workspace, relative) !== destination) throw new Error("Generated image archive changed");
      try { await fs.writeFile(destination, image, { flag: "wx", mode: 0o600 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !(await fs.readFile(destination)).equals(image)) throw error; }
      replacements.set(asset.src, relative);
    }
    const visit = (value: unknown): void => {
      if (!value || typeof value !== "object") return;
      for (const [key, child] of Object.entries(value)) {
        if (typeof child === "string" && replacements.has(child)) (value as Record<string, unknown>)[key] = replacements.get(child)!;
        else visit(child);
      }
    };
    visit(canonicalClassroom);
  }
  if (canonicalClassroom && typeof canonicalClassroom === "object" && "stage" in canonicalClassroom)
    (canonicalClassroom as { stage: { name: string } }).stage.name = input.title;
  // New generation owns canonical MAIC content. Canonical-only Quiz courses have no fake Office document.
  if (canonicalClassroom && input.teaching.length === 0) {
    input.signal?.throwIfAborted();
    await input.assertCurrent?.();
    const view = await input.host.call<{ projectId: string; sourceRevision: string; revision: string }>(
      "courseware.classroom.create", { sessionId: input.sessionId, classroom: canonicalClassroom });
    return { path: "", project: { projectId: view.projectId, source: { sha256: view.sourceRevision }, pages: [] }, sha256: view.sourceRevision };
  }
  const sceneMapping = input.sceneMapping && structuredClone(input.sceneMapping);
  if (input.sceneProof && !sceneMapping) throw new Error("Generated scene object mapping is required");
  if (!input.title.trim() || input.title.length > 500 || !Array.isArray(input.teaching) ||
      input.teaching.length < 1 || input.teaching.length > 30 ||
      input.teaching.some((page) => typeof page.pageId !== "string" || !page.pageId ||
        typeof page.narration !== "string" || !page.narration.trim() || page.narration.length > 2500))
    throw new Error("Invalid generated course title or narration");
  const bytes = validateOfficeBytes(input.pptx, "pptx");
  if (bytes.length > 50 * 1024 * 1024) throw new Error("Generated PPTX exceeds 50 MiB");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const relative = join(".deckwise-ppt", "generated", `${sha256}.pptx`);
  const path = await resolveRealPathForCreateWithinRoot(input.workspace, relative);
  if (!path) throw new Error("Generated course directory is outside the workspace");
  await fs.mkdir(dirname(path), { recursive: true });
  if (await resolveRealPathForCreateWithinRoot(input.workspace, relative) !== path)
    throw new Error("Generated course directory changed");
  try {
    await fs.writeFile(path, bytes, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const file = await fs.open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size !== bytes.length ||
          createHash("sha256").update(await file.readFile()).digest("hex") !== sha256)
        throw new Error("Existing generated PPTX differs from content hash");
    } finally { await file.close(); }
  }
  if (await resolveRealOpenablePath(path, input.workspace) !== path)
    throw new Error("Generated PPTX left the workspace");
  input.signal?.throwIfAborted();
  const documentId = jobIdFor(input.workspace, path);
  const revisionRoot = await resolveRealPathForCreateWithinRoot(input.workspace, join(".deckwise-ppt", "revisions"));
  if (!revisionRoot || !await resolveRealPathForCreateWithinRoot(input.workspace, join(".deckwise-ppt", "revisions", documentId)))
    throw new Error("Generated revision directory is outside the workspace");
  const saved = (await listRevisions(revisionRoot, documentId)).at(-1);
  if (saved && saved.sha256 !== sha256) throw new Error("Generated document already has a different saved revision");
  const revision = saved ?? await publishRevision({
    root: revisionRoot, jobId: documentId, bytes, extension: "pptx", cause: "generated", expectedRevision: 0,
  });
  if (await resolveRealOpenablePath(revision.documentPath, input.workspace) !== revision.documentPath)
    throw new Error("Generated revision left the workspace");
  let jobId: string | undefined;
  let terminal = false;
  try {
    input.signal?.throwIfAborted();
    jobId = (await input.host.call<{ jobId: string }>("courseware.parseStart", {
      sessionId: input.sessionId, path: revision.documentPath,
    })).jobId;
    while (true) {
      input.signal?.throwIfAborted();
      const status = await input.host.call<{ status: string; message?: string; summary?: { sourceSha256: string; pageCount?: number } }>(
        "courseware.parseStatus", { jobId },
      );
      if (status.status === "RUNNING") { await delay(100, undefined, { signal: input.signal }); continue; }
      terminal = true;
      if (status.status !== "SUCCEEDED") throw new Error(status.message || "Generated PPTX parsing failed");
      if (status.summary?.sourceSha256 !== sha256) throw new Error("Parsed PPTX differs from generated bytes");
      break;
    }
    input.signal?.throwIfAborted();
    await input.assertCurrent?.();
    const { project } = await input.host.call<{ project: { projectId: string; source: { sha256: string }; pages: Array<{ pageId: string }> } }>(
      "courseware.project.initializeGenerated", { sessionId: input.sessionId, jobId, sourceSha256: sha256,
        title: input.title, narrations: input.teaching.map((page) => page.narration),
        ...(sceneMapping ? { sceneMapping } : {}), ...(input.sceneProof ? { sceneProof: input.sceneProof } : {}) },
    );
    if (project.source.sha256 !== sha256 || project.pages.length !== input.teaching.length)
      throw new Error("Initialized project differs from generated deck");
    input.signal?.throwIfAborted();
    await input.assertCurrent?.();
    if (canonicalClassroom) {
      const view = await input.host.call<{ revision: string | null; sourceRevision: string }>("courseware.classroom.get", {
        sessionId: input.sessionId, projectId: project.projectId,
      });
      const classroom = structuredClone(canonicalClassroom) as { stage: { name: string }; scenes: Array<{ type: string; content: { canvas?: { elements: Array<{ id: string; type: string; content?: string }> } }; actions?: Array<{ type: string; question?: string }>; metadata?: Record<string, unknown> }> };
      classroom.stage.name = input.title;
      let nativeIndex = 0;
      for (const scene of classroom.scenes) if (scene.type === "slide") {
        const question = scene.actions?.find(action => action.type === "interaction_checkpoint" && typeof action.question === "string")?.question;
        scene.metadata = { ...scene.metadata, nativePageId: project.pages[nativeIndex++]?.pageId,
          ...(question !== undefined ? { nativeQuestionText: question } : {}),
          nativeNarrationText: (scene.actions as Array<{ type: string; text?: string }> | undefined)?.filter(action => action.type === "speech").map(action => action.text ?? "").join("\n") ?? "" };
      }
      await input.host.call("courseware.classroom.write", { sessionId: input.sessionId, projectId: project.projectId,
        expectedRevision: view.revision, expectedSourceRevision: view.sourceRevision, classroom });
    }
    await input.host.call("courseware.task.attachGenerated", {
      sessionId: input.sessionId, path, projectId: project.projectId, sourceSha256: sha256,
      ...(input.sceneProof ? { sceneProof: input.sceneProof } : {}),
    });
    return { path, project, sha256 };
  } finally {
    if (jobId) {
      if (!terminal) {
        await input.host.call("courseware.parseCancel", { jobId });
        while ((await input.host.call<{ status: string }>("courseware.parseStatus", { jobId })).status === "RUNNING") await delay(100);
      }
      await input.host.call("courseware.parseRelease", { jobId });
    }
  }
}
