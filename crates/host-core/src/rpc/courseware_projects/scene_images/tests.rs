use super::*;
use base64::{engine::general_purpose::STANDARD, Engine};
use sha2::Digest;

struct Fixture {
    dir: tempfile::TempDir,
    root: std::path::PathBuf,
    session: String,
    peer: String,
    sha256: String,
    state: Arc<Mutex<AppState>>,
}

#[tokio::test]
async fn explicit_retry_keeps_original_receipt_and_reuses_one_successor_after_restart() {
    let mut f = Fixture::new().await;
    let prepared = f
        .call("courseware.sceneImage.prepare", f.prepare())
        .await
        .unwrap();
    assert!(f
        .call("courseware.sceneImage.retry", f.operation(&prepared))
        .await
        .is_err());
    let original = f.submit(f.prepare()).await;
    let operation = f.operation(&original);
    let mut foreign = operation.clone();
    foreign["principalKey"] = json!("b".repeat(64));
    assert!(f
        .call("courseware.sceneImage.retry", foreign)
        .await
        .is_err());
    let retry = f
        .call("courseware.sceneImage.retry", operation.clone())
        .await
        .unwrap();
    assert_ne!(retry["intent"]["intentId"], original["intent"]["intentId"]);
    assert_ne!(
        retry["intent"]["idempotencyKey"],
        original["intent"]["idempotencyKey"]
    );
    assert_eq!(retry["intent"]["request"], original["intent"]["request"]);
    assert_eq!(retry["intent"]["phase"], "prepared");
    assert!(retry["intent"]["taskRef"].is_null());
    assert!(retry["intent"].get("submissionScope").is_none());
    f.restart().await;
    assert_eq!(
        f.call("courseware.sceneImage.retry", operation.clone())
            .await
            .unwrap(),
        retry
    );
    assert_eq!(
        f.call("courseware.sceneImage.get", operation)
            .await
            .unwrap(),
        original
    );
    assert_eq!(
        f.call("courseware.sceneImage.prepare", f.prepare())
            .await
            .unwrap(),
        retry
    );
}

#[tokio::test]
async fn only_current_unsubmitted_images_can_rebind_model_with_a_fresh_request_key() {
    let mut f = Fixture::new().await;
    let old = f
        .call("courseware.sceneImage.prepare", f.prepare())
        .await
        .unwrap();
    let mut change = f.operation(&old);
    change["expectedRequestHash"] = old["intent"]["requestHash"].clone();
    change["model"] = json!("current-model");
    let mut stale = change.clone();
    stale["expectedRequestHash"] = json!("0".repeat(64));
    assert!(f
        .call("courseware.sceneImage.rebindModel", stale)
        .await
        .is_err());
    let mut foreign = change.clone();
    foreign["principalKey"] = json!("b".repeat(64));
    assert!(f
        .call("courseware.sceneImage.rebindModel", foreign)
        .await
        .is_err());
    let updated = f
        .call("courseware.sceneImage.rebindModel", change.clone())
        .await
        .unwrap();
    assert_eq!(updated["intent"]["intentId"], old["intent"]["intentId"]);
    assert_eq!(
        updated["intent"]["request"]["input"],
        old["intent"]["request"]["input"]
    );
    assert_eq!(
        updated["intent"]["request"]["kind"],
        old["intent"]["request"]["kind"]
    );
    assert_eq!(updated["intent"]["request"]["model"], "current-model");
    assert_eq!(updated["intent"]["phase"], "prepared");
    assert_ne!(
        updated["intent"]["idempotencyKey"],
        old["intent"]["idempotencyKey"]
    );
    assert_ne!(
        updated["intent"]["requestHash"],
        old["intent"]["requestHash"]
    );
    assert!(f
        .call("courseware.sceneImage.rebindModel", change.clone())
        .await
        .is_err());
    f.restart().await;
    assert_eq!(
        f.call("courseware.sceneImage.get", f.operation(&old))
            .await
            .unwrap(),
        updated
    );
    f.call("courseware.sceneImage.begin", f.operation(&updated))
        .await
        .unwrap();
    change["expectedRequestHash"] = updated["intent"]["requestHash"].clone();
    change["model"] = json!("another-model");
    assert!(f
        .call("courseware.sceneImage.rebindModel", change)
        .await
        .is_err());
    let begun = f
        .call("courseware.sceneImage.get", f.operation(&updated))
        .await
        .unwrap();
    assert_eq!(
        begun["intent"]["requestHash"],
        updated["intent"]["requestHash"]
    );
    assert_eq!(
        begun["intent"]["idempotencyKey"],
        updated["intent"]["idempotencyKey"]
    );
}

#[tokio::test]
async fn scene_object_mapping_requires_reviewed_inputs_before_source_or_project_write() {
    let f = Fixture::new().await;
    let refused = f
        .call(
            "courseware.project.initializeGenerated",
            json!({
                "sessionId":f.session, "jobId":"unused", "sourceSha256":"a".repeat(64),
                "title":"Shapes", "narrations":["A circle. Good!"], "sceneMapping":{"pages":[]}
            }),
        )
        .await
        .unwrap_err();
    assert!(refused
        .message
        .contains("Scene mapping requires reviewed generation inputs"));
    let state = f.state.lock().await;
    assert!(state
        .db
        .courseware_project_context(f.root.to_str().unwrap(), "unused")
        .is_err());
}

impl Fixture {
    async fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("workspace");
        std::fs::create_dir(&root).unwrap();
        let mut app = AppState::open(dir.path()).unwrap();
        app.handshook = true;
        let mut ids = Vec::new();
        for _ in 0..2 {
            let session = sessions::create_session(
                &app.db,
                None,
                None,
                None,
                None,
                Some(root.to_string_lossy().into()),
            )
            .unwrap();
            app.db
                .kv_set(
                    TASK_NAMESPACE,
                    &session.id,
                    &json!({"taskType":"scene","educationContext":null}),
                )
                .unwrap();
            ids.push(session.id);
        }
        let mut f = Self {
            dir,
            root,
            session: ids[0].clone(),
            peer: ids[1].clone(),
            sha256: String::new(),
            state: Arc::new(Mutex::new(app)),
        };
        f.revise("A bright circle. 小朋友😀");
        f.approve().await;
        f
    }

    fn path(&self) -> std::path::PathBuf {
        self.root
            .join(format!(".deckwise-ppt/scenes/{}/plan.json", self.session))
    }

    fn revise(&mut self, visual: &str) {
        let plan = json!({"title":"Shapes","pages":[
            {"title":"Circle","visibleText":["圆 Circle"],"visualIntent":visual,"narration":"A circle. Good!"},
            {"title":"Square","visibleText":["Square"],"visualIntent":"A square window","narration":"Look at the window."}]});
        let bytes = serde_json::to_vec(&plan).unwrap();
        self.sha256 = hex::encode(sha2::Sha256::digest(&bytes));
        std::fs::create_dir_all(self.path().parent().unwrap()).unwrap();
        std::fs::write(self.path(), bytes).unwrap();
    }

    async fn call(&self, method: &str, params: Value) -> Result<Value, JsonRpcError> {
        let (tx, _rx) = mpsc::unbounded_channel();
        crate::rpc::handle_request(self.state.clone(), method, params, tx).await
    }

    async fn approve(&self) {
        self.call(
            "courseware.scenePlan.approve",
            json!({"sessionId":self.session,"sha256":self.sha256}),
        )
        .await
        .unwrap();
    }

    fn scope(&self) -> Value {
        json!({"sessionId":self.session,"principalKey":"a".repeat(64)})
    }
    fn prepare(&self) -> Value {
        let mut p = self.scope();
        p["planSha256"] = json!(self.sha256);
        p["pageId"] = json!("scene-001");
        p["model"] = json!("image-model");
        p
    }
    fn operation(&self, view: &Value) -> Value {
        let mut p = self.scope();
        p["intentId"] = view["intent"]["intentId"].clone();
        p
    }
    async fn restart(&mut self) {
        let mut app = AppState::open(self.dir.path()).unwrap();
        app.handshook = true;
        self.state = Arc::new(Mutex::new(app));
    }

    async fn submitted(&self, model: &str, page: &str) -> Value {
        let mut p = self.prepare();
        p["model"] = json!(model);
        p["pageId"] = json!(page);
        self.submit(p).await
    }

    async fn submit(&self, p: Value) -> Value {
        let prepared = self.call("courseware.sceneImage.prepare", p).await.unwrap();
        let mut operation = self.operation(&prepared);
        self.call("courseware.sceneImage.begin", operation.clone())
            .await
            .unwrap();
        operation["taskRef"] = json!({"taskId":format!("task-{}", prepared["intent"]["intentId"].as_str().unwrap()),
            "idempotencyKey":prepared["intent"]["idempotencyKey"],"requestHash":prepared["intent"]["requestHash"]});
        self.call("courseware.sceneImage.bind", operation)
            .await
            .unwrap()
    }

    fn stage(&self, view: &Value) -> Value {
        let bytes = STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==").unwrap();
        let mut p = self.operation(view);
        p["asset"] = json!({"taskRef":view["intent"]["taskRef"],"sha256":hex::encode(sha2::Sha256::digest(&bytes)),
            "mimeType":"image/png","byteLength":bytes.len(),"width":1,"height":1});
        p["bytesBase64"] = json!(STANDARD.encode(bytes));
        p
    }
}

#[tokio::test]
async fn scene_image_generation_requires_all_current_reviewed_assets_and_rechecks_after_restart() {
    let mut f = Fixture::new().await;
    let mut ids = Vec::new();
    for page in ["scene-001", "scene-002"] {
        for target in [
            json!({"kind":"visualMaster"}),
            json!({"kind":"cleanPlate"}),
            json!({"kind":"layer","name":"Circle"}),
        ] {
            let mut request = f.prepare();
            request["pageId"] = json!(page);
            request["target"] = target.clone();
            let row = f.submit(request).await;
            let mut staged = f.stage(&row);
            if target["kind"] == "cleanPlate" {
                let bytes = STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVR4nGNgYPj/HwADAgH/5ncLrgAAAABJRU5ErkJggg==").unwrap();
                staged["asset"]["sha256"] = json!(hex::encode(sha2::Sha256::digest(&bytes)));
                staged["asset"]["byteLength"] = json!(bytes.len());
                staged["bytesBase64"] = json!(STANDARD.encode(bytes));
            }
            f.call("courseware.sceneImage.asset.stage", staged)
                .await
                .unwrap();
            let mut adopt = f.operation(&row);
            adopt["expectedSelectedIntentId"] = Value::Null;
            f.call("courseware.sceneImage.asset.adopt", adopt)
                .await
                .unwrap();
            ids.push(row["intent"]["intentId"].as_str().unwrap().to_owned());
        }
    }
    let proof = GenerationProof {
        plan_sha256: f.sha256.clone(),
        principal_key: "a".repeat(64),
        selected_intent_ids: ids,
    };
    f.restart().await;
    {
        let state = f.state.lock().await;
        let root = f.root.to_str().unwrap();
        assert_eq!(
            verify_generation(&state, root, &f.session, &proof)
                .unwrap()
                .pages
                .len(),
            2
        );
        for kind in ["missing", "duplicate", "account", "plan", "peer"] {
            let mut bad = proof.clone();
            match kind {
                "missing" => {
                    bad.selected_intent_ids.pop();
                }
                "duplicate" => bad
                    .selected_intent_ids
                    .push(bad.selected_intent_ids[0].clone()),
                "account" => bad.principal_key = "b".repeat(64),
                "plan" => bad.plan_sha256 = "c".repeat(64),
                _ => {}
            }
            assert!(
                verify_generation(
                    &state,
                    root,
                    if kind == "peer" { &f.peer } else { &f.session },
                    &bad
                )
                .is_err(),
                "{kind}"
            );
        }
    }
    for method in [
        "courseware.project.initializeGenerated",
        "courseware.task.attachGenerated",
    ] {
        let params = if method.ends_with("initializeGenerated") {
            json!({"sessionId":f.session,"jobId":"unused","sourceSha256":"a".repeat(64),"title":"Shapes","narrations":["A circle. Good!","Look at the window."]})
        } else {
            json!({"sessionId":f.session,"projectId":"unused","path":"unused","sourceSha256":"a".repeat(64)})
        };
        let refused = f.call(method, params).await.unwrap_err();
        assert!(refused.message.contains("Reviewed scene inputs"));
    }
    let mut request = f.prepare();
    request["target"] = json!({"kind":"layer","name":"Circle"});
    request["instructions"] = json!("A brighter circle");
    let next = f.submit(request).await;
    f.call("courseware.sceneImage.asset.stage", f.stage(&next))
        .await
        .unwrap();
    let mut adopt = f.operation(&next);
    adopt["expectedSelectedIntentId"] = json!(proof.selected_intent_ids[2]);
    f.call("courseware.sceneImage.asset.adopt", adopt)
        .await
        .unwrap();
    let state = f.state.lock().await;
    assert!(verify_generation(&state, f.root.to_str().unwrap(), &f.session, &proof).is_err());
}

#[tokio::test]
async fn scene_image_targets_and_prompt_revisions_have_independent_reviewed_choices() {
    let mut f = Fixture::new().await;
    let targets = [
        json!({"kind":"visualMaster"}),
        json!({"kind":"cleanPlate"}),
        json!({"kind":"layer","name":"小兔"}),
        json!({"kind":"layer","name":"苹果"}),
    ];
    let mut choices = Vec::new();
    for target in &targets {
        let mut p = f.prepare();
        p["target"] = target.clone();
        let item = f.submit(p.clone()).await;
        assert_eq!(item["intent"]["target"], *target);
        assert_eq!(
            f.call("courseware.sceneImage.prepare", p).await.unwrap()["intent"]["intentId"],
            item["intent"]["intentId"]
        );
        f.call("courseware.sceneImage.asset.stage", f.stage(&item))
            .await
            .unwrap();
        let mut select = f.operation(&item);
        select["expectedSelectedIntentId"] = Value::Null;
        f.call("courseware.sceneImage.asset.adopt", select)
            .await
            .unwrap();
        choices.push(item);
    }
    assert!(choices[0]["intent"]["request"]["input"]
        .as_str()
        .unwrap()
        .contains("16:10 kindergarten storybook teaching-slide illustration, 1280x800"));
    assert!(choices[1]["intent"]["request"]["input"]
        .as_str()
        .unwrap()
        .contains("empty environment"));
    assert!(choices[2]["intent"]["request"]["input"]
        .as_str()
        .unwrap()
        .contains("Transparent PNG"));
    assert_eq!(
        choices
            .iter()
            .map(|i| i["intent"]["requestHash"].as_str().unwrap())
            .collect::<std::collections::HashSet<_>>()
            .len(),
        4
    );
    f.restart().await;
    let saved = f
        .call("courseware.sceneImage.list", f.scope())
        .await
        .unwrap();
    assert_eq!(
        saved["intents"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|i| i["intent"]["selected"] == true)
            .count(),
        4
    );
    let mut p = f.prepare();
    p["target"] = targets[2].clone();
    p["instructions"] = json!("Make the rabbit smile.");
    let next = f.submit(p).await;
    assert_ne!(
        next["intent"]["idempotencyKey"],
        choices[2]["intent"]["idempotencyKey"]
    );
    assert!(next["intent"]["request"]["input"]
        .as_str()
        .unwrap()
        .contains("Make the rabbit smile."));
    f.call("courseware.sceneImage.asset.stage", f.stage(&next))
        .await
        .unwrap();
    let mut select = f.operation(&next);
    select["expectedSelectedIntentId"] = choices[1]["intent"]["intentId"].clone();
    assert!(f
        .call("courseware.sceneImage.asset.adopt", select.clone())
        .await
        .is_err());
    select["expectedSelectedIntentId"] = choices[2]["intent"]["intentId"].clone();
    f.call("courseware.sceneImage.asset.adopt", select)
        .await
        .unwrap();
    for (index, item) in choices.iter().enumerate() {
        let saved = f
            .call("courseware.sceneImage.get", f.operation(item))
            .await
            .unwrap();
        assert_eq!(saved["intent"]["selected"], index != 2);
    }
}

#[tokio::test]
async fn scene_image_invalid_targets_and_instructions_never_prepare_a_request() {
    let f = Fixture::new().await;
    for target in [
        json!({"kind":"other"}),
        json!({"kind":"layer","name":""}),
        json!({"kind":"layer","name":" bad "}),
        json!({"kind":"layer","name":"x\ny"}),
        json!({"kind":"layer","name":"a".repeat(81)}),
        json!({"kind":"cleanPlate","name":"hidden"}),
    ] {
        let mut p = f.prepare();
        p["target"] = target;
        assert!(
            f.call("courseware.sceneImage.prepare", p.clone())
                .await
                .is_err(),
            "{p}"
        );
    }
    for instructions in [
        json!("x".repeat(1201)),
        json!("bad\u{0000}prompt"),
        Value::Null,
    ] {
        let mut p = f.prepare();
        p["instructions"] = instructions;
        assert!(f.call("courseware.sceneImage.prepare", p).await.is_err());
    }
    assert_eq!(
        f.call("courseware.sceneImage.list", f.scope())
            .await
            .unwrap()["intents"],
        json!([])
    );
}

#[tokio::test]
async fn scene_image_above_eight_mib_archives_original_bytes_and_survives_restart() {
    let mut f = Fixture::new().await;
    let submitted = f.submitted("image-model", "scene-001").await;
    let mut stage = f.stage(&submitted);
    let mut bytes = STANDARD
        .decode(stage["bytesBase64"].as_str().unwrap())
        .unwrap();
    bytes.resize(9 * 1024 * 1024, 0);
    stage["asset"]["byteLength"] = json!(bytes.len());
    stage["asset"]["sha256"] = json!(hex::encode(Sha256::digest(&bytes)));
    stage["bytesBase64"] = json!(STANDARD.encode(&bytes));
    let mut metadata: assets::ImageAsset = serde_json::from_value(stage["asset"].clone()).unwrap();
    metadata.byte_length = 32 * 1024 * 1024;
    assert!(metadata.valid());
    metadata.byte_length += 1;
    assert!(!metadata.valid());
    let saved = f
        .call("courseware.sceneImage.asset.stage", stage)
        .await
        .unwrap();
    assert_eq!(
        std::fs::read(saved["path"].as_str().unwrap()).unwrap(),
        bytes
    );
    f.restart().await;
    let reopened = f
        .call("courseware.sceneImage.asset.get", f.operation(&submitted))
        .await
        .unwrap();
    assert_eq!(saved["intent"]["asset"], reopened["intent"]["asset"]);
    assert_eq!(
        std::fs::read(reopened["path"].as_str().unwrap()).unwrap(),
        bytes
    );
}

#[tokio::test]
async fn scene_image_archive_preview_selection_survive_restart_and_corruption_is_not_repaired() {
    let mut f = Fixture::new().await;
    let submitted = f.submitted("image-model", "scene-001").await;
    let operation = f.operation(&submitted);
    let stage = f.stage(&submitted);
    let saved = f
        .call("courseware.sceneImage.asset.stage", stage.clone())
        .await
        .unwrap();
    assert_eq!(saved["intent"]["selected"], false);
    let path = std::path::PathBuf::from(saved["path"].as_str().unwrap());
    assert!(path.starts_with(f.dir.path()));
    assert_eq!(
        std::fs::read(&path).unwrap(),
        STANDARD
            .decode(stage["bytesBase64"].as_str().unwrap())
            .unwrap()
    );
    let mut adopt = operation.clone();
    adopt["expectedSelectedIntentId"] = Value::Null;
    let selected = f
        .call("courseware.sceneImage.asset.adopt", adopt)
        .await
        .unwrap();
    assert_eq!(selected["intent"]["selected"], true);
    f.restart().await;
    assert_eq!(
        f.call("courseware.sceneImage.asset.get", operation.clone())
            .await
            .unwrap(),
        selected
    );
    assert_eq!(
        f.call("courseware.sceneImage.asset.stage", stage.clone())
            .await
            .unwrap(),
        selected
    );
    std::fs::write(&path, b"corrupted").unwrap();
    assert!(f
        .call("courseware.sceneImage.asset.get", operation)
        .await
        .is_err());
    assert!(f
        .call("courseware.sceneImage.asset.stage", stage)
        .await
        .is_err());
    assert_eq!(std::fs::read(path).unwrap(), b"corrupted");
}

mod generation;

#[path = "style_tests.rs"]
mod style_tests;
