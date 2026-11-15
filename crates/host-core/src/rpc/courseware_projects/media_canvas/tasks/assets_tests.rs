use super::*;
use base64::{engine::general_purpose::STANDARD, Engine};
use sha2::Digest;

const PNG: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";

struct Fixture {
    dir: tempfile::TempDir,
    state: Arc<Mutex<AppState>>,
    scope: Value,
    peer: Value,
    saved: Value,
    prepared: Value,
    project: Value,
}

async fn call(
    state: &Arc<Mutex<AppState>>,
    method: &str,
    params: Value,
) -> Result<Value, JsonRpcError> {
    let (tx, _) = mpsc::unbounded_channel();
    handle_request(state.clone(), method, params, tx).await
}

impl Fixture {
    async fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let (state, scope, peer, project) = super::super::tests::setup(dir.path());
        let saved = call(&state, "courseware.mediaCanvas.set", json!({
            "sessionId": scope["sessionId"], "projectId": scope["projectId"], "expectedRevision": null,
            "document": super::super::tests::document(&scope["projectId"])
        })).await.unwrap();
        let prepared = call(&state, "courseware.mediaCanvas.image.prepare", json!({
            "sessionId": scope["sessionId"], "principalKey": "a".repeat(64), "intentId": "candidate-1",
            "expectedRevision": saved["revision"], "draftId": "image-1", "expectedDraftRevision": 0,
            "model": "image-model"
        })).await.unwrap();
        Self {
            dir,
            state,
            scope,
            peer,
            saved,
            prepared,
            project,
        }
    }

    fn operation(&self) -> Value {
        json!({ "sessionId": self.scope["sessionId"], "principalKey": "a".repeat(64), "intentId": "candidate-1" })
    }

    fn receipt(&self) -> Value {
        json!({ "taskId": "original-task", "idempotencyKey": self.prepared["intent"]["idempotencyKey"],
            "requestHash": self.prepared["intent"]["requestHash"] })
    }

    fn stage(&self) -> Value {
        let bytes = STANDARD.decode(PNG).unwrap();
        let mut operation = self.operation();
        operation["asset"] = json!({ "taskRef": self.receipt(), "sha256": hex::encode(sha2::Sha256::digest(&bytes)),
            "mimeType": "image/png", "byteLength": bytes.len(), "width": 1, "height": 1 });
        operation["bytesBase64"] = json!(PNG);
        operation
    }

    async fn submit(&self) {
        call(
            &self.state,
            "courseware.mediaCanvas.image.begin",
            self.operation(),
        )
        .await
        .unwrap();
        let mut bind = self.operation();
        bind["taskRef"] = self.receipt();
        call(&self.state, "courseware.mediaCanvas.image.bind", bind)
            .await
            .unwrap();
    }

    async fn get(&self) -> Value {
        call(
            &self.state,
            "courseware.mediaCanvas.image.get",
            self.operation(),
        )
        .await
        .unwrap()
    }

    async fn restart(&mut self) {
        let mut app = AppState::open(self.dir.path()).unwrap();
        app.handshook = true;
        self.state = Arc::new(Mutex::new(app));
    }
}

#[tokio::test]
async fn canvas_asset_stage_get_retry_and_restart_retain_original_candidate_without_journal_paths()
{
    let mut f = Fixture::new().await;
    assert!(f.prepared["intent"].get("asset").is_none());
    f.restart().await;
    assert_eq!(f.get().await, f.prepared);
    assert!(call(
        &f.state,
        "courseware.mediaCanvas.image.asset.get",
        f.operation()
    )
    .await
    .is_err());
    f.submit().await;
    let stage = f.stage();
    let archived = call(
        &f.state,
        "courseware.mediaCanvas.image.asset.stage",
        stage.clone(),
    )
    .await
    .unwrap();
    assert_eq!(archived["intent"]["asset"], stage["asset"]);
    assert_eq!(archived["current"], true);
    assert_eq!(
        std::fs::read(archived["path"].as_str().unwrap()).unwrap(),
        STANDARD.decode(PNG).unwrap()
    );
    assert_eq!(
        call(&f.state, "courseware.mediaCanvas.image.asset.stage", stage)
            .await
            .unwrap(),
        archived
    );
    let journal = f.get().await;
    assert!(journal.get("path").is_none());
    assert!(journal["intent"]["asset"].get("path").is_none());
    assert!(journal["intent"]["asset"].get("bytesBase64").is_none());
    f.restart().await;
    assert_eq!(f.get().await, journal);
    assert_eq!(
        call(
            &f.state,
            "courseware.mediaCanvas.image.asset.get",
            f.operation()
        )
        .await
        .unwrap(),
        archived
    );
    let mut next = json!({ "sessionId": f.scope["sessionId"], "principalKey": "a".repeat(64),
        "intentId": "candidate-2", "expectedRevision": f.saved["revision"], "draftId": "image-1",
        "expectedDraftRevision": 0, "model": "image-model" });
    let prepared = call(
        &f.state,
        "courseware.mediaCanvas.image.prepare",
        next.clone(),
    )
    .await
    .unwrap();
    assert_ne!(
        prepared["intent"]["idempotencyKey"],
        f.prepared["intent"]["idempotencyKey"]
    );
    assert!(prepared["intent"].get("asset").is_none());
    next = json!({ "sessionId": f.scope["sessionId"], "principalKey": "a".repeat(64) });
    assert_eq!(
        call(&f.state, "courseware.mediaCanvas.image.list", next)
            .await
            .unwrap()["intents"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        call(
            &f.state,
            "courseware.mediaCanvas.image.asset.get",
            f.operation()
        )
        .await
        .unwrap(),
        archived
    );
}

#[tokio::test]
async fn canvas_asset_stage_requires_submitted_original_receipt() {
    let f = Fixture::new().await;
    assert!(call(
        &f.state,
        "courseware.mediaCanvas.image.asset.stage",
        f.stage()
    )
    .await
    .is_err());
    call(
        &f.state,
        "courseware.mediaCanvas.image.begin",
        f.operation(),
    )
    .await
    .unwrap();
    assert!(call(
        &f.state,
        "courseware.mediaCanvas.image.asset.stage",
        f.stage()
    )
    .await
    .is_err());
    let mut bind = f.operation();
    bind["taskRef"] = f.receipt();
    call(&f.state, "courseware.mediaCanvas.image.bind", bind)
        .await
        .unwrap();
    for (field, value) in [
        ("taskId", json!("foreign-task")),
        ("idempotencyKey", json!(uuid::Uuid::new_v4().to_string())),
        ("requestHash", json!("f".repeat(64))),
    ] {
        let mut forged = f.stage();
        forged["asset"]["taskRef"][field] = value;
        assert!(
            call(&f.state, "courseware.mediaCanvas.image.asset.stage", forged)
                .await
                .is_err(),
            "{field}"
        );
        assert!(f.get().await["intent"].get("asset").is_none());
    }
    assert!(call(
        &f.state,
        "courseware.mediaCanvas.image.asset.stage",
        f.stage()
    )
    .await
    .is_ok());
}

#[tokio::test]
async fn canvas_asset_stage_and_get_allow_changed_deleted_draft_and_plan_mode_without_ppt_write() {
    for deleted in [false, true] {
        let f = Fixture::new().await;
        f.submit().await;
        let mut document = f.saved["document"].clone();
        document["revision"] = json!(1);
        if deleted {
            document["drafts"] = json!([]);
        } else {
            document["drafts"][0]["revision"] = json!(1);
            document["drafts"][0]["prompt"] = json!("Changed draft");
        }
        call(&f.state, "courseware.mediaCanvas.set", json!({ "sessionId": f.scope["sessionId"],
            "projectId": f.scope["projectId"], "expectedRevision": f.saved["revision"], "document": document })).await.unwrap();
        f.state
            .lock()
            .await
            .db
            .conn()
            .execute(
                "UPDATE sessions SET mode='plan' WHERE id=?1",
                [f.scope["sessionId"].as_str().unwrap()],
            )
            .unwrap();
        let archived = call(
            &f.state,
            "courseware.mediaCanvas.image.asset.stage",
            f.stage(),
        )
        .await
        .unwrap();
        assert_eq!(archived["current"], false);
        assert_eq!(archived["intent"]["draft"], f.prepared["intent"]["draft"]);
        assert_eq!(
            call(
                &f.state,
                "courseware.mediaCanvas.image.asset.get",
                f.operation()
            )
            .await
            .unwrap(),
            archived
        );
        assert_eq!(
            serde_json::to_value(
                f.state
                    .lock()
                    .await
                    .db
                    .get_courseware_project(
                        f.dir.path().to_str().unwrap(),
                        f.project["projectId"].as_str().unwrap()
                    )
                    .unwrap()
                    .unwrap()
            )
            .unwrap(),
            f.project
        );
    }
}

#[tokio::test]
async fn canvas_asset_stage_rejects_forged_metadata_bytes_hash_and_extra_paths() {
    let f = Fixture::new().await;
    f.submit().await;
    for (field, value) in [
        ("mimeType", json!("text/html")),
        ("mimeType", json!("image/jpeg")),
        ("sha256", json!("f".repeat(64))),
        ("byteLength", json!(0)),
        ("byteLength", json!(8 * 1024 * 1024 + 1)),
        ("width", json!(2)),
        ("height", json!(4097)),
    ] {
        let mut forged = f.stage();
        forged["asset"][field] = value;
        assert!(
            call(&f.state, "courseware.mediaCanvas.image.asset.stage", forged)
                .await
                .is_err(),
            "{field}"
        );
    }
    for bytes in [
        "!invalid base64".to_owned(),
        STANDARD.encode(b"not an image"),
        "A".repeat((8usize * 1024 * 1024).div_ceil(3) * 4 + 4),
    ] {
        let mut forged = f.stage();
        forged["bytesBase64"] = json!(bytes);
        assert!(
            call(&f.state, "courseware.mediaCanvas.image.asset.stage", forged)
                .await
                .is_err()
        );
    }
    for (field, value) in [
        ("path", json!("/tmp/renderer-image.png")),
        ("bytesBase64", Value::Null),
        ("asset", Value::Null),
    ] {
        let mut forged = f.stage();
        forged[field] = value;
        assert!(
            call(&f.state, "courseware.mediaCanvas.image.asset.stage", forged)
                .await
                .is_err(),
            "{field}"
        );
    }
    let mut nested_path = f.stage();
    nested_path["asset"]["path"] = json!("/tmp/renderer-image.png");
    assert!(call(
        &f.state,
        "courseware.mediaCanvas.image.asset.stage",
        nested_path
    )
    .await
    .is_err());
    let mut get_with_path = f.operation();
    get_with_path["path"] = json!("/tmp/renderer-image.png");
    assert!(call(
        &f.state,
        "courseware.mediaCanvas.image.asset.get",
        get_with_path
    )
    .await
    .is_err());
    assert!(f.get().await["intent"].get("asset").is_none());
}

#[tokio::test]
async fn canvas_asset_cannot_replace_archived_metadata_or_original_bytes() {
    let f = Fixture::new().await;
    f.submit().await;
    let archived = call(
        &f.state,
        "courseware.mediaCanvas.image.asset.stage",
        f.stage(),
    )
    .await
    .unwrap();
    for (field, value) in [
        ("width", json!(2)),
        ("mimeType", json!("image/jpeg")),
        ("sha256", json!("f".repeat(64))),
    ] {
        let mut replacement = f.stage();
        replacement["asset"][field] = value;
        let error = call(
            &f.state,
            "courseware.mediaCanvas.image.asset.stage",
            replacement,
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, 1008, "{field}");
    }
    let mut replacement = f.stage();
    let mut bytes = STANDARD.decode(PNG).unwrap();
    *bytes.last_mut().unwrap() ^= 1;
    replacement["bytesBase64"] = json!(STANDARD.encode(bytes));
    assert!(call(
        &f.state,
        "courseware.mediaCanvas.image.asset.stage",
        replacement
    )
    .await
    .is_err());
    assert_eq!(
        std::fs::read(archived["path"].as_str().unwrap()).unwrap(),
        STANDARD.decode(PNG).unwrap()
    );
    assert_eq!(
        call(
            &f.state,
            "courseware.mediaCanvas.image.asset.get",
            f.operation()
        )
        .await
        .unwrap(),
        archived
    );
}

#[tokio::test]
async fn canvas_asset_stage_and_get_are_private_to_original_account_and_session() {
    let f = Fixture::new().await;
    f.submit().await;
    let archived = call(
        &f.state,
        "courseware.mediaCanvas.image.asset.stage",
        f.stage(),
    )
    .await
    .unwrap();
    for (field, value) in [
        ("principalKey", json!("b".repeat(64))),
        ("sessionId", f.peer["sessionId"].clone()),
    ] {
        for (method, mut params) in [
            ("courseware.mediaCanvas.image.asset.stage", f.stage()),
            ("courseware.mediaCanvas.image.asset.get", f.operation()),
        ] {
            params[field] = value.clone();
            assert_eq!(
                call(&f.state, method, params).await.unwrap_err().code,
                1007,
                "{field}, {method}"
            );
        }
    }
    assert_eq!(
        call(
            &f.state,
            "courseware.mediaCanvas.image.asset.get",
            f.operation()
        )
        .await
        .unwrap(),
        archived
    );
}

#[tokio::test]
async fn canvas_asset_ignored_journal_write_never_acknowledges_candidate_and_retry_recovers() {
    let f = Fixture::new().await;
    f.submit().await;
    f.state.lock().await.db.conn().execute_batch("CREATE TRIGGER ignore_canvas_asset BEFORE UPDATE ON kv WHEN NEW.ns='coursewareMediaCanvasImages.v1' BEGIN SELECT RAISE(IGNORE); END;").unwrap();
    assert!(call(
        &f.state,
        "courseware.mediaCanvas.image.asset.stage",
        f.stage()
    )
    .await
    .is_err());
    assert!(f.get().await["intent"].get("asset").is_none());
    assert!(call(
        &f.state,
        "courseware.mediaCanvas.image.asset.get",
        f.operation()
    )
    .await
    .is_err());
    f.state
        .lock()
        .await
        .db
        .conn()
        .execute_batch("DROP TRIGGER ignore_canvas_asset;")
        .unwrap();
    let archived = call(
        &f.state,
        "courseware.mediaCanvas.image.asset.stage",
        f.stage(),
    )
    .await
    .unwrap();
    assert_eq!(
        call(
            &f.state,
            "courseware.mediaCanvas.image.asset.get",
            f.operation()
        )
        .await
        .unwrap(),
        archived
    );
}

#[tokio::test]
async fn canvas_asset_get_rechecks_missing_corrupt_archive_and_never_overwrites_corruption() {
    let mut f = Fixture::new().await;
    f.submit().await;
    let archived = call(
        &f.state,
        "courseware.mediaCanvas.image.asset.stage",
        f.stage(),
    )
    .await
    .unwrap();
    let path = archived["path"].as_str().unwrap();
    std::fs::remove_file(path).unwrap();
    assert!(call(
        &f.state,
        "courseware.mediaCanvas.image.asset.get",
        f.operation()
    )
    .await
    .is_err());
    assert_eq!(
        call(
            &f.state,
            "courseware.mediaCanvas.image.asset.stage",
            f.stage()
        )
        .await
        .unwrap(),
        archived
    );
    let corrupt = vec![0; STANDARD.decode(PNG).unwrap().len()];
    std::fs::write(path, &corrupt).unwrap();
    f.restart().await;
    assert!(call(
        &f.state,
        "courseware.mediaCanvas.image.asset.get",
        f.operation()
    )
    .await
    .is_err());
    assert!(call(
        &f.state,
        "courseware.mediaCanvas.image.asset.stage",
        f.stage()
    )
    .await
    .is_err());
    assert_eq!(std::fs::read(path).unwrap(), corrupt);
    assert_eq!(f.get().await["intent"], archived["intent"]);
}

#[tokio::test]
async fn canvas_asset_explicit_restore_repairs_original_missing_or_corrupt_bytes_after_restart() {
    for missing in [true, false] {
        let mut f = Fixture::new().await;
        f.submit().await;
        let archived = call(
            &f.state,
            "courseware.mediaCanvas.image.asset.stage",
            f.stage(),
        )
        .await
        .unwrap();
        let path = archived["path"].as_str().unwrap();
        if missing {
            std::fs::remove_file(path).unwrap();
        } else {
            std::fs::write(path, b"damaged local cache").unwrap();
        }
        f.restart().await;
        assert!(call(
            &f.state,
            "courseware.mediaCanvas.image.asset.get",
            f.operation()
        )
        .await
        .is_err());
        let restored = call(
            &f.state,
            "courseware.mediaCanvas.image.asset.restore",
            f.stage(),
        )
        .await
        .unwrap();
        assert_eq!(restored, archived);
        assert_eq!(std::fs::read(path).unwrap(), STANDARD.decode(PNG).unwrap());
        f.restart().await;
        assert_eq!(
            call(
                &f.state,
                "courseware.mediaCanvas.image.asset.get",
                f.operation()
            )
            .await
            .unwrap(),
            archived
        );
        assert_eq!(f.get().await["intent"], archived["intent"]);
    }
}

#[tokio::test]
async fn canvas_asset_restore_rejects_unarchived_foreign_or_modified_originals_without_replacing_bytes(
) {
    let f = Fixture::new().await;
    assert!(call(
        &f.state,
        "courseware.mediaCanvas.image.asset.restore",
        f.stage()
    )
    .await
    .is_err());
    f.submit().await;
    assert!(call(
        &f.state,
        "courseware.mediaCanvas.image.asset.restore",
        f.stage()
    )
    .await
    .is_err());
    let archived = call(
        &f.state,
        "courseware.mediaCanvas.image.asset.stage",
        f.stage(),
    )
    .await
    .unwrap();
    let path = archived["path"].as_str().unwrap();
    std::fs::write(path, b"keep damage on rejected repair").unwrap();
    for boundary in [
        "principal",
        "session",
        "hash",
        "receipt",
        "dimensions",
        "bytes",
        "extra",
    ] {
        let mut operation = f.stage();
        match boundary {
            "principal" => operation["principalKey"] = json!("b".repeat(64)),
            "session" => operation["sessionId"] = f.peer["sessionId"].clone(),
            "hash" => operation["asset"]["sha256"] = json!("f".repeat(64)),
            "receipt" => operation["asset"]["taskRef"]["taskId"] = json!("foreign-task"),
            "dimensions" => operation["asset"]["width"] = json!(2),
            "bytes" => operation["bytesBase64"] = json!(STANDARD.encode(b"wrong bytes")),
            "extra" => operation["path"] = json!("/tmp/foreign.bin"),
            _ => unreachable!(),
        }
        assert!(
            call(
                &f.state,
                "courseware.mediaCanvas.image.asset.restore",
                operation
            )
            .await
            .is_err(),
            "{boundary}"
        );
        assert_eq!(
            std::fs::read(path).unwrap(),
            b"keep damage on rejected repair"
        );
        assert_eq!(f.get().await["intent"], archived["intent"]);
    }
}
