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
    let prepared = f.call("courseware.sceneImage.prepare", f.prepare()).await.unwrap();
    assert!(f.call("courseware.sceneImage.retry", f.operation(&prepared)).await.is_err());
    let original = f.submit(f.prepare()).await;
    let operation = f.operation(&original);
    let mut foreign = operation.clone();
    foreign["principalKey"] = json!("b".repeat(64));
    assert!(f.call("courseware.sceneImage.retry", foreign).await.is_err());
    let retry = f.call("courseware.sceneImage.retry", operation.clone()).await.unwrap();
    assert_ne!(retry["intent"]["intentId"], original["intent"]["intentId"]);
    assert_ne!(retry["intent"]["idempotencyKey"], original["intent"]["idempotencyKey"]);
    assert_eq!(retry["intent"]["request"], original["intent"]["request"]);
    assert_eq!(retry["intent"]["phase"], "prepared");
    assert!(retry["intent"]["taskRef"].is_null());
    assert!(retry["intent"].get("submissionScope").is_none());
    f.restart().await;
    assert_eq!(f.call("courseware.sceneImage.retry", operation.clone()).await.unwrap(), retry);
    assert_eq!(f.call("courseware.sceneImage.get", operation).await.unwrap(), original);
    assert_eq!(f.call("courseware.sceneImage.prepare", f.prepare()).await.unwrap(), retry);
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
        .contains("teaching-slide visual master"));
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

#[tokio::test]
async fn scene_image_archive_refuses_forged_bytes_metadata_task_and_foreign_scope() {
    let f = Fixture::new().await;
    let submitted = f.submitted("image-model", "scene-001").await;
    let stage = f.stage(&submitted);
    for field in [
        "task", "hash", "length", "width", "mime", "bytes", "account", "session", "path",
    ] {
        let mut p = stage.clone();
        match field {
            "task" => p["asset"]["taskRef"]["taskId"] = json!("foreign-task"),
            "hash" => p["asset"]["sha256"] = json!("b".repeat(64)),
            "length" => p["asset"]["byteLength"] = json!(0),
            "width" => p["asset"]["width"] = json!(2),
            "mime" => p["asset"]["mimeType"] = json!("image/svg+xml"),
            "bytes" => p["bytesBase64"] = json!("not base64"),
            "account" => p["principalKey"] = json!("b".repeat(64)),
            "session" => p["sessionId"] = json!(f.peer),
            _ => p["path"] = json!("/tmp/renderer-image"),
        }
        assert!(
            f.call("courseware.sceneImage.asset.stage", p)
                .await
                .is_err(),
            "{field}"
        );
    }
    assert_eq!(
        f.call("courseware.sceneImage.get", f.operation(&submitted))
            .await
            .unwrap(),
        submitted
    );
}

#[tokio::test]
async fn scene_image_selection_is_page_local_compare_and_set_and_stale_plan_is_read_only() {
    let mut f = Fixture::new().await;
    let one = f.submitted("image-model", "scene-001").await;
    let two = f.submitted("other-model", "scene-001").await;
    for item in [&one, &two] {
        f.call("courseware.sceneImage.asset.stage", f.stage(item))
            .await
            .unwrap();
    }
    let mut select = f.operation(&one);
    select["expectedSelectedIntentId"] = Value::Null;
    f.call("courseware.sceneImage.asset.adopt", select.clone())
        .await
        .unwrap();
    let peer = f.submitted("image-model", "scene-002").await;
    f.call("courseware.sceneImage.asset.stage", f.stage(&peer))
        .await
        .unwrap();
    let mut other = f.operation(&two);
    other["expectedSelectedIntentId"] = Value::Null;
    assert!(f
        .call("courseware.sceneImage.asset.adopt", other.clone())
        .await
        .is_err());
    other["expectedSelectedIntentId"] = one["intent"]["intentId"].clone();
    f.call("courseware.sceneImage.asset.adopt", other)
        .await
        .unwrap();
    assert_eq!(
        f.call("courseware.sceneImage.get", f.operation(&one))
            .await
            .unwrap()["intent"]["selected"],
        false
    );
    assert_eq!(
        f.call("courseware.sceneImage.get", f.operation(&peer))
            .await
            .unwrap()["intent"]["selected"],
        false
    );
    f.revise("A revised visual");
    f.approve().await;
    let old = f
        .call("courseware.sceneImage.asset.get", f.operation(&two))
        .await
        .unwrap();
    assert_eq!(old["current"], false);
    assert_eq!(old["intent"]["selected"], true);
    assert!(f
        .call("courseware.sceneImage.asset.adopt", select)
        .await
        .is_err());
    let new = f
        .call("courseware.sceneImage.prepare", f.prepare())
        .await
        .unwrap();
    assert_eq!(new["intent"]["selected"], false);
    assert!(new["intent"]["asset"].is_null());
}

#[tokio::test]
async fn scene_image_old_journals_default_to_unarchived_unselected() {
    let f = Fixture::new().await;
    let prepared = f
        .call("courseware.sceneImage.prepare", f.prepare())
        .await
        .unwrap();
    {
        let state = f.state.lock().await;
        let scope: Scope = serde_json::from_value(f.scope()).unwrap();
        let key = storage_key(f.root.to_str().unwrap(), &scope).unwrap();
        let mut rows = state.db.kv_get(NAMESPACE, &key).unwrap().unwrap();
        rows[0].as_object_mut().unwrap().remove("asset");
        rows[0].as_object_mut().unwrap().remove("selected");
        rows[0].as_object_mut().unwrap().remove("target");
        state.db.kv_set(NAMESPACE, &key, &rows).unwrap();
    }
    assert_eq!(
        f.call("courseware.sceneImage.get", f.operation(&prepared))
            .await
            .unwrap(),
        prepared
    );
}

#[tokio::test]
async fn scene_image_prepare_pins_the_approved_page_and_reuses_the_original_key() {
    let f = Fixture::new().await;
    let prepared = f
        .call("courseware.sceneImage.prepare", f.prepare())
        .await
        .unwrap();
    assert_eq!(prepared["current"], true);
    assert_eq!(prepared["intent"]["phase"], "prepared");
    assert_eq!(prepared["intent"]["planSha256"], f.sha256);
    assert_eq!(prepared["intent"]["request"]["kind"], "image");
    assert!(prepared["intent"]["request"].get("voice").is_none());
    assert!(prepared["intent"]["request"]["input"]
        .as_str()
        .unwrap()
        .contains("小朋友😀"));
    assert_eq!(
        f.call("courseware.sceneImage.prepare", f.prepare())
            .await
            .unwrap(),
        prepared
    );
    let mut other = f.prepare();
    other["pageId"] = json!("scene-002");
    assert!(f
        .call("courseware.sceneImage.prepare", other.clone())
        .await
        .is_err());
    let master = f.submit(f.prepare()).await;
    f.call("courseware.sceneImage.asset.stage", f.stage(&master))
        .await
        .unwrap();
    let mut adopt = f.operation(&master);
    adopt["expectedSelectedIntentId"] = Value::Null;
    f.call("courseware.sceneImage.asset.adopt", adopt)
        .await
        .unwrap();
    let other = f
        .call("courseware.sceneImage.prepare", other)
        .await
        .unwrap();
    assert_ne!(
        other["intent"]["idempotencyKey"],
        prepared["intent"]["idempotencyKey"]
    );
    assert_eq!(
        other["intent"]["referenceIntentId"],
        master["intent"]["intentId"]
    );
    assert!(other["intent"]["request"]["input"]
        .as_str()
        .unwrap()
        .contains("square window"));
    assert_eq!(
        f.call("courseware.sceneImage.list", f.scope())
            .await
            .unwrap()["intents"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
}

#[tokio::test]
async fn scene_image_unknown_submission_survives_restart_and_cannot_begin_twice() {
    let mut f = Fixture::new().await;
    let prepared = f
        .call("courseware.sceneImage.prepare", f.prepare())
        .await
        .unwrap();
    let operation = f.operation(&prepared);
    let begun = f
        .call("courseware.sceneImage.begin", operation.clone())
        .await
        .unwrap();
    assert_eq!(begun["intent"]["phase"], "submission-unknown");
    f.restart().await;
    assert_eq!(
        f.call("courseware.sceneImage.get", operation.clone())
            .await
            .unwrap(),
        begun
    );
    assert!(f
        .call("courseware.sceneImage.begin", operation.clone())
        .await
        .is_err());
    assert_eq!(
        f.call("courseware.sceneImage.prepare", f.prepare())
            .await
            .unwrap(),
        begun
    );
    let mut bind = operation.clone();
    bind["taskRef"] = json!({"taskId":"task-1","idempotencyKey":begun["intent"]["idempotencyKey"],"requestHash":begun["intent"]["requestHash"]});
    let bound = f
        .call("courseware.sceneImage.bind", bind.clone())
        .await
        .unwrap();
    assert_eq!(bound["intent"]["phase"], "submitted");
    assert_eq!(
        f.call("courseware.sceneImage.bind", bind.clone())
            .await
            .unwrap(),
        bound
    );
    bind["taskRef"]["taskId"] = json!("task-2");
    assert!(f.call("courseware.sceneImage.bind", bind).await.is_err());
    f.restart().await;
    assert_eq!(
        f.call("courseware.sceneImage.get", operation)
            .await
            .unwrap(),
        bound
    );
}

#[tokio::test]
async fn scene_image_revisions_require_reapproval_and_keep_late_receipts_on_their_old_plan() {
    let mut f = Fixture::new().await;
    let prepared = f
        .call("courseware.sceneImage.prepare", f.prepare())
        .await
        .unwrap();
    let operation = f.operation(&prepared);
    f.revise("A new red circle");
    assert!(f
        .call("courseware.sceneImage.prepare", f.prepare())
        .await
        .is_err());
    assert!(f
        .call("courseware.sceneImage.begin", operation.clone())
        .await
        .is_err());
    assert_eq!(
        f.call("courseware.sceneImage.get", operation.clone())
            .await
            .unwrap()["current"],
        false
    );
    f.approve().await;
    let next = f
        .call("courseware.sceneImage.prepare", f.prepare())
        .await
        .unwrap();
    assert_ne!(
        next["intent"]["idempotencyKey"],
        prepared["intent"]["idempotencyKey"]
    );
    let next_operation = f.operation(&next);
    f.call("courseware.sceneImage.begin", next_operation.clone())
        .await
        .unwrap();
    std::fs::write(f.path(), "{malformed").unwrap();
    let mut bind = next_operation.clone();
    bind["taskRef"] = json!({"taskId":"late-task","idempotencyKey":next["intent"]["idempotencyKey"],"requestHash":next["intent"]["requestHash"]});
    let late = f.call("courseware.sceneImage.bind", bind).await.unwrap();
    assert_eq!(late["current"], false);
    assert_eq!(late["intent"]["taskRef"]["taskId"], "late-task");
    assert_eq!(
        f.call("courseware.sceneImage.get", next_operation)
            .await
            .unwrap(),
        late
    );
}

#[tokio::test]
async fn scene_image_scope_and_strict_fields_prevent_foreign_or_forged_intents() {
    let f = Fixture::new().await;
    let prepared = f
        .call("courseware.sceneImage.prepare", f.prepare())
        .await
        .unwrap();
    for key in ["input", "voice", "idempotencyKey", "path", "intentId"] {
        let mut p = f.prepare();
        p[key] = json!("forged");
        assert!(f.call("courseware.sceneImage.prepare", p).await.is_err());
    }
    for page in ["scene-000", "scene-1", "scene-003", "../page"] {
        let mut p = f.prepare();
        p["pageId"] = json!(page);
        assert!(f.call("courseware.sceneImage.prepare", p).await.is_err());
    }
    let mut other = f.scope();
    other["principalKey"] = json!("b".repeat(64));
    assert_eq!(
        f.call("courseware.sceneImage.list", other.clone())
            .await
            .unwrap()["intents"],
        json!([])
    );
    other["intentId"] = prepared["intent"]["intentId"].clone();
    assert!(f.call("courseware.sceneImage.get", other).await.is_err());
    let mut peer = f.scope();
    peer["sessionId"] = json!(f.peer);
    assert_eq!(
        f.call("courseware.sceneImage.list", peer).await.unwrap()["intents"],
        json!([])
    );
    let mut bind = f.operation(&prepared);
    bind["taskRef"] = json!({"taskId":"task-1","idempotencyKey":prepared["intent"]["idempotencyKey"],"requestHash":prepared["intent"]["requestHash"]});
    assert!(f
        .call("courseware.sceneImage.bind", bind.clone())
        .await
        .is_err());
    let operation = f.operation(&prepared);
    f.call("courseware.sceneImage.begin", operation.clone())
        .await
        .unwrap();
    bind["taskRef"]["requestHash"] = json!("0".repeat(64));
    assert!(f.call("courseware.sceneImage.bind", bind).await.is_err());
    assert_eq!(
        f.call("courseware.sceneImage.get", operation)
            .await
            .unwrap()["intent"]["phase"],
        "submission-unknown"
    );
}

#[tokio::test]
async fn scene_image_submission_scope_uses_begin_order_and_survives_restart() {
    let team = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    for bind_first in [true, false] {
        let mut f = Fixture::new().await;
        let prepared = f
            .call("courseware.sceneImage.prepare", f.prepare())
            .await
            .unwrap();
        let op = f.operation(&prepared);
        let bind = json!({"sessionId":f.session,"teamProjectId":team});
        if bind_first {
            f.call("courseware.task.bindTeam", bind.clone())
                .await
                .unwrap();
        }
        let begun = f
            .call("courseware.sceneImage.begin", op.clone())
            .await
            .unwrap();
        let expected_team = if bind_first { json!(team) } else { Value::Null };
        assert_eq!(
            begun["intent"]["submissionScope"],
            json!({"sessionId":f.session,"teamProjectId":expected_team})
        );
        if !bind_first {
            f.call("courseware.task.bindTeam", bind).await.unwrap();
        }
        f.restart().await;
        assert_eq!(
            f.call("courseware.sceneImage.get", op.clone())
                .await
                .unwrap(),
            begun
        );
        assert!(f.call("courseware.sceneImage.begin", op).await.is_err());
    }
}

#[tokio::test]
async fn rejected_scene_image_prepares_a_fresh_attempt_without_replaying_history() {
    for team in [false, true] {
        let mut f = Fixture::new().await;
        if team {
            f.call(
                "courseware.task.bindTeam",
                json!({"sessionId":f.session,
                "teamProjectId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}),
            )
            .await
            .unwrap();
        }
        let prepared = f
            .call("courseware.sceneImage.prepare", f.prepare())
            .await
            .unwrap();
        let op = f.operation(&prepared);
        let mut reject = op.clone();
        reject["rejectedRequest"] = json!({"idempotencyKey":prepared["intent"]["idempotencyKey"],
            "requestHash":prepared["intent"]["requestHash"]});
        assert!(f
            .call("courseware.sceneImage.reject", reject.clone())
            .await
            .is_err());
        let begun = f
            .call("courseware.sceneImage.begin", op.clone())
            .await
            .unwrap();
        let mut wrong = reject.clone();
        wrong["rejectedRequest"]["requestHash"] = json!("f".repeat(64));
        assert!(f.call("courseware.sceneImage.reject", wrong).await.is_err());
        assert_eq!(
            f.call("courseware.sceneImage.get", op.clone())
                .await
                .unwrap(),
            begun
        );
        if !team {
            assert!(f
                .call("courseware.sceneImage.reject", reject)
                .await
                .is_err());
            continue;
        }
        let rejected = f
            .call("courseware.sceneImage.reject", reject)
            .await
            .unwrap();
        assert_eq!(rejected["intent"]["phase"], "rejected");
        f.restart().await;
        assert_eq!(
            f.call("courseware.sceneImage.get", op.clone())
                .await
                .unwrap(),
            rejected
        );
        assert!(f
            .call("courseware.sceneImage.begin", op.clone())
            .await
            .is_err());
        let mut binding = op;
        binding["taskRef"] = json!({"taskId":"late", "idempotencyKey":begun["intent"]["idempotencyKey"],
            "requestHash":begun["intent"]["requestHash"]});
        assert!(f.call("courseware.sceneImage.bind", binding).await.is_err());
        let fresh = f
            .call("courseware.sceneImage.prepare", f.prepare())
            .await
            .unwrap();
        assert_eq!(fresh["intent"]["phase"], "prepared");
        assert_ne!(fresh["intent"]["intentId"], rejected["intent"]["intentId"]);
        assert_ne!(
            fresh["intent"]["idempotencyKey"],
            rejected["intent"]["idempotencyKey"]
        );
        assert_eq!(
            fresh["intent"]["requestHash"],
            rejected["intent"]["requestHash"]
        );
    }
}

#[path = "style_tests.rs"]
mod style_tests;
