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

pub mod identity;
mod narration;
mod online_source_review;
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
            project_id: format!("office-{}", parts[2]),
            sha256: output.sha256,
            pages: output.pages,
            identity: output
                .identity
                .map(|value| identity::SavedSourceIdentity::parse(&serde_json::to_vec(&value)?))
                .transpose()?,
        })
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
        "warningCount": warnings.map_or(0, Vec::len), "errorCount": error_count, "warnings": displayed,
    }))
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[tokio::test]
    async fn teaching_seed_requires_same_workspace_saved_archive_and_unchanged_bytes() {
        use sha2::{Digest, Sha256};
        let temp = tempfile::tempdir().unwrap();
        let workspace = temp.path().join("workspace");
        let other = temp.path().join("other");
        std::fs::create_dir_all(&other).unwrap();
        let directory = temp.path().join("job");
        std::fs::create_dir_all(&directory).unwrap();
        let input = workspace.join(".deckwise-ppt/revisions/lesson-123/r0001/document.pptx");
        std::fs::create_dir_all(input.parent().unwrap()).unwrap();
        std::fs::write(&input, b"saved bytes").unwrap();
        let hash = hex::encode(Sha256::digest(b"saved bytes"));
        let (cancel, _) = watch::channel(false);
        let task = tokio::spawn(async {});
        while !task.is_finished() {
            tokio::task::yield_now().await;
        }
        let state = Arc::new(Mutex::new(
            json!({"status":"SUCCEEDED", "summary":{"sourceSha256":hash,"pages":2}}),
        ));
        let mut parser = Parser {
            job: Some(Job {
                id: "job".into(),
                workspace: workspace.canonicalize().unwrap(),
                input: input.clone(),
                directory,
                state: state.clone(),
                cancel,
                task,
            }),
            ..Default::default()
        };
        let seed = parser.saved_project_seed("job", &workspace).unwrap();
        assert_eq!(
            (seed.project_id.as_str(), seed.sha256.as_str(), seed.pages),
            ("office-lesson-123", hash.as_str(), 2)
        );
        assert!(seed.identity.is_none());
        let output = parser.job.as_ref().unwrap().directory.join("output");
        std::fs::create_dir(&output).unwrap();
        let mut identity: Value =
            serde_json::from_slice(include_bytes!("courseware/identity/fixtures/identity.json"))
                .unwrap();
        identity["sourceSha256"] = json!(hash);
        let bytes = serde_json::to_vec(&identity).unwrap();
        std::fs::write(output.join("identity.json"), &bytes).unwrap();
        {
            let mut status = state.lock().unwrap();
            status["summary"]["identitySha256"] = json!(hex::encode(Sha256::digest(&bytes)));
            status["summary"]["pages"] = json!(1);
        }
        assert!(parser
            .saved_project_seed("job", &workspace)
            .unwrap()
            .identity
            .is_some());
        std::fs::write(output.join("identity.json"), b"{}").unwrap();
        assert!(parser.saved_project_seed("job", &workspace).is_err());
        {
            let mut status = state.lock().unwrap();
            status["summary"]
                .as_object_mut()
                .unwrap()
                .remove("identitySha256");
            status["summary"]["pages"] = json!(2);
        }
        assert!(parser.saved_project_seed("job", &other).is_err());
        state.lock().unwrap()["status"] = json!("FAILED");
        assert!(parser.saved_project_seed("job", &workspace).is_err());
        state.lock().unwrap()["status"] = json!("SUCCEEDED");
        std::fs::write(&input, b"changed bytes").unwrap();
        assert!(parser
            .saved_project_seed("job", &workspace)
            .unwrap_err()
            .to_string()
            .starts_with("COURSEWARE_CONFLICT"));
        std::fs::write(&input, b"saved bytes").unwrap();
        parser.job.as_mut().unwrap().input = workspace.join("lesson.pptx");
        assert!(parser.saved_project_seed("job", &workspace).is_err());
        parser.release("job").unwrap();
    }

    #[tokio::test]
    async fn cancellation_and_timeout_reap_the_worker() {
        for canceled in [true, false] {
            let temp = tempfile::tempdir().unwrap();
            let script = temp.path().join("worker.sh");
            std::fs::write(&script, "while :; do :; done\n").unwrap();
            let (_sender, receiver) = watch::channel(canceled);
            let error = run_worker(
                Path::new("/bin/sh"),
                &script,
                open_source(temp.path(), &script).unwrap(),
                temp.path(),
                receiver,
                WorkerLimits {
                    timeout: Duration::from_millis(20),
                    ..WORKER_LIMITS
                },
            )
            .await
            .unwrap_err();
            assert!(error
                .to_string()
                .contains(if canceled { "canceled" } else { "timed out" }));
        }
    }

    #[test]
    fn params_cannot_choose_executable_or_output() {
        assert!(serde_json::from_value::<StartParams>(
            json!({ "path": "lesson.pptx", "worker": "/bin/sh" })
        )
        .is_err());
        assert!(serde_json::from_value::<JobParams>(
            json!({ "jobId": "id", "outputDirectory": "/tmp" })
        )
        .is_err());
        assert!(Parser::default().status("unknown").is_err());
    }

    #[test]
    fn opened_source_cannot_be_redirected_by_replacing_its_path() {
        use std::io::Read;
        let temp = tempfile::tempdir().unwrap();
        let workspace = temp.path().join("workspace");
        std::fs::create_dir(&workspace).unwrap();
        let path = workspace.join("lesson.pptx");
        std::fs::write(&path, "original bytes").unwrap();
        let mut source = open_source(&workspace, &path).unwrap();
        std::fs::remove_file(&path).unwrap();
        let outside = temp.path().join("outside.pptx");
        std::fs::write(&outside, "outside bytes").unwrap();
        std::os::unix::fs::symlink(&outside, &path).unwrap();
        assert!(open_source(&workspace, &path).is_err());
        let mut bytes = String::new();
        source.file.read_to_string(&mut bytes).unwrap();
        assert_eq!(bytes, "original bytes");
    }

    #[tokio::test]
    async fn diagnostic_output_is_bounded_and_the_pipe_is_drained() {
        let temp = tempfile::tempdir().unwrap();
        let log = temp.path().join("log");
        capture_log(std::io::Cursor::new(vec![b'x'; 100_000]), log.clone())
            .await
            .unwrap();
        assert_eq!(std::fs::metadata(log).unwrap().len(), 64 * 1024);
    }

    #[test]
    fn inspection_report_is_bounded_and_does_not_expose_assets_or_runtime_paths() {
        let warnings = vec![json!({ "code": "UNSUPPORTED", "message": "x".repeat(1000) }); 25];
        let ir = json!({ "pages": [{ "elements": [{ "src": "/private/asset" }] }], "warnings": warnings });
        let report = json!({ "sourceSha256": "a".repeat(64), "privatePath": "/private/runtime" });
        let summary = inspection_summary(&ir, &report).unwrap();
        assert_eq!(summary["pages"], 1);
        assert_eq!(summary["warningCount"], 25);
        assert_eq!(summary["warnings"].as_array().unwrap().len(), 20);
        assert_eq!(
            summary["warnings"][0]["message"].as_str().unwrap().len(),
            500
        );
        assert!(!summary.to_string().contains("/private/"));
        assert!(inspection_summary(&ir, &json!({})).is_err());
        assert!(inspection_summary(&json!({ "pages": [] }), &report).is_err());
    }
    #[test]
    fn inspection_counts_all_errors_and_prioritizes_them_before_truncation() {
        let mut warnings = vec![json!({ "code": "NOTICE", "severity": "info" }); 20];
        warnings.extend((0..25).map(|_| {
            json!({
                "code": "PPTX_NATIVE_MATH_UNVERIFIED", "severity": "error", "pageIndex": 1,
                "message": "Formula content is not verified"
            })
        }));
        let ir = json!({ "pages": [{}, {}], "warnings": warnings });
        let summary = inspection_summary(&ir, &json!({ "sourceSha256": "a".repeat(64) })).unwrap();
        assert_eq!(summary["warningCount"], 45);
        assert_eq!(summary["errorCount"], 25);
        let displayed = summary["warnings"].as_array().unwrap();
        assert_eq!(displayed.len(), 20);
        for warning in displayed {
            assert_eq!(warning["severity"], "error");
            assert_eq!(warning["pageIndex"], 1);
        }
    }

    #[test]
    fn inspection_normalizes_unknown_severity_and_invalid_page_indices() {
        let ir = json!({ "pages": [{}, {}], "warnings": [
            { "code": "OLD", "pageIndex": 0 },
            { "severity": "fatal", "pageIndex": -1 },
            { "severity": "warning", "pageIndex": 2 },
            { "severity": "info", "pageIndex": 0.5 }
        ] });
        let summary = inspection_summary(&ir, &json!({ "sourceSha256": "a".repeat(64) })).unwrap();
        assert_eq!(summary["errorCount"], 0);
        assert_eq!(summary["warnings"][0]["severity"], "unknown");
        assert_eq!(summary["warnings"][0]["pageIndex"], 0);
        for i in 1..4 {
            assert!(summary["warnings"][i].get("pageIndex").is_none());
        }
        assert_eq!(summary["warnings"][1]["severity"], "unknown");
        assert_eq!(summary["warnings"][2]["severity"], "warning");
        assert_eq!(summary["warnings"][3]["severity"], "info");
    }

    #[test]
    fn pilot_input_boundary_is_inclusive() {
        let temp = tempfile::tempdir().unwrap();
        let file = temp.path().join("limit.pptx");
        let handle = std::fs::File::create(&file).unwrap();
        handle.set_len(50 * 1024 * 1024).unwrap();
        assert!(open_source(temp.path(), &file).is_ok());
        handle.set_len(50 * 1024 * 1024 + 1).unwrap();
        assert!(open_source(temp.path(), &file).is_err());
    }

    #[test]
    fn output_budget_counts_assets_and_rejects_links() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::write(temp.path().join("asset"), b"12345").unwrap();
        assert!(check_output_budget(temp.path(), 5).is_ok());
        assert!(check_output_budget(temp.path(), 4).is_err());
        std::os::unix::fs::symlink("asset", temp.path().join("link")).unwrap();
        assert!(check_output_budget(temp.path(), 100).is_err());
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn resource_limits_terminate_and_reap_running_workers() {
        for resource in ["rss", "output"] {
            let temp = tempfile::tempdir().unwrap();
            let script = temp.path().join("worker.sh");
            std::fs::write(&script, "echo $$ > worker.pid\nmkdir -p \"$2\"\nprintf 12345 > \"$2/asset\"\nwhile :; do :; done\n").unwrap();
            let (_sender, receiver) = watch::channel(false);
            let mut limits = WORKER_LIMITS;
            limits.timeout = Duration::from_secs(2);
            if resource == "rss" {
                limits.rss_bytes = 1;
            } else {
                limits.output_bytes = 4;
            }
            let error = run_worker(
                Path::new("/bin/sh"),
                &script,
                open_source(temp.path(), &script).unwrap(),
                temp.path(),
                receiver,
                limits,
            )
            .await
            .unwrap_err();
            assert!(
                error.to_string().contains(if resource == "rss" {
                    "PPTX_MEMORY_LIMIT"
                } else {
                    "PPTX_OUTPUT_LIMIT"
                }),
                "{error}"
            );
            let pid = std::fs::read_to_string(temp.path().join("worker.pid")).unwrap();
            assert!(!Path::new(&format!("/proc/{}", pid.trim())).exists());
        }
    }

    #[test]
    fn process_memory_includes_native_resident_pages_and_high_water_mark() {
        assert_eq!(
            resident_bytes("Name: worker\nVmRSS:\t10 kB\nVmHWM:\t12 kB\n").unwrap(),
            12 * 1024
        );
        assert!(resident_bytes("VmRSS: invalid kB\n").is_err());
    }

    #[tokio::test]
    async fn final_output_check_rejects_a_worker_that_exits_before_sampling() {
        let temp = tempfile::tempdir().unwrap();
        let script = temp.path().join("worker.sh");
        std::fs::write(&script, "mkdir -p \"$2\"\nprintf 12345 > \"$2/asset\"\n").unwrap();
        let (_sender, receiver) = watch::channel(false);
        let error = run_worker(
            Path::new("/bin/sh"),
            &script,
            open_source(temp.path(), &script).unwrap(),
            temp.path(),
            receiver,
            WorkerLimits {
                output_bytes: 4,
                ..WORKER_LIMITS
            },
        )
        .await
        .unwrap_err();
        assert!(error.to_string().contains("PPTX_OUTPUT_LIMIT"), "{error}");
    }
    #[tokio::test]
    async fn limit_diagnostics_do_not_expose_worker_error_paths() {
        let temp = tempfile::tempdir().unwrap();
        let script = temp.path().join("worker.sh");
        std::fs::write(
            &script,
            "echo 'Error: PPTX_PAGE_LIMIT: /private/source.pptx' >&2\nexit 1\n",
        )
        .unwrap();
        let (_sender, receiver) = watch::channel(false);
        let error = run_worker(
            Path::new("/bin/sh"),
            &script,
            open_source(temp.path(), &script).unwrap(),
            temp.path(),
            receiver,
            WORKER_LIMITS,
        )
        .await
        .unwrap_err();
        assert_eq!(
            error.to_string(),
            "PPTX_PAGE_LIMIT: Local parsing supports at most 100 pages"
        );
    }
}
