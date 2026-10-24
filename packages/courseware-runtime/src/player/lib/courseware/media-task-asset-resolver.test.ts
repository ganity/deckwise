import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { expect, it, vi } from "vitest";
import ready from "../../tests/fixtures/fixed-playback/media-tasks/task-ready.json";
import queued from "../../tests/fixtures/fixed-playback/media-tasks/submit-success.json";
import unknown from "../../tests/fixtures/fixed-playback/media-tasks/task-submission-unknown.json";
import httpReady from "../../../../tests/fixtures/media-task-c1-http/task-ready.json";
import freshHttpReady from "../../../../tests/fixtures/media-task-c1-http/fresh-task-ready.json";
import httpSource from "../../../../tests/fixtures/media-task-c1-http/SOURCE.json";
import { createMediaTaskAssetResolver } from "./media-task-asset-resolver";
import {
  digestBytes,
  loadFixedBuild,
  type FixedAsset,
} from "./load-fixed-build";

const asset: FixedAsset = {
  id: ready.assetRef.assetId,
  sha256: ready.assetRef.sha256,
  mimeType: ready.assetRef.mime,
  path: `assets/${ready.assetRef.sha256}.wav`,
};
it("consumes unmodified C1 ready/queued/unknown fixtures with pinned hashes", async () => {
  const root = path.resolve("src/player/tests/fixtures/fixed-playback/media-tasks");
  const manifest = JSON.parse(
    readFileSync(path.join(root, "SOURCE.json"), "utf8"),
  );
  for (const [file, sha] of Object.entries(manifest.sourceHashes))
    expect(
      createHash("sha256")
        .update(readFileSync(path.join(root, file)))
        .digest("hex"),
    ).toBe(sha);
  const bytes = new Uint8Array(ready.assetRef.byteLength);
  const download = vi.fn(async () => bytes);
  const resolver = createMediaTaskAssetResolver([ready], download);
  const controller = new AbortController();
  expect(await resolver(asset, controller.signal)).toBe(bytes);
  expect(download).toHaveBeenCalledExactlyOnceWith(
    ready.taskId,
    controller.signal,
  );
  for (const task of [queued, unknown])
    expect(() => createMediaTaskAssetResolver([task], download)).toThrow(
      "MEDIA_TASK_NOT_READY",
    );
});
it.each([httpReady, freshHttpReady])(
  "resolves actual C HTTP task $taskId to its pinned PNG bytes",
  async (task) => {
    const root = path.resolve("tests/fixtures/media-task-c1-http");
    for (const [file, record] of Object.entries(httpSource.files)) {
      expect(createHash("sha256").update(readFileSync(path.join(root, file))).digest("hex"))
        .toBe(record.sha256);
    }
    const bytes = new Uint8Array(readFileSync(path.join(root, "asset.png")));
    const download = vi.fn(async () => bytes);
    const controller = new AbortController();
    const resolved = await createMediaTaskAssetResolver([task], download)({
      id: task.assetRef.assetId,
      sha256: task.assetRef.sha256,
      mimeType: task.assetRef.mime,
      path: `assets/${task.assetRef.sha256}.png`,
    }, controller.signal);
    expect(resolved.length).toBe(task.assetRef.byteLength);
    expect(await digestBytes(resolved)).toBe(task.assetRef.sha256);
    expect(download).toHaveBeenCalledExactlyOnceWith(task.taskId, controller.signal);
  },
);
it.each(["id", "hash", "mime"] as const)(
  "rejects a fixed asset's changed %s before download",
  async (kind) => {
    const download = vi.fn();
    const resolver = createMediaTaskAssetResolver([ready], download);
    const changed = { ...asset };
    if (kind === "id") changed.id = "different-asset";
    if (kind === "hash") changed.sha256 = "0".repeat(64);
    if (kind === "mime") changed.mimeType = "video/mp4";
    await expect(resolver(changed)).rejects.toThrow("MEDIA_ASSET_MISMATCH");
    expect(download).not.toHaveBeenCalled();
  },
);
it("refuses malformed, oversized, redirected or ambiguous references", () => {
  const download = vi.fn();
  for (const task of [
    { ...ready, version: "future" },
    {
      ...ready,
      assetRef: { ...ready.assetRef, byteLength: 16 * 1024 * 1024 + 1 },
    },
    {
      ...ready,
      assetRef: {
        ...ready.assetRef,
        downloadPath: "https://untrusted.invalid/asset",
      },
    },
    { ...ready, taskId: "../other" },
  ])
    expect(() => createMediaTaskAssetResolver([task], download)).toThrow(
      "MEDIA_TASK_INVALID",
    );
  for (const task of [
    ready,
    {
      ...ready,
      taskId: "task-2",
      assetRef: {
        ...ready.assetRef,
        downloadPath: "/courseware/media/tasks/task-2/asset",
      },
    },
  ])
    expect(() => createMediaTaskAssetResolver([ready, task], download)).toThrow(
      "MEDIA_TASK_AMBIGUOUS",
    );
  expect(download).not.toHaveBeenCalled();
});
it("captures reference values independently of later task response mutation", async () => {
  const task = structuredClone(ready);
  const download = vi.fn(async () => new Uint8Array(4));
  const resolver = createMediaTaskAssetResolver([task], download);
  task.taskId = "replaced";
  task.assetRef.sha256 = "0".repeat(64);
  await resolver(asset);
  expect(download).toHaveBeenCalledExactlyOnceWith(ready.taskId, undefined);
});
it("propagates access failures, length mismatch and cancellation without another request", async () => {
  const denied = new Error("403 forbidden");
  const download = vi.fn(async () => {
    throw denied;
  });
  const resolver = createMediaTaskAssetResolver([ready], download);
  await expect(resolver(asset)).rejects.toBe(denied);
  await expect(
    resolver(asset, AbortSignal.abort(new Error("closed"))),
  ).rejects.toThrow("closed");
  expect(download).toHaveBeenCalledTimes(1);
  await expect(
    createMediaTaskAssetResolver([ready], async () => new Uint8Array(3))(asset),
  ).rejects.toThrow("MEDIA_ASSET_LENGTH_MISMATCH");
  const controller = new AbortController();
  await expect(
    createMediaTaskAssetResolver([ready], async () => {
      controller.abort(new Error("selection changed"));
      return new Uint8Array(4);
    })(asset, controller.signal),
  ).rejects.toThrow("selection changed");
});
it("leaves final byte integrity enforcement to the fixed loader", async () => {
  const bytes = new Uint8Array(4);
  const resolver = createMediaTaskAssetResolver([ready], async () => bytes);
  const payload = {
    schemaVersion: "deckwise-playback/1",
    report: {
      ready: true,
      visualFidelity: "NOT_VERIFIED",
      reviewedWarningCodes: [],
      diagnostics: [],
      capabilities: {
        staticSlides: "limited",
        fixedNarration: true,
        teacherWait: true,
        transitions: false,
        objectAnimations: false,
        spotlight: false,
      },
      sourceSha256: "a".repeat(64),
      sourceRevision: "R8",
      teachingRevision: "T8",
      mappingRevision: "M8",
      converter: {
        version: "maic-pptx-import-ir/1",
        manifestSha256: "b".repeat(64),
      },
    },
    assets: [asset],
    pages: [
      {
        pageId: "page",
        title: "Fixed",
        slide: {
          id: "slide",
          viewportSize: 1000,
          viewportRatio: 0.5625,
          elements: [],
          theme: {},
          background: {},
        },
        objects: [],
        actions: [],
      },
    ],
  };
  const packageBytes = new TextEncoder().encode(JSON.stringify(payload));
  await expect(
    loadFixedBuild(packageBytes, await digestBytes(packageBytes), resolver),
  ).rejects.toThrow("ASSET_HASH_MISMATCH");
});
