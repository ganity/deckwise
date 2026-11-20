//! Host-owned temporary PPTX parsing jobs. Adoption into a project is separate.
use anyhow::{anyhow, bail, Result};
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::Command;
use tokio::sync::watch;
use tokio::task::JoinHandle;

mod classroom_source;
pub mod identity;
mod narration;
mod online_source_review;
#[cfg(target_os = "linux")]
pub mod project_commit;
pub use online_source_review::{
    ResolveRequest as OnlineSourceResolveRequest, Target as OnlineSourceReviewTarget,
};
mod process;
pub mod snapshot_assets;
pub mod source_candidates;

#[derive(Debug)]
pub struct SavedProjectSeed {
    pub project_id: String,
    pub sha256: String,
    pub pages: usize,
    pub identity: Option<identity::SavedSourceIdentity>,
}

const MAX_INPUT_BYTES: u64 = 50 * 1024 * 1024;
const MAX_PAGES: usize = 100;

#[derive(Clone, Copy)]
struct WorkerLimits {
    timeout: Duration,
    rss_bytes: u64,
    output_bytes: u64,
}

// Local pilot policy; whole-application and minimum-machine acceptance is separate.
const WORKER_LIMITS: WorkerLimits = WorkerLimits {
    timeout: Duration::from_secs(90),
    rss_bytes: 1024 * 1024 * 1024,
    output_bytes: 256 * 1024 * 1024,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StartParams {
    pub path: String,
    pub session_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct JobParams {
    pub job_id: String,
}

struct Job {
    id: String,
    portable_project: Option<(String, PathBuf)>,
    workspace: PathBuf,
    input: PathBuf,
    directory: PathBuf,
    state: Arc<Mutex<Value>>,
    cancel: watch::Sender<bool>,
    task: JoinHandle<()>,
}

struct Source {
    file: std::fs::File,
    name: std::ffi::OsString,
}

#[derive(Default)]
pub struct Parser {
    job: Option<Job>,
    online_review: online_source_review::ReviewCache,
}

impl Parser {
    pub fn start(&mut self, data_dir: &Path, workspace: &Path, input: &str) -> Result<Value> {
        if self.job.is_some() {
            bail!("Release the existing courseware job before starting another");
        }
        let project_workspace = workspace.canonicalize()?;
        if !cfg!(target_os = "linux") || !cfg!(target_arch = "x86_64") {
            bail!("PPTX worker is currently verified only on Linux x64");
        }
        let node = configured_file("DECKWISE_PPTX_NODE")?;
        let worker = configured_file("DECKWISE_PPTX_WORKER")?;
        let input = crate::workspace::resolve_in_workspace(workspace, input)
            .map_err(|error| anyhow!(error))?;
        let metadata = std::fs::metadata(&input)?;
        if !metadata.is_file()
            || metadata.len() > MAX_INPUT_BYTES
            || !input
                .extension()
                .is_some_and(|ext| ext.eq_ignore_ascii_case("pptx"))
        {
            bail!("A regular PPTX file within the input limit is required");
        }
        let source = open_source(workspace, &input)?;
        let id = uuid::Uuid::new_v4().to_string();
        let directory = data_dir.join("cache/courseware").join(&id);
        std::fs::create_dir_all(
            directory
                .parent()
                .ok_or_else(|| anyhow!("Invalid job directory"))?,
        )?;
        std::fs::create_dir(&directory)?;
        let state = Arc::new(Mutex::new(json!({ "jobId": id, "status": "RUNNING" })));
        let (cancel, receiver) = watch::channel(false);
        let final_cancel = receiver.clone();
        let shared_state = state.clone();
        let task_directory = directory.clone();
        let task_id = id.clone();
        let task = tokio::spawn(async move {
            let mut outcome = run_worker(
                &node,
                &worker,
                source,
                &task_directory,
                receiver,
                WORKER_LIMITS,
            )
            .await;
            let mut status = match shared_state.lock() {
                Ok(status) => status,
                Err(_) => return,
            };
            if *final_cancel.borrow() {
                outcome = Err(anyhow!("PPTX parsing canceled"));
            }
            let result = match outcome {
                Ok(summary) => json!({
                    "jobId": task_id, "status": "SUCCEEDED", "pages": summary["pages"],
                    "summary": summary,
                    "outputDirectory": task_directory.join("output"),
                }),
                Err(error) => {
                    let cleanup = remove_job_directory(&task_directory);
                    json!({
                        "jobId": task_id, "status": "FAILED", "message": error.to_string(),
                        "cleanupFailed": cleanup.is_err(),
                    })
                }
            };
            *status = result;
        });
        self.job = Some(Job {
            id: id.clone(),
            portable_project: None,
            workspace: project_workspace,
            input,
            directory,
            state,
            cancel,
            task,
        });
        Ok(json!({ "jobId": id, "status": "RUNNING" }))
    }

    fn get(&self, id: &str) -> Result<&Job> {
        self.job
            .as_ref()
            .filter(|job| job.id == id)
            .ok_or_else(|| anyhow!("Unknown courseware job"))
    }

    pub fn status(&self, id: &str) -> Result<Value> {
        let job = self.get(id)?;
        if !job.task.is_finished() {
            return Ok(json!({ "jobId": id, "status": "RUNNING" }));
        }
        let value = job
            .state
            .lock()
            .map(|value| value.clone())
            .map_err(|_| anyhow!("Courseware state unavailable"))?;
        if value.get("status").and_then(Value::as_str) == Some("RUNNING") {
            bail!("Courseware task stopped without a result");
        }
        Ok(value)
    }

    pub fn saved_project_seed(&self, id: &str, workspace: &Path) -> Result<SavedProjectSeed> {
        let job = self.get(id)?;
        if job.workspace != workspace.canonicalize()? {
            bail!("COURSEWARE_INVALID: parser belongs to another workspace");
        }
        let status = self.status(id)?;
        if status["status"] != "SUCCEEDED" {
            bail!("COURSEWARE_INVALID: parsing must succeed before opening teaching");
        }
        let relative = job.input.strip_prefix(&job.workspace)?;
        let parts: Vec<_> = relative.iter().filter_map(|part| part.to_str()).collect();
        if parts.len() != 5
            || parts[0] != ".deckwise-ppt"
            || parts[1] != "revisions"
            || parts[3].len() != 5
            || !parts[3].starts_with('r')
            || !parts[3][1..].bytes().all(|b| b.is_ascii_digit())
        {
            bail!("COURSEWARE_INVALID: an editor saved revision is required");
        }
        let (output, _) = self.verified_candidate_source(id, workspace)?;
        Ok(SavedProjectSeed {
            project_id: job
                .portable_project
                .as_ref()
                .map(|(id, _)| id.clone())
                .unwrap_or_else(|| format!("office-{}", parts[2])),
            sha256: output.sha256,
            pages: output.pages,
            identity: output
                .identity
                .map(|mut value| {
                    // Portable identities omit diagnostic messages, which can contain old profile paths.
                    if job.portable_project.is_some() {
                        value["diagnostics"] = json!([]);
                    }
                    identity::SavedSourceIdentity::parse(&serde_json::to_vec(&value)?)
                })
                .transpose()?,
        })
    }

    /// Only the verified portable import RPC can bind this parser job to a persistent UUID.
    pub fn bind_restored_project(
        &mut self,
        id: &str,
        workspace: &Path,
        project_uuid: uuid::Uuid,
        source_path: &Path,
    ) -> Result<()> {
        let seed = self.saved_project_seed(id, workspace)?;
        let project_id = format!("portable-{project_uuid}");
        anyhow::ensure!(
            !project_uuid.is_nil()
                && source_path.is_absolute()
                && source_path.starts_with(workspace.canonicalize()?),
            "COURSEWARE_INVALID: missing portable project UUID"
        );
        let job = self.job.as_mut().unwrap();
        anyhow::ensure!(
            job.portable_project
                .as_ref()
                .is_none_or(|(saved, path)| *saved == project_id && path == source_path)
                && (!seed.project_id.starts_with("portable-") || seed.project_id == project_id),
            "COURSEWARE_CONFLICT: parser already belongs to another portable project"
        );
        job.portable_project = Some((project_id, source_path.to_owned()));
        Ok(())
    }

    pub fn restored_source_path(&self, id: &str, workspace: &Path) -> Result<Option<&Path>> {
        let job = self.get(id)?;
        anyhow::ensure!(
            job.workspace == workspace.canonicalize()?,
            "COURSEWARE_INVALID: parser belongs to another workspace"
        );
        Ok(job
            .portable_project
            .as_ref()
            .map(|(_, path)| path.as_path()))
    }

    fn verified_candidate_source(
        &self,
        id: &str,
        workspace: &Path,
    ) -> Result<(source_candidates::ParsedOutput, Vec<u8>)> {
        use sha2::{Digest, Sha256};
        let job = self.get(id)?;
        if job.workspace != workspace.canonicalize()? {
            bail!("COURSEWARE_INVALID: parser belongs to another workspace");
        }
        let status = self.status(id)?;
        if status["status"] != "SUCCEEDED" {
            bail!("COURSEWARE_INVALID: parsing must succeed before staging a candidate");
        }
        let hash = status["summary"]["sourceSha256"]
            .as_str()
            .ok_or_else(|| anyhow!("COURSEWARE_INVALID: missing source hash"))?;
        let source = open_source(&job.workspace, &job.input)?;
        let mut file = std::io::Read::take(source.file, MAX_INPUT_BYTES + 1);
        let mut bytes = Vec::new();
        std::io::Read::read_to_end(&mut file, &mut bytes)?;
        let actual_hash = hex::encode(Sha256::digest(&bytes));
        if bytes.len() as u64 > MAX_INPUT_BYTES || actual_hash != hash {
            bail!("COURSEWARE_CONFLICT: saved revision changed after parsing");
        }
        let pages = status["summary"]["pages"]
            .as_u64()
            .filter(|n| *n > 0 && *n <= MAX_PAGES as u64)
            .ok_or_else(|| anyhow!("COURSEWARE_INVALID: invalid parsed pages"))?;
        let identity = status["summary"]
            .get("identitySha256")
            .map(|digest| {
                identity::read(
                    &job.directory.join("output"),
                    digest.as_str().unwrap_or(""),
                    hash,
                    pages as usize,
                )
            })
            .transpose()?;
        Ok((
            source_candidates::ParsedOutput {
                sha256: hash.to_owned(),
                pages: pages as usize,
                identity: identity.map(|identity| identity.value().clone()),
            },
            bytes,
        ))
    }

    pub fn cancel(&self, id: &str) -> Result<Value> {
        let job = self.get(id)?;
        if job
            .state
            .lock()
            .map_err(|_| anyhow!("Courseware state unavailable"))?
            .get("status")
            .and_then(Value::as_str)
            == Some("RUNNING")
        {
            job.cancel.send_replace(true);
        }
        self.status(id)
    }

    pub fn release(&mut self, id: &str) -> Result<Value> {
        let job = self.get(id)?;
        if !job.task.is_finished() {
            bail!("Cancel and wait for a terminal state before releasing");
        }
        remove_job_directory(&job.directory)?;
        self.job = None;
        Ok(json!({ "released": true }))
    }

    pub fn stop(&self) {
        if let Some(job) = &self.job {
            job.cancel.send_replace(true);
        }
    }

    pub async fn close(&mut self) -> Result<()> {
        self.online_review.clear();
        if let Some(job) = self.job.take() {
            job.cancel.send_replace(true);
            let result = job.task.await;
            let cleanup = remove_job_directory(&job.directory);
            result?;
            cleanup?;
        }
        Ok(())
    }
}

fn remove_job_directory(directory: &Path) -> Result<()> {
    match std::fs::remove_dir_all(directory) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

fn configured_file(key: &str) -> Result<PathBuf> {
    let path = PathBuf::from(
        std::env::var_os(key).ok_or_else(|| anyhow!("PPTX worker is not installed"))?,
    );
    if !path.is_absolute() || !path.is_file() {
        bail!("Invalid PPTX runtime installation");
    }
    Ok(path.canonicalize()?)
}

fn open_source(workspace: &Path, input: &Path) -> Result<Source> {
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = options.open(input)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() || metadata.len() > MAX_INPUT_BYTES {
        bail!("Invalid PPTX source");
    }
    #[cfg(target_os = "linux")]
    {
        use std::os::fd::AsRawFd;
        let actual = std::fs::read_link(format!("/proc/self/fd/{}", file.as_raw_fd()))?;
        crate::workspace::resolve_in_workspace(workspace, &actual.to_string_lossy())
            .map_err(|error| anyhow!(error))?;
    }
    Ok(Source {
        file,
        name: input
            .file_name()
            .ok_or_else(|| anyhow!("Missing input filename"))?
            .to_owned(),
    })
}

async fn capture_log<R: AsyncRead + Unpin>(pipe: R, path: PathBuf) -> std::io::Result<()> {
    let mut limited = pipe.take(64 * 1024);
    let mut file = tokio::fs::File::create(path).await?;
    tokio::io::copy(&mut limited, &mut file).await?;
    tokio::io::copy(&mut limited.into_inner(), &mut tokio::io::sink()).await?;
    Ok(())
}

async fn run_worker(
    node: &Path,
    worker: &Path,
    source: Source,
    directory: &Path,
    mut cancel: watch::Receiver<bool>,
    limits: WorkerLimits,
) -> Result<Value> {
    let output = directory.join("output");
    if *cancel.borrow() {
        bail!("PPTX parsing canceled");
    }
    let input_directory = directory.join("source");
    tokio::fs::create_dir(&input_directory).await?;
    let input = input_directory.join(source.name);
    let mut source = tokio::fs::File::from_std(source.file).take(MAX_INPUT_BYTES + 1);
    let mut snapshot = tokio::fs::File::create(&input).await?;
    let copied = tokio::select! {
        _ = cancel.changed() => { bail!("PPTX parsing canceled"); }
        result = tokio::io::copy(&mut source, &mut snapshot) => result?,
    };
    if copied > MAX_INPUT_BYTES {
        bail!("PPTX source grew beyond the input limit");
    }
    drop(snapshot);
    if *cancel.borrow() {
        bail!("PPTX parsing canceled");
    }
    let mut child = Command::new(node)
        .arg(worker)
        .arg(&input)
        .arg(&output)
        .current_dir(directory)
        .env_clear()
        .env("ELECTRON_RUN_AS_NODE", "1")
        .env("LANG", "C.UTF-8")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| anyhow!("Missing worker stdout"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| anyhow!("Missing worker stderr"))?;
    let stdout_task = tokio::spawn(capture_log(stdout, directory.join("worker.log")));
    let stderr_task = tokio::spawn(capture_log(stderr, directory.join("worker-errors.log")));
    let pid = child
        .id()
        .ok_or_else(|| anyhow!("Missing worker process ID"))?;
    let result = tokio::select! {
        biased;
        _ = async {
            while !*cancel.borrow_and_update() {
                if cancel.changed().await.is_err() { break; }
            }
        } => Err(anyhow!("PPTX parsing canceled")),
        _ = tokio::time::sleep(limits.timeout) => Err(anyhow!("PPTX parsing timed out")),
        result = monitor_worker(pid, &output, limits) => match result {
            Err(error) if error.to_string() == process::RSS_UNAVAILABLE => process::confirm_exit(&mut child, error).await,
            result => result,
        },
        result = child.wait() => process::exit_result(result),
    };
    if result.is_err() {
        if child.try_wait()?.is_none() {
            child.kill().await?;
        }
        child.wait().await?;
    }
    stdout_task.await??;
    stderr_task.await??;
    if let Err(error) = result {
        let diagnostic = if error.to_string().starts_with("PPTX worker failed") {
            tokio::fs::read_to_string(directory.join("worker-errors.log")).await?
        } else {
            String::new()
        };
        for (code, message) in [
            (
                "PPTX_PAGE_LIMIT",
                "Local parsing supports at most 100 pages",
            ),
            (
                "ZIP_LIMIT_EXCEEDED",
                "PPTX archive exceeds local input or expansion limits",
            ),
            ("PPTX_OUTPUT_LIMIT", "PPTX output exceeds the local limit"),
            ("PPTX_INPUT_LIMIT", "PPTX input exceeds the local limit"),
        ] {
            if diagnostic.contains(&format!("Error: {code}:")) {
                bail!("{code}: {message}");
            }
        }
        return Err(error);
    }
    // Cancellation wins over a process result that arrived before adoption.
    if *cancel.borrow() {
        bail!("PPTX parsing canceled");
    }
    check_output_budget(&output, limits.output_bytes)?;
    let ir_path = output.join("slide-ir.json");
    if tokio::fs::metadata(&ir_path).await?.len() > 64 * 1024 * 1024 {
        bail!("Worker IR exceeds the prototype result limit");
    }
    let bytes = tokio::fs::read(ir_path).await?;
    let ir: Value = serde_json::from_slice(&bytes)?;
    let pages = ir
        .get("pages")
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow!("Worker result has no pages"))?;
    if pages.is_empty() {
        bail!("Worker result has no pages");
    }
    if pages.len() > MAX_PAGES {
        bail!("PPTX_PAGE_LIMIT: Worker result exceeds 100 pages");
    }
    if *cancel.borrow() {
        bail!("PPTX parsing canceled");
    }
    let report_path = output.join("result.json");
    if tokio::fs::metadata(&report_path).await?.len() > 128 * 1024 {
        bail!("Worker report exceeds the prototype result limit");
    }
    let report: Value = serde_json::from_slice(&tokio::fs::read(report_path).await?)?;
    if report["maxRssKiB"]
        .as_u64()
        .is_some_and(|rss| rss > limits.rss_bytes / 1024)
    {
        bail!("PPTX_MEMORY_LIMIT: Worker peak resident memory exceeds the local limit");
    }
    let digest = identity::verify_worker(&output, &report, &ir)?;
    let mut summary = inspection_summary(&ir, &report)?;
    summary["irSha256"] = {
        use sha2::{Digest, Sha256};
        hex::encode(Sha256::digest(&bytes)).into()
    };
    if let Some(digest) = digest {
        summary["identitySha256"] = digest.into();
    }
    Ok(summary)
}

fn check_output_budget(directory: &Path, limit: u64) -> Result<()> {
    let mut bytes = 0_u64;
    let mut entries = 0;
    if !directory.try_exists()? {
        return Ok(());
    }
    for entry in walkdir::WalkDir::new(directory).follow_links(false) {
        let entry = entry?;
        entries += 1;
        if entries > 20_000 || entry.file_type().is_symlink() {
            bail!("PPTX_OUTPUT_LIMIT: Invalid or excessive worker output entries");
        }
        if entry.file_type().is_file() {
            bytes = bytes
                .checked_add(entry.metadata()?.len())
                .ok_or_else(|| anyhow!("PPTX_OUTPUT_LIMIT: Output size overflow"))?;
            if bytes > limit {
                bail!("PPTX_OUTPUT_LIMIT: Worker output exceeds the local limit");
            }
        } else if !entry.file_type().is_dir() {
            bail!("PPTX_OUTPUT_LIMIT: Non-regular worker output");
        }
    }
    Ok(())
}

fn resident_bytes(status: &str) -> Result<u64> {
    ["VmRSS:", "VmHWM:"]
        .into_iter()
        .filter_map(|key| status.lines().find_map(|line| line.strip_prefix(key)))
        .map(|value| {
            let mut parts = value.split_whitespace();
            let kib: u64 = parts
                .next()
                .ok_or_else(|| anyhow!("Missing worker RSS"))?
                .parse()?;
            if parts.next() != Some("kB") {
                bail!("Invalid worker RSS unit");
            }
            kib.checked_mul(1024)
                .ok_or_else(|| anyhow!("Worker RSS overflow"))
        })
        .collect::<Result<Vec<_>>>()?
        .into_iter()
        .max()
        .ok_or_else(|| anyhow!(process::RSS_UNAVAILABLE))
}

async fn monitor_worker(pid: u32, output: &Path, limits: WorkerLimits) -> Result<()> {
    loop {
        // shortcut: sampled Linux RSS/output can overshoot between checks; use a delegated
        // cgroup/filesystem quota when an installer can provide a true kernel-enforced ceiling.
        tokio::time::sleep(Duration::from_millis(100)).await;
        match tokio::fs::read_to_string(format!("/proc/{pid}/status")).await {
            Ok(status) => {
                // A zombie has no VmRSS; child.wait() owns its reaping.
                if !status
                    .lines()
                    .any(|line| line.starts_with("State:") && line.contains("Z (zombie)"))
                    && resident_bytes(&status)? > limits.rss_bytes
                {
                    bail!("PPTX_MEMORY_LIMIT: Worker resident memory exceeds the local limit");
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        check_output_budget(output, limits.output_bytes)?;
    }
}

fn inspection_summary(ir: &Value, report: &Value) -> Result<Value> {
    let pages = ir["pages"]
        .as_array()
        .filter(|pages| !pages.is_empty())
        .ok_or_else(|| anyhow!("Worker result has no pages"))?;
    let hash = report["sourceSha256"]
        .as_str()
        .filter(|hash| hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_hexdigit()))
        .ok_or_else(|| anyhow!("Worker report has no source hash"))?;
    let warnings = ir["warnings"].as_array();
    let error_count = warnings
        .into_iter()
        .flatten()
        .filter(|warning| warning["severity"] == "error")
        .count();
    // Count the full report and show errors first so the display cap cannot hide loss.
    let displayed: Vec<Value> = warnings
        .into_iter()
        .flatten()
        .filter(|warning| warning["severity"] == "error")
        .chain(
            warnings
                .into_iter()
                .flatten()
                .filter(|warning| warning["severity"] != "error"),
        )
        .take(20)
        .map(|warning| {
            let severity = warning["severity"]
                .as_str()
                .filter(|value| matches!(*value, "info" | "warning" | "error"))
                .unwrap_or("unknown");
            let mut entry = json!({
                "code": warning["code"].as_str().unwrap_or("UNKNOWN").chars().take(100).collect::<String>(),
                "message": warning["message"].as_str().unwrap_or("").chars().take(500).collect::<String>(),
                "severity": severity,
            });
            if let Some(index) = warning["pageIndex"]
                .as_u64()
                .filter(|index| *index < pages.len() as u64)
            {
                entry["pageIndex"] = json!(index);
            }
            entry
        })
        .collect();
    Ok(json!({
        "pages": pages.len(), "sourceSha256": hash,
        "timingWarningCount": warnings.into_iter().flatten().filter(|w| w["code"].as_str().is_some_and(|code| code.starts_with("PPTX_TIMING_"))).count(),
        "warningCount": warnings.map_or(0, Vec::len), "errorCount": error_count, "warnings": displayed,
    }))
}

#[cfg(all(test, unix))]
mod tests;
