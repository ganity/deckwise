import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isCoursewareSnapshot, type CoursewareFixedBuildView, type CoursewareSnapshot } from "@pi-desktop/shared";
import { adaptCanonicalSnapshot, buildFixedCourseware, FixedBuildError } from "@pi-desktop/courseware-runtime/node";

type Host = { call<T>(method: string, params: unknown): Promise<T> };
type Selection = { sessionId: string; projectId: string; snapshotId: string };
type Built = Awaited<ReturnType<typeof buildFixedCourseware>>;
type Diagnostic = Built["report"]["diagnostics"][number];
type Owner = { host: Host; workspace: string; selection: Selection; abort: AbortController };
type Review = { owner: Owner; reviewId: string; snapshot: CoursewareSnapshot; diagnostics: Diagnostic[]; codes: string[] };
type Ready = { owner: Owner; previewId: string; snapshot: CoursewareSnapshot; build: Built };
export type FixedBuildView = CoursewareFixedBuildView;

/** Main consumes only persisted Host exports; callers never supply file paths or converter approvals. */
export class CoursewareFixedBuildCoordinator {
  private active: Owner | null = null;
  private review: Review | null = null;
  private ready: Ready | null = null;
  private generation = 0;

  constructor(
    private getHost: () => Host | null,
    private getWorkspace: () => Promise<string | null>,
    private getViewingSessionId: () => string | null,
    private workerDirectory: string,
    private outputDirectory: string,
  ) {}

  async build(payload: unknown): Promise<FixedBuildView> {
    const selection = this.selection(payload);
    if (this.active) throw new Error("A courseware build is already running");
    const generation = this.generation;
    const host = this.getHost();
    const workspace = await this.getWorkspace();
    if (generation !== this.generation) throw new Error("Courseware build canceled");
    if (!host || !workspace) throw new Error("Courseware Host or workspace is unavailable");
    const owner = { host, workspace, selection, abort: new AbortController() };
    await this.assertOwner(owner);
    if (generation !== this.generation) throw new Error("Courseware build canceled");
    if (this.active) throw new Error("A courseware build is already running");
    this.review = null; this.ready = null;
    return this.run(owner, []);
  }

  async approveWarnings(payload: unknown): Promise<FixedBuildView> {
    const review = this.review;
    if (!review || !this.fields(payload, ["reviewId", "codes"]) || Reflect.get(payload, "reviewId") !== review.reviewId)
      throw new Error("Courseware warning review expired");
    const codes: unknown = Reflect.get(payload, "codes");
    if (!Array.isArray(codes) || codes.length !== review.codes.length || new Set(codes).size !== codes.length ||
        codes.some((code) => !review.codes.includes(code))) throw new Error("Confirm exactly the displayed conversion warnings");
    await this.assertOwner(review.owner);
    if (this.review !== review || this.active) throw new Error("Courseware warning review changed");
    this.review = null;
    return this.run(review.owner, review.codes, review.snapshot);
  }

  cancel(): void {
    this.generation++;
    this.active?.abort.abort(new Error("Courseware build canceled"));
    this.review?.owner.abort.abort(new Error("Courseware warning review canceled"));
    this.ready?.owner.abort.abort(new Error("Courseware preview closed"));
    this.review = null; this.ready = null;
  }

  /** Private Main handoff. No directory is returned through renderer IPC. */
  async selected(previewId: unknown): Promise<{ snapshot: CoursewareSnapshot; build: Built }> {
    const ready = this.ready;
    if (!ready || previewId !== ready.previewId) throw new Error("Courseware preview expired");
    await this.assertOwner(ready.owner);
    if (this.ready !== ready) throw new Error("Courseware preview changed");
    return { snapshot: structuredClone(ready.snapshot), build: structuredClone(ready.build) };
  }

  private async run(owner: Owner, codes: string[], expected?: CoursewareSnapshot): Promise<FixedBuildView> {
    if (this.active) throw new Error("A courseware build is already running");
    this.active = owner;
    try {
      await this.assertOwner(owner);
      const raw = await owner.host.call<unknown>("courseware.snapshot.get", owner.selection);
      await this.assertOwner(owner);
      if (!this.fields(raw, ["snapshot", "project", "mapping", "sourcePath", "assets"])) throw new Error("Invalid Host snapshot export");
      const snapshot: unknown = Reflect.get(raw, "snapshot");
      if (!isCoursewareSnapshot(snapshot) || snapshot.projectId !== owner.selection.projectId ||
          snapshot.snapshotId !== owner.selection.snapshotId || (expected && JSON.stringify(snapshot) !== JSON.stringify(expected)))
        throw new Error("Host snapshot differs from the selected immutable input");
      const manifest = await readFile(join(this.workerDirectory, "manifest.json"));
      await this.assertOwner(owner);
      const input = adaptCanonicalSnapshot(Reflect.get(raw, "project"), snapshot, {
        sourcePath: Reflect.get(raw, "sourcePath"), mapping: Reflect.get(raw, "mapping"), assets: Reflect.get(raw, "assets"),
        converter: { version: "maic-pptx-import-ir/1", manifestSha256: createHash("sha256").update(manifest).digest("hex") },
        reviewedWarningCodes: codes,
      });
      try {
        const build = await buildFixedCourseware(input, {
          workerDirectory: this.workerDirectory, outputDirectory: this.outputDirectory, signal: owner.abort.signal,
        });
        await this.assertOwner(owner);
        const previewId = randomUUID();
        this.ready = { owner, previewId, snapshot: structuredClone(snapshot), build };
        return { status: "ready", previewId, snapshot: structuredClone(snapshot),
          buildRef: { buildId: build.buildId, packageSha256: build.packageHash, snapshotId: snapshot.snapshotId }, report: structuredClone(build.report) };
      } catch (error) {
        await this.assertOwner(owner);
        if (error instanceof FixedBuildError && error.code === "CONTENT_ERROR") {
          const blocking = error.diagnostics.filter((entry) => entry.severity === "error");
          if (blocking.length) throw new Error(`CONTENT_ERROR: ${blocking.slice(0, 3)
            .map((entry) => `${entry.code}: ${entry.message}`).join("; ")}${blocking.length > 3 ? `; +${blocking.length - 3}` : ""}`);
        }
        if (!(error instanceof FixedBuildError) || error.code !== "CONTENT_REVIEW_REQUIRED") throw error;
        const diagnostics = structuredClone(error.diagnostics);
        if (diagnostics.some((entry) => entry.severity === "error")) throw error;
        const warningCodes = [...new Set(diagnostics.filter((entry) => (entry.severity ?? "warning") === "warning").map((entry) => entry.code))];
        if (!warningCodes.length) throw error;
        const reviewId = randomUUID();
        this.review = { owner, reviewId, snapshot: structuredClone(snapshot), diagnostics, codes: warningCodes };
        return { status: "review", reviewId, snapshot: structuredClone(snapshot), diagnostics: structuredClone(diagnostics) };
      }
    } finally {
      if (this.active === owner) this.active = null;
    }
  }

  private fields(value: unknown, keys: string[]): value is Record<string, unknown> {
    return !!value && typeof value === "object" && !Array.isArray(value) &&
      Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
  }

  private selection(value: unknown): Selection {
    if (!this.fields(value, ["sessionId", "projectId", "snapshotId"]) ||
        Object.values(value).some((entry) => typeof entry !== "string" || !/^[\w.-]{1,128}$/u.test(entry)))
      throw new Error("Invalid immutable courseware selection");
    return { sessionId: value.sessionId as string, projectId: value.projectId as string, snapshotId: value.snapshotId as string };
  }

  private async assertOwner(owner: Owner): Promise<void> {
    owner.abort.signal.throwIfAborted();
    if (await this.getWorkspace() !== owner.workspace || this.getHost() !== owner.host ||
        this.getViewingSessionId() !== owner.selection.sessionId) throw new Error("Courseware build owner changed");
    owner.abort.signal.throwIfAborted();
  }
}
