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
            portable_project: None,
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
        serde_json::from_slice(include_bytes!("identity/fixtures/identity.json")).unwrap();
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
    let ir =
        json!({ "pages": [{ "elements": [{ "src": "/private/asset" }] }], "warnings": warnings });
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
