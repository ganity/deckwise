use super::*;

#[tokio::test]
async fn courseware_draft_never_acknowledges_ignored_storage_or_missing_parameters() {
    let dir = tempfile::tempdir().unwrap();
    let mut app = AppState::open(dir.path()).unwrap();
    app.handshook = true;
    let session = sessions::create_session(
        &app.db,
        None,
        None,
        None,
        None,
        Some(dir.path().to_string_lossy().into()),
    )
    .unwrap();
    let raw: Value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../packages/shared/src/courseware-contract.fixtures/accepted.json"
    )))
    .unwrap();
    let project = serde_json::from_value(raw["project"].clone()).unwrap();
    app.db
        .create_courseware_project(dir.path().to_str().unwrap(), &project)
        .unwrap();
    let state = Arc::new(Mutex::new(app));
    let (tx, _) = mpsc::unbounded_channel();
    let mut params = json!({ "sessionId": session.id, "projectId": raw["project"]["projectId"], "pageId": raw["project"]["pages"][0]["pageId"],
        "expectedRevision": null, "draft": { "baseline": raw["project"], "actions": [{ "id": "speech", "type": "speech", "text": "Draft" }], "instruction": "" } });
    for field in ["expectedRevision", "draft"] {
        let mut missing = params.clone();
        missing.as_object_mut().unwrap().remove(field);
        assert!(handle_request(
            state.clone(),
            "courseware.teachingDraft.set",
            missing,
            tx.clone()
        )
        .await
        .is_err());
    }
    state.lock().await.db.conn().execute_batch("CREATE TRIGGER ignore_draft BEFORE INSERT ON kv WHEN NEW.ns='coursewareTeachingDrafts.v1' BEGIN SELECT RAISE(IGNORE); END;").unwrap();
    assert!(handle_request(
        state.clone(),
        "courseware.teachingDraft.set",
        params.clone(),
        tx.clone()
    )
    .await
    .is_err());
    state
        .lock()
        .await
        .db
        .conn()
        .execute_batch("DROP TRIGGER ignore_draft;")
        .unwrap();
    let stored = handle_request(
        state.clone(),
        "courseware.teachingDraft.set",
        params.clone(),
        tx.clone(),
    )
    .await
    .unwrap();
    params["expectedRevision"] = stored["draft"]["revision"].clone();
    params["draft"] = Value::Null;
    state.lock().await.db.conn().execute_batch("CREATE TRIGGER ignore_draft BEFORE DELETE ON kv WHEN OLD.ns='coursewareTeachingDrafts.v1' BEGIN SELECT RAISE(IGNORE); END;").unwrap();
    assert!(
        handle_request(state.clone(), "courseware.teachingDraft.set", params, tx)
            .await
            .is_err()
    );
}

#[tokio::test]
async fn courseware_draft_restart_isolation_cas_and_stale_recovery() {
    let dir = tempfile::tempdir().unwrap();
    let (session_id, other_id, identity, baseline, revision) = {
        let mut app = AppState::open(dir.path()).unwrap();
        app.handshook = true;
        let create = || {
            sessions::create_session(
                &app.db,
                None,
                None,
                None,
                None,
                Some(dir.path().to_string_lossy().into()),
            )
            .unwrap()
        };
        let session = create();
        let other = create();
        let raw: Value = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../packages/shared/src/courseware-contract.fixtures/accepted.json"
        )))
        .unwrap();
        let project = serde_json::from_value(raw["project"].clone()).unwrap();
        app.db
            .create_courseware_project(dir.path().to_str().unwrap(), &project)
            .unwrap();
        let identity = json!({ "sessionId": session.id, "projectId": raw["project"]["projectId"], "pageId": raw["project"]["pages"][0]["pageId"] });
        let baseline = raw["project"].clone();
        let state = Arc::new(Mutex::new(app));
        let (tx, _) = mpsc::unbounded_channel();
        let mut params = identity.clone();
        params["expectedRevision"] = Value::Null;
        params["draft"] = json!({ "baseline": baseline, "actions": [{ "id": "draft-1", "type": "speech", "text": "" }], "instruction": "Short sentences" });
        let stored = handle_request(
            state.clone(),
            "courseware.teachingDraft.set",
            params.clone(),
            tx.clone(),
        )
        .await
        .unwrap();
        assert_eq!(stored["draft"]["instruction"], "Short sentences");
        assert_eq!(stored["draft"]["actions"][0]["text"], "");
        let revision = stored["draft"]["revision"].clone();
        assert!(handle_request(
            state.clone(),
            "courseware.teachingDraft.set",
            params.clone(),
            tx.clone()
        )
        .await
        .is_err());
        params["expectedRevision"] = revision.clone();
        params["draft"]["baseline"]["teachingRevision"] = json!("forged");
        assert!(handle_request(
            state.clone(),
            "courseware.teachingDraft.set",
            params.clone(),
            tx.clone()
        )
        .await
        .is_err());
        params["draft"]["baseline"] = baseline.clone();
        params["draft"]["instruction"] = json!("x".repeat(4001));
        assert!(handle_request(
            state.clone(),
            "courseware.teachingDraft.set",
            params,
            tx.clone()
        )
        .await
        .is_err());
        let mut other_identity = identity.clone();
        other_identity["sessionId"] = json!(other.id);
        assert_eq!(
            handle_request(
                state.clone(),
                "courseware.teachingDraft.get",
                other_identity,
                tx.clone()
            )
            .await
            .unwrap()["draft"],
            Value::Null
        );
        let mut other_page = identity.clone();
        other_page["pageId"] = baseline["pages"][1]["pageId"].clone();
        assert_eq!(
            handle_request(
                state.clone(),
                "courseware.teachingDraft.get",
                other_page,
                tx.clone()
            )
            .await
            .unwrap()["draft"],
            Value::Null
        );
        let project = state
            .lock()
            .await
            .db
            .get_courseware_project(
                dir.path().to_str().unwrap(),
                baseline["projectId"].as_str().unwrap(),
            )
            .unwrap()
            .unwrap();
        assert_eq!(serde_json::to_value(project).unwrap(), baseline);
        (session.id, other.id, identity, baseline, revision)
    };
    let mut app = AppState::open(dir.path()).unwrap();
    app.handshook = true;
    let state = Arc::new(Mutex::new(app));
    let (tx, _) = mpsc::unbounded_channel();
    let restored = handle_request(
        state.clone(),
        "courseware.teachingDraft.get",
        identity.clone(),
        tx.clone(),
    )
    .await
    .unwrap();
    assert_eq!(restored["draft"]["revision"], revision);
    assert_eq!(restored["draft"]["baseline"], baseline);
    handle_request(state.clone(), "courseware.teaching.setLock", json!({
        "sessionId": session_id, "projectId": baseline["projectId"], "pageId": baseline["pages"][0]["pageId"],
        "expectedSourceRevision": baseline["source"]["revision"], "expectedTeachingRevision": baseline["teachingRevision"], "locked": true
    }), tx.clone()).await.unwrap();
    assert_eq!(
        handle_request(
            state.clone(),
            "courseware.teachingDraft.get",
            identity.clone(),
            tx.clone()
        )
        .await
        .unwrap(),
        restored
    );
    let mut update = identity.clone();
    update["expectedRevision"] = revision.clone();
    update["draft"] = json!({ "baseline": baseline, "actions": [], "instruction": "late write" });
    assert!(handle_request(
        state.clone(),
        "courseware.teachingDraft.set",
        update.clone(),
        tx.clone()
    )
    .await
    .is_err());
    update["draft"] = Value::Null;
    assert_eq!(
        handle_request(
            state.clone(),
            "courseware.teachingDraft.set",
            update,
            tx.clone()
        )
        .await
        .unwrap()["draft"],
        Value::Null
    );
    assert_eq!(
        handle_request(
            state.clone(),
            "courseware.teachingDraft.get",
            identity.clone(),
            tx.clone()
        )
        .await
        .unwrap()["draft"],
        Value::Null
    );
    let mut missing = identity.clone();
    missing["sessionId"] = json!("missing-session");
    assert!(handle_request(
        state.clone(),
        "courseware.teachingDraft.get",
        missing,
        tx.clone()
    )
    .await
    .is_err());
    let mut foreign = identity;
    foreign["sessionId"] = json!(other_id);
    foreign["workspace"] = json!("/tmp");
    assert!(
        handle_request(state, "courseware.teachingDraft.get", foreign, tx)
            .await
            .is_err()
    );
}
