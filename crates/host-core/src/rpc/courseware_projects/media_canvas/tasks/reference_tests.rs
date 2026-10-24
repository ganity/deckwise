use super::*;
use base64::{engine::general_purpose::STANDARD, Engine};
use sha2::Digest;

struct Fixture {
    dir: tempfile::TempDir,
    state: Arc<Mutex<AppState>>,
    scope: Value,
    peer: Value,
    saved: Value,
    scene_key: String,
    reference: Value,
    archive: std::path::PathBuf,
    bytes: Vec<u8>,
}

async fn call(
    state: &Arc<Mutex<AppState>>,
    method: &str,
    params: Value,
) -> Result<Value, JsonRpcError> {
    let (tx, _) = mpsc::unbounded_channel();
    handle_request(state.clone(), method, params, tx).await
}

async fn save_canvas(state: &Arc<Mutex<AppState>>, scope: &Value, reference: &Value) -> Value {
    let mut document = super::super::tests::document(&scope["projectId"]);
    document["drafts"][0]["references"] = json!([reference]);
    call(
        state,
        "courseware.mediaCanvas.set",
        json!({ "sessionId": scope["sessionId"], "projectId": scope["projectId"],
            "expectedRevision": null, "document": document }),
    )
    .await
    .unwrap()
}

impl Fixture {
    async fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let (state, scope, peer, _) = super::super::tests::setup(dir.path());
        let bytes = STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==").unwrap();
        let sha256 = hex::encode(sha2::Sha256::digest(&bytes));
        let reference =
            json!({ "assetId": "archived-image", "revision": sha256, "label": "Owned reference" });
        let request = ImageRequest {
            kind: "image".into(),
            model: "image-model".into(),
            input: "A bright geometric shape".into(),
            reference_image: None,
        };
        let key = uuid::Uuid::new_v4().to_string();
        let receipt = json!({ "taskId": "archived-task", "idempotencyKey": key, "requestHash": request.hash() });
        let scene_key = serde_json::to_string(&(
            dir.path().canonicalize().unwrap(),
            scope["sessionId"].as_str().unwrap(),
            "a".repeat(64),
        ))
        .unwrap();
        let archive = {
            let app = state.lock().await;
            crate::courseware::snapshot_assets::archive_bytes(&app.data_dir, &sha256, &bytes)
                .unwrap();
            app.db
                .kv_set(
                    "coursewareSceneImages.v1",
                    &scene_key,
                    &json!([{ "intentId": "archived-image", "planSha256": "c".repeat(64),
                        "pageId": "scene-001", "target": { "kind": "visualMaster" },
                        "request": request, "idempotencyKey": key, "requestHash": request.hash(),
                        "phase": "submitted", "taskRef": receipt, "selected": true,
                        "asset": { "taskRef": receipt, "sha256": sha256, "mimeType": "image/png",
                            "byteLength": bytes.len(), "width": 1, "height": 1 } }]),
                )
                .unwrap();
            crate::courseware::snapshot_assets::verify(&app.data_dir, &sha256)
                .unwrap()
                .0
        };
        let saved = save_canvas(&state, &scope, &reference).await;
        Self {
            dir,
            state,
            scope,
            peer,
            saved,
            scene_key,
            reference,
            archive,
            bytes,
        }
    }

    fn prepare(&self) -> Value {
        json!({ "sessionId": self.scope["sessionId"], "principalKey": "a".repeat(64),
            "intentId": "reference-attempt", "draftId": "image-1", "expectedDraftRevision": self.saved["document"]["drafts"][0]["revision"],
            "expectedRevision": self.saved["revision"], "model": "image-model" })
    }

    fn operation(&self) -> Value {
        json!({ "sessionId": self.scope["sessionId"], "principalKey": "a".repeat(64),
            "intentId": "reference-attempt" })
    }

    async fn edit_references(&mut self, references: Value) {
        self.saved = call(
            &self.state,
            "courseware.mediaCanvas.editDraft",
            json!({ "sessionId": self.scope["sessionId"], "projectId": self.scope["projectId"],
                "expectedRevision": self.saved["revision"], "draftId": "image-1",
                "expectedDraftRevision": self.saved["document"]["drafts"][0]["revision"],
                "patch": { "references": references } }),
        )
        .await
        .unwrap();
    }

    async fn list(&self, operation: &Value) -> Value {
        call(
            &self.state,
            "courseware.mediaCanvas.image.list",
            json!({ "sessionId": operation["sessionId"], "principalKey": operation["principalKey"] }),
        )
        .await
        .unwrap()
    }

    async fn archive_generated_reference(&mut self) -> Value {
        self.edit_references(json!([])).await;
        let mut prepare = self.prepare();
        prepare["intentId"] = json!("archived-image");
        let source = call(&self.state, "courseware.mediaCanvas.image.prepare", prepare)
            .await
            .unwrap();
        let mut operation = self.operation();
        operation["intentId"] = json!("archived-image");
        call(
            &self.state,
            "courseware.mediaCanvas.image.begin",
            operation.clone(),
        )
        .await
        .unwrap();
        let receipt = json!({ "taskId": "generated-reference-task", "idempotencyKey": source["intent"]["idempotencyKey"],
            "requestHash": source["intent"]["requestHash"] });
        let mut bind = operation.clone();
        bind["taskRef"] = receipt.clone();
        call(&self.state, "courseware.mediaCanvas.image.bind", bind)
            .await
            .unwrap();
        let mut stage = operation;
        stage["asset"] = json!({ "taskRef": receipt, "sha256": self.reference["revision"],
            "mimeType": "image/png", "byteLength": self.bytes.len(), "width": 1, "height": 1 });
        stage["bytesBase64"] = json!(STANDARD.encode(&self.bytes));
        let archived = call(
            &self.state,
            "courseware.mediaCanvas.image.asset.stage",
            stage,
        )
        .await
        .unwrap();
        let mut reference = self.reference.clone();
        reference["assetId"] = json!("canvas-image:archived-image");
        self.edit_references(json!([reference])).await;
        archived
    }
}

#[tokio::test]
async fn generated_canvas_reference_survives_source_draft_edits_and_restart_without_mutating_original(
) {
    let mut f = Fixture::new().await;
    let archived = f.archive_generated_reference().await;
    let prepared = call(
        &f.state,
        "courseware.mediaCanvas.image.prepare",
        f.prepare(),
    )
    .await
    .unwrap();
    assert_eq!(
        prepared["intent"]["draft"]["references"][0]["assetId"],
        "canvas-image:archived-image"
    );
    assert_eq!(
        prepared["intent"]["request"]["referenceImage"]["sha256"],
        archived["intent"]["asset"]["sha256"]
    );
    assert_ne!(
        prepared["intent"]["requestHash"],
        archived["intent"]["requestHash"]
    );
    assert_eq!(
        f.list(&f.operation()).await["intents"][0]["intent"],
        archived["intent"]
    );
    call(
        &f.state,
        "courseware.mediaCanvas.image.begin",
        f.operation(),
    )
    .await
    .unwrap();
    f.edit_references(json!([])).await;
    let mut app = AppState::open(f.dir.path()).unwrap();
    app.handshook = true;
    f.state = Arc::new(Mutex::new(app));
    let resolved = call(
        &f.state,
        "courseware.mediaCanvas.image.reference",
        f.operation(),
    )
    .await
    .unwrap();
    assert_eq!(
        resolved["reference"],
        prepared["intent"]["request"]["referenceImage"]
    );
    assert_eq!(resolved["asset"], archived["intent"]["asset"]);
    assert_eq!(
        std::fs::read(resolved["path"].as_str().unwrap()).unwrap(),
        f.bytes
    );
    assert_eq!(
        f.list(&f.operation()).await["intents"][0]["intent"],
        archived["intent"]
    );
}

#[tokio::test]
async fn generated_canvas_references_reject_foreign_or_invalid_archives_without_scene_fallback() {
    for boundary in [
        "principal",
        "session",
        "hash",
        "missing",
        "corrupt",
        "unarchived",
        "webp",
    ] {
        let mut f = Fixture::new().await;
        f.archive_generated_reference().await;
        let mut prepare = f.prepare();
        match boundary {
            "principal" => prepare["principalKey"] = json!("b".repeat(64)),
            "session" => {
                let saved = save_canvas(
                    &f.state,
                    &f.peer,
                    &f.saved["document"]["drafts"][0]["references"][0],
                )
                .await;
                prepare["sessionId"] = f.peer["sessionId"].clone();
                prepare["expectedRevision"] = saved["revision"].clone();
            }
            "hash" => {
                let mut reference = f.saved["document"]["drafts"][0]["references"][0].clone();
                reference["revision"] = json!("f".repeat(64));
                f.edit_references(json!([reference])).await;
                prepare = f.prepare();
            }
            "missing" => std::fs::remove_file(&f.archive).unwrap(),
            "corrupt" => std::fs::write(&f.archive, vec![0; f.bytes.len()]).unwrap(),
            "unarchived" | "webp" => {
                let app = f.state.lock().await;
                let mut journal = app.db.kv_get(JOURNAL, &f.scene_key).unwrap().unwrap();
                if boundary == "unarchived" {
                    journal[0]["asset"] = Value::Null;
                } else {
                    journal[0]["asset"]["mimeType"] = json!("image/webp");
                }
                app.db.kv_set(JOURNAL, &f.scene_key, &journal).unwrap();
            }
            _ => unreachable!(),
        }
        assert!(
            call(
                &f.state,
                "courseware.mediaCanvas.image.prepare",
                prepare.clone()
            )
            .await
            .is_err(),
            "{boundary}"
        );
        let intents = f.list(&prepare).await;
        assert!(
            intents["intents"]
                .as_array()
                .unwrap()
                .iter()
                .all(|entry| entry["intent"]["intentId"] != "reference-attempt"),
            "{boundary}"
        );
    }
}

#[tokio::test]
async fn canvas_reference_freezes_owned_png_and_resolves_after_deselection_edit_and_restart() {
    let mut f = Fixture::new().await;
    let prepared = call(
        &f.state,
        "courseware.mediaCanvas.image.prepare",
        f.prepare(),
    )
    .await
    .unwrap();
    let metadata = json!({ "sha256": f.reference["revision"], "mimeType": "image/png", "byteLength": f.bytes.len() });
    assert_eq!(
        prepared["intent"]["draft"]["references"],
        json!([f.reference])
    );
    assert_eq!(prepared["intent"]["request"]["referenceImage"], metadata);
    assert_eq!(prepared["intent"]["request"]["input"], "Original");
    assert_eq!(prepared["current"], true);
    assert!(prepared["intent"]["request"]["referenceImage"]
        .get("bytesBase64")
        .is_none());
    assert!(prepared["intent"]["request"]["referenceImage"]
        .get("path")
        .is_none());
    assert_eq!(
        call(
            &f.state,
            "courseware.mediaCanvas.image.prepare",
            f.prepare()
        )
        .await
        .unwrap(),
        prepared
    );
    assert_eq!(
        call(
            &f.state,
            "courseware.mediaCanvas.image.begin",
            f.operation()
        )
        .await
        .unwrap()["intent"]["phase"],
        "submission-unknown"
    );
    {
        let app = f.state.lock().await;
        let mut journal = app
            .db
            .kv_get("coursewareSceneImages.v1", &f.scene_key)
            .unwrap()
            .unwrap();
        journal[0]["selected"] = json!(false);
        app.db
            .kv_set("coursewareSceneImages.v1", &f.scene_key, &journal)
            .unwrap();
    }
    f.edit_references(json!([])).await;
    let mut app = AppState::open(f.dir.path()).unwrap();
    app.handshook = true;
    f.state = Arc::new(Mutex::new(app));
    let retained = call(&f.state, "courseware.mediaCanvas.image.get", f.operation())
        .await
        .unwrap();
    assert_eq!(retained["intent"]["request"], prepared["intent"]["request"]);
    assert_eq!(retained["current"], false);
    let resolved = call(
        &f.state,
        "courseware.mediaCanvas.image.reference",
        f.operation(),
    )
    .await
    .unwrap();
    assert_eq!(resolved["reference"], metadata);
    assert_eq!(resolved["asset"]["sha256"], f.reference["revision"]);
    assert_eq!(resolved["path"], json!(f.archive));
    assert_eq!(
        std::fs::read(resolved["path"].as_str().unwrap()).unwrap(),
        f.bytes
    );
}

#[tokio::test]
async fn canvas_reference_prepare_rejects_foreign_principal_session_and_hash() {
    for boundary in ["principal", "session", "hash"] {
        let mut f = Fixture::new().await;
        let mut prepare = f.prepare();
        match boundary {
            "principal" => prepare["principalKey"] = json!("b".repeat(64)),
            "session" => {
                let peer = save_canvas(&f.state, &f.peer, &f.reference).await;
                prepare["sessionId"] = f.peer["sessionId"].clone();
                prepare["expectedRevision"] = peer["revision"].clone();
            }
            "hash" => {
                let mut reference = f.reference.clone();
                reference["revision"] = json!("f".repeat(64));
                f.edit_references(json!([reference])).await;
                prepare = f.prepare();
            }
            _ => unreachable!(),
        }
        let error = call(
            &f.state,
            "courseware.mediaCanvas.image.prepare",
            prepare.clone(),
        )
        .await
        .unwrap_err();
        assert!(
            error.message.contains("owned archived PNG or JPEG"),
            "{boundary}: {}",
            error.message
        );
        assert_eq!(f.list(&prepare).await["intents"], json!([]), "{boundary}");
    }
}

#[tokio::test]
async fn canvas_reference_resolution_does_not_grant_foreign_scope_access_to_shared_archive() {
    let f = Fixture::new().await;
    call(
        &f.state,
        "courseware.mediaCanvas.image.prepare",
        f.prepare(),
    )
    .await
    .unwrap();
    for (field, value) in [
        ("principalKey", json!("b".repeat(64))),
        ("sessionId", f.peer["sessionId"].clone()),
    ] {
        let mut foreign = f.operation();
        foreign[field] = value;
        let error = call(
            &f.state,
            "courseware.mediaCanvas.image.reference",
            foreign.clone(),
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, 1007, "{field}");
        assert_eq!(f.list(&foreign).await["intents"], json!([]));
    }
    assert!(call(
        &f.state,
        "courseware.mediaCanvas.image.reference",
        f.operation()
    )
    .await
    .is_ok());
}

#[tokio::test]
async fn canvas_reference_missing_or_corrupt_bytes_block_prepare_begin_and_resolution() {
    for missing in [true, false] {
        let f = Fixture::new().await;
        if missing {
            std::fs::remove_file(&f.archive).unwrap();
        } else {
            std::fs::write(&f.archive, vec![0; f.bytes.len()]).unwrap();
        }
        assert!(call(
            &f.state,
            "courseware.mediaCanvas.image.prepare",
            f.prepare()
        )
        .await
        .is_err());
        assert_eq!(f.list(&f.operation()).await["intents"], json!([]));
        if !missing {
            std::fs::remove_file(&f.archive).unwrap();
        }
        {
            let app = f.state.lock().await;
            crate::courseware::snapshot_assets::archive_bytes(
                &app.data_dir,
                f.reference["revision"].as_str().unwrap(),
                &f.bytes,
            )
            .unwrap();
        }
        let prepared = call(
            &f.state,
            "courseware.mediaCanvas.image.prepare",
            f.prepare(),
        )
        .await
        .unwrap();
        if missing {
            std::fs::remove_file(&f.archive).unwrap();
        } else {
            std::fs::write(&f.archive, vec![0; f.bytes.len()]).unwrap();
        }
        assert!(call(
            &f.state,
            "courseware.mediaCanvas.image.prepare",
            f.prepare()
        )
        .await
        .is_err());
        for method in [
            "courseware.mediaCanvas.image.begin",
            "courseware.mediaCanvas.image.reference",
        ] {
            assert!(
                call(&f.state, method, f.operation()).await.is_err(),
                "{method}, missing={missing}"
            );
        }
        assert_eq!(
            call(&f.state, "courseware.mediaCanvas.image.get", f.operation())
                .await
                .unwrap(),
            prepared
        );
    }
}

#[tokio::test]
async fn canvas_reference_multiple_saved_references_are_rejected_without_dropping_them() {
    let mut f = Fixture::new().await;
    let mut second = f.reference.clone();
    second["assetId"] = json!("another-reference");
    let references = json!([f.reference, second]);
    f.edit_references(references.clone()).await;
    let error = call(
        &f.state,
        "courseware.mediaCanvas.image.prepare",
        f.prepare(),
    )
    .await
    .unwrap_err();
    assert!(error.message.contains("at most one reference"));
    assert_eq!(f.list(&f.operation()).await["intents"], json!([]));
    let saved = call(&f.state, "courseware.mediaCanvas.get", f.scope.clone())
        .await
        .unwrap();
    assert_eq!(saved["document"]["drafts"][0]["references"], references);
}

#[tokio::test]
async fn canvas_reference_generation_allows_plain_scene_and_import_before_and_after_generated_path()
{
    for task_type in ["plain", "scene", "import"] {
        for generated in [false, true] {
            let f = Fixture::new().await;
            let mut task = json!({ "taskType": task_type });
            if generated {
                task["generatedPath"] = json!("generated/courseware.pptx");
            }
            f.state
                .lock()
                .await
                .db
                .kv_set(
                    TASK_NAMESPACE,
                    f.scope["sessionId"].as_str().unwrap(),
                    &task,
                )
                .unwrap();
            let prepared = call(
                &f.state,
                "courseware.mediaCanvas.image.prepare",
                f.prepare(),
            )
            .await
            .unwrap();
            assert_eq!(
                prepared["current"], true,
                "{task_type}, generated={generated}"
            );
            assert_eq!(
                call(
                    &f.state,
                    "courseware.mediaCanvas.image.begin",
                    f.operation()
                )
                .await
                .unwrap()["intent"]["phase"],
                "submission-unknown",
                "{task_type}, generated={generated}"
            );
            let resolved = call(
                &f.state,
                "courseware.mediaCanvas.image.reference",
                f.operation(),
            )
            .await
            .unwrap();
            assert_eq!(
                std::fs::read(resolved["path"].as_str().unwrap()).unwrap(),
                f.bytes
            );
        }
    }
}

#[tokio::test]
async fn canvas_reference_begin_rechecks_task_eligibility_but_retains_prepared_snapshot() {
    let f = Fixture::new().await;
    let prepared = call(
        &f.state,
        "courseware.mediaCanvas.image.prepare",
        f.prepare(),
    )
    .await
    .unwrap();
    for task in [
        Value::Null,
        json!({}),
        json!({ "taskType": "unsupported", "generatedPath": "generated/courseware.pptx" }),
    ] {
        f.state
            .lock()
            .await
            .db
            .kv_set(
                TASK_NAMESPACE,
                f.scope["sessionId"].as_str().unwrap(),
                &task,
            )
            .unwrap();
        assert!(call(
            &f.state,
            "courseware.mediaCanvas.image.prepare",
            f.prepare()
        )
        .await
        .is_err());
        assert!(call(
            &f.state,
            "courseware.mediaCanvas.image.begin",
            f.operation()
        )
        .await
        .is_err());
        assert_eq!(
            call(&f.state, "courseware.mediaCanvas.image.get", f.operation())
                .await
                .unwrap(),
            prepared
        );
        assert!(call(
            &f.state,
            "courseware.mediaCanvas.image.reference",
            f.operation()
        )
        .await
        .is_ok());
    }
}
