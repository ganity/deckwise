use super::*;

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
async fn replacing_master_or_background_clears_only_that_pages_stale_layer_selection() {
    let mut f = Fixture::new().await;
    let mut selected = Vec::new();
    for target in [
        json!({"kind":"visualMaster"}),
        json!({"kind":"cleanPlate"}),
        json!({"kind":"layer","name":"Circle"}),
    ] {
        let mut request = f.prepare();
        request["target"] = target;
        let image = f.submit(request).await;
        f.call("courseware.sceneImage.asset.stage", f.stage(&image))
            .await
            .unwrap();
        let mut adopt = f.operation(&image);
        adopt["expectedSelectedIntentId"] = Value::Null;
        f.call("courseware.sceneImage.asset.adopt", adopt)
            .await
            .unwrap();
        selected.push(image);
    }
    let peer = f.submitted("image-model", "scene-002").await;
    f.call("courseware.sceneImage.asset.stage", f.stage(&peer))
        .await
        .unwrap();
    let mut adopt = f.operation(&peer);
    adopt["expectedSelectedIntentId"] = Value::Null;
    f.call("courseware.sceneImage.asset.adopt", adopt)
        .await
        .unwrap();
    for (index, target) in [
        (1, json!({"kind":"cleanPlate"})),
        (0, json!({"kind":"visualMaster"})),
    ] {
        let mut request = f.prepare();
        request["model"] = json!("replacement-model");
        request["target"] = target;
        let image = f.submit(request).await;
        f.call("courseware.sceneImage.asset.stage", f.stage(&image))
            .await
            .unwrap();
        let mut adopt = f.operation(&image);
        adopt["expectedSelectedIntentId"] = selected[index]["intent"]["intentId"].clone();
        f.call("courseware.sceneImage.asset.adopt", adopt)
            .await
            .unwrap();
        selected[index] = image;
        f.restart().await;
        assert_eq!(
            f.call("courseware.sceneImage.get", f.operation(&selected[2]))
                .await
                .unwrap()["intent"]["selected"],
            false
        );
        if index == 0 {
            assert_eq!(
                f.call("courseware.sceneImage.get", f.operation(&selected[1]))
                    .await
                    .unwrap()["intent"]["selected"],
                false
            );
        }
        assert_eq!(
            f.call("courseware.sceneImage.get", f.operation(&peer))
                .await
                .unwrap()["intent"]["selected"],
            true
        );
        assert!(f
            .call("courseware.sceneImage.asset.get", f.operation(&selected[2]))
            .await
            .is_ok());
    }
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

#[tokio::test]
async fn assessment_pages_need_no_images_and_style_review_starts_at_first_body_page() {
    let mut f = Fixture::new().await;
    let quiz = json!({"title":"Quiz","visibleText":[],"visualIntent":"Quiz template","narration":"","quiz":{"type":"quiz","questions":[{"id":"q","type":"single","question":"Greeting?","options":[{"value":"A","label":"Hello"},{"value":"B","label":"Bye"}],"answer":["A"]}]},"teaching":{"pageType":"quiz","phase":"practice","objective":"Greet","durationSeconds":30,"requiredObjects":[]}});
    let checkpoint = json!({"title":"Discuss","visibleText":[],"visualIntent":"MAIC template","narration":"","teaching":{"pageType":"interactive","phase":"practice","objective":"Explain","durationSeconds":30,"requiredObjects":[],"question":{"text":"Why?","response":{"kind":"discussion","options":[],"answerIndices":[]}}}});
    let mut plan = json!({"title":"Assessment","pages":[quiz,checkpoint]});
    let write = |f: &mut Fixture, plan: &Value| {
        let bytes = serde_json::to_vec(plan).unwrap();
        f.sha256 = hex::encode(sha2::Sha256::digest(&bytes));
        std::fs::write(f.path(), bytes).unwrap();
    };
    write(&mut f, &plan);
    f.approve().await;
    let proof = GenerationProof {
        plan_sha256: f.sha256.clone(),
        principal_key: "a".repeat(64),
        selected_intent_ids: vec![],
        teaching_corrections: vec![],
        teaching_correction: None,
    };
    assert_eq!(
        verify_generation(
            &*f.state.lock().await,
            f.root.to_str().unwrap(),
            &f.session,
            &proof
        )
        .unwrap()
        .pages
        .len(),
        2
    );
    assert!(f
        .call("courseware.sceneImage.prepare", f.prepare())
        .await
        .is_err());
    plan["pages"].as_array_mut().unwrap().push(json!({"title":"Body","visibleText":["Hello"],"visualIntent":"Greeting","narration":"Hello."}));
    write(&mut f, &plan);
    f.approve().await;
    let mut request = f.prepare();
    request["pageId"] = json!("scene-003");
    let prepared = f
        .call("courseware.sceneImage.prepare", request)
        .await
        .unwrap();
    assert!(prepared["intent"]
        .get("referenceIntentId")
        .is_none_or(Value::is_null));
    let proof = GenerationProof {
        plan_sha256: f.sha256.clone(),
        ..proof
    };
    assert!(verify_generation(
        &*f.state.lock().await,
        f.root.to_str().unwrap(),
        &f.session,
        &proof
    )
    .is_err());
}
