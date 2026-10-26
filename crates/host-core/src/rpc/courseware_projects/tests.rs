use super::*;

#[tokio::test]
async fn rpc_follows_persisted_session_and_rejects_stale_or_forged_requests() {
    let dir = tempfile::tempdir().unwrap();
    let first = dir.path().join("first");
    let second = dir.path().join("second");
    std::fs::create_dir_all(&first).unwrap();
    std::fs::create_dir_all(&second).unwrap();
    let mut app = AppState::open(dir.path()).unwrap();
    app.handshook = true;
    let fixture: Value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../packages/shared/src/courseware-contract.fixtures/accepted.json"
    )))
    .unwrap();
    let project = serde_json::from_value(fixture["project"].clone()).unwrap();
    app.db
        .create_courseware_project(first.to_str().unwrap(), &project)
        .unwrap();
    let a = sessions::create_session(
        &app.db,
        None,
        None,
        None,
        None,
        Some(first.to_string_lossy().into()),
    )
    .unwrap();
    let b = sessions::create_session(
        &app.db,
        None,
        None,
        None,
        None,
        Some(second.to_string_lossy().into()),
    )
    .unwrap();
    app.workspace.set(second);
    let state = Arc::new(Mutex::new(app));
    let (tx, _rx) = mpsc::unbounded_channel();
    let get = json!({ "sessionId": a.id, "projectId": "course-01" });
    let loaded = super::super::handle_request(
        state.clone(),
        "courseware.project.get",
        get.clone(),
        tx.clone(),
    )
    .await
    .unwrap();
    assert_eq!(loaded["project"], fixture["project"]);
    let invisible = super::super::handle_request(
        state.clone(),
        "courseware.project.get",
        json!({ "sessionId": b.id, "projectId": "course-01" }),
        tx.clone(),
    )
    .await
    .unwrap();
    assert_eq!(invisible["project"], Value::Null);
    let unknown = super::super::handle_request(
        state.clone(),
        "courseware.project.get",
        json!({ "sessionId": "missing", "projectId": "course-01" }),
        tx.clone(),
    )
    .await
    .unwrap_err();
    assert_eq!(unknown.code, 1007);
    let mut forged = get.clone();
    forged["workspace"] = json!(first);
    assert_eq!(
        super::super::handle_request(state.clone(), "courseware.project.get", forged, tx.clone())
            .await
            .unwrap_err()
            .code,
        1002
    );
    let write = json!({ "sessionId": a.id, "write": fixture["write"] });
    let saved = super::super::handle_request(
        state.clone(),
        "courseware.teaching.write",
        write.clone(),
        tx.clone(),
    )
    .await
    .unwrap();
    assert_eq!(
        saved["project"]["pages"][0]["actions"],
        fixture["write"]["actions"]
    );
    let stale = super::super::handle_request(
        state.clone(),
        "courseware.teaching.write",
        write,
        tx.clone(),
    )
    .await
    .unwrap_err();
    assert_eq!(stale.code, 1008);
    let locked = super::super::handle_request(state.clone(), "courseware.teaching.setLock", json!({
        "sessionId": a.id, "projectId": "course-01", "pageId": "fixture-page-1",
        "expectedSourceRevision": "R8", "expectedTeachingRevision": saved["project"]["teachingRevision"], "locked": true
    }), tx.clone()).await.unwrap();
    let denied = super::super::handle_request(state, "courseware.teaching.write", json!({
        "sessionId": a.id, "write": { "expectedTeachingRevision": locked["project"]["teachingRevision"],
            "projectId": "course-01", "pageId": "fixture-page-1", "expectedSourceRevision": "R8", "actions": [] }
    }), tx).await.unwrap_err();
    assert_eq!(denied.code, 1008);
    assert!(denied.message.starts_with("COURSEWARE_LOCKED"));
}
