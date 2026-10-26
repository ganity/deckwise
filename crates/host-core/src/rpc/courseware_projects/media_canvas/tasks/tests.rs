use super::*;

async fn call(
    state: &Arc<Mutex<AppState>>,
    method: &str,
    params: Value,
) -> Result<Value, JsonRpcError> {
    let (tx, _) = mpsc::unbounded_channel();
    handle_request(state.clone(), method, params, tx).await
}

async fn fixture() -> (tempfile::TempDir, Arc<Mutex<AppState>>, Value, Value) {
    let dir = tempfile::tempdir().unwrap();
    let (state, scope, _, _) = super::super::tests::setup(dir.path());
    let mut write = scope.clone();
    write["expectedRevision"] = Value::Null;
    write["document"] = super::super::tests::document(&scope["projectId"]);
    let saved = call(&state, "courseware.mediaCanvas.set", write)
        .await
        .unwrap();
    let prepare = json!({ "sessionId": scope["sessionId"], "principalKey": "a".repeat(64),
        "intentId": "attempt-1", "draftId": "image-1", "expectedDraftRevision": 0,
        "expectedRevision": saved["revision"], "model": "image-model" });
    (dir, state, prepare, saved)
}

fn operation(prepare: &Value) -> Value {
    json!({ "sessionId": prepare["sessionId"], "principalKey": prepare["principalKey"], "intentId": prepare["intentId"] })
}

#[tokio::test]
async fn canvas_image_request_has_unique_explicit_attempts_but_stable_retry_and_restart_receipt() {
    let (dir, state, prepare, saved) = fixture().await;
    let first = call(
        &state,
        "courseware.mediaCanvas.image.prepare",
        prepare.clone(),
    )
    .await
    .unwrap();
    assert_eq!(
        call(
            &state,
            "courseware.mediaCanvas.image.prepare",
            prepare.clone()
        )
        .await
        .unwrap(),
        first
    );
    assert_eq!(first["intent"]["request"]["input"], "Original");
    let mut next = prepare.clone();
    next["intentId"] = json!("attempt-2");
    let second = call(&state, "courseware.mediaCanvas.image.prepare", next)
        .await
        .unwrap();
    assert_ne!(
        second["intent"]["idempotencyKey"],
        first["intent"]["idempotencyKey"]
    );
    assert_eq!(
        second["intent"]["requestHash"],
        first["intent"]["requestHash"]
    );
    let op = operation(&prepare);
    assert!(call(&state, "courseware.mediaCanvas.image.bind", {
        let mut value = op.clone(); value["taskRef"] = json!({ "taskId": "early", "idempotencyKey": first["intent"]["idempotencyKey"], "requestHash": first["intent"]["requestHash"] }); value
    }).await.is_err());
    let begun = call(&state, "courseware.mediaCanvas.image.begin", op.clone())
        .await
        .unwrap();
    assert_eq!(begun["intent"]["phase"], "submission-unknown");
    assert!(
        call(&state, "courseware.mediaCanvas.image.begin", op.clone())
            .await
            .is_err()
    );
    let mut write = json!({ "sessionId": prepare["sessionId"], "projectId": saved["document"]["projectId"],
        "expectedRevision": saved["revision"], "document": saved["document"] });
    write["document"]["drafts"] = json!([]);
    write["document"]["revision"] = json!(1);
    call(&state, "courseware.mediaCanvas.set", write)
        .await
        .unwrap();
    drop(state);
    let mut app = AppState::open(dir.path()).unwrap();
    app.handshook = true;
    let state = Arc::new(Mutex::new(app));
    let retained = call(&state, "courseware.mediaCanvas.image.get", op.clone())
        .await
        .unwrap();
    assert_eq!(retained["intent"], begun["intent"]);
    assert_eq!(retained["current"], false);
    let mut bind = op.clone();
    bind["taskRef"] = json!({ "taskId": "late-result", "idempotencyKey": first["intent"]["idempotencyKey"], "requestHash": first["intent"]["requestHash"] });
    let bound = call(&state, "courseware.mediaCanvas.image.bind", bind.clone())
        .await
        .unwrap();
    assert_eq!(bound["intent"]["phase"], "submitted");
    assert_eq!(
        call(&state, "courseware.mediaCanvas.image.bind", bind.clone())
            .await
            .unwrap(),
        bound
    );
    bind["taskRef"]["taskId"] = json!("replacement");
    assert!(call(&state, "courseware.mediaCanvas.image.bind", bind)
        .await
        .is_err());
}

#[tokio::test]
async fn canvas_image_scope_cas_mode_limits_and_storage_failure_prevent_dispatch() {
    let (_dir, state, prepare, saved) = fixture().await;
    for (field, value) in [
        ("expectedRevision", json!("stale")),
        ("expectedDraftRevision", json!(1)),
        ("draftId", json!("missing")),
        ("model", json!("../bad")),
        ("input", json!("forged")),
        ("taskRef", Value::Null),
    ] {
        let mut bad = prepare.clone();
        bad[field] = value;
        assert!(
            call(&state, "courseware.mediaCanvas.image.prepare", bad)
                .await
                .is_err(),
            "{field}"
        );
    }
    state.lock().await.db.conn().execute_batch("CREATE TRIGGER ignore_canvas_image BEFORE INSERT ON kv WHEN NEW.ns='coursewareMediaCanvasImages.v1' BEGIN SELECT RAISE(IGNORE); END;").unwrap();
    assert!(call(
        &state,
        "courseware.mediaCanvas.image.prepare",
        prepare.clone()
    )
    .await
    .is_err());
    state
        .lock()
        .await
        .db
        .conn()
        .execute_batch("DROP TRIGGER ignore_canvas_image;")
        .unwrap();
    let first = call(
        &state,
        "courseware.mediaCanvas.image.prepare",
        prepare.clone(),
    )
    .await
    .unwrap();
    let op = operation(&prepare);
    let mut foreign = op.clone();
    foreign["principalKey"] = json!("b".repeat(64));
    assert!(call(&state, "courseware.mediaCanvas.image.get", foreign)
        .await
        .is_err());
    state
        .lock()
        .await
        .db
        .conn()
        .execute(
            "UPDATE sessions SET mode='plan' WHERE id=?1",
            [prepare["sessionId"].as_str().unwrap()],
        )
        .unwrap();
    assert!(
        call(&state, "courseware.mediaCanvas.image.begin", op.clone())
            .await
            .is_err()
    );
    assert!(call(
        &state,
        "courseware.mediaCanvas.image.prepare",
        prepare.clone()
    )
    .await
    .is_err());
    assert_eq!(
        call(&state, "courseware.mediaCanvas.image.get", op.clone())
            .await
            .unwrap(),
        first
    );
    state
        .lock()
        .await
        .db
        .conn()
        .execute(
            "UPDATE sessions SET mode='agent' WHERE id=?1",
            [prepare["sessionId"].as_str().unwrap()],
        )
        .unwrap();
    let mut write = json!({ "sessionId": prepare["sessionId"], "projectId": saved["document"]["projectId"],
        "expectedRevision": saved["revision"], "document": saved["document"] });
    write["document"]["revision"] = json!(1);
    write["document"]["drafts"][0]["revision"] = json!(1);
    write["document"]["drafts"][0]["prompt"] = json!("x".repeat(4001));
    let changed = call(&state, "courseware.mediaCanvas.set", write.clone())
        .await
        .unwrap();
    let mut oversized = prepare.clone();
    oversized["expectedRevision"] = changed["revision"].clone();
    oversized["expectedDraftRevision"] = json!(1);
    assert!(
        call(&state, "courseware.mediaCanvas.image.prepare", oversized)
            .await
            .is_err()
    );
    assert!(
        call(&state, "courseware.mediaCanvas.image.begin", op.clone())
            .await
            .is_err()
    );
    write["expectedRevision"] = changed["revision"].clone();
    write["document"]["revision"] = json!(2);
    write["document"]["drafts"][0]["revision"] = json!(2);
    write["document"]["drafts"][0]["prompt"] = json!("Original");
    write["document"]["drafts"][0]["references"] =
        json!([{ "assetId": "forged", "revision": "a".repeat(64), "label": "Fake" }]);
    let changed = call(&state, "courseware.mediaCanvas.set", write)
        .await
        .unwrap();
    let mut forged = prepare;
    forged["expectedRevision"] = changed["revision"].clone();
    forged["expectedDraftRevision"] = json!(2);
    assert!(call(&state, "courseware.mediaCanvas.image.prepare", forged)
        .await
        .is_err());
    assert_eq!(
        call(&state, "courseware.mediaCanvas.image.get", op)
            .await
            .unwrap()["intent"]["phase"],
        "prepared"
    );
}

#[tokio::test]
async fn canvas_image_submission_scope_uses_begin_order_and_survives_restart() {
    let team = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    for bind_first in [true, false] {
        let (dir, state, prepare, _) = fixture().await;
        call(
            &state,
            "courseware.mediaCanvas.image.prepare",
            prepare.clone(),
        )
        .await
        .unwrap();
        let op = operation(&prepare);
        let bind = json!({"sessionId":prepare["sessionId"],"teamProjectId":team});
        if bind_first {
            call(&state, "courseware.task.bindTeam", bind.clone())
                .await
                .unwrap();
        }
        let begun = call(&state, "courseware.mediaCanvas.image.begin", op.clone())
            .await
            .unwrap();
        let expected_team = if bind_first { json!(team) } else { Value::Null };
        assert_eq!(
            begun["intent"]["submissionScope"],
            json!({"sessionId":prepare["sessionId"],"teamProjectId":expected_team})
        );
        if !bind_first {
            call(&state, "courseware.task.bindTeam", bind)
                .await
                .unwrap();
        }
        drop(state);
        let mut app = AppState::open(dir.path()).unwrap();
        app.handshook = true;
        let state = Arc::new(Mutex::new(app));
        assert_eq!(
            call(&state, "courseware.mediaCanvas.image.get", op.clone())
                .await
                .unwrap(),
            begun
        );
        assert!(call(&state, "courseware.mediaCanvas.image.begin", op)
            .await
            .is_err());
    }
}

#[tokio::test]
async fn rejected_canvas_image_keeps_history_and_cannot_begin_or_bind_after_restart() {
    for team in [false, true] {
        let (dir, state, prepare, _) = fixture().await;
        if team {
            call(
                &state,
                "courseware.task.bindTeam",
                json!({"sessionId":prepare["sessionId"],
                "teamProjectId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}),
            )
            .await
            .unwrap();
        }
        let prepared = call(
            &state,
            "courseware.mediaCanvas.image.prepare",
            prepare.clone(),
        )
        .await
        .unwrap();
        let op = operation(&prepare);
        let mut reject = op.clone();
        reject["rejectedRequest"] = json!({"idempotencyKey":prepared["intent"]["idempotencyKey"],
            "requestHash":prepared["intent"]["requestHash"]});
        assert!(call(
            &state,
            "courseware.mediaCanvas.image.reject",
            reject.clone()
        )
        .await
        .is_err());
        let begun = call(&state, "courseware.mediaCanvas.image.begin", op.clone())
            .await
            .unwrap();
        let mut wrong = reject.clone();
        wrong["rejectedRequest"]["idempotencyKey"] = json!(uuid::Uuid::new_v4());
        assert!(call(&state, "courseware.mediaCanvas.image.reject", wrong)
            .await
            .is_err());
        assert_eq!(
            call(&state, "courseware.mediaCanvas.image.get", op.clone())
                .await
                .unwrap(),
            begun
        );
        if !team {
            assert!(call(&state, "courseware.mediaCanvas.image.reject", reject)
                .await
                .is_err());
            continue;
        }
        let rejected = call(&state, "courseware.mediaCanvas.image.reject", reject)
            .await
            .unwrap();
        assert_eq!(rejected["intent"]["phase"], "rejected");
        drop(state);
        let mut app = AppState::open(dir.path()).unwrap();
        app.handshook = true;
        let state = Arc::new(Mutex::new(app));
        assert_eq!(
            call(&state, "courseware.mediaCanvas.image.get", op.clone())
                .await
                .unwrap(),
            rejected
        );
        assert!(
            call(&state, "courseware.mediaCanvas.image.begin", op.clone())
                .await
                .is_err()
        );
        let mut binding = op;
        binding["taskRef"] = json!({"taskId":"late", "idempotencyKey":begun["intent"]["idempotencyKey"],
            "requestHash":begun["intent"]["requestHash"]});
        assert!(call(&state, "courseware.mediaCanvas.image.bind", binding)
            .await
            .is_err());
        let mut next = prepare;
        next["intentId"] = json!("explicit-new-attempt");
        let fresh = call(&state, "courseware.mediaCanvas.image.prepare", next)
            .await
            .unwrap();
        assert_eq!(fresh["intent"]["phase"], "prepared");
        assert_ne!(
            fresh["intent"]["idempotencyKey"],
            rejected["intent"]["idempotencyKey"]
        );
    }
}
