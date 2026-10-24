use super::*;
use crate::courseware::{identity::SavedSourceIdentity, SavedProjectSeed};

fn setup(dir: &Path) -> (AppState, String, Value) {
    let market = dir.join("plugins/market");
    std::fs::create_dir_all(&market).unwrap();
    std::fs::write(
        market.join("catalog.json"),
        serde_json::to_vec(&crate::plugins::built_in_catalog_at(dir)).unwrap(),
    )
    .unwrap();
    let mut state = AppState::open(dir).unwrap();
    state.handshook = true;
    let root = dir.to_str().unwrap();
    let session =
        sessions::create_session(&state.db, None, None, None, None, Some(root.into())).unwrap();
    let identity = SavedSourceIdentity::parse(include_bytes!(
        "../../courseware/identity/fixtures/identity.json"
    ))
    .unwrap();
    let seed = SavedProjectSeed {
        project_id: "office-chat-test".into(),
        sha256: identity.value()["sourceSha256"].as_str().unwrap().into(),
        pages: 1,
        identity: Some(identity),
    };
    state
        .db
        .open_identified_courseware_project(root, &seed)
        .unwrap();
    let args = json!({"projectId":hex::encode(Sha256::digest(root.as_bytes())),"documentId":"chat-test",
        "sessionId":"native-session","requestId":"native-request","editGeneration":1,"tool":"add_slide_text","input":{"text":"Pear"}});
    (state, session.id, args)
}

fn request(session: &str, args: &Value, call: &str) -> ToolsExecuteParams {
    serde_json::from_value(
        json!({"sessionId":session,"turnId":"turn-1","toolCallId":call,
        "toolName":"ppt_add_slide_text","mode":"agent","args":args}),
    )
    .unwrap()
}

fn context(state: &AppState, root: &str) -> Value {
    state
        .db
        .courseware_project_context(root, "office-chat-test")
        .unwrap()
}

#[tokio::test]
async fn declared_chat_plan_uses_actual_permission_and_never_dispatches_native_commands() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_str().unwrap();
    let (state, session, native) = setup(dir.path());
    let original = context(&state, root)["project"].clone();
    state
        .db
        .set_setting("app", &json!({"defaultPermissionMode":"ask"}))
        .unwrap();
    let args = json!({"baseline":{"projectId":native["projectId"],"documentId":"chat-test","sessionId":"native-session",
        "editGeneration":1,"coursewareProjectId":"office-chat-test","pageId":original["pages"][0]["pageId"],
        "sourceRevision":original["source"]["revision"],"sourceSha256":original["source"]["sha256"],
        "teachingRevision":original["teachingRevision"],"contentSha256":"a".repeat(64)},"pageNumber":1,
        "changes":[{"toolName":"ppt_add_slide_text","label":"Edit page"},{"toolName":"ppt_propose_page_narration","label":"Also rewrite narration"}]});
    let params = json!({"sessionId":session,"turnId":"planned-turn","toolCallId":"plan-1","toolName":"ppt_record_change_plan",
        "mode":"agent","declaredRisk":"low","args":args});
    let state = Arc::new(Mutex::new(state));
    let (tx, mut rx) = mpsc::unbounded_channel();
    for decision in ["deny", "allow-once"] {
        let task = tokio::spawn(handle_request(
            state.clone(),
            "tools.execute",
            params.clone(),
            tx.clone(),
        ));
        let notice: Value = serde_json::from_str(
            &tokio::time::timeout(Duration::from_secs(5), rx.recv())
                .await
                .unwrap()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(notice["method"], "permissions.request");
        assert_eq!(notice["params"]["risk"], "high");
        assert!(context(&*state.lock().await, root)["chatChanges"]
            .as_array()
            .is_none_or(|changes| changes.is_empty()));
        handle_request(
            state.clone(),
            "permissions.resolve",
            json!({"requestId":notice["params"]["requestId"],"decision":decision}),
            tx.clone(),
        )
        .await
        .unwrap();
        let result = task.await.unwrap().unwrap();
        assert_eq!(result["ok"], decision == "allow-once");
        assert!(
            rx.try_recv().is_err(),
            "Recording a plan cannot dispatch an Office operation"
        );
    }
    let saved = context(&*state.lock().await, root);
    assert_eq!(saved["project"], original);
    assert_eq!(
        saved["chatChanges"][0]["plan"]["items"][1]["status"],
        "not-recorded"
    );
    sessions::configure_session(&state.lock().await.db, &session, "plan", None, None).unwrap();
    assert_eq!(
        handle_request(state.clone(), "tools.execute", params, tx.clone())
            .await
            .unwrap()["ok"],
        false
    );
    assert!(rx.try_recv().is_err());
    assert_eq!(context(&*state.lock().await, root), saved);
}

#[tokio::test]
async fn intent_is_durable_before_dispatch_and_lost_ack_cannot_replay_after_restart() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_str().unwrap();
    let (state, session, args) = setup(dir.path());
    let baseline = context(&state, root)["project"].clone();
    let state = Arc::new(Mutex::new(state));
    let (tx, mut rx) = mpsc::unbounded_channel();
    let p = request(&session, &args, "edit-1");
    let operation = tokio::spawn({
        let state = state.clone();
        let tx = tx.clone();
        async move { execute_plugin_tool(&state, &tx, &p, 60_000, "agent", None).await }
    });
    let dispatch: Value = serde_json::from_str(&rx.recv().await.unwrap()).unwrap();
    assert_eq!(dispatch["method"], "plugins.execute");
    let saved = context(&*state.lock().await, root);
    assert_eq!(saved["project"], baseline);
    assert_eq!(
        saved["chatChanges"][0]["operations"][0]["outcome"],
        Value::Null
    );
    // Simulate losing both processes after the native dispatch, before its acknowledgement.
    operation.abort();
    assert!(operation.await.unwrap_err().is_cancelled());
    drop(state);
    let mut restored = AppState::open(dir.path()).unwrap();
    restored.handshook = true;
    let saved = context(&restored, root);
    assert_eq!(
        saved["chatChanges"][0]["operations"][0]["outcome"],
        Value::Null
    );
    let state = Arc::new(Mutex::new(restored));
    let result = execute_plugin_tool(
        &state,
        &tx,
        &request(&session, &args, "edit-1"),
        100,
        "agent",
        None,
    )
    .await;
    assert!(!result.ok);
    assert_eq!(
        result.error_code.as_deref(),
        Some("COURSEWARE_CHAT_RECEIPT_FAILED")
    );
    assert!(rx.try_recv().is_err());
    assert_eq!(context(&*state.lock().await, root)["project"], baseline);
}

#[tokio::test]
async fn same_turn_retains_native_success_and_failed_narration_without_mutating_teaching() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_str().unwrap();
    let (state, session, args) = setup(dir.path());
    let baseline = context(&state, root)["project"].clone();
    let state = Arc::new(Mutex::new(state));
    let (tx, mut rx) = mpsc::unbounded_channel();
    for (index, name, ok, content) in [
        (
            0,
            "ppt_add_slide_text",
            true,
            json!({"status":"verified","result":{"page":1,"verified":true}}),
        ),
        (
            1,
            "ppt_propose_page_narration",
            false,
            json!({"error":"fixture generation failure"}),
        ),
    ] {
        let mut p = request(&session, &args, &format!("step-{index}"));
        p.tool_name = name.into();
        if index == 1 {
            p.args = json!({"baseline":{"projectId":args["projectId"],"documentId":"chat-test"},"instruction":"Also change narration"});
        }
        let pending = tokio::spawn({
            let state = state.clone();
            let tx = tx.clone();
            async move { execute_plugin_tool(&state, &tx, &p, 1000, "agent", None).await }
        });
        let dispatch: Value = serde_json::from_str(&rx.recv().await.unwrap()).unwrap();
        state.lock().await.plugin_execs.remove(dispatch["params"]["executionId"].as_str().unwrap()).unwrap()
            .send(json!({"ok":ok,"content":content,"errorCode":if ok{Value::Null}else{json!("PPT_EDITOR_REJECTED")}})).unwrap();
        assert_eq!(pending.await.unwrap().ok, ok);
    }
    let saved = context(&*state.lock().await, root);
    assert_eq!(saved["project"], baseline);
    assert_eq!(saved["chatChanges"].as_array().unwrap().len(), 1);
    let ops = saved["chatChanges"][0]["operations"].as_array().unwrap();
    assert_eq!(ops.len(), 2);
    assert_eq!(ops[0]["outcome"]["state"], "acknowledged");
    assert_eq!(ops[0]["outcome"]["saved"], false);
    assert_eq!(ops[1]["outcome"]["state"], "uncertain");
    assert!(ops.iter().all(|op| op.get("args").is_none()));
}

#[tokio::test]
async fn receipt_write_failure_blocks_dispatch_and_outcome_failure_retains_pending() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_str().unwrap();
    let (state, session, args) = setup(dir.path());
    let state = Arc::new(Mutex::new(state));
    let external = rusqlite::Connection::open(dir.path().join("pi.sqlite")).unwrap();
    external.execute_batch("CREATE TRIGGER fail_chat BEFORE INSERT ON kv WHEN NEW.ns='coursewareChatChanges.v1' BEGIN SELECT RAISE(ABORT,'fixture intent failure'); END;").unwrap();
    let (tx, mut rx) = mpsc::unbounded_channel();
    let result = execute_plugin_tool(
        &state,
        &tx,
        &request(&session, &args, "blocked"),
        100,
        "agent",
        None,
    )
    .await;
    assert!(!result.ok);
    assert!(rx.try_recv().is_err());
    external.execute_batch("DROP TRIGGER fail_chat;").unwrap();
    let p = request(&session, &args, "lost-outcome");
    let operation = tokio::spawn({
        let state = state.clone();
        let tx = tx.clone();
        async move { execute_plugin_tool(&state, &tx, &p, 1000, "agent", None).await }
    });
    let dispatch: Value = serde_json::from_str(&rx.recv().await.unwrap()).unwrap();
    external.execute_batch("CREATE TRIGGER fail_outcome BEFORE UPDATE ON kv WHEN NEW.ns='coursewareChatChanges.v1' BEGIN SELECT RAISE(ABORT,'fixture outcome failure'); END;").unwrap();
    state
        .lock()
        .await
        .plugin_execs
        .remove(dispatch["params"]["executionId"].as_str().unwrap())
        .unwrap()
        .send(json!({"ok":true,"content":{"status":"verified","result":{"page":1}}}))
        .unwrap();
    assert!(!operation.await.unwrap().ok);
    assert!(
        context(&*state.lock().await, root)["chatChanges"][0]["operations"][0]["outcome"].is_null()
    );
}

#[test]
fn workspace_isolation_read_only_tools_and_generic_editing_do_not_create_receipts() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_str().unwrap();
    let (state, session, args) = setup(dir.path());
    let mut p = request(&session, &args, "read");
    p.tool_name = "ppt_get_context".into();
    assert!(prepare(&state, &p).unwrap().is_none());
    p.tool_name = "ppt_add_slide_text".into();
    p.args["documentId"] = json!("uninitialized");
    assert!(prepare(&state, &p).unwrap().is_none());
    p.args = args;
    p.args["projectId"] = json!("foreign-workspace");
    assert!(prepare(&state, &p).is_err());
    assert!(context(&state, root).get("chatChanges").is_none());
}
