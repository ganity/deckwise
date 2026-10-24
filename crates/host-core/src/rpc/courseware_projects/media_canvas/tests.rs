use super::*;

pub(super) fn document(project_id: &Value) -> Value {
    json!({ "version": 1, "projectId": project_id, "revision": 0, "viewport": { "x": 24, "y": 24, "zoom": 1 },
        "drafts": [{ "id": "image-1", "revision": 0, "kind": "image", "title": "Picture", "prompt": "Original", "references": [], "x": 100, "y": 200 }] })
}

pub(super) fn setup(dir: &std::path::Path) -> (Arc<Mutex<AppState>>, Value, Value, Value) {
    let mut app = AppState::open(dir).unwrap();
    app.handshook = true;
    let session = sessions::create_session(&app.db, None, None, None, None, Some(dir.to_string_lossy().into())).unwrap();
    let other = sessions::create_session(&app.db, None, None, None, None, Some(dir.to_string_lossy().into())).unwrap();
    let raw: Value = serde_json::from_str(include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../packages/shared/src/courseware-contract.fixtures/accepted.json"))).unwrap();
    app.db.create_courseware_project(dir.to_str().unwrap(), &serde_json::from_value(raw["project"].clone()).unwrap()).unwrap();
    app.db.kv_set(TASK_NAMESPACE, &session.id, &json!({ "taskType": "scene" })).unwrap();
    app.db.kv_set(TASK_NAMESPACE, &other.id, &json!({ "taskType": "plain" })).unwrap();
    let identity = json!({ "sessionId": session.id, "projectId": format!("canvas:{}", session.id) });
    let other = json!({ "sessionId": other.id, "projectId": format!("canvas:{}", other.id) });
    (Arc::new(Mutex::new(app)), identity, other, raw["project"].clone())
}

#[tokio::test]
async fn media_canvas_roundtrip_restart_cas_and_private_session_scope() {
    let dir = tempfile::tempdir().unwrap();
    let (state, scope, other, baseline) = setup(dir.path());
    let mut write = scope.clone(); write["expectedRevision"] = Value::Null; write["document"] = document(&scope["projectId"]);
    let (tx, _) = mpsc::unbounded_channel();
    let saved = handle_request(state.clone(), "courseware.mediaCanvas.set", write.clone(), tx).await.unwrap();
    assert!(handle(state.clone(), "courseware.mediaCanvas.set", write.clone()).await.is_err());
    assert_eq!(handle(state.clone(), "courseware.mediaCanvas.get", other).await.unwrap()["document"], Value::Null);
    assert_eq!(handle(state.clone(), "courseware.mediaCanvas.get", scope.clone()).await.unwrap(), saved);
    let mut edit = scope.clone(); edit["expectedRevision"] = saved["revision"].clone(); edit["draftId"] = json!("image-1"); edit["expectedDraftRevision"] = json!(0);
    edit["patch"] = json!({ "prompt": "Chat edited", "references": [{ "assetId": "reference", "revision": "sha256:123", "label": "Reference" }] });
    let changed = handle(state.clone(), "courseware.mediaCanvas.editDraft", edit.clone()).await.unwrap();
    assert_eq!(changed["document"]["drafts"][0]["prompt"], "Chat edited");
    assert_eq!(changed["document"]["drafts"][0]["x"].as_f64(), Some(100.0));
    assert!(handle(state.clone(), "courseware.mediaCanvas.editDraft", edit).await.is_err());
    assert_eq!(serde_json::to_value(state.lock().await.db.get_courseware_project(dir.path().to_str().unwrap(), baseline["projectId"].as_str().unwrap()).unwrap().unwrap()).unwrap(), baseline);
    drop(state);
    let mut app = AppState::open(dir.path()).unwrap(); app.handshook = true;
    let state = Arc::new(Mutex::new(app));
    assert_eq!(handle(state.clone(), "courseware.mediaCanvas.get", scope.clone()).await.unwrap(), changed);
    let mut wrong = scope.clone(); wrong["projectId"] = json!("unrelated-project");
    assert!(handle(state.clone(), "courseware.mediaCanvas.get", wrong).await.is_err());
    let mut missing_session = scope; missing_session["sessionId"] = json!("missing");
    assert!(handle(state.clone(), "courseware.mediaCanvas.get", missing_session).await.is_err());
    let foreign = tempfile::tempdir().unwrap();
    let session = sessions::create_session(&state.lock().await.db, None, None, None, None, Some(foreign.path().to_string_lossy().into())).unwrap();
    assert!(handle(state, "courseware.mediaCanvas.get", json!({ "sessionId": session.id, "projectId": baseline["projectId"] })).await.is_err());
}

#[tokio::test]
async fn media_canvas_rejects_ignored_storage_unknown_patch_missing_revision_and_forged_content() {
    let dir = tempfile::tempdir().unwrap();
    let (state, scope, _, _) = setup(dir.path());
    let mut write = scope.clone(); write["document"] = document(&scope["projectId"]);
    assert!(handle(state.clone(), "courseware.mediaCanvas.set", write.clone()).await.is_err());
    write["expectedRevision"] = Value::Null;
    for bad in [json!("NaN"), json!(100_001)] {
        let mut invalid = write.clone(); invalid["document"]["drafts"][0]["x"] = bad;
        assert!(handle(state.clone(), "courseware.mediaCanvas.set", invalid).await.is_err());
    }
    let mut invalid = write.clone(); invalid["document"]["projectId"] = json!("forged");
    assert!(handle(state.clone(), "courseware.mediaCanvas.set", invalid).await.is_err());
    state.lock().await.db.conn().execute_batch("CREATE TRIGGER ignore_canvas BEFORE INSERT ON kv WHEN NEW.ns='coursewareMediaCanvas.v1' BEGIN SELECT RAISE(IGNORE); END;").unwrap();
    assert!(handle(state.clone(), "courseware.mediaCanvas.set", write.clone()).await.is_err());
    state.lock().await.db.conn().execute_batch("DROP TRIGGER ignore_canvas;").unwrap();
    let stored = handle(state.clone(), "courseware.mediaCanvas.set", write.clone()).await.unwrap();
    write["expectedRevision"] = stored["revision"].clone();
    write["document"]["revision"] = json!(1);
    write["document"]["drafts"][0]["prompt"] = json!("changed without increasing draft revision");
    assert!(handle(state.clone(), "courseware.mediaCanvas.set", write).await.is_err());
    let mut edit = scope; edit["expectedRevision"] = stored["revision"].clone(); edit["draftId"] = json!("image-1"); edit["expectedDraftRevision"] = json!(0);
    edit["patch"] = json!({ "generate": true });
    assert!(handle(state, "courseware.mediaCanvas.editDraft", edit).await.is_err());
}

#[tokio::test]
async fn media_canvas_supports_pre_pptx_tasks_and_rejects_missing_task_plan_mode_and_wrong_owner() {
    let dir = tempfile::tempdir().unwrap();
    let mut app = AppState::open(dir.path()).unwrap(); app.handshook = true;
    let session = sessions::create_session(&app.db, None, None, None, None, Some(dir.path().to_string_lossy().into())).unwrap();
    let state = Arc::new(Mutex::new(app));
    let scope = json!({ "sessionId": session.id, "projectId": format!("canvas:{}", session.id) });
    assert!(handle(state.clone(), "courseware.mediaCanvas.get", scope.clone()).await.is_err());
    state.lock().await.db.kv_set(TASK_NAMESPACE, &session.id, &json!({ "taskType": "plain" })).unwrap();
    let mut write = scope.clone(); write["expectedRevision"] = Value::Null; write["document"] = document(&scope["projectId"]);
    let saved = handle(state.clone(), "courseware.mediaCanvas.set", write.clone()).await.unwrap();
    assert_eq!(saved["document"]["drafts"][0]["prompt"], "Original");
    state.lock().await.db.conn().execute("UPDATE sessions SET mode='plan' WHERE id=?1", [&session.id]).unwrap();
    assert_eq!(handle(state.clone(), "courseware.mediaCanvas.get", scope.clone()).await.unwrap(), saved);
    write["expectedRevision"] = saved["revision"].clone(); write["document"]["revision"] = json!(1);
    assert!(handle(state.clone(), "courseware.mediaCanvas.set", write).await.is_err());
    let mut wrong = scope; wrong["projectId"] = json!("canvas:another-session");
    assert!(handle(state, "courseware.mediaCanvas.get", wrong).await.is_err());
}
