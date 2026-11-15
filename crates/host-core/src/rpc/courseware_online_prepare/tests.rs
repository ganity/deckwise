use super::*;

const PROJECT: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const REVISION: &str = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PRINCIPAL: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

fn setup(dir: &Path) -> (Arc<Mutex<AppState>>, String) {
    let mut app = AppState::open(dir).unwrap();
    app.handshook = true;
    let session = sessions::create_session(
        &app.db,
        None,
        None,
        None,
        None,
        Some(dir.to_str().unwrap().into()),
    )
    .unwrap();
    app.db
        .kv_set(
            TASK_NAMESPACE,
            &session.id,
            &json!({
                "taskType": "plain", "educationContext": { "grade": "Grade 3" }
            }),
        )
        .unwrap();
    (Arc::new(Mutex::new(app)), session.id)
}

fn base(session: &str) -> Value {
    json!({ "sessionId": session, "principalKey": PRINCIPAL })
}

fn begin(session: &str) -> Value {
    let mut value = base(session);
    value["selection"] = json!({
        "projectId": PROJECT, "requestId": uuid::Uuid::new_v4().to_string(),
        "expectedEpoch": 3, "expectedSourceRevision": null,
        "sourceSha256": "c".repeat(64), "byteLength": MAX_SOURCE_BYTES,
    });
    value
}

fn teaching() -> Value {
    json!({
        "projectId": "local-project_1", "teachingRevision": "teaching.R8",
        "mappingRevision": "mapping-8", "payloadSha256": "d".repeat(64),
    })
}

fn transition(session: &str, request: &Value, from: &str, to: &str) -> Value {
    let mut value = base(session);
    value["requestId"] = request["selection"]["requestId"].clone();
    value["expectedPhase"] = json!(from);
    value["phase"] = json!(to);
    value
}

async fn call(
    state: Arc<Mutex<AppState>>,
    method: &str,
    params: Value,
) -> Result<Value, JsonRpcError> {
    let (tx, _) = mpsc::unbounded_channel();
    super::super::handle_request(state, method, params, tx).await
}

async fn get(state: Arc<Mutex<AppState>>, session: &str) -> Value {
    call(state, "courseware.onlinePrepare.get", base(session))
        .await
        .unwrap()["receipt"]
        .clone()
}

async fn started(state: Arc<Mutex<AppState>>, session: &str, request: &Value) -> Value {
    call(
        state.clone(),
        "courseware.onlinePrepare.begin",
        request.clone(),
    )
    .await
    .unwrap();
    let mut upload = transition(session, request, "upload-pending", "uploaded");
    upload["uploadedRevision"] = json!(REVISION);
    call(state.clone(), "courseware.onlinePrepare.advance", upload)
        .await
        .unwrap();
    call(
        state.clone(),
        "courseware.onlinePrepare.advance",
        transition(session, request, "uploaded", "start-pending"),
    )
    .await
    .unwrap();
    let mut start = transition(session, request, "start-pending", "started");
    start["sessionEpoch"] = json!(4);
    call(state, "courseware.onlinePrepare.advance", start)
        .await
        .unwrap()
}

#[tokio::test]
async fn owner_path_survives_restart_and_binds_only_after_explicit_completion() {
    let dir = tempfile::tempdir().unwrap();
    let (state, session) = setup(dir.path());
    let request = begin(&session);
    assert!(get(state.clone(), &session).await.is_null());
    let pending = call(
        state.clone(),
        "courseware.onlinePrepare.begin",
        request.clone(),
    )
    .await
    .unwrap();
    assert_eq!(pending["phase"], "upload-pending");
    assert!(pending.get("receipt").is_none());
    assert!(pending.get("uploadedRevision").is_none());
    assert!(pending.get("teaching").is_none());
    assert_eq!(
        call(
            state.clone(),
            "courseware.onlinePrepare.begin",
            request.clone()
        )
        .await
        .unwrap(),
        pending
    );

    let mut upload = transition(&session, &request, "upload-pending", "uploaded");
    upload["uploadedRevision"] = json!(REVISION);
    let uploaded = call(
        state.clone(),
        "courseware.onlinePrepare.advance",
        upload.clone(),
    )
    .await
    .unwrap();
    assert_eq!(
        call(state.clone(), "courseware.onlinePrepare.advance", upload)
            .await
            .unwrap(),
        uploaded
    );
    drop(state);
    let mut app = AppState::open(dir.path()).unwrap();
    app.handshook = true;
    let state = Arc::new(Mutex::new(app));
    assert_eq!(get(state.clone(), &session).await, uploaded);
    let start_pending = call(
        state.clone(),
        "courseware.onlinePrepare.advance",
        transition(&session, &request, "uploaded", "start-pending"),
    )
    .await
    .unwrap();
    drop(state);
    let mut app = AppState::open(dir.path()).unwrap();
    app.handshook = true;
    let state = Arc::new(Mutex::new(app));
    assert_eq!(get(state.clone(), &session).await, start_pending);
    let mut start = transition(&session, &request, "start-pending", "started");
    start["sessionEpoch"] = json!(4);
    let started = call(
        state.clone(),
        "courseware.onlinePrepare.advance",
        start.clone(),
    )
    .await
    .unwrap();
    assert_eq!(
        call(state.clone(), "courseware.onlinePrepare.advance", start)
            .await
            .unwrap(),
        started
    );
    assert!(state
        .lock()
        .await
        .db
        .kv_get(TASK_NAMESPACE, &session)
        .unwrap()
        .unwrap()
        .get("teamProjectId")
        .is_none());
    let bind = transition(&session, &request, "started", "bound");
    let bound = call(
        state.clone(),
        "courseware.onlinePrepare.advance",
        bind.clone(),
    )
    .await
    .unwrap();
    assert_eq!(bound["uploadedRevision"], REVISION);
    assert_eq!(bound["sessionEpoch"], 4);
    assert_eq!(
        call(state.clone(), "courseware.onlinePrepare.advance", bind)
            .await
            .unwrap(),
        bound
    );
    drop(state);
    let mut app = AppState::open(dir.path()).unwrap();
    app.handshook = true;
    assert_eq!(
        app.db.kv_get(TASK_NAMESPACE, &session).unwrap().unwrap(),
        json!({
            "taskType": "plain", "educationContext": { "grade": "Grade 3" }, "teamProjectId": PROJECT
        })
    );
    let state = Arc::new(Mutex::new(app));
    assert_eq!(get(state.clone(), &session).await, bound);
    assert!(bound.get("teaching").is_none());
    assert_eq!(
        call(
            state.clone(),
            "courseware.onlinePrepare.begin",
            request.clone()
        )
        .await
        .unwrap(),
        bound
    );
    let next = begin(&session);
    let next_receipt = call(
        state.clone(),
        "courseware.onlinePrepare.begin",
        next.clone(),
    )
    .await
    .unwrap();
    assert_eq!(next_receipt["requestId"], next["selection"]["requestId"]);
    assert_eq!(next_receipt["phase"], "upload-pending");
    assert!(call(state, "courseware.onlinePrepare.begin", request)
        .await
        .is_err());
}

#[tokio::test]
async fn strict_cas_preserves_selection_revision_and_epoch_under_retry_and_race() {
    let dir = tempfile::tempdir().unwrap();
    let (state, session) = setup(dir.path());
    let request = begin(&session);
    call(
        state.clone(),
        "courseware.onlinePrepare.begin",
        request.clone(),
    )
    .await
    .unwrap();
    for field in [
        "projectId",
        "expectedSourceRevision",
        "sourceSha256",
        "expectedEpoch",
        "byteLength",
    ] {
        let mut changed = request.clone();
        changed["selection"][field] = match field {
            "expectedEpoch" => json!(2),
            "byteLength" => json!(1),
            "sourceSha256" => json!("d".repeat(64)),
            _ => json!(REVISION),
        };
        assert!(
            call(state.clone(), "courseware.onlinePrepare.begin", changed)
                .await
                .is_err()
        );
    }
    assert!(call(
        state.clone(),
        "courseware.onlinePrepare.begin",
        begin(&session)
    )
    .await
    .is_err());
    let mut upload = transition(&session, &request, "upload-pending", "uploaded");
    assert!(call(
        state.clone(),
        "courseware.onlinePrepare.advance",
        upload.clone()
    )
    .await
    .is_err());
    upload["uploadedRevision"] = json!(REVISION);
    let mut foreign = upload.clone();
    foreign["requestId"] = json!(uuid::Uuid::new_v4().to_string());
    assert!(
        call(state.clone(), "courseware.onlinePrepare.advance", foreign)
            .await
            .is_err()
    );
    let mut other_upload = upload.clone();
    other_upload["uploadedRevision"] = json!(PROJECT);
    let (first, second) = tokio::join!(
        call(state.clone(), "courseware.onlinePrepare.advance", upload),
        call(
            state.clone(),
            "courseware.onlinePrepare.advance",
            other_upload
        )
    );
    assert_ne!(first.is_ok(), second.is_ok());
    let uploaded = first.or(second).unwrap();
    let mut pending = transition(&session, &request, "uploaded", "start-pending");
    pending["uploadedRevision"] = json!("cccccccc-cccc-4ccc-8ccc-cccccccccccc");
    assert!(call(
        state.clone(),
        "courseware.onlinePrepare.advance",
        pending.clone()
    )
    .await
    .is_err());
    pending.as_object_mut().unwrap().remove("uploadedRevision");
    pending["sessionEpoch"] = json!(4);
    assert!(call(
        state.clone(),
        "courseware.onlinePrepare.advance",
        pending.clone()
    )
    .await
    .is_err());
    pending.as_object_mut().unwrap().remove("sessionEpoch");
    call(state.clone(), "courseware.onlinePrepare.advance", pending)
        .await
        .unwrap();
    let mut start = transition(&session, &request, "start-pending", "started");
    for epoch in [json!(3), json!(5), Value::Null] {
        start["sessionEpoch"] = epoch;
        assert!(call(
            state.clone(),
            "courseware.onlinePrepare.advance",
            start.clone()
        )
        .await
        .is_err());
    }
    start["sessionEpoch"] = json!(4);
    let started = call(
        state.clone(),
        "courseware.onlinePrepare.advance",
        start.clone(),
    )
    .await
    .unwrap();
    assert_eq!(started["uploadedRevision"], uploaded["uploadedRevision"]);
    let old = transition(&session, &request, "uploaded", "start-pending");
    assert!(call(state.clone(), "courseware.onlinePrepare.advance", old)
        .await
        .is_err());
    let mut bind = transition(&session, &request, "started", "bound");
    bind["sessionEpoch"] = json!(5);
    assert!(
        call(state.clone(), "courseware.onlinePrepare.advance", bind)
            .await
            .is_err()
    );
    assert_eq!(get(state, &session).await, started);
}

#[tokio::test]
async fn receipt_is_scoped_to_persisted_chat_workspace_and_principal() {
    let dir = tempfile::tempdir().unwrap();
    let other = tempfile::tempdir().unwrap();
    let (state, session) = setup(dir.path());
    let request = begin(&session);
    let pending = call(state.clone(), "courseware.onlinePrepare.begin", request)
        .await
        .unwrap();
    let mut other_principal = base(&session);
    other_principal["principalKey"] = json!("f".repeat(64));
    assert!(call(
        state.clone(),
        "courseware.onlinePrepare.get",
        other_principal
    )
    .await
    .unwrap()["receipt"]
        .is_null());
    let other_session = {
        let state = state.lock().await;
        sessions::create_session(
            &state.db,
            None,
            None,
            None,
            None,
            Some(dir.path().to_str().unwrap().into()),
        )
        .unwrap()
        .id
    };
    assert!(get(state.clone(), &other_session).await.is_null());
    {
        let state = state.lock().await;
        let project_id = state
            .db
            .ensure_project(other.path().to_str().unwrap(), false)
            .unwrap();
        state
            .db
            .conn()
            .execute(
                "UPDATE sessions SET project_id = ?1 WHERE id = ?2",
                rusqlite::params![project_id, session],
            )
            .unwrap();
    }
    assert!(get(state.clone(), &session).await.is_null());
    {
        let state = state.lock().await;
        let project_id = state
            .db
            .ensure_project(dir.path().to_str().unwrap(), false)
            .unwrap();
        state
            .db
            .conn()
            .execute(
                "UPDATE sessions SET project_id = ?1 WHERE id = ?2",
                rusqlite::params![project_id, session],
            )
            .unwrap();
    }
    assert_eq!(get(state.clone(), &session).await, pending);
    let missing = uuid::Uuid::new_v4().to_string();
    assert!(call(
        state.clone(),
        "courseware.onlinePrepare.get",
        base(&missing)
    )
    .await
    .is_err());
    let scratch = {
        let state = state.lock().await;
        sessions::create_session(&state.db, None, None, None, None, None)
            .unwrap()
            .id
    };
    assert!(call(state, "courseware.onlinePrepare.get", base(&scratch))
        .await
        .is_err());
}

#[tokio::test]
async fn bound_phase_and_task_binding_rollback_together_and_never_replace_another_team() {
    let dir = tempfile::tempdir().unwrap();
    let (state, session) = setup(dir.path());
    let mut request = begin(&session);
    request["selection"]["teaching"] = teaching();
    let started = started(state.clone(), &session, &request).await;
    let bind = transition(&session, &request, "started", "bound");
    let original_task = state
        .lock()
        .await
        .db
        .kv_get(TASK_NAMESPACE, &session)
        .unwrap()
        .unwrap();
    state.lock().await.db.conn().execute_batch(
        "CREATE TEMP TRIGGER reject_online_bound BEFORE UPDATE ON kv
         WHEN NEW.ns = 'coursewareOnlinePrepare.v1' AND json_extract(NEW.value_json, '$.phase') = 'bound'
         BEGIN SELECT RAISE(ABORT, 'injected receipt write failure'); END;"
    ).unwrap();
    assert!(call(
        state.clone(),
        "courseware.onlinePrepare.advance",
        bind.clone()
    )
    .await
    .is_err());
    assert_eq!(get(state.clone(), &session).await, started);
    assert_eq!(
        state
            .lock()
            .await
            .db
            .kv_get(TASK_NAMESPACE, &session)
            .unwrap()
            .unwrap(),
        original_task
    );
    state
        .lock()
        .await
        .db
        .conn()
        .execute_batch("DROP TRIGGER reject_online_bound")
        .unwrap();
    let foreign = json!({ "taskType": "plain", "teamProjectId": REVISION });
    state
        .lock()
        .await
        .db
        .kv_set(TASK_NAMESPACE, &session, &foreign)
        .unwrap();
    assert!(call(
        state.clone(),
        "courseware.onlinePrepare.advance",
        bind.clone()
    )
    .await
    .is_err());
    assert_eq!(get(state.clone(), &session).await, started);
    assert_eq!(
        state
            .lock()
            .await
            .db
            .kv_get(TASK_NAMESPACE, &session)
            .unwrap()
            .unwrap(),
        foreign
    );
    state
        .lock()
        .await
        .db
        .kv_set(TASK_NAMESPACE, &session, &original_task)
        .unwrap();
    call(state.clone(), "courseware.onlinePrepare.advance", bind)
        .await
        .unwrap();
    let mut other_project = begin(&session);
    other_project["selection"]["projectId"] = json!(REVISION);
    assert!(call(
        state.clone(),
        "courseware.onlinePrepare.begin",
        other_project
    )
    .await
    .is_err());
    assert_eq!(get(state, &session).await["phase"], "bound");
}

#[tokio::test]
async fn rejects_invalid_bounds_unknown_fields_and_requests_without_courseware_task() {
    let dir = tempfile::tempdir().unwrap();
    let (state, session) = setup(dir.path());
    let request = begin(&session);
    let invalid_fields = [
        ("projectId", json!("../project")),
        ("projectId", json!(PROJECT.to_uppercase())),
        ("requestId", json!("request")),
        ("expectedEpoch", json!(-1)),
        ("expectedEpoch", json!(0.5)),
        ("expectedEpoch", json!(MAX_SAFE_EPOCH + 1)),
        ("expectedSourceRevision", json!("source-revision")),
        ("expectedSourceRevision", json!(REVISION.to_uppercase())),
        ("sourceSha256", json!("C".repeat(64))),
        ("byteLength", json!(0)),
        ("byteLength", json!(MAX_SOURCE_BYTES + 1)),
        ("token", json!("forbidden")),
    ];
    for (field, value) in invalid_fields {
        let mut forged = request.clone();
        forged["selection"][field] = value;
        assert!(
            call(state.clone(), "courseware.onlinePrepare.begin", forged)
                .await
                .is_err(),
            "{field}"
        );
    }
    let mut missing = request.clone();
    missing["selection"]
        .as_object_mut()
        .unwrap()
        .remove("expectedSourceRevision");
    assert!(
        call(state.clone(), "courseware.onlinePrepare.begin", missing)
            .await
            .is_err()
    );
    for field in ["path", "bytesBase64", "token", "phase", "selection"] {
        let mut forged = base(&session);
        forged[field] = Value::Null;
        assert!(call(state.clone(), "courseware.onlinePrepare.get", forged)
            .await
            .is_err());
    }
    let mut null_optional = transition(&session, &request, "upload-pending", "uploaded");
    null_optional["uploadedRevision"] = Value::Null;
    assert!(call(
        state.clone(),
        "courseware.onlinePrepare.advance",
        null_optional
    )
    .await
    .is_err());
    let skipped = transition(&session, &request, "upload-pending", "started");
    assert!(
        call(state.clone(), "courseware.onlinePrepare.advance", skipped)
            .await
            .is_err()
    );
    assert!(get(state.clone(), &session).await.is_null());
    state
        .lock()
        .await
        .db
        .kv_delete(TASK_NAMESPACE, &session)
        .unwrap();
    assert!(
        call(state.clone(), "courseware.onlinePrepare.begin", request)
            .await
            .is_err()
    );
    assert!(get(state, &session).await.is_null());
}

#[tokio::test]
async fn corrupt_persisted_receipts_fail_closed_without_erasing_the_record() {
    let dir = tempfile::tempdir().unwrap();
    let (state, session) = setup(dir.path());
    let pending = call(
        state.clone(),
        "courseware.onlinePrepare.begin",
        begin(&session),
    )
    .await
    .unwrap();
    let key = serde_json::to_string(&(dir.path().to_str().unwrap(), &session, PRINCIPAL)).unwrap();
    for (field, value) in [
        ("phase", json!("started")),
        ("uploadedRevision", json!("opaque")),
        ("phase", json!("unknown")),
        ("token", json!("forbidden")),
        ("expectedEpoch", json!(MAX_SAFE_EPOCH + 1)),
    ] {
        let mut corrupt = pending.clone();
        corrupt[field] = value;
        state
            .lock()
            .await
            .db
            .kv_set(NAMESPACE, &key, &corrupt)
            .unwrap();
        assert!(call(
            state.clone(),
            "courseware.onlinePrepare.get",
            base(&session)
        )
        .await
        .is_err());
        assert!(call(
            state.clone(),
            "courseware.onlinePrepare.begin",
            begin(&session)
        )
        .await
        .is_err());
        assert_eq!(
            state
                .lock()
                .await
                .db
                .kv_get(NAMESPACE, &key)
                .unwrap()
                .unwrap(),
            corrupt
        );
    }
}

#[tokio::test]
async fn teaching_pins_survive_every_phase_replay_and_restart() {
    let dir = tempfile::tempdir().unwrap();
    let (state, session) = setup(dir.path());
    let mut request = begin(&session);
    request["selection"]["teaching"] = teaching();
    let pending = call(
        state.clone(),
        "courseware.onlinePrepare.begin",
        request.clone(),
    )
    .await
    .unwrap();
    assert_eq!(pending["teaching"], teaching());
    let mut state = state;
    for (from, to) in [
        ("upload-pending", "uploaded"),
        ("uploaded", "start-pending"),
        ("start-pending", "started"),
        ("started", "bound"),
    ] {
        let mut input = transition(&session, &request, from, to);
        if to == "uploaded" {
            input["uploadedRevision"] = json!(REVISION);
        }
        if to == "started" {
            input["sessionEpoch"] = json!(4);
        }
        let receipt = call(
            state.clone(),
            "courseware.onlinePrepare.advance",
            input.clone(),
        )
        .await
        .unwrap();
        assert_eq!(receipt["teaching"], teaching());
        assert_eq!(
            call(state.clone(), "courseware.onlinePrepare.advance", input)
                .await
                .unwrap(),
            receipt
        );
        drop(state);
        let mut app = AppState::open(dir.path()).unwrap();
        app.handshook = true;
        state = Arc::new(Mutex::new(app));
        assert_eq!(get(state.clone(), &session).await, receipt);
        assert_eq!(
            call(
                state.clone(),
                "courseware.onlinePrepare.begin",
                request.clone()
            )
            .await
            .unwrap(),
            receipt
        );
    }
}

#[tokio::test]
async fn teaching_pins_cannot_be_added_removed_or_changed_on_the_same_request() {
    let dir = tempfile::tempdir().unwrap();
    let (state, session) = setup(dir.path());
    let mut request = begin(&session);
    request["selection"]["teaching"] = teaching();
    let pending = call(
        state.clone(),
        "courseware.onlinePrepare.begin",
        request.clone(),
    )
    .await
    .unwrap();
    for field in [
        "projectId",
        "teachingRevision",
        "mappingRevision",
        "payloadSha256",
    ] {
        let mut changed = request.clone();
        changed["selection"]["teaching"][field] = if field == "payloadSha256" {
            json!("e".repeat(64))
        } else {
            json!("other-local-id")
        };
        assert!(
            call(state.clone(), "courseware.onlinePrepare.begin", changed)
                .await
                .is_err(),
            "{field}"
        );
    }
    let mut missing = request.clone();
    missing["selection"]
        .as_object_mut()
        .unwrap()
        .remove("teaching");
    assert!(call(
        state.clone(),
        "courseware.onlinePrepare.begin",
        missing.clone()
    )
    .await
    .is_err());
    let mut forged_advance = transition(&session, &request, "upload-pending", "uploaded");
    forged_advance["uploadedRevision"] = json!(REVISION);
    forged_advance["teaching"] = teaching();
    assert!(call(
        state.clone(),
        "courseware.onlinePrepare.advance",
        forged_advance
    )
    .await
    .is_err());
    assert_eq!(get(state.clone(), &session).await, pending);

    let key = scope(&*state.lock().await, &session, PRINCIPAL).unwrap();
    state.lock().await.db.kv_delete(NAMESPACE, &key).unwrap();
    let legacy = call(state.clone(), "courseware.onlinePrepare.begin", missing)
        .await
        .unwrap();
    assert!(legacy.get("teaching").is_none());
    assert!(
        call(state.clone(), "courseware.onlinePrepare.begin", request)
            .await
            .is_err()
    );
    assert_eq!(get(state, &session).await, legacy);
}

#[tokio::test]
async fn malformed_incoming_or_stored_teaching_pins_fail_closed() {
    let dir = tempfile::tempdir().unwrap();
    let (state, session) = setup(dir.path());
    let mut request = begin(&session);
    request["selection"]["teaching"] = teaching();
    let mut malformed = vec![Value::Null, json!([]), json!({})];
    for field in [
        "projectId",
        "teachingRevision",
        "mappingRevision",
        "payloadSha256",
    ] {
        let mut missing = teaching();
        missing.as_object_mut().unwrap().remove(field);
        malformed.push(missing);
        let invalid_values = if field == "payloadSha256" {
            vec![
                json!("D".repeat(64)),
                json!("d".repeat(63)),
                json!("z".repeat(64)),
                Value::Null,
            ]
        } else {
            vec![
                json!(""),
                json!("."),
                json!(".."),
                json!("../escape"),
                json!("not safe"),
                json!("中"),
                json!("x".repeat(129)),
                Value::Null,
            ]
        };
        for value in invalid_values {
            let mut pin = teaching();
            pin[field] = value;
            malformed.push(pin);
        }
    }
    let mut extra = teaching();
    extra["token"] = json!("forbidden");
    malformed.push(extra);
    for pin in &malformed {
        let mut input = request.clone();
        input["selection"]["teaching"] = pin.clone();
        assert!(
            call(state.clone(), "courseware.onlinePrepare.begin", input)
                .await
                .is_err(),
            "{pin}"
        );
    }
    assert!(get(state.clone(), &session).await.is_null());
    let mut boundary = request.clone();
    for field in ["projectId", "teachingRevision", "mappingRevision"] {
        boundary["selection"]["teaching"][field] = json!("a".repeat(128));
    }
    let pending = call(state.clone(), "courseware.onlinePrepare.begin", boundary)
        .await
        .unwrap();
    let key = scope(&*state.lock().await, &session, PRINCIPAL).unwrap();
    for pin in malformed {
        let mut corrupt = pending.clone();
        corrupt["teaching"] = pin;
        state
            .lock()
            .await
            .db
            .kv_set(NAMESPACE, &key, &corrupt)
            .unwrap();
        assert!(call(
            state.clone(),
            "courseware.onlinePrepare.get",
            base(&session)
        )
        .await
        .is_err());
        assert!(call(
            state.clone(),
            "courseware.onlinePrepare.begin",
            request.clone()
        )
        .await
        .is_err());
        let mut upload = transition(&session, &request, "upload-pending", "uploaded");
        upload["uploadedRevision"] = json!(REVISION);
        assert!(
            call(state.clone(), "courseware.onlinePrepare.advance", upload)
                .await
                .is_err()
        );
        assert_eq!(
            state
                .lock()
                .await
                .db
                .kv_get(NAMESPACE, &key)
                .unwrap()
                .unwrap(),
            corrupt
        );
    }
}
