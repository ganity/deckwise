use super::*;
use base64::{engine::general_purpose::STANDARD, Engine};

pub(super) const CANDIDATE: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TEAM: &str = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

pub(super) async fn call(
    state: &Arc<Mutex<AppState>>,
    operation: &str,
    params: Value,
) -> Result<Value, JsonRpcError> {
    let (tx, _) = mpsc::unbounded_channel();
    handle_request(
        state.clone(),
        &format!("courseware.mediaCanvas.music.{operation}"),
        params,
        tx,
    )
    .await
}

pub(super) async fn fixture() -> (tempfile::TempDir, Arc<Mutex<AppState>>, Value, Value) {
    let dir = tempfile::tempdir().unwrap();
    let (state, scope, _, _) = super::super::tests::setup(dir.path());
    let mut write = scope.clone();
    write["expectedRevision"] = Value::Null;
    write["document"] = super::super::tests::document(&scope["projectId"]);
    write["document"]["drafts"][0]["kind"] = json!("music");
    write["document"]["drafts"][0]["title"] = json!("Title");
    let saved = super::super::handle(state.clone(), "courseware.mediaCanvas.set", write)
        .await
        .unwrap();
    let prepare = json!({"sessionId":scope["sessionId"],"principalKey":"a".repeat(64),"intentId":"music-1",
        "expectedRevision":saved["revision"],"draftId":"image-1","expectedDraftRevision":0,"model":"suno",
        "music":{"title":"Title","tags":"pop","instrumental":false}});
    (dir, state, prepare, saved)
}
pub(super) fn op(prepare: &Value) -> Value {
    json!({"sessionId":prepare["sessionId"],"principalKey":prepare["principalKey"],"intentId":prepare["intentId"]})
}
pub(super) fn task(intent: &Value, task_id: &str) -> Value {
    json!({"taskId":task_id,"requestHash":intent["intent"]["requestHash"],"idempotencyKey":intent["intent"]["idempotencyKey"]})
}
pub(super) async fn submitted(state: &Arc<Mutex<AppState>>, prepare: &Value) -> (Value, Value) {
    let prepared = call(state, "prepare", prepare.clone()).await.unwrap();
    call(state, "begin", op(prepare)).await.unwrap();
    let reference = task(&prepared, "music-task");
    let mut bind = op(prepare);
    bind["taskRef"] = reference.clone();
    let result = call(state, "bind", bind).await.unwrap();
    (result, reference)
}
pub(super) fn candidates(prepare: &Value, reference: &Value, ready: bool) -> Value {
    let mut value = op(prepare);
    value["taskRef"] = reference.clone();
    value["ready"] = json!(ready);
    value["candidates"] = json!([{"candidateId":CANDIDATE,"order":0,"state":if ready {"completed"} else {"processing"},"exportable":ready,"durationMs":1234}]);
    value
}

#[test]
fn music_hash_matches_platform_java_utf16_and_keeps_option_distinctions() {
    let request = Request::Music {
        model: "suno".into(),
        input: "你好🎵".into(),
        music: MusicOptions {
            title: "Title".into(),
            tags: Some("pop".into()),
            negative_tags: None,
            instrumental: Some(false),
        },
    };
    assert_eq!(
        request.hash(),
        "3b8963388b328b57f587eb9dbda61b9e0badf426fb9517b58b9427e4446c5148"
    );
    let mut changed = request.clone();
    if let Request::Music { music, .. } = &mut changed {
        music.instrumental = None;
    }
    assert_ne!(request.hash(), changed.hash());
    let mut instrumental = changed;
    if let Request::Music { input, music, .. } = &mut instrumental {
        *input = "".into();
        music.instrumental = Some(true);
    }
    assert!(instrumental.valid());
    if let Request::Music { music, .. } = &mut instrumental {
        music.instrumental = Some(false);
    }
    assert!(!instrumental.valid());
}

#[tokio::test]
async fn canvas_music_intent_is_durable_single_dispatch_and_private_after_restart() {
    let (dir, state, prepare, _) = fixture().await;
    let first = call(&state, "prepare", prepare.clone()).await.unwrap();
    assert_eq!(
        first,
        call(&state, "prepare", prepare.clone()).await.unwrap()
    );
    let mut second = prepare.clone();
    second["intentId"] = json!("music-2");
    let second = call(&state, "prepare", second).await.unwrap();
    assert_ne!(
        first["intent"]["idempotencyKey"],
        second["intent"]["idempotencyKey"]
    );
    let mut binding = op(&prepare);
    binding["taskRef"] = task(&first, "task-1");
    assert!(call(&state, "bind", binding.clone()).await.is_err());
    let begun = call(&state, "begin", op(&prepare)).await.unwrap();
    assert_eq!(begun["intent"]["phase"], "submission-unknown");
    assert!(call(&state, "begin", op(&prepare)).await.is_err());
    drop(state);
    let mut app = AppState::open(dir.path()).unwrap();
    app.handshook = true;
    let state = Arc::new(Mutex::new(app));
    assert_eq!(call(&state, "get", op(&prepare)).await.unwrap(), begun);
    let mut foreign = op(&prepare);
    foreign["principalKey"] = json!("b".repeat(64));
    assert!(call(&state, "get", foreign).await.is_err());
    let bound = call(&state, "bind", binding.clone()).await.unwrap();
    assert_eq!(bound["intent"]["phase"], "submitted");
    assert_eq!(bound, call(&state, "bind", binding.clone()).await.unwrap());
    binding["taskRef"]["taskId"] = json!("different");
    assert!(call(&state, "bind", binding).await.is_err());
}

#[tokio::test]
async fn canvas_music_candidates_preview_export_and_archive_survive_draft_edits_restart() {
    let (dir, state, prepare, saved) = fixture().await;
    let (_, reference) = submitted(&state, &prepare).await;
    let processing = candidates(&prepare, &reference, false);
    call(&state, "candidates.record", processing.clone())
        .await
        .unwrap();
    let ready = candidates(&prepare, &reference, true);
    let result = call(&state, "candidates.record", ready.clone())
        .await
        .unwrap();
    assert_eq!(result["intent"]["candidates"][0]["candidateId"], CANDIDATE);
    assert!(call(&state, "candidates.record", processing).await.is_err());
    let mut forged = ready.clone();
    forged["candidates"][0]["candidateId"] = json!(TEAM);
    assert!(call(&state, "candidates.record", forged).await.is_err());
    let bytes = b"ID3-music-preview";
    let mut preview = op(&prepare);
    preview["candidateId"] = json!(CANDIDATE);
    preview["asset"] = json!({"taskRef":reference,"sha256":hex::encode(Sha256::digest(bytes)),"mimeType":"audio/mpeg","byteLength":bytes.len()});
    preview["bytesBase64"] = json!(STANDARD.encode(bytes));
    let archived = call(&state, "asset.stage", preview.clone()).await.unwrap();
    let path = archived["path"].as_str().unwrap();
    assert_eq!(std::fs::read(path).unwrap(), bytes);
    let mut get_preview = op(&prepare);
    get_preview["candidateId"] = json!(CANDIDATE);
    assert_eq!(
        call(&state, "asset.get", get_preview.clone())
            .await
            .unwrap(),
        archived
    );
    std::fs::write(path, b"corrupt").unwrap();
    assert!(call(&state, "asset.get", get_preview.clone())
        .await
        .is_err());
    assert!(call(&state, "asset.stage", preview.clone()).await.is_err());
    call(&state, "asset.restore", preview.clone())
        .await
        .unwrap();
    let mut replacement = preview.clone();
    replacement["asset"]["sha256"] = json!("b".repeat(64));
    assert!(call(&state, "asset.restore", replacement).await.is_err());
    let mut write = json!({"sessionId":prepare["sessionId"],"projectId":saved["document"]["projectId"],"expectedRevision":saved["revision"],"document":saved["document"]});
    write["document"]["revision"] = json!(1);
    write["document"]["drafts"] = json!([]);
    super::super::handle(state.clone(), "courseware.mediaCanvas.set", write)
        .await
        .unwrap();
    let export = json!({"sessionId":prepare["sessionId"],"principalKey":prepare["principalKey"],"intentId":"export-1","sourceIntentId":"music-1","candidateId":CANDIDATE,"model":"mp3"});
    let export_intent = call(&state, "export.prepare", export.clone())
        .await
        .unwrap();
    assert_eq!(export_intent["current"], false);
    assert_eq!(
        export_intent["intent"]["request"],
        json!({"kind":"music-export","model":"mp3","input":CANDIDATE})
    );
    assert_ne!(
        export_intent["intent"]["idempotencyKey"],
        result["intent"]["idempotencyKey"]
    );
    let mut export_op = op(&export);
    let begun = call(&state, "begin", export_op.clone()).await.unwrap();
    assert_eq!(
        begun["intent"]["submissionScope"],
        result["intent"]["submissionScope"]
    );
    let export_task = task(&export_intent, "export-task");
    export_op["taskRef"] = export_task.clone();
    call(&state, "bind", export_op).await.unwrap();
    let mut archive = op(&export);
    archive["asset"] = preview["asset"].clone();
    archive["asset"]["taskRef"] = export_task;
    archive["bytesBase64"] = preview["bytesBase64"].clone();
    let exported = call(&state, "asset.stage", archive).await.unwrap();
    drop(state);
    let mut app = AppState::open(dir.path()).unwrap();
    app.handshook = true;
    let state = Arc::new(Mutex::new(app));
    assert_eq!(
        call(&state, "asset.get", op(&export)).await.unwrap(),
        exported
    );
    assert_eq!(
        call(&state, "asset.get", get_preview).await.unwrap()["intent"]["previews"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        call(
            &state,
            "list",
            json!({"sessionId":prepare["sessionId"],"principalKey":prepare["principalKey"]})
        )
        .await
        .unwrap()["intents"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
}

#[tokio::test]
async fn canvas_music_enforces_cas_options_task_scope_and_storage_before_dispatch() {
    let (_dir, state, prepare, _) = fixture().await;
    for (field, value) in [
        ("expectedRevision", json!("stale")),
        ("expectedDraftRevision", json!(1)),
        ("input", json!("forged")),
        ("model", json!("../bad")),
        ("music", json!({"title":"Different"})),
    ] {
        let mut bad = prepare.clone();
        bad[field] = value;
        assert!(call(&state, "prepare", bad).await.is_err(), "{field}");
    }
    state.lock().await.db.conn().execute_batch("CREATE TRIGGER ignore_music BEFORE INSERT ON kv WHEN NEW.ns='coursewareMediaCanvasMusic.v1' BEGIN SELECT RAISE(IGNORE); END;").unwrap();
    assert!(call(&state, "prepare", prepare.clone()).await.is_err());
    state
        .lock()
        .await
        .db
        .conn()
        .execute_batch("DROP TRIGGER ignore_music;")
        .unwrap();
    call(&state, "prepare", prepare.clone()).await.unwrap();
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
    assert!(call(&state, "begin", op(&prepare)).await.is_err());
    assert_eq!(
        call(&state, "get", op(&prepare)).await.unwrap()["intent"]["phase"],
        "prepared"
    );
}

#[tokio::test]
async fn canvas_music_export_keeps_source_team_and_rejection_never_replays() {
    let (_dir, state, prepare, _) = fixture().await;
    let (tx, _) = mpsc::unbounded_channel();
    handle_request(
        state.clone(),
        "courseware.task.bindTeam",
        json!({"sessionId":prepare["sessionId"],"teamProjectId":TEAM}),
        tx,
    )
    .await
    .unwrap();
    let (_, reference) = submitted(&state, &prepare).await;
    call(
        &state,
        "candidates.record",
        candidates(&prepare, &reference, true),
    )
    .await
    .unwrap();
    let export = json!({"sessionId":prepare["sessionId"],"principalKey":prepare["principalKey"],"intentId":"export-1","sourceIntentId":"music-1","candidateId":CANDIDATE,"model":"mp3"});
    let prepared = call(&state, "export.prepare", export.clone())
        .await
        .unwrap();
    let (tx, _) = mpsc::unbounded_channel();
    assert!(handle_request(
        state.clone(),
        "courseware.task.bindTeam",
        json!({"sessionId":prepare["sessionId"],"teamProjectId":CANDIDATE}),
        tx,
    )
    .await
    .is_err());
    let begun = call(&state, "begin", op(&export)).await.unwrap();
    assert_eq!(begun["intent"]["submissionScope"]["teamProjectId"], TEAM);
    let mut rejected = op(&export);
    rejected["rejectedRequest"] = json!({"idempotencyKey":prepared["intent"]["idempotencyKey"],"requestHash":prepared["intent"]["requestHash"]});
    assert_eq!(
        call(&state, "reject", rejected).await.unwrap()["intent"]["phase"],
        "rejected"
    );
    assert!(call(&state, "begin", op(&export)).await.is_err());
    let mut bind = op(&export);
    bind["taskRef"] = task(&prepared, "late");
    assert!(call(&state, "bind", bind).await.is_err());
}

#[tokio::test]
async fn canvas_music_export_uses_original_personal_scope_after_later_team_binding() {
    let (_dir, state, prepare, _) = fixture().await;
    let (_, reference) = submitted(&state, &prepare).await;
    call(
        &state,
        "candidates.record",
        candidates(&prepare, &reference, true),
    )
    .await
    .unwrap();
    let (tx, _) = mpsc::unbounded_channel();
    handle_request(
        state.clone(),
        "courseware.task.bindTeam",
        json!({"sessionId":prepare["sessionId"],"teamProjectId":TEAM}),
        tx,
    )
    .await
    .unwrap();
    let export = json!({"sessionId":prepare["sessionId"],"principalKey":prepare["principalKey"],"intentId":"export-1","sourceIntentId":"music-1","candidateId":CANDIDATE,"model":"mp3"});
    call(&state, "export.prepare", export.clone())
        .await
        .unwrap();
    let begun = call(&state, "begin", op(&export)).await.unwrap();
    assert_eq!(
        begun["intent"]["submissionScope"],
        json!({"sessionId":prepare["sessionId"],"teamProjectId":null})
    );
}
