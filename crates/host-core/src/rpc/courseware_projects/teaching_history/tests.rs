use super::*;

#[tokio::test]
async fn deleted_teaching_history_rpc_requires_handshake_persisted_session_saved_job_and_exact_params(
) {
    let dir = tempfile::tempdir().unwrap();
    let app = AppState::open(dir.path()).unwrap();
    let owner = sessions::create_session(
        &app.db,
        None,
        Some("plan".into()),
        None,
        None,
        Some(dir.path().to_string_lossy().into()),
    )
    .unwrap();
    let foreign = tempfile::tempdir().unwrap();
    let other = sessions::create_session(
        &app.db,
        None,
        None,
        None,
        None,
        Some(foreign.path().to_string_lossy().into()),
    )
    .unwrap();
    let state = Arc::new(Mutex::new(app));
    let (tx, _rx) = mpsc::unbounded_channel();
    let call = |params| {
        super::super::super::handle_request(
            state.clone(),
            "courseware.teachingHistory.list",
            params,
            tx.clone(),
        )
    };
    let params = json!({"sessionId":owner.id,"jobId":"missing-job"});
    assert_eq!(call(params.clone()).await.unwrap_err().code, 1001);
    state.lock().await.handshook = true;
    for field in ["workspace", "projectId", "actions", "pageId"] {
        let mut forged = params.clone();
        forged[field] = json!("forged");
        assert_eq!(call(forged).await.unwrap_err().code, 1002, "{field}");
    }
    assert_eq!(
        call(json!({"sessionId":"missing","jobId":"missing-job"}))
            .await
            .unwrap_err()
            .code,
        1007
    );
    // Plan mode reaches saved-job validation; this read does not require write permission.
    assert!(call(params).await.unwrap_err().message.contains("job"));
    assert!(call(json!({"sessionId":other.id,"jobId":"missing-job"}))
        .await
        .is_err());
    assert!(call(json!({"sessionId":owner.id})).await.is_err());
}
