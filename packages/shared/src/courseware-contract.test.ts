import { describe, expect, it } from "vitest";
import accepted from "./courseware-contract.fixtures/accepted.json";
import staleWrite from "./courseware-contract.fixtures/stale-write.json";
import references from "./courseware-contract.fixtures/references.json";
import teamImage from "./courseware-contract.fixtures/team-image.json";
import teamAudio from "./courseware-contract.fixtures/team-audio.json";
import {
  checkCoursewareCandidate, checkTeachingWrite, isCoursewareBuildRef, isCoursewareCandidate,
  isCoursewareProject, isCoursewareSnapshot, isCoursewareTaskRef, isTeachingWrite, isCoursewareTeamAssetRef, isCoursewareTeamProject,
} from "./courseware-contract.js";

function fixture(value: { project: unknown; write: unknown }) {
  if (!isCoursewareProject(value.project) || !isTeachingWrite(value.write)) throw new Error("Invalid contract fixture");
  return { project: value.project, write: value.write };
}

describe("courseware contract v1", () => {
  it("accepts actual C4 team metadata without granting membership or private-task access", () => {
    expect(isCoursewareTeamAssetRef(teamImage.data)).toBe(true);
    expect(isCoursewareTeamAssetRef(teamAudio.data)).toBe(true);
    for (const mime of ["image/png", "image/jpeg", "image/webp"]) {
      expect(isCoursewareTeamAssetRef({ ...teamImage.data, assetRef: { ...teamImage.data.assetRef, mime } })).toBe(true);
    }
    const { width, height, ...withoutDimensions } = teamImage.data.assetRef;
    expect(isCoursewareTeamAssetRef({ ...teamImage.data, assetRef: withoutDimensions })).toBe(true);
    expect(width).toBe(1); expect(height).toBe(1);
  });

  it("validates the authenticated team project listing without accepting forged fields", () => {
    const project = { projectId: "project-1", ownerUserId: 42, role: "EDITOR", createdAt: "2026-10-22T10:00:00Z" };
    expect(isCoursewareTeamProject(project)).toBe(true);
    for (const broken of [
      { ...project, role: "ADMIN" }, { ...project, ownerUserId: 0 },
      { ...project, createdAt: "not-a-date" }, { ...project, apiKey: "secret" },
    ]) expect(isCoursewareTeamProject(broken)).toBe(false);
  });

  it("rejects forged team routes, metadata, MIME and private fields", () => {
    const good = teamImage.data;
    for (const asset of [
      { ...good.assetRef, assetId: ".." }, { ...good.assetRef, sha256: "A".repeat(64) },
      { ...good.assetRef, mime: ["image/png"] }, { ...good.assetRef, mime: "image/svg+xml" },
      { ...good.assetRef, downloadPath: "https://outside.test/image" },
      { ...good.assetRef, downloadPath: good.assetRef.downloadPath + "?token=secret" },
      { ...good.assetRef, width: null }, { ...good.assetRef, width: 0 },
      { ...good.assetRef, height: 2147483648 }, { ...good.assetRef, durationMs: 100 },
      { ...good.assetRef, byteLength: 0 }, { ...good.assetRef, byteLength: 16777217 },
      { ...good.assetRef, model: "private" }, { ...good.assetRef, taskId: "private" },
    ]) expect(isCoursewareTeamAssetRef({ ...good, assetRef: asset })).toBe(false);
    expect(isCoursewareTeamAssetRef({ ...good, projectId: ".." })).toBe(false);
    expect(isCoursewareTeamAssetRef({ ...good, projectId: teamAudio.data.assetRef.assetId })).toBe(false);
    expect(isCoursewareTeamAssetRef({ ...good, tenantId: 1 })).toBe(false);
    expect(isCoursewareTeamAssetRef({ ...teamAudio.data, assetRef: { ...teamAudio.data.assetRef, width: 1 } })).toBe(false);
  });
  it("consumes the shared success and stale fixtures", () => {
    const good = fixture(accepted);
    const stale = fixture(staleWrite);
    expect(checkTeachingWrite(good.project, good.write)).toBe("accepted");
    expect(checkTeachingWrite(stale.project, stale.write)).toBe("stale");
  });

  it("protects manual locks, wrong identities and missing pages", () => {
    const { project, write } = fixture(accepted);
    expect(checkTeachingWrite(project, { ...write, pageId: "fixture-page-2" })).toBe("locked");
    expect(checkTeachingWrite(project, { ...write, projectId: "another-project" })).toBe("stale");
    expect(checkTeachingWrite(project, { ...write, pageId: "another-page" })).toBe("missing-page");
    expect(checkTeachingWrite(project, { ...write, expectedTeachingRevision: "T7" })).toBe("stale");
  });

  it("uses logical page identity through reordering", () => {
    const { project, write } = fixture(accepted);
    expect(checkTeachingWrite({ ...project, pages: [...project.pages].reverse() }, write)).toBe("accepted");
    expect(isCoursewareProject({ ...project, pages: [...project.pages, project.pages[0]] })).toBe(false);
  });

  it("rejects invalid schemas, unknown envelope fields, malformed actions and oversized records", () => {
    const { project, write } = fixture(accepted);
    for (const broken of [null, [], { ...project, schemaVersion: "unknown" }, { ...project, apiKey: "secret" },
      { ...project, pages: [] }, { ...project, source: { ...project.source, sha256: "invalid" } },
      { ...project, title: "x".repeat(501) }, { ...project, pages: [{ ...project.pages[0], actions: [{}] }] }]) {
      expect(isCoursewareProject(broken)).toBe(false);
    }
    expect(isTeachingWrite({ ...write, locked: false })).toBe(false);
    expect(isCoursewareProject({ ...project, taskType: ["scene"] })).toBe(false);
    expect(isCoursewareProject({ ...project, educationContext: { fullEnglishTeaching: "false" } })).toBe(false);
    expect(isCoursewareProject({ ...project, educationContext: { apiKey: "secret" } })).toBe(false);
    expect(isCoursewareProject({ ...project, educationContext: { visualStyle: "Matte clay 3D" } })).toBe(true);
    for (const visualStyle of [null, 3, "x".repeat(501), "🖌".repeat(251)])
      expect(isCoursewareProject({ ...project, educationContext: { visualStyle } })).toBe(false);
    expect(isCoursewareProject({ ...project, educationContext: { bodyPageLimit: 8 } })).toBe(true);
    for (const bodyPageLimit of [null, 0, 31, 1.5, "8"])
      expect(isCoursewareProject({ ...project, educationContext: { bodyPageLimit } })).toBe(false);
    expect(isTeachingWrite({ ...write, actions: [{ id: "a", type: "speech", text: "x".repeat(2 * 1024 * 1024) }] })).toBe(false);
  });

  it("validates candidate, snapshot and build references without authorizing them", () => {
    const { project } = fixture(accepted);
    const candidate = { candidateId: "candidate-1", projectId: project.projectId, source: project.source,
      teachingRevision: project.teachingRevision, targetPageIds: ["fixture-page-1"], outputSha256: project.source.sha256 };
    const snapshot = { snapshotId: "snapshot-1", projectId: project.projectId, source: project.source,
      teachingRevision: project.teachingRevision, mappingRevision: "M8", assetIds: ["voice-1"] };
    expect(isCoursewareCandidate(candidate)).toBe(true);
    expect(isCoursewareCandidate({ ...candidate, targetPageIds: ["fixture-page-1", "fixture-page-1"] })).toBe(false);
    expect(isCoursewareSnapshot(snapshot)).toBe(true);
    expect(isCoursewareSnapshot({ ...snapshot, assetIds: ["voice-1", "voice-1"] })).toBe(false);
    expect(isCoursewareBuildRef({ buildId: "build-1", snapshotId: snapshot.snapshotId, packageSha256: project.source.sha256 })).toBe(true);
    expect(isCoursewareBuildRef({ buildId: "build-1", snapshotId: snapshot.snapshotId, packageSha256: "bad" })).toBe(false);
    expect(isCoursewareCandidate(references.candidate)).toBe(true);
    expect(isCoursewareSnapshot(references.snapshot)).toBe(true);
    expect(isCoursewareBuildRef(references.build)).toBe(true);
    expect(isCoursewareTaskRef(references.task)).toBe(true);
    expect(isCoursewareTaskRef({ ...references.task, apiKey: "secret" })).toBe(false);
  });

  it("rejects adoption after source/teaching changes, missing targets, or unsaved Office edits", () => {
    const { project } = fixture(accepted);
    if (!isCoursewareCandidate(references.candidate)) throw new Error("Invalid candidate fixture");
    const candidate = references.candidate;
    expect(checkCoursewareCandidate(project, candidate, false)).toBe("accepted");
    expect(checkCoursewareCandidate(project, candidate, true)).toBe("editor-dirty");
    expect(checkCoursewareCandidate({ ...project, teachingRevision: "T9" }, candidate, false)).toBe("stale");
    expect(checkCoursewareCandidate({ ...project, source: { ...project.source, sha256: "a".repeat(64) } }, candidate, false)).toBe("stale");
    expect(checkCoursewareCandidate(project, { ...candidate, targetPageIds: ["missing"] }, false)).toBe("missing-page");
  });
});

describe('saved-source native animation nodes', () => {
  it('accepts source-bound steps in native order with speech and waits between them', () => {
    const { project, write } = fixture(accepted);
    const node = (stepIndex: number) => ({ id: `native-${stepIndex}`, type: 'native_animation', version: 1,
      sourceSha256: project.source.sha256, stepIndex });
    const actions = [node(0), ...write.actions, node(1)];
    const bound = { ...project, pages: [{ ...project.pages[0], actions }, ...project.pages.slice(1)] };
    expect(isCoursewareProject(bound)).toBe(true);
    expect(isTeachingWrite({ ...write, actions })).toBe(true);
    expect(checkTeachingWrite(project, { ...write, actions })).toBe('accepted');
    expect(checkTeachingWrite({ ...project, source: { ...project.source, sha256: 'f'.repeat(64) } }, { ...write, actions })).toBe('stale');
    for (const change of [{ version: 2 }, { stepIndex: -1 }, { stepIndex: .5 }, { stepIndex: 200 },
      { sourceSha256: null }, { sourceSha256: 'A'.repeat(64) }, { extra: true }, { id: '' }]) {
      expect(isTeachingWrite({ ...write, actions: [{ ...node(0), ...change }] })).toBe(false);
    }
    for (const sequence of [[node(1)], [node(0), { ...node(0), id: 'duplicate' }], [node(0), node(2)]])
      expect(isTeachingWrite({ ...write, actions: sequence })).toBe(false);
    const stale = { ...node(0), sourceSha256: 'f'.repeat(64) };
    expect(isCoursewareProject({ ...project, pages: [{ ...project.pages[0], actions: [stale] }] })).toBe(false);
  });
});
