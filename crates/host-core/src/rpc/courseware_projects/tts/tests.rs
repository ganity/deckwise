use super::*;

#[tokio::test]
async fn private_rpc_uses_persisted_session_and_never_accepts_input_or_workspace_override() {
    let dir = tempfile::tempdir().unwrap();
    let first = dir.path().join("first");
    let second = dir.path().join("second");
    std::fs::create_dir(&first).unwrap();
    std::fs::create_dir(&second).unwrap();
    let mut app = AppState::open(dir.path()).unwrap();
    app.handshook = true;
    let raw: Value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../packages/shared/src/courseware-contract.fixtures/accepted.json"
    )))
    .unwrap();
    let project = serde_json::from_value(raw["project"].clone()).unwrap();
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
    let selection = json!({"intentId":"intent-1","principalKey":"a".repeat(64),"projectId":"course-01",
        "pageId":"fixture-page-1","actionId":"narration-0","expectedSourceRevision":"R8",
        "expectedTeachingRevision":"T8","model":"courseware-tts-v1","voice":null});
    let state = Arc::new(Mutex::new(app));
    let (tx, _rx) = mpsc::unbounded_channel();
    let prepare = json!({"sessionId":a.id,"selection":selection});
    let mut forged = prepare.clone();
    forged["workspace"] = json!(first);
    assert_eq!(
        super::super::super::handle_request(
            state.clone(),
            "courseware.tts.prepare",
            forged,
            tx.clone()
        )
        .await
        .unwrap_err()
        .code,
        1002
    );
    let mut forged = prepare.clone();
    forged["selection"]["input"] = json!("forged narration");
    assert_eq!(
        super::super::super::handle_request(
            state.clone(),
            "courseware.tts.prepare",
            forged,
            tx.clone()
        )
        .await
        .unwrap_err()
        .code,
        1002
    );
    let saved = super::super::super::handle_request(
        state.clone(),
        "courseware.tts.prepare",
        prepare,
        tx.clone(),
    )
    .await
    .unwrap();
    assert_eq!(saved["intent"]["request"]["input"], "Look at the square.");
    let get = json!({"sessionId":a.id,"projectId":"course-01","principalKey":"a".repeat(64),"intentId":"intent-1"});
    let mut other = get.clone();
    other["sessionId"] = json!(b.id);
    assert_eq!(
        super::super::super::handle_request(state.clone(), "courseware.tts.get", other, tx.clone())
            .await
            .unwrap_err()
            .code,
        1007
    );
    super::super::super::handle_request(state.clone(), "courseware.task.set", json!({
        "sessionId":a.id,"taskType":"plain"
    }), tx.clone()).await.unwrap();
    let team = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    super::super::super::handle_request(state.clone(), "courseware.task.bindTeam", json!({
        "sessionId":a.id,"teamProjectId":team
    }), tx.clone()).await.unwrap();
    let uncertain = super::super::super::handle_request(
        state.clone(),
        "courseware.tts.begin",
        get.clone(),
        tx.clone(),
    )
    .await
    .unwrap();
    assert_eq!(uncertain["intent"]["phase"], "submission-unknown");
    assert_eq!(uncertain["intent"]["submissionScope"], json!({"sessionId":a.id,"teamProjectId":team}));
    assert!(super::super::super::handle_request(state.clone(), "courseware.tts.begin", get.clone(), tx.clone()).await.is_err());
    let mut bind = get.clone();
    bind["taskRef"] = json!({"taskId":"remote-task","idempotencyKey":saved["intent"]["idempotencyKey"],"requestHash":saved["intent"]["requestHash"]});
    let bound =
        super::super::super::handle_request(state.clone(), "courseware.tts.bind", bind, tx.clone())
            .await
            .unwrap();
    assert_eq!(bound["intent"]["phase"], "submitted");
    drop(state);
    let mut app = AppState::open(dir.path()).unwrap();
    app.handshook = true;
    let state = Arc::new(Mutex::new(app));
    assert_eq!(
        super::super::super::handle_request(state.clone(), "courseware.tts.get", get, tx.clone())
            .await
            .unwrap(),
        bound
    );
    let list = super::super::super::handle_request(
        state,
        "courseware.tts.list",
        json!({"sessionId":a.id,"projectId":"course-01","principalKey":"a".repeat(64)}),
        tx,
    )
    .await
    .unwrap();
    assert_eq!(list["intents"].as_array().unwrap().len(), 1);
}
