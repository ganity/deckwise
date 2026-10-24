use super::*;

#[tokio::test]
async fn courseware_task_selection_persists_and_is_session_scoped() {
    let dir = tempfile::tempdir().unwrap();
    let session_id = {
        let mut app = AppState::open(dir.path()).unwrap();
        app.handshook = true;
        let session = sessions::create_session(
            &app.db, None, None, None, None, Some(dir.path().to_string_lossy().into()),
        ).unwrap();
        let state = Arc::new(Mutex::new(app));
        let (tx, _) = mpsc::unbounded_channel();
        let selected = handle_request(state.clone(), "courseware.task.set", json!({
            "sessionId": session.id, "taskType": "scene",
            "educationContext": { "schoolStage": "kindergarten", "subject": "English" },
        }), tx.clone()).await.unwrap();
        assert_eq!(selected["task"]["taskType"], "scene");
        assert!(handle_request(state.clone(), "courseware.task.set", json!({
            "sessionId": session.id, "taskType": "unknown"
        }), tx.clone()).await.is_err());
        assert!(handle_request(state, "courseware.task.get", json!({
            "sessionId": "missing"
        }), tx).await.is_err());
        session.id
    };
    let mut app = AppState::open(dir.path()).unwrap();
    app.handshook = true;
    let (tx, _) = mpsc::unbounded_channel();
    let restored = handle_request(Arc::new(Mutex::new(app)), "courseware.task.get", json!({
        "sessionId": session_id,
    }), tx).await.unwrap();
    assert_eq!(restored["task"]["taskType"], "scene");
    assert_eq!(restored["task"]["educationContext"]["subject"], "English");
}

#[tokio::test]
async fn team_binding_is_persisted_and_cannot_be_silently_reassigned() {
    let dir = tempfile::tempdir().unwrap();
    let mut app = AppState::open(dir.path()).unwrap();
    app.handshook = true;
    let session = sessions::create_session(
        &app.db, None, None, None, None, Some(dir.path().to_string_lossy().into()),
    ).unwrap();
    let state = Arc::new(Mutex::new(app));
    let (tx, _) = mpsc::unbounded_channel();
    handle_request(state.clone(), "courseware.task.set", json!({
        "sessionId": session.id, "taskType": "import"
    }), tx.clone()).await.unwrap();
    let team = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    let bound = handle_request(state.clone(), "courseware.task.bindTeam", json!({
        "sessionId": session.id, "teamProjectId": team
    }), tx.clone()).await.unwrap();
    assert_eq!(bound["task"]["teamProjectId"], team);
    let replay = handle_request(state.clone(), "courseware.task.bindTeam", json!({
        "sessionId": session.id, "teamProjectId": team
    }), tx.clone()).await.unwrap();
    assert_eq!(replay, bound);
    let repeated_selection = handle_request(state.clone(), "courseware.task.set", json!({
        "sessionId": session.id, "taskType": "import"
    }), tx.clone()).await.unwrap();
    assert_eq!(repeated_selection, bound);
    let changed_selection = handle_request(state.clone(), "courseware.task.set", json!({
        "sessionId": session.id, "taskType": "plain"
    }), tx.clone()).await.unwrap();
    assert_eq!(changed_selection["task"]["teamProjectId"], team);
    assert!(handle_request(state.clone(), "courseware.task.bindTeam", json!({
        "sessionId": session.id, "teamProjectId": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
    }), tx.clone()).await.is_err());
    assert!(handle_request(state, "courseware.task.bindTeam", json!({
        "sessionId": session.id, "teamProjectId": "invalid"
    }), tx).await.is_err());
}

#[tokio::test]
async fn import_source_is_attached_once_inside_the_session_workspace() {
    let dir = tempfile::tempdir().unwrap();
    let mut app = AppState::open(dir.path()).unwrap();
    app.handshook = true;
    let session = sessions::create_session(
        &app.db, None, None, None, None, Some(dir.path().to_string_lossy().into()),
    ).unwrap();
    let state = Arc::new(Mutex::new(app));
    let (tx, _) = mpsc::unbounded_channel();
    handle_request(state.clone(), "courseware.task.set", json!({
        "sessionId": session.id, "taskType": "import"
    }), tx.clone()).await.unwrap();
    let outside = dir.path().join("outside.pptx");
    std::fs::write(&outside, b"fixture").unwrap();
    assert!(handle_request(state.clone(), "courseware.task.attachImport", json!({
        "sessionId": session.id, "path": outside
    }), tx.clone()).await.is_err());
    let imports = dir.path().join(".deckwise-ppt/imports");
    std::fs::create_dir_all(&imports).unwrap();
    let source = imports.join("lesson.pptx");
    std::fs::write(&source, b"fixture").unwrap();
    let attached = handle_request(state.clone(), "courseware.task.attachImport", json!({
        "sessionId": session.id, "path": source
    }), tx.clone()).await.unwrap();
    assert_eq!(attached["task"]["importPath"], source.to_string_lossy().as_ref());
    assert!(handle_request(state.clone(), "courseware.task.attachImport", json!({
        "sessionId": session.id, "path": source
    }), tx.clone()).await.is_err());
    assert!(handle_request(state, "courseware.task.set", json!({
        "sessionId": session.id, "taskType": "plain"
    }), tx).await.is_err());
}

#[tokio::test]
async fn imported_task_cannot_initialize_generated_narration() {
    let dir = tempfile::tempdir().unwrap();
    let mut app = AppState::open(dir.path()).unwrap();
    app.handshook = true;
    let session = sessions::create_session(
        &app.db, None, None, None, None, Some(dir.path().to_string_lossy().into()),
    ).unwrap();
    let state = Arc::new(Mutex::new(app));
    let (tx, _) = mpsc::unbounded_channel();
    handle_request(state.clone(), "courseware.task.set", json!({
        "sessionId": session.id, "taskType": "import"
    }), tx.clone()).await.unwrap();
    let result = handle_request(state, "courseware.project.initializeGenerated", json!({
        "sessionId": session.id, "jobId": "missing", "sourceSha256": "a".repeat(64), "title": "讲解",
        "narrations": ["讲解"]
    }), tx).await;
    assert!(result.is_err());
}

#[tokio::test]
async fn scene_task_attaches_only_the_initialized_generated_source() {
    use sha2::Digest;
    let dir = tempfile::tempdir().unwrap();
    let mut app = AppState::open(dir.path()).unwrap();
    app.handshook = true;
    let session = sessions::create_session(
        &app.db, None, None, None, None, Some(dir.path().to_string_lossy().into()),
    ).unwrap();
    let sha256 = hex::encode(sha2::Sha256::digest(b"generated-fixture"));
    let generated = dir.path().join(".deckwise-ppt/generated");
    std::fs::create_dir_all(&generated).unwrap();
    let path = generated.join(format!("{sha256}.pptx"));
    std::fs::write(&path, b"generated-fixture").unwrap();
    let project = serde_json::from_value(json!({
        "schemaVersion": "deckwise-courseware/1", "projectId": "office-scene-test",
        "taskType": "scene", "title": "问候", "source": { "revision": sha256, "sha256": sha256 },
        "teachingRevision": "teaching-1", "pages": [{ "pageId": "page-1", "actions": [
            { "id": "narration-0", "type": "speech", "text": "Hello" }
        ], "locked": false, "reviewState": "review" }]
    })).unwrap();
    app.db.create_courseware_project(dir.path().to_str().unwrap(), &project).unwrap();
    let state = Arc::new(Mutex::new(app));
    let (tx, _) = mpsc::unbounded_channel();
    handle_request(state.clone(), "courseware.task.set", json!({
        "sessionId": session.id, "taskType": "scene"
    }), tx.clone()).await.unwrap();
    let request = json!({ "sessionId": session.id, "path": path, "projectId": "office-scene-test", "sourceSha256": sha256 });
    let attached = handle_request(state.clone(), "courseware.task.attachGenerated", request.clone(), tx.clone()).await.unwrap();
    assert_eq!(attached["task"]["generatedPath"], path.to_string_lossy().as_ref());
    assert!(handle_request(state.clone(), "courseware.task.attachGenerated", request, tx.clone()).await.is_ok());
    assert!(handle_request(state, "courseware.task.set", json!({
        "sessionId": session.id, "taskType": "plain"
    }), tx).await.is_err());
}
