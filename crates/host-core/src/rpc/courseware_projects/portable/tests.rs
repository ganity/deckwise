use super::*;

#[test]
fn attachment_detects_retained_and_pending_commits_without_creating_metadata() {
    let directory = tempfile::tempdir().unwrap();
    let source = directory.path().join("lesson.pptx");
    assert!(!has_portable_files(&source).unwrap());
    assert!(!directory.path().join(".deckwise").exists());
    std::fs::create_dir(directory.path().join(".deckwise")).unwrap();
    for marker in [
        "lesson.teaching.json",
        ".deckwise/current.json",
        ".deckwise/pending.json",
    ] {
        let path = directory.path().join(marker);
        std::fs::write(&path, b"invalid marker still requires verification").unwrap();
        assert!(has_portable_files(&source).unwrap());
        assert!(!has_portable_files(&directory.path().join("other.pptx")).unwrap());
        std::fs::remove_file(path).unwrap();
    }
}

#[tokio::test]
async fn copy_rpc_rejects_path_overrides_and_unknown_sessions_without_creating_files() {
    let directory = tempfile::tempdir().unwrap();
    let app = AppState::open(directory.path()).unwrap();
    let state = Arc::new(Mutex::new(app));
    let request = json!({"sessionId":"unknown", "jobId":"unknown-job", "expectedSourceRevision":"r1", "expectedTeachingRevision":"t1"});
    for field in ["workspace", "path", "outputDirectory", "media"] {
        let mut forged = request.clone();
        forged[field] = json!("/outside");
        assert!(handle(state.clone(), forged).await.is_err());
    }
    assert!(handle(state.clone(), request).await.is_err());
    let request = json!({"sessionId":"unknown", "jobId":"unknown-job", "sourcePath":directory.path().join("lesson.pptx")});
    for field in ["workspace", "projectUuid", "media", "teaching"] {
        let mut forged = request.clone();
        forged[field] = json!("/outside");
        assert!(restore(state.clone(), forged).await.is_err());
    }
    assert!(attach(state.clone(), request.clone()).await.is_err());
    assert!(restore(state.clone(), request).await.is_err());
    assert!(local_media(
        state,
        json!({"sessionId":"unknown", "projectId":"unknown", "pageId":"page", "actionId":"action",
        "expectedSourceRevision":"r1", "expectedTeachingRevision":"t1"})
    )
    .await
    .is_err());
    assert!(!directory.path().join("courseware-copies").exists());
    assert!(!directory.path().join(".deckwise").exists());
}

#[cfg(target_os = "linux")]
#[tokio::test]
#[ignore = "requires DECKWISE_PPTX_NODE and the installed DECKWISE_PPTX_WORKER"]
async fn real_parser_copy_preserves_adopted_local_audio_without_original_profile() {
    use crate::courseware::{project_commit::ProjectCommitStore, snapshot_assets};
    use crate::db::courseware_projects::{
        tts::{audio::Audio, Selection, TaskRef},
        TeachingWrite,
    };
    use sha2::{Digest, Sha256};
    use std::time::Duration;
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("workspace");
    let other = directory.path().join("other");
    let input = root.join(".deckwise-ppt/revisions/copy-e2e/r0001/lesson.pptx");
    std::fs::create_dir_all(input.parent().unwrap()).unwrap();
    std::fs::create_dir(&other).unwrap();
    let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let source = std::fs::read(
        repo.join("packages/courseware-runtime/tests/fixtures/fixed-courseware/lesson-r8.pptx"),
    )
    .unwrap();
    std::fs::write(&input, &source).unwrap();
    let mut app = AppState::open(directory.path()).unwrap();
    app.handshook = true;
    let session = sessions::create_session(
        &app.db,
        None,
        None,
        None,
        None,
        Some(root.to_string_lossy().into()),
    )
    .unwrap();
    let foreign = sessions::create_session(
        &app.db,
        None,
        None,
        None,
        None,
        Some(other.to_string_lossy().into()),
    )
    .unwrap();
    app.workspace.set(other.clone());
    let state = Arc::new(Mutex::new(app));
    let (tx, _) = mpsc::unbounded_channel();
    let dispatch = |method: &'static str, params| {
        super::super::super::handle_request(state.clone(), method, params, tx.clone())
    };
    let started = dispatch(
        "courseware.parseStart",
        json!({"sessionId":session.id,"path":input}),
    )
    .await
    .unwrap();
    let job = started["jobId"].as_str().unwrap();
    tokio::time::timeout(Duration::from_secs(90), async {
        loop {
            let status = dispatch("courseware.parseStatus", json!({"jobId":job}))
                .await
                .unwrap();
            if status["status"] != "RUNNING" {
                assert_eq!(status["status"], "SUCCEEDED", "{status}");
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .unwrap();
    let opened = dispatch(
        "courseware.project.openSaved",
        json!({"sessionId":session.id,"jobId":job}),
    )
    .await
    .unwrap();
    let project_id = opened["project"]["projectId"].as_str().unwrap();
    let wav = std::fs::read(
        repo.join("packages/courseware-runtime/tests/fixtures/fixed-courseware/page-1.wav"),
    )
    .unwrap();
    let expected;
    {
        let app = state.lock().await;
        let seed = app.courseware.saved_project_seed(job, &root).unwrap();
        let p = app
            .db
            .get_courseware_project(root.to_str().unwrap(), project_id)
            .unwrap()
            .unwrap();
        let page_id = p.pages[0].page_id.clone();
        let p = app.db.write_courseware_teaching(root.to_str().unwrap(), &TeachingWrite {
            project_id: p.project_id, page_id: page_id.clone(), expected_source_revision: p.source.revision,
            expected_teaching_revision: p.teaching_revision,
            actions: vec![json!({"id":"narration", "type":"speech", "text":"Hello!", "source":"generated"}),
                json!({"id":"unfinished", "type":"speech", "text":""}),
                json!({"id":"wait", "type":"interaction_checkpoint", "checkpointKind":"teacher_continue", "checkpointId":"wait-1"})],
        }).unwrap();
        let mut p = p;
        for page in p.pages.clone().into_iter().skip(1) {
            p = app.db.write_courseware_teaching(root.to_str().unwrap(), &TeachingWrite {
                project_id: p.project_id.clone(), page_id: page.page_id,
                expected_source_revision: p.source.revision.clone(), expected_teaching_revision: p.teaching_revision.clone(),
                actions: vec![json!({"id":"narration-0", "type":"speech", "text":"Draft greeting"}),
                    json!({"id":"wait", "type":"interaction_checkpoint", "checkpointKind":"teacher_continue", "checkpointId":"wait-1"})],
            }).unwrap();
        }
        let principal = "a".repeat(64);
        let prepared = app
            .db
            .prepare_courseware_tts(
                root.to_str().unwrap(),
                Selection {
                    project_id: p.project_id.clone(),
                    page_id: page_id.clone(),
                    action_id: "narration".into(),
                    intent_id: "local-fixture".into(),
                    principal_key: principal.clone(),
                    expected_source_revision: p.source.revision.clone(),
                    expected_teaching_revision: p.teaching_revision.clone(),
                    model: "courseware-tts-v1".into(),
                    voice: None,
                },
            )
            .unwrap();
        app.db
            .begin_courseware_tts(
                root.to_str().unwrap(),
                &p.project_id,
                &principal,
                "local-fixture",
                &session.id,
            )
            .unwrap();
        let task = TaskRef {
            task_id: "local-provider-receipt".into(),
            idempotency_key: prepared["intent"]["idempotencyKey"]
                .as_str()
                .unwrap()
                .into(),
            request_hash: prepared["intent"]["requestHash"].as_str().unwrap().into(),
        };
        app.db
            .bind_courseware_tts(
                root.to_str().unwrap(),
                &p.project_id,
                &principal,
                "local-fixture",
                task.clone(),
            )
            .unwrap();
        let hash = hex::encode(Sha256::digest(&wav));
        snapshot_assets::archive_bytes(&app.data_dir, &hash, &wav).unwrap();
        app.db
            .stage_courseware_tts_audio(
                root.to_str().unwrap(),
                &p.project_id,
                &principal,
                "local-fixture",
                Audio {
                    task_ref: task,
                    sha256: hash,
                    mime_type: "audio/wav".into(),
                    byte_length: wav.len() as u64,
                    duration_ms: 5955,
                },
            )
            .unwrap();
        let p = app
            .db
            .adopt_courseware_tts_audio(
                root.to_str().unwrap(),
                &p.project_id,
                &principal,
                "local-fixture",
                &p.teaching_revision,
                None,
            )
            .unwrap();
        expected = app
            .db
            .set_courseware_page_lock(
                root.to_str().unwrap(),
                &p.project_id,
                &page_id,
                &p.source.revision,
                &p.teaching_revision,
                true,
            )
            .unwrap();
        assert_eq!(seed.pages, expected.pages.len());
    }
    let request = json!({"sessionId":session.id, "jobId":job,
        "expectedSourceRevision":expected.source.revision, "expectedTeachingRevision":expected.teaching_revision});
    let mut stale = request.clone();
    stale["expectedTeachingRevision"] = json!("stale");
    assert!(dispatch("courseware.project.copy", stale).await.is_err());
    let mut foreign_request = request.clone();
    foreign_request["sessionId"] = json!(foreign.id);
    assert!(dispatch("courseware.project.copy", foreign_request)
        .await
        .is_err());
    assert!(!root.join("courseware-copies").exists());
    let result = dispatch("courseware.project.copy", request).await.unwrap();
    assert_eq!(result["mediaCount"], 1);
    assert!(!other.join("courseware-copies").exists());
    assert_eq!(std::fs::read(&input).unwrap(), source);
    let copy = std::path::PathBuf::from(result["path"].as_str().unwrap());
    let fresh = tempfile::tempdir().unwrap();
    for entry in walkdir::WalkDir::new(&copy).min_depth(1) {
        let entry = entry.unwrap();
        let out = fresh.path().join(entry.path().strip_prefix(&copy).unwrap());
        if entry.file_type().is_dir() {
            std::fs::create_dir(out).unwrap();
        } else {
            std::fs::copy(entry.path(), out).unwrap();
        }
    }
    dispatch("courseware.parseRelease", json!({"jobId":job}))
        .await
        .unwrap();
    drop(state);
    drop(directory);
    let mut reopened = ProjectCommitStore::open(fresh.path()).unwrap();
    let committed = reopened.current().unwrap().unwrap();
    assert_eq!(committed.source, source);
    let content = crate::db::courseware_projects::portable::Teaching::parse(
        &committed.teaching,
        committed.revision.commit_id,
        &committed.revision.source_sha256,
    )
    .unwrap();
    assert_eq!(
        serde_json::to_value(&content.project).unwrap(),
        serde_json::to_value(&expected).unwrap()
    );
    assert_eq!(
        std::fs::read(fresh.path().join(&content.media[0].path)).unwrap(),
        wav
    );
    let json = String::from_utf8(committed.teaching).unwrap();
    for private in [
        "principalKey",
        "local-provider-receipt",
        "local-fixture",
        "submissionScope",
        "taskRef",
    ] {
        assert!(!json.contains(private));
    }
    drop(reopened);

    // Reconstruct teaching in an unrelated Host profile using only the moved project files.
    let profile = tempfile::tempdir().unwrap();
    let mut app = AppState::open(profile.path()).unwrap();
    app.handshook = true;
    let session = sessions::create_session(
        &app.db,
        None,
        None,
        None,
        None,
        Some(fresh.path().to_string_lossy().into()),
    )
    .unwrap();
    let input = fresh
        .path()
        .join(".deckwise-ppt/revisions/fresh-copy/r0001/lesson.pptx");
    std::fs::create_dir_all(input.parent().unwrap()).unwrap();
    std::fs::write(&input, &source).unwrap();
    let state = Arc::new(Mutex::new(app));
    let (tx, _) = mpsc::unbounded_channel();
    let dispatch = |method: &'static str, params| {
        super::super::super::handle_request(state.clone(), method, params, tx.clone())
    };
    let started = dispatch(
        "courseware.parseStart",
        json!({"sessionId":session.id,"path":input}),
    )
    .await
    .unwrap();
    let job = started["jobId"].as_str().unwrap();
    tokio::time::timeout(Duration::from_secs(90), async {
        loop {
            let status = dispatch("courseware.parseStatus", json!({"jobId":job}))
                .await
                .unwrap();
            if status["status"] != "RUNNING" {
                assert_eq!(status["status"], "SUCCEEDED", "{status}");
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    let request =
        json!({"sessionId":session.id,"jobId":job,"sourcePath":fresh.path().join("lesson.pptx")});
    let ordinary = fresh.path().join("ordinary");
    std::fs::create_dir(&ordinary).unwrap();
    std::fs::write(ordinary.join("lesson.pptx"), &source).unwrap();
    assert_eq!(
        dispatch(
            "courseware.project.attach",
            json!({"sessionId":session.id,"jobId":job,
        "sourcePath":ordinary.join("lesson.pptx")})
        )
        .await
        .unwrap(),
        json!({"attached":false})
    );
    assert!(!ordinary.join(".deckwise").exists());
    let asset_path = fresh.path().join(&content.media[0].path);
    std::fs::write(&asset_path, b"damaged copied media").unwrap();
    assert!(dispatch("courseware.project.attach", request.clone())
        .await
        .is_err());
    {
        let app = state.lock().await;
        assert!(app
            .db
            .get_courseware_project(
                fresh.path().to_str().unwrap(),
                &format!("portable-{}", content.project_uuid)
            )
            .unwrap()
            .is_none());
    }
    std::fs::write(&asset_path, &wav).unwrap();
    assert_eq!(
        dispatch("courseware.project.attach", request.clone())
            .await
            .unwrap(),
        json!({"attached":true})
    );
    let restored = dispatch("courseware.project.restore", request.clone())
        .await
        .unwrap();
    let project_id = restored["project"]["projectId"].as_str().unwrap();
    assert_eq!(project_id, format!("portable-{}", content.project_uuid));
    let mut expected = serde_json::to_value(&expected).unwrap();
    expected["projectId"] = json!(project_id);
    assert_eq!(restored["project"], expected);
    let opened = dispatch(
        "courseware.project.openSaved",
        json!({"sessionId":session.id,"jobId":job}),
    )
    .await
    .unwrap();
    assert_eq!(opened["project"], expected);
    let copied_again = dispatch("courseware.project.copy", json!({"sessionId":session.id,"jobId":job,
        "expectedSourceRevision":content.project.source.revision,"expectedTeachingRevision":content.project.teaching_revision})).await.unwrap();
    assert_eq!(copied_again["mediaCount"], 1);
    assert_ne!(copied_again["projectUuid"], restored["projectUuid"]);
    let page_id = content.project.pages[0].page_id.clone();
    let action_id = content.project.pages[0]
        .actions
        .iter()
        .find(|action| action["audioAssetId"].is_string())
        .unwrap()["id"]
        .as_str()
        .unwrap();
    let media_request = json!({"sessionId":session.id,"projectId":project_id,"pageId":page_id,"actionId":action_id,
        "expectedSourceRevision":content.project.source.revision,"expectedTeachingRevision":content.project.teaching_revision});
    let local = dispatch("courseware.project.localMedia", media_request.clone())
        .await
        .unwrap();
    assert_eq!(
        std::fs::read(local["media"]["path"].as_str().unwrap()).unwrap(),
        wav
    );
    assert_eq!(local["media"]["durationMs"], 5955);
    let mut stale = media_request.clone();
    stale["expectedTeachingRevision"] = json!("stale");
    assert!(dispatch("courseware.project.localMedia", stale)
        .await
        .is_err());
    let mut missing = media_request.clone();
    missing["pageId"] = json!("another-page");
    assert_eq!(
        dispatch("courseware.project.localMedia", missing)
            .await
            .unwrap()["media"],
        Value::Null
    );
    let ready = {
        let app = state.lock().await;
        let mut project = app
            .db
            .get_courseware_project(fresh.path().to_str().unwrap(), project_id)
            .unwrap()
            .unwrap();
        for page in &mut project.pages {
            page.review_state = "ready".into();
            page.actions
                .retain(|action| action["type"] != "speech" || action["audioAssetId"].is_string());
        }
        project.teaching_revision = "ready-copy".into();
        app.db
            .kv_set(
                "coursewareProjects.v1",
                &serde_json::to_string(&(fresh.path().to_str().unwrap(), project_id)).unwrap(),
                &serde_json::to_value(&project).unwrap(),
            )
            .unwrap();
        project
    };
    let proof = json!({"asset":{"id":content.media[0].id,"sha256":content.media[0].sha256,"mimeType":content.media[0].mime_type},"local":true});
    let capture = json!({"sessionId":session.id,"jobId":job,"snapshotId":"portable-snapshot",
        "expectedSourceRevision":ready.source.revision,"expectedTeachingRevision":ready.teaching_revision,"assets":[proof]});
    for (pointer, value) in [
        ("/assets/0/local", json!(false)),
        ("/assets/0/path", json!("/arbitrary/path")),
        ("/assets/0/asset/mimeType", json!("video/mp4")),
    ] {
        let mut invalid = capture.clone();
        if pointer.ends_with("/path") {
            invalid["assets"][0]["path"] = value;
        } else {
            *invalid.pointer_mut(pointer).unwrap() = value;
        }
        assert!(dispatch("courseware.snapshot.capture", invalid)
            .await
            .is_err());
    }
    let captured = dispatch("courseware.snapshot.capture", capture.clone())
        .await
        .unwrap();
    assert_eq!(
        captured["snapshot"]["assetIds"],
        json!([content.media[0].id])
    );
    let files = dispatch(
        "courseware.snapshot.get",
        json!({"sessionId":session.id,"projectId":project_id,"snapshotId":"portable-snapshot"}),
    )
    .await
    .unwrap();
    assert_eq!(
        std::fs::read(files["assets"][0]["path"].as_str().unwrap()).unwrap(),
        wav
    );
    {
        let app = state.lock().await;
        let mut duplicate = ready.clone();
        duplicate.pages[1].actions.push(json!({"id":"new-speech","type":"speech","text":"A different sentence","audioAssetId":content.media[0].id}));
        app.db
            .kv_set(
                "coursewareProjects.v1",
                &serde_json::to_string(&(fresh.path().to_str().unwrap(), project_id)).unwrap(),
                &serde_json::to_value(&duplicate).unwrap(),
            )
            .unwrap();
    }
    // A valid proof on one page cannot authorize a different sentence sharing the same media ID.
    assert!(dispatch("courseware.snapshot.capture", capture.clone())
        .await
        .is_err());
    {
        let app = state.lock().await;
        app.db
            .kv_set(
                "coursewareProjects.v1",
                &serde_json::to_string(&(fresh.path().to_str().unwrap(), project_id)).unwrap(),
                &serde_json::to_value(&ready).unwrap(),
            )
            .unwrap();
    }
    {
        let app = state.lock().await;
        let mut project = app
            .db
            .get_courseware_project(fresh.path().to_str().unwrap(), project_id)
            .unwrap()
            .unwrap();
        project.pages[0]
            .actions
            .iter_mut()
            .find(|action| action["id"] == action_id)
            .unwrap()["text"] = json!("Changed locally");
        project.teaching_revision = "local-edit".into();
        app.db
            .kv_set(
                "coursewareProjects.v1",
                &serde_json::to_string(&(fresh.path().to_str().unwrap(), project_id)).unwrap(),
                &serde_json::to_value(&project).unwrap(),
            )
            .unwrap();
    }
    let again = dispatch("courseware.project.restore", request.clone())
        .await
        .unwrap();
    assert_eq!(again["project"]["teachingRevision"], "local-edit");
    assert_eq!(
        dispatch("courseware.project.attach", request.clone())
            .await
            .unwrap(),
        json!({"attached":true})
    );
    let sidecar = fresh.path().join("lesson.teaching.json");
    let baseline = std::fs::read(&sidecar).unwrap();
    std::fs::remove_file(&sidecar).unwrap();
    assert!(dispatch("courseware.project.attach", request.clone())
        .await
        .is_err());
    std::fs::write(&sidecar, &baseline).unwrap();
    let mut edited = media_request.clone();
    edited["expectedTeachingRevision"] = json!("local-edit");
    assert_eq!(
        dispatch("courseware.project.localMedia", edited)
            .await
            .unwrap()["media"],
        Value::Null
    );
    std::fs::write(local["media"]["path"].as_str().unwrap(), b"damaged media").unwrap();
    // Restoring never repairs an unexpected archive overwrite behind the user's back.
    assert!(dispatch("courseware.project.restore", request)
        .await
        .is_err());
    dispatch("courseware.parseRelease", json!({"jobId":job}))
        .await
        .unwrap();

    // A native save changes the public PPTX; keep the original baseline and require ordinary source review.
    std::fs::write(local["media"]["path"].as_str().unwrap(), &wav).unwrap();
    {
        let app = state.lock().await;
        let mut project = ready.clone();
        project.teaching_revision = "local-edit".into();
        // Use the canonical writer so the fixture retains the same CAS serialization as real edits.
        app.db
            .kv_delete(
                "coursewareProjects.v1",
                &serde_json::to_string(&(fresh.path().to_str().unwrap(), project_id)).unwrap(),
            )
            .unwrap();
        app.db
            .create_courseware_project(fresh.path().to_str().unwrap(), &project)
            .unwrap();
    }
    let mut changed = source.clone();
    let end = changed
        .windows(4)
        .rposition(|bytes| bytes == b"PK\x05\x06")
        .unwrap();
    let comment = b"isolated native save";
    changed.truncate(end + 22);
    changed[end + 20..end + 22].copy_from_slice(&(comment.len() as u16).to_le_bytes());
    changed.extend_from_slice(comment);
    std::fs::write(fresh.path().join("lesson.pptx"), &changed).unwrap();
    let next = fresh
        .path()
        .join(".deckwise-ppt/revisions/fresh-copy/r0002/lesson.pptx");
    std::fs::create_dir_all(next.parent().unwrap()).unwrap();
    std::fs::write(&next, &changed).unwrap();
    let started = dispatch(
        "courseware.parseStart",
        json!({"sessionId":session.id,"path":next}),
    )
    .await
    .unwrap();
    let changed_job = started["jobId"].as_str().unwrap();
    tokio::time::timeout(Duration::from_secs(90), async {
        loop {
            let status = dispatch("courseware.parseStatus", json!({"jobId":changed_job}))
                .await
                .unwrap();
            if status["status"] != "RUNNING" {
                assert_eq!(status["status"], "SUCCEEDED", "{status}");
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    let changed_request = json!({"sessionId":session.id,"jobId":changed_job,"sourcePath":fresh.path().join("lesson.pptx")});
    assert_eq!(
        dispatch("courseware.project.attach", changed_request)
            .await
            .unwrap(),
        json!({"attached":true})
    );
    assert!(dispatch(
        "courseware.project.openSaved",
        json!({"sessionId":session.id,"jobId":changed_job})
    )
    .await
    .is_err());
    let review = dispatch(
        "courseware.review.prepare",
        json!({"sessionId":session.id,"jobId":changed_job}),
    )
    .await
    .unwrap();
    assert_eq!(review["project"]["projectId"], project_id);
    assert_eq!(review["project"]["teachingRevision"], "local-edit");
    assert_eq!(
        std::fs::read(fresh.path().join("lesson.pptx")).unwrap(),
        changed
    );
    assert_eq!(std::fs::read(&sidecar).unwrap(), baseline);
    let adopted = dispatch("courseware.review.adopt", json!({"sessionId":session.id,"jobId":changed_job,
        "reviewId":review["reviewId"], "bindings":review["project"]["pages"].as_array().unwrap().iter()
            .map(|page| page["pageId"].clone()).collect::<Vec<_>>(), "effectBindings":[]})).await.unwrap();
    let mut media_request = media_request.clone();
    media_request["expectedSourceRevision"] = adopted["project"]["source"]["revision"].clone();
    media_request["expectedTeachingRevision"] = adopted["project"]["teachingRevision"].clone();
    assert_eq!(
        dispatch("courseware.project.localMedia", media_request)
            .await
            .unwrap()["media"]["asset"]["id"],
        content.media[0].id
    );
    assert_eq!(
        dispatch(
            "courseware.project.attach",
            json!({"sessionId":session.id,"jobId":changed_job,
        "sourcePath":fresh.path().join("lesson.pptx")})
        )
        .await
        .unwrap(),
        json!({"attached":true})
    );
    let opened = dispatch(
        "courseware.project.openSaved",
        json!({"sessionId":session.id,"jobId":changed_job}),
    )
    .await
    .unwrap();
    assert_eq!(opened["project"], adopted["project"]);
    let copied = dispatch(
        "courseware.project.copy",
        json!({"sessionId":session.id,"jobId":changed_job,
        "expectedSourceRevision":adopted["project"]["source"]["revision"],
        "expectedTeachingRevision":adopted["project"]["teachingRevision"]}),
    )
    .await
    .unwrap();
    assert_eq!(copied["mediaCount"], 1);
    assert_eq!(
        copied["sourceSha256"],
        adopted["project"]["source"]["sha256"]
    );
    dispatch("courseware.parseRelease", json!({"jobId":changed_job}))
        .await
        .unwrap();
}
