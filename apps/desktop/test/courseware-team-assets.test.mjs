import assert from "node:assert/strict";
import test from "node:test";
import { loadCoursewareMedia } from "./fixtures/courseware-media-loader.mjs";
import { createHash } from "node:crypto";
import { crc32 } from "node:zlib";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { once } from "node:events";
import ts from "typescript";
import * as shared from "../../../packages/shared/dist/index.js";

const electron = process.env.DECKWISE_E2E_ELECTRON_NET === "1" ? (await import("electron")).default : null;
const scenes = electron ? await import("./courseware-scene-completion.electron.mjs") : null;
const transportFetch = electron?.net.fetch ?? fetch;
const image = JSON.parse(
  await fs.readFile(
    new URL("../../../packages/shared/src/courseware-contract.fixtures/team-image.json", import.meta.url),
    "utf8",
  ),
).data;
const audio = JSON.parse(
  await fs.readFile(
    new URL("../../../packages/shared/src/courseware-contract.fixtures/team-audio.json", import.meta.url),
    "utf8",
  ),
).data;
const png = await fs.readFile(new URL("fixtures/courseware-team-image.png", import.meta.url));
const wav = await fs.readFile(new URL("fixtures/courseware-team-audio.wav", import.meta.url));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
// C4's retained PNG has invalid IDAT CRC. Preserve it as a codec negative.
const validPng = electron?.nativeImage
  .createFromBitmap(Buffer.from([0, 0, 255, 255]), { width: 1, height: 1 })
  .toPNG();
const validImage = structuredClone(image);
if (validPng) {
  Object.assign(validImage.assetRef, {
    assetId: "11111111-1111-4111-8111-111111111111",
    sha256: sha(validPng),
    byteLength: validPng.length,
  });
  validImage.assetRef.downloadPath = `/courseware/team/projects/${validImage.projectId}/assets/${validImage.assetRef.assetId}/content`;
}
const json = (data, code = 200) =>
  new Response(JSON.stringify({ code, data, message: "Do not expose remote details" }), {
    headers: { "content-type": "application/json" },
  });
async function load(name, dependencies) {
  const source = await fs.readFile(new URL(`../electron/main/${name}.ts`, import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  });
  const exports = {};
  new Function("require", "exports", outputText)((id) => {
    if (!Object.hasOwn(dependencies, id)) throw new Error(`Unexpected dependency ${id}`);
    return dependencies[id];
  }, exports);
  return exports;
}
const media = await loadCoursewareMedia();
const sceneContext = electron
  ? await load("courseware-scene-context", { electron, "node:crypto": crypto, "node:zlib": { crc32 } })
  : null;
const resolver = electron
  ? await load("courseware-team-images", {
      "@pi-desktop/shared": shared,
      "./courseware-scene-context": sceneContext,
    })
  : null;
function setup(
  fetcher = async (url) =>
    url.endsWith("/content") ? new Response(png, { headers: { "content-type": "image/png" } }) : json(image),
) {
  const calls = [];
  let principal = {},
    tokens = 0;
  const client = new media.CoursewareMediaClient({
    baseUrl: "https://platform.test/api/backend",
    getPrincipal: () => principal,
    resolveAccessToken: async () => `team-token-${++tokens}`,
    fetch: async (url, init) => {
      calls.push({ url, init });
      return fetcher(url, init);
    },
  });
  return {
    client,
    calls,
    changePrincipal: (value) => {
      principal = value;
    },
  };
}

test("canonical C4 image/audio references and actual retained bytes match", () => {
  for (const [ref, bytes] of [
    [image, png],
    [audio, wav],
  ]) {
    assert(shared.isCoursewareTeamAssetRef(ref));
    assert.equal(sha(bytes), ref.assetRef.sha256);
    assert.equal(bytes.length, ref.assetRef.byteLength);
  }
});

test("team reads use current tokens and exact GET routes without sharing, generation or cache", async () => {
  const f = setup();
  const ref = structuredClone(image);
  const pending = f.client.downloadTeamAsset(ref);
  ref.assetRef.sha256 = "f".repeat(64);
  const result = await pending;
  assert.deepEqual(result.reference, image);
  assert.deepEqual(result.bytes, png);
  await f.client.downloadTeamAsset(image);
  assert.equal(f.calls.length, 4);
  for (const [i, { url, init }] of f.calls.entries()) {
    assert.equal(
      url,
      `https://platform.test/api/backend${image.assetRef.downloadPath.replace(/\/content$/u, i % 2 ? "/content" : "")}`,
    );
    assert.equal(init.method ?? "GET", "GET");
    assert.equal(init.body, undefined);
    assert(init.headers.get("Accept").includes("application/json"));
    if (i % 2) assert(init.headers.get("Accept").includes("image/png"));
    assert.equal(init.headers.get("Authorization"), `Bearer team-token-${i + 1}`);
    assert.equal(init.redirect, "error");
    assert.equal(init.credentials, "omit");
    assert.equal(init.cache, "no-store");
  }
  assert(!JSON.stringify(result.reference).includes("team-token"));
  const a = setup(async (url) =>
    url.endsWith("/content") ? new Response(wav, { headers: { "content-type": "audio/wav" } }) : json(audio),
  );
  assert.deepEqual((await a.client.downloadTeamAsset(audio)).bytes, wav);
});

test("forged team references reject before any network access", async () => {
  const f = setup();
  for (const ref of [
    null,
    { ...image, projectId: ".." },
    { ...image, projectId: "foreign" },
    { ...image, tenantId: 1 },
    { ...image, assetRef: { ...image.assetRef, downloadPath: "https://outside.test/content" } },
    {
      ...image,
      assetRef: { ...image.assetRef, downloadPath: image.assetRef.downloadPath + "?token=secret" },
    },
    { ...image, assetRef: { ...image.assetRef, mime: ["image/png"] } },
    { ...image, assetRef: { ...image.assetRef, byteLength: 16777217 } },
    { ...image, assetRef: { ...image.assetRef, assetId: "../content" } },
    { ...image, assetRef: { ...image.assetRef, taskId: "private" } },
  ]) {
    await assert.rejects(f.client.downloadTeamAsset(ref), /INVALID_TEAM_ASSET_REF/);
  }
  assert.equal(f.calls.length, 0);
});

test("fresh metadata cannot silently replace immutable pins or leak private task fields", async () => {
  for (const mutation of ["project", "id", "hash", "mime", "length", "width", "missing", "private"]) {
    const altered = structuredClone(image);
    if (mutation === "project") altered.projectId = audio.assetRef.assetId;
    if (mutation === "id") altered.assetRef.assetId = audio.assetRef.assetId;
    if (mutation === "hash") altered.assetRef.sha256 = "f".repeat(64);
    if (mutation === "mime") altered.assetRef.mime = "image/webp";
    if (mutation === "length") altered.assetRef.byteLength++;
    if (mutation === "width") altered.assetRef.width++;
    if (mutation === "missing") delete altered.assetRef.width;
    if (mutation === "private") altered.assetRef.model = "private";
    const f = setup(async () => json(altered));
    await assert.rejects(f.client.downloadTeamAsset(image), /INTEGRITY_ERROR/, mutation);
    assert.equal(f.calls.length, 1);
  }
});

test("corrupt, wrong-MIME, oversized and business-error content fails without retry", async () => {
  for (const mode of ["hash", "mime", "length", "overflow", "business", "metadata-size"]) {
    const f = setup(async (url) => {
      if (!url.endsWith("/content"))
        return mode === "metadata-size"
          ? new Response("x".repeat(65537), { headers: { "content-type": "application/json" } })
          : json(image);
      if (mode === "business") return json(null, 46902);
      if (mode === "overflow")
        return new Response(new Uint8Array(16777217), { headers: { "content-type": "image/png" } });
      const bytes = Buffer.from(png);
      if (mode === "hash") bytes[bytes.length - 1] ^= 1;
      return new Response(mode === "length" ? bytes.subarray(1) : bytes, {
        headers: { "content-type": mode === "mime" ? "text/html" : "image/png" },
      });
    });
    await assert.rejects(
      f.client.downloadTeamAsset(image),
      /INTEGRITY_ERROR|RESPONSE_TOO_LARGE|PLATFORM_46902/,
      mode,
    );
    assert.equal(f.calls.length, mode === "metadata-size" ? 1 : 2);
  }
  for (const code of [46100, 46102, 46901, 46902]) {
    const f = setup(async () => json(null, code));
    await assert.rejects(f.client.downloadTeamAsset(image), new RegExp(`PLATFORM_${code}$`));
    assert.equal(f.calls.length, 1);
  }
});

test("account changes and cancellation fence metadata, streamed bodies and absent login", async () => {
  const absent = setup();
  absent.changePrincipal(null);
  await assert.rejects(absent.client.downloadTeamAsset(image), /AUTH_REQUIRED/);
  assert.equal(absent.calls.length, 0);
  for (const phase of ["metadata", "body"]) {
    let f;
    f = setup(async (url) => {
      if (!url.endsWith("/content")) {
        if (phase === "metadata") f.changePrincipal({});
        return json(image);
      }
      return new Response(
        new ReadableStream({
          pull(controller) {
            f.changePrincipal({});
            controller.enqueue(png);
            controller.close();
          },
        }),
        { headers: { "content-type": "image/png" } },
      );
    });
    await assert.rejects(f.client.downloadTeamAsset(image), /AUTH_CHANGED/);
  }
  const untouched = setup();
  await assert.rejects(untouched.client.downloadTeamAsset(image, AbortSignal.abort()));
  assert.equal(untouched.calls.length, 0);
  const controller = new AbortController();
  const f = setup(async () => {
    controller.abort();
    return json(image);
  });
  await assert.rejects(f.client.downloadTeamAsset(image, controller.signal));
  assert.equal(f.calls.length, 1);
});

test("real HTTP redirect never forwards team credentials to another endpoint", async (t) => {
  let hits = 0;
  const server = createServer((req, res) => {
    hits++;
    res.writeHead(302, { location: "/sink" });
    res.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const principal = {};
  const client = new media.CoursewareMediaClient({
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    fetch: transportFetch,
    getPrincipal: () => principal,
    resolveAccessToken: async () => "local-team-token",
  });
  await assert.rejects(client.downloadTeamAsset(image), /TRANSPORT_FAILED/);
  assert.equal(hits, 1);
});

test("actual DesktopAuthSession reads team PNGs, rechecks revocation and rejects results after logout", async (t) => {
  try {
    const root = await fs.mkdtemp(path.join(tmpdir(), "deckwise-team-auth-"));
    const calls = [];
    let revoked = false;
    const token = `header.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.signature`;
    const basePath = image.assetRef.downloadPath.replace(/\/content$/u, "");
    const server = createServer((req, res) => {
      calls.push({ path: req.url, method: req.method });
      const send = (data, code = 200) => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ code, data }));
      };
      if (req.url.startsWith("/auth/desktop/wx/qrcode"))
        return send({ ticket: "team-ticket", entryUrl: "https://fixture.test/qr" });
      if (req.url === "/auth/wx/poll/team-ticket")
        return send({ status: "SUCCESS", accessToken: token, refreshToken: "local-team-refresh" });
      if (req.url === "/auth/me")
        return send({ edition: "EDUCATION", pcAllowed: true, role: "ADMIN", userId: 7, tenantId: 8 });
      if (req.url === "/auth/logout") return send({});
      assert.equal(req.headers.authorization, `Bearer ${token}`);
      if (revoked) return send(null, 46100);
      if (electron && req.url === validImage.assetRef.downloadPath.replace(/\/content$/u, ""))
        return send(validImage);
      if (electron && req.url === validImage.assetRef.downloadPath) {
        res.setHeader("content-type", "image/png");
        return res.end(validPng);
      }
      if (req.url === basePath) return send(image);
      if (req.url === image.assetRef.downloadPath) {
        res.setHeader("content-type", "image/png");
        return res.end(png);
      }
      res.writeHead(404);
      res.end();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const before = process.env.DECKWISE_PLATFORM_BASE_URL;
    process.env.DECKWISE_PLATFORM_BASE_URL = `http://127.0.0.1:${server.address().port}`;
    const { DesktopAuthSession } = await load("auth-session", {
      "node:crypto": crypto,
      "node:fs/promises": fs,
      "node:os": { homedir: () => root },
      "node:path": path,
      electron: { net: { fetch: transportFetch } },
      "@pi-desktop/shared": shared,
      "./courseware-media": media,
      "./courseware-team-images": resolver,
    });
    const auth = new DesktopAuthSession({ dataDir: root, onChanged() {}, log() {} });
    t.after(async () => {
      await auth.logout();
      server.closeAllConnections();
      server.close();
      await fs.rm(root, { recursive: true, force: true });
      if (before === undefined) delete process.env.DECKWISE_PLATFORM_BASE_URL;
      else process.env.DECKWISE_PLATFORM_BASE_URL = before;
    });
    await auth.startQrLogin();
    await auth.pollQrLogin("team-ticket");
    const principal = auth.getCoursewarePrincipal();
    assert.deepEqual((await auth.coursewareMedia.downloadTeamAsset(image)).bytes, png);
    const beforeInvalid = calls.length;
    await assert.rejects(auth.resolveTeamSceneImages([{}]), /INVALID_SCENE_ASSETS/);
    assert.equal(calls.length, beforeInvalid);
    if (resolver) {
      await assert.rejects(auth.resolveTeamSceneImages([image]), /COURSEWARE_SCENE_INVALID_INPUT/);
      const mutable = structuredClone(validImage);
      const pendingImages = auth.resolveTeamSceneImages([mutable]);
      mutable.assetRef.sha256 = "f".repeat(64);
      const images = await pendingImages;
      assert.equal(images[0].sha256, validImage.assetRef.sha256);
      await scenes.withModel(async (f) => {
        await f.services.completeScene({
          sessionId: "chat-1",
          modelKey: `${f.session.providerId}/${f.session.modelId}`,
          thinkingLevel: "off",
          images,
          system: "Use the supplied team image as data",
          data: "Current page only",
        });
        const sent = f.requests[0].body.messages
          .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
          .find((part) => part.type === "image_url");
        assert.equal(sent.image_url.url, `data:image/png;base64,${validPng.toString("base64")}`);
      });
    }
    revoked = true;
    const count = calls.length;
    await assert.rejects(auth.coursewareMedia.downloadTeamAsset(image), /PLATFORM_46100/);
    assert.equal(calls.length, count + 1);
    assert(
      calls.filter((call) => call.path.startsWith("/courseware/")).every((call) => call.method === "GET"),
    );
    await auth.logout();
    assert.throws(() => principal.assertCurrent(), /AUTH_CHANGED/);
    await assert.rejects(auth.resolveTeamSceneImages([image]), /AUTH_REQUIRED/);
    await assert.rejects(auth.coursewareMedia.downloadTeamAsset(image), /AUTH_REQUIRED/);
  } catch (error) {
    console.error(error);
    throw error;
  }
});

test("Electron team PNG resolution pins batches, decodes real bytes and fences account changes", {
  skip: !electron,
}, async () => {
  try {
    const retainedPng = await fs.readFile(new URL("fixtures/courseware-team-image.png", import.meta.url));
    assert(
      electron.nativeImage.createFromBuffer(retainedPng).isEmpty(),
      "original retained C4 PNG must remain a negative",
    );
    const repairedForDiagnosis = Buffer.from(retainedPng);
    repairedForDiagnosis.writeUInt32BE(crc32(retainedPng.subarray(37, 52)), 52);
    assert(
      !electron.nativeImage.createFromBuffer(repairedForDiagnosis).isEmpty(),
      "changing only the IDAT CRC isolates the decoder failure",
    );
    assert.notEqual(
      sha(repairedForDiagnosis),
      sha(retainedPng),
      "CRC repair changes the authorized hash and cannot be silently adopted",
    );
    const image = validImage,
      png = validPng;
    const principal = { assertCurrent() {} };
    const other = structuredClone(image);
    other.assetRef.assetId = audio.assetRef.assetId;
    other.assetRef.downloadPath = `/courseware/team/projects/${other.projectId}/assets/${other.assetRef.assetId}/content`;
    const f = setup(async (url) =>
      url.endsWith("/content")
        ? new Response(png, { headers: { "content-type": "image/png" } })
        : json(url.includes(other.assetRef.assetId) ? other : image),
    );
    const references = [structuredClone(image), other];
    const pending = resolver.resolveCoursewareTeamPngs({ references, media: f.client, principal });
    references[0].assetRef.sha256 = "f".repeat(64);
    const images = await pending;
    assert.equal(images.length, 1);
    assert.deepEqual(images[0].assetIds, [image.assetRef.assetId, other.assetRef.assetId]);
    assert.deepEqual(images[0].bytes, png);
    assert.equal(f.calls.length, 4, "same bytes in another asset still need their own membership reads");
    const tooManyBytes = Array.from({ length: 6 }, (_, i) => {
      const ref = structuredClone(image);
      ref.assetRef.assetId = `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
      Object.assign(ref.assetRef, {
        byteLength: 7 * 1024 * 1024,
        sha256: String(i).repeat(64),
        downloadPath: `/courseware/team/projects/${ref.projectId}/assets/${ref.assetRef.assetId}/content`,
      });
      return ref;
    });
    for (const refs of [
      tooManyBytes,
      [],
      [image, image],
      [audio],
      Array.from({ length: 203 }, () => image),
      [{ ...image, assetRef: { ...image.assetRef, byteLength: 8388609 } }],
      [{ ...image, assetRef: { ...image.assetRef, width: 4097 } }],
    ]) {
      const untouched = setup();
      await assert.rejects(
        resolver.resolveCoursewareTeamPngs({ references: refs, media: untouched.client, principal }),
        /INVALID_SCENE_ASSETS/,
      );
      assert.equal(untouched.calls.length, 0);
    }
    for (const mode of ["decoder", "size", "account", "cancel"]) {
      const bad = structuredClone(image),
        bytes = Buffer.from(png);
      let current = true;
      const controller = new AbortController();
      if (mode === "decoder") {
        bytes.fill(0, 41, bytes.length - 12);
        bad.assetRef.sha256 = sha(bytes);
      }
      if (mode === "size") bad.assetRef.width = 2;
      const client = setup(async (url) => {
        if (!url.endsWith("/content")) return json(bad);
        if (mode === "account") current = false;
        if (mode === "cancel") controller.abort();
        return new Response(bytes, { headers: { "content-type": "image/png" } });
      }).client;
      await assert.rejects(
        resolver.resolveCoursewareTeamPngs({
          references: [bad],
          media: client,
          signal: controller.signal,
          principal: {
            assertCurrent() {
              if (!current) throw new Error("Account changed");
            },
          },
        }),
      );
    }
    const noDimensions = structuredClone(image);
    delete noDimensions.assetRef.width;
    delete noDimensions.assetRef.height;
    const missing = setup(async (url) =>
      url.endsWith("/content")
        ? new Response(png, { headers: { "content-type": "image/png" } })
        : json(noDimensions),
    );
    const decoded = await resolver.resolveCoursewareTeamPngs({
      references: [noDimensions],
      media: missing.client,
      principal,
    });
    assert.equal(decoded[0].width, 1);
    assert.equal(decoded[0].height, 1);
  } catch (error) {
    console.error(error);
    throw error;
  }
});
