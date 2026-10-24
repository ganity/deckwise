import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import fixture from "../../../../tests/fixtures/team-fixed-files-c2b/fixed-playback.json";
import source from "../../../../tests/fixtures/team-fixed-files-c2b/SOURCE.json";
import { loadTeamFixedBuild } from "./load-team-fixed-build";

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function setup() {
  const selected = structuredClone(fixture.data.fixedBuild);
  for (const entry of selected.files) entry.downloadUrl = "";
  const { buildId, snapshotId, packageSha256 } = fixture.data.pointer;
  const expected = { buildId, snapshotId, packageSha256 };
  const bytes = new Map(selected.files.map(item => [item.file.path, new Uint8Array(readFileSync(path.join(source.buildDirectory, item.file.path)))]));
  const download = vi.fn(async (p: string, signal?: AbortSignal) => { signal?.throwIfAborted(); return bytes.get(p)!; });
  const replace = (name: string, value: unknown) => {
    const data = new TextEncoder().encode(JSON.stringify(value));
    bytes.set(name, data);
    const file = selected.files.find(f => f.file.path === name)!.file;
    file.sha256 = sha(data); file.byteLength = data.length;
    return file.sha256;
  };
  const reindex = () => {
    const manifest = JSON.parse(new TextDecoder().decode(bytes.get("manifest.json")));
    manifest.files = selected.files.filter(f => f.file.path !== "manifest.json").map(f => ({ path: f.file.path, sha256: f.file.sha256 }));
    selected.manifestSha256 = replace("manifest.json", manifest);
  };
  return { selected, expected, bytes, download, replace, reindex };
}
it("consumes the exact pinned C2b response and all nine unchanged D builder files", async () => {
  expect(sha(readFileSync("tests/fixtures/team-fixed-files-c2b/fixed-playback.json"))).toBe(source.files["fixed-playback.json"].sha256);
  const s = setup(), controller = new AbortController();
  const revoke = vi.spyOn(URL, "revokeObjectURL");
  const loaded = await loadTeamFixedBuild(s.selected, s.expected, s.download, controller.signal);
  expect(loaded.buildId).toBe(s.expected.buildId); expect(loaded.scenes).toHaveLength(3);
  expect(s.download.mock.calls.map(c => c[0]).sort()).toEqual([...s.bytes.keys()].sort());
  expect(s.download.mock.calls.every(c => c[1] === controller.signal)).toBe(true);
  loaded.dispose(); expect(revoke).toHaveBeenCalledTimes(5); revoke.mockRestore();
});
it.each(["buildId", "snapshotId", "packageSha256"] as const)("rejects a stale selected %s before retrieval", async key => {
  const s = setup(); s.selected.build[key] = key === "snapshotId" ? "another-snapshot" : "0".repeat(64);
  await expect(loadTeamFixedBuild(s.selected, s.expected, s.download)).rejects.toThrow("TEAM_SELECTION_MISMATCH");
  expect(s.download).not.toHaveBeenCalled();
});
it.each(["unsafe", "duplicate", "missing", "budget", "mime", "manifestHash"])("rejects %s transport metadata before retrieval", async kind => {
  const s = setup();
  if (kind === "unsafe") s.selected.files[0].file.path = "../secret";
  if (kind === "duplicate") s.selected.files.push(s.selected.files[0]);
  if (kind === "missing") s.selected.files = s.selected.files.filter(f => f.file.path !== "source.pptx");
  if (kind === "budget") s.selected.files[0].file.byteLength = 256 * 1024 * 1024 + 1;
  if (kind === "mime") s.selected.files.find(f => f.file.path === "source.pptx")!.file.mimeType = "application/json";
  if (kind === "manifestHash") s.selected.manifestSha256 = "0".repeat(64);
  await expect(loadTeamFixedBuild(s.selected, s.expected, s.download)).rejects.toThrow(/TEAM_/);
  expect(s.download).not.toHaveBeenCalled();
});
it.each(["duplicate", "hash", "missing", "build"])("rejects %s in the verified manifest", async kind => {
  const s = setup(), manifest = JSON.parse(new TextDecoder().decode(s.bytes.get("manifest.json")));
  if (kind === "duplicate") manifest.files.push(manifest.files[0]);
  if (kind === "hash") manifest.files[0].sha256 = "0".repeat(64);
  if (kind === "missing") manifest.files.pop();
  if (kind === "build") manifest.buildId = "0".repeat(64);
  s.selected.manifestSha256 = s.replace("manifest.json", manifest);
  await expect(loadTeamFixedBuild(s.selected, s.expected, s.download)).rejects.toThrow(/TEAM_(MANIFEST|SELECTION)/);
  expect(s.download.mock.calls.map(c => c[0])).toEqual(["manifest.json"]);
});
it.each(["length", "hash", "missing", "denied"])("propagates %s file failure without publishing media URLs", async kind => {
  const s = setup(), create = vi.spyOn(URL, "createObjectURL");
  s.download.mockImplementation(async p => {
    if (p !== "package.json") return s.bytes.get(p)!;
    if (kind === "denied") throw new Error("401 expired session");
    if (kind === "missing") throw new Error("404 missing immutable file");
    const bytes = s.bytes.get(p)!.slice();
    if (kind === "length") return bytes.slice(1);
    bytes[0] ^= 1; return bytes;
  });
  await expect(loadTeamFixedBuild(s.selected, s.expected, s.download)).rejects.toThrow(/TEAM_FILE_|401|404/);
  expect(create).not.toHaveBeenCalled(); create.mockRestore();
});
it.each(["source", "report", "asset", "extra"])("rejects internally rehashed %s mismatches", async kind => {
  const s = setup();
  if (kind === "source") { const b=s.bytes.get("source.pptx")!.slice(); b[0]^=1;s.bytes.set("source.pptx",b);s.selected.files.find(f=>f.file.path==="source.pptx")!.file.sha256=sha(b); }
  if (kind === "report") { const r=JSON.parse(new TextDecoder().decode(s.bytes.get("report.json")));r.sourceRevision="other";s.replace("report.json",r); }
  if (kind === "asset") s.selected.files[0].file.mimeType="video/mp4";
  if (kind === "extra") s.selected.files.push({file:{path:`assets/${"0".repeat(64)}.wav`,sha256:"0".repeat(64),mimeType:"audio/wav",byteLength:0},downloadUrl:"ignored"});
  s.reindex();
  await expect(loadTeamFixedBuild(s.selected,s.expected,s.download)).rejects.toThrow(/TEAM_(SOURCE|REPORT|ASSET|FILE_SET)_MISMATCH|TEAM_FILE_SET_INVALID/);
});
it("forwards cancellation before and during retrieval without retaining URLs", async () => {
  const s=setup(),reason=new Error("selection closed"),controller=new AbortController();
  await expect(loadTeamFixedBuild(s.selected,s.expected,s.download,AbortSignal.abort(reason))).rejects.toBe(reason);
  expect(s.download).not.toHaveBeenCalled();
  s.download.mockImplementation(async p=>{controller.abort(reason);return s.bytes.get(p)!;});
  await expect(loadTeamFixedBuild(s.selected,s.expected,s.download,controller.signal)).rejects.toBe(reason);
  expect(s.download).toHaveBeenCalledTimes(1);
});
it("captures metadata before asynchronous retrieval and ignores expired signed URL strings", async () => {
  const s=setup();
  const download=async(p:string)=>{s.selected.files[0].file.path="../changed";s.expected.buildId="0".repeat(64);return s.bytes.get(p)!;};
  const loaded=await loadTeamFixedBuild(s.selected,s.expected,download);
  expect(loaded.buildId).toBe(fixture.data.pointer.buildId);loaded.dispose();
});
it("retains the actual loader's action/schema rejection after transport checks", async () => {
  const s=setup(),payload=JSON.parse(new TextDecoder().decode(s.bytes.get("package.json")));
  payload.pages[0].actions[0].type="unknown";
  const id=s.replace("package.json",payload);s.selected.build.buildId=id;s.selected.build.packageSha256=id;s.expected.buildId=id;s.expected.packageSha256=id;
  s.reindex();const manifest=JSON.parse(new TextDecoder().decode(s.bytes.get("manifest.json")));manifest.buildId=id;manifest.packageHash=id;s.selected.manifestSha256=s.replace("manifest.json",manifest);
  await expect(loadTeamFixedBuild(s.selected,s.expected,s.download)).rejects.toThrow("PACKAGE_SCHEMA_INVALID");
});
