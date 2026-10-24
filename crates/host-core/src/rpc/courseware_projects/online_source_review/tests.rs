use super::*;

#[tokio::test]
async fn online_source_review_rpc_requires_handshake_persisted_session_and_strict_fields() {
    let dir = tempfile::tempdir().unwrap();
    let app = AppState::open(dir.path()).unwrap();
    let session = sessions::create_session(
        &app.db,
        None,
        Some("plan".into()),
        None,
        None,
        Some(dir.path().to_string_lossy().into()),
    )
    .unwrap();
    let state = Arc::new(Mutex::new(app));
    let (tx, _rx) = mpsc::unbounded_channel();
    let call = |method, params| {
        super::super::super::handle_request(state.clone(), method, params, tx.clone())
    };
    let args = json!({"sessionId":session.id,"baselineId":"missing","jobId":"missing","target":{
        "source":{"revision":"44444444-4444-4444-8444-444444444444","sha256":"b".repeat(64)},"byteLength":123,"sessionEpoch":1,"callbackId":"c".repeat(64)}});
    assert_eq!(
        call("courseware.onlineSource.review", args.clone())
            .await
            .unwrap_err()
            .code,
        1001
    );
    state.lock().await.handshook = true;
    let mut forged = args.clone();
    forged["bindings"] = json!([]);
    assert_eq!(
        call("courseware.onlineSource.review", forged)
            .await
            .unwrap_err()
            .code,
        1002
    );
    let mut forged = args.clone();
    forged["target"]["path"] = json!("/forged");
    assert_eq!(
        call("courseware.onlineSource.review", forged)
            .await
            .unwrap_err()
            .code,
        1002
    );
    let mut missing = args.clone();
    missing["sessionId"] = json!("unknown");
    assert_eq!(
        call("courseware.onlineSource.review", missing)
            .await
            .unwrap_err()
            .code,
        1007
    );
    assert!(call("courseware.onlineSource.review", args.clone())
        .await
        .unwrap_err()
        .message
        .contains("baseline"));
    assert!(call(
        "courseware.onlineSource.baseline",
        json!({"sessionId":session.id,"jobId":"missing","path":"/forged"})
    )
    .await
    .is_err());
    let mut resolve = args.clone();
    resolve["reviewId"] = json!("missing");
    resolve["pages"] = json!([]);
    resolve["removedPages"] = json!([]);
    resolve["cues"] = json!([]);
    assert!(call("courseware.onlineSource.resolve", resolve.clone())
        .await
        .unwrap_err()
        .message
        .contains("baseline"));
    resolve["pages"] = json!([{"kind":"new","targetImportPageId":"page_1","confirmReady":true,"oldPageId":"forged"}]);
    assert_eq!(
        call("courseware.onlineSource.resolve", resolve)
            .await
            .unwrap_err()
            .code,
        1002
    );
    assert!(call(
        "courseware.onlineSource.clear",
        json!({"sessionId":session.id,"baselineId":"missing"})
    )
    .await
    .is_err());
}
