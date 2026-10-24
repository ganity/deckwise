use super::*;

#[tokio::test]
async fn ppt_editor_tools_reuse_permission_dispatch_and_cancellation() {
    for name in [
        "ppt_add_slide_text",
        "ppt_replace_slide_image_from_asset",
        "ppt_set_slide_text_bold",
        "ppt_set_slide_text_box_size",
        "ppt_set_slide_image_size",
        "ppt_set_slide_image_position",
        "ppt_add_slide_object_animation",
        "ppt_insert_slide_image_from_asset",
        "ppt_set_slide_fade",
        "ppt_set_slide_font_family",
        "ppt_set_slide_font_size",
        "ppt_set_slide_text_color",
        "ppt_set_slide_text_box_position",
        "ppt_propose_page_narration",
        "ppt_propose_page_redo",
        "ppt_propose_page_style_batch",
        "ppt_propose_page_fade",
    ] {
        eprintln!("Checking PPT permission/dispatch/cancellation: {name}");
        tokio::time::timeout(std::time::Duration::from_secs(10), assert_ppt_tool(name))
            .await
            .expect("PPT permission/cancellation flow timed out");
    }
}

async fn assert_ppt_tool(tool_name: &str) {
    let dir = tempfile::tempdir().unwrap();
    // Permission tests use the bundled catalog, independent of marketplace availability.
    let market = dir.path().join("plugins/market");
    std::fs::create_dir_all(&market).unwrap();
    std::fs::write(
        market.join("catalog.json"),
        serde_json::to_vec(&crate::plugins::built_in_catalog_at(dir.path())).unwrap(),
    )
    .unwrap();
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
    app.db
        .set_setting("app", &json!({ "defaultPermissionMode": "ask" }))
        .unwrap();
    let state = Arc::new(Mutex::new(app));
    let (tx, mut rx) = mpsc::unbounded_channel();
    let params = json!({ "sessionId": session.id, "turnId": "turn-1", "toolCallId": "edit-1", "toolName": tool_name, "mode": "agent", "declaredRisk": "low", "args": { "input": { "text": "New text" } } });
    let pending = tokio::spawn(handle_request(
        state.clone(),
        "tools.execute",
        params.clone(),
        tx.clone(),
    ));
    let request: Value = serde_json::from_str(
        &tokio::time::timeout(std::time::Duration::from_secs(5), rx.recv())
            .await
            .expect("permission notification timed out")
            .unwrap(),
    )
    .unwrap();
    assert_eq!(request["method"], "permissions.request");
    assert_eq!(request["params"]["risk"], "high");
    assert!(rx.try_recv().is_err());
    handle_request(
        state.clone(),
        "permissions.resolve",
        json!({ "requestId": request["params"]["requestId"], "decision": "allow-once" }),
        tx.clone(),
    )
    .await
    .unwrap();
    let dispatch: Value = serde_json::from_str(&rx.recv().await.unwrap()).unwrap();
    assert_eq!(dispatch["method"], "plugins.execute");
    assert_eq!(dispatch["params"]["toolName"], tool_name);
    assert_eq!(dispatch["params"]["turnId"], "turn-1");
    handle_request(state.clone(), "plugins.resolveExecution", json!({ "executionId": dispatch["params"]["executionId"], "ok": true, "content": { "verified": true } }), tx.clone()).await.unwrap();
    assert_eq!(pending.await.unwrap().unwrap()["content"]["verified"], true);

    let mut running = params.clone();
    running["toolCallId"] = json!("running-cancel");
    let pending = tokio::spawn(handle_request(
        state.clone(),
        "tools.execute",
        running,
        tx.clone(),
    ));
    let approval: Value = serde_json::from_str(&rx.recv().await.unwrap()).unwrap();
    handle_request(
        state.clone(),
        "permissions.resolve",
        json!({ "requestId": approval["params"]["requestId"], "decision": "allow-once" }),
        tx.clone(),
    )
    .await
    .unwrap();
    let execution: Value = serde_json::from_str(&rx.recv().await.unwrap()).unwrap();
    assert_eq!(execution["method"], "plugins.execute");
    handle_request(
        state.clone(),
        "tools.abort",
        json!({ "sessionId": session.id, "toolCallId": "running-cancel" }),
        tx.clone(),
    )
    .await
    .unwrap();
    let cancellation: Value = serde_json::from_str(&rx.recv().await.unwrap()).unwrap();
    assert_eq!(cancellation["method"], "ppt.cancelExecution");
    assert_eq!(
        cancellation["params"]["executionId"],
        execution["params"]["executionId"]
    );
    assert_eq!(pending.await.unwrap().unwrap()["ok"], false);
    assert!(state.lock().await.plugin_execs.is_empty());

    let mut cancelled = params.clone();
    cancelled["toolCallId"] = json!("edit-cancel");
    let pending = tokio::spawn(handle_request(
        state.clone(),
        "tools.execute",
        cancelled,
        tx.clone(),
    ));
    let request: Value = serde_json::from_str(&rx.recv().await.unwrap()).unwrap();
    assert_eq!(request["method"], "permissions.request");
    handle_request(
        state.clone(),
        "tools.abort",
        json!({ "sessionId": session.id, "toolCallId": "edit-cancel" }),
        tx.clone(),
    )
    .await
    .unwrap();
    assert_eq!(pending.await.unwrap().unwrap()["ok"], false);
    assert!(rx.try_recv().is_err());

    let mut read = params.clone();
    read["toolName"] = json!(if tool_name.starts_with("ppt_propose_page_") {
        "ppt_get_narration_context"
    } else {
        "ppt_get_context"
    });
    read["toolCallId"] = json!("read-1");
    let pending = tokio::spawn(handle_request(
        state.clone(),
        "tools.execute",
        read,
        tx.clone(),
    ));
    let dispatch: Value = serde_json::from_str(&rx.recv().await.unwrap()).unwrap();
    assert_eq!(dispatch["method"], "plugins.execute");
    handle_request(
        state.clone(),
        "plugins.resolveExecution",
        json!({ "executionId": dispatch["params"]["executionId"], "ok": true, "content": {} }),
        tx.clone(),
    )
    .await
    .unwrap();
    assert_eq!(pending.await.unwrap().unwrap()["ok"], true);

    // The durable mode wins even when the runtime claims Agent/Auto.
    sessions::configure_session(&state.lock().await.db, &session.id, "plan", None, None).unwrap();
    let denied = handle_request(state.clone(), "tools.execute", params, tx)
        .await
        .unwrap();
    assert_eq!(denied["ok"], false);
    assert!(rx.try_recv().is_err());
    assert!(!tools::is_desktop_dispatched("ppt_execute_js"));
}
