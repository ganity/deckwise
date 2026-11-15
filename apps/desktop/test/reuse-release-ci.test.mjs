import assert from "node:assert/strict";
import test from "node:test";
import { reuseReleaseCi } from "../../../scripts/reuse-release-ci.cjs";

const sha = "a".repeat(40);
const validRun = { id: 12, head_sha: sha, head_branch: "main", event: "push", status: "completed", conclusion: "success",
  path: ".github/workflows/ci.yml", repository: { full_name: "ganity/deckwise" }, head_repository: { full_name: "ganity/deckwise" }, html_url: "https://github.com/ganity/deckwise/actions/runs/12" };
const validJobs = ["JS build / typecheck / lint / architecture / test", "Rust host-core format / lint / test", "Windows paired courseware integration"]
  .map(name => ({ name, status: "completed", conclusion: "success" }));
async function check(runs = [validRun], jobs = validJobs, failure) {
  const outputs = [], summaries = [], messages = [];
  const listJobsForWorkflowRun = () => {};
  await reuseReleaseCi({
    context: { repo: { owner: "ganity", repo: "deckwise" }, sha },
    github: { rest: { actions: { async listWorkflowRuns(params) {
      assert.equal(params.workflow_id, "ci.yml"); assert.equal(params.head_sha, sha);
      assert.equal(params.event, "push"); assert.equal(params.branch, "main");
      if (failure) throw failure;
      return { data: { workflow_runs: runs } };
    }, listJobsForWorkflowRun } }, async paginate(method, params) {
      assert.equal(method, listJobsForWorkflowRun); assert.equal(params.run_id, 12); assert.equal(params.filter, "latest"); return jobs;
    } },
    core: { setOutput: (key, value) => outputs.push([key, value]), info: value => messages.push(value), warning: value => messages.push(value),
      summary: { addRaw(value) { summaries.push(value); return this; }, async write() {} } },
  });
  return { reused: outputs.at(-1)[1], summaries, messages };
}
test("a successful exact-commit main CI reuses both validated jobs and records evidence", async () => {
  const result = await check(); assert.equal(result.reused, "true"); assert.match(result.summaries[0], /actions\/runs\/12/);
});
for (const [name, overrides] of [
  ["different commit", { head_sha: "b".repeat(40) }], ["PR result", { event: "pull_request" }],
  ["manual result", { event: "workflow_dispatch" }], ["other branch", { head_branch: "feature" }],
  ["failed result", { conclusion: "failure" }], ["unfinished result", { status: "in_progress" }],
  ["other workflow", { path: ".github/workflows/docs-check.yml" }],
  ["other repository", { repository: { full_name: "another/deckwise" } }],
  ["fork commit", { head_repository: { full_name: "another/deckwise" } }],
]) test(`${name} cannot bypass release verification`, async () => {
  assert.equal((await check([{ ...validRun, ...overrides }])).reused, "false");
});
for (const conclusion of ["skipped", "cancelled", "failure"]) test(`${conclusion} Rust job cannot be reused`, async () => {
  assert.equal((await check([validRun], [validJobs[0], { ...validJobs[1], conclusion }])).reused, "false");
});
test("missing jobs, missing runs and unavailable evidence retain full verification", async () => {
  assert.equal((await check([validRun], validJobs.slice(0, 1))).reused, "false");
  assert.equal((await check([])).reused, "false");
  const result = await check([], [], { status: 403 }); assert.equal(result.reused, "false"); assert.match(result.messages[0], /running full release verification/);
});
