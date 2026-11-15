// Only successful main-push CI for the exact release commit can replace verification.
async function reuseReleaseCi({ github, context, core }) {
  core.setOutput("reused", "false");
  const repo = context.repo;
  const fullName = `${repo.owner}/${repo.repo}`;
  try {
    const { data } = await github.rest.actions.listWorkflowRuns({
      ...repo, workflow_id: "ci.yml", head_sha: context.sha,
      branch: "main", event: "push", status: "success", per_page: 100,
    });
    for (const run of data.workflow_runs) {
      if (run.head_sha !== context.sha || run.head_branch !== "main" || run.event !== "push" ||
          run.status !== "completed" || run.conclusion !== "success" ||
          run.path !== ".github/workflows/ci.yml" ||
          run.repository?.full_name !== fullName || run.head_repository?.full_name !== fullName) continue;
      const jobs = await github.paginate(github.rest.actions.listJobsForWorkflowRun, {
        ...repo, run_id: run.id, filter: "latest", per_page: 100,
      });
      if (!["JS build / typecheck / lint / architecture / test", "Rust host-core format / lint / test", "Windows paired courseware integration"]
        .every(name => jobs.some(job => job.name === name && job.status === "completed" && job.conclusion === "success"))) continue;
      await core.summary.addRaw(`Reused successful main CI for ${context.sha}: ${run.html_url}\n`).write();
      core.setOutput("reused", "true");
      return;
    }
    core.info("No successful main CI for this exact commit; running full release verification.");
  } catch (error) {
    core.warning(`CI evidence lookup unavailable (HTTP ${error.status ?? "unknown"}); running full release verification.`);
  }
}
module.exports = { reuseReleaseCi };
