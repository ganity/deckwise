use super::*;

#[tokio::test]
async fn visual_master_renders_approved_display_text_in_a_complete_teaching_composition() {
    let mut f = Fixture::new().await;
    let mut plan: Value = serde_json::from_slice(&std::fs::read(f.path()).unwrap()).unwrap();
    plan["pages"][0]["visibleText"] = json!(["西游记奇幻英语之旅", "第一集", "Hello"]);
    let bytes = serde_json::to_vec(&plan).unwrap();
    f.sha256 = hex::encode(sha2::Sha256::digest(&bytes));
    std::fs::write(f.path(), bytes).unwrap();
    f.approve().await;
    let prepared = f
        .call("courseware.sceneImage.prepare", f.prepare())
        .await
        .unwrap();
    let prompt = prepared["intent"]["request"]["input"].as_str().unwrap();
    for text in ["西游记奇幻英语之旅", "第一集", "Hello"] {
        assert!(
            prompt.contains(text),
            "approved display text missing from model request: {text}"
        );
    }
    assert!(!prompt.contains("No text, labels, letters"));
    assert!(!prompt.contains("slide text is added separately"));
    assert!(prompt.contains("one intentional teaching composition"));
    let mut oversized = plan;
    oversized["pages"][0]["visualIntent"] = json!("Scene ".repeat(160));
    oversized["visualBible"] = json!({"artDirection":"a".repeat(800),"characters":"b".repeat(100),"setting":"c".repeat(100)});
    let bytes = serde_json::to_vec(&oversized).unwrap();
    f.sha256 = hex::encode(sha2::Sha256::digest(&bytes));
    std::fs::write(f.path(), bytes).unwrap();
    f.approve().await;
    let mut request = f.prepare();
    request["instructions"] = json!("Warm lighting. ".repeat(75));
    let error = f
        .call("courseware.sceneImage.prepare", request)
        .await
        .unwrap_err();
    assert!(error.message.contains("4000 UTF-16 units"));
}

#[tokio::test]
async fn decomposition_archives_children_atomically_and_keeps_one_task_across_restart() {
    let mut f = Fixture::new().await;
    let master = f.submitted("image-model", "scene-001").await;
    f.call("courseware.sceneImage.asset.stage", f.stage(&master))
        .await
        .unwrap();
    let mut adopt = f.operation(&master);
    adopt["expectedSelectedIntentId"] = Value::Null;
    f.call("courseware.sceneImage.asset.adopt", adopt)
        .await
        .unwrap();
    let mut prepare = f.prepare();
    prepare["target"] = json!({"kind":"cleanPlate"});
    prepare["model"] = json!("seedream-layers");
    prepare["referenceIntentId"] = master["intent"]["intentId"].clone();
    prepare["decomposition"] = json!(true);
    let parent = f.submit(prepare).await;
    assert_eq!(parent["intent"]["request"]["kind"], "image-layers");
    let stage = f.stage(&parent);
    let base = json!({"target":{"kind":"cleanPlate"},"asset":stage["asset"],"bytesBase64":stage["bytesBase64"]});
    let mut layer = base.clone();
    layer["target"] = json!({"kind":"layer","name":"Teacher"});
    layer["asset"]["normalizedBoundingBox"] = json!([100, 200, 700, 900]);
    layer["asset"]["sourceZIndex"] = json!(2);
    let mut bundle = f.operation(&parent);
    bundle["images"] = json!([base, layer]);
    let mut invalid_bundle = bundle.clone();
    invalid_bundle["images"][1]["asset"]["normalizedBoundingBox"] = json!([700, 200, 100, 900]);
    assert!(f
        .call("courseware.sceneImage.bundle.stage", invalid_bundle)
        .await
        .is_err());
    assert!(f
        .call("courseware.sceneImage.get", f.operation(&parent))
        .await
        .unwrap()["intent"]["asset"]
        .is_null());
    f.call("courseware.sceneImage.bundle.stage", bundle.clone())
        .await
        .unwrap();
    f.restart().await;
    f.call("courseware.sceneImage.bundle.stage", bundle.clone())
        .await
        .unwrap();
    let rows = f
        .call("courseware.sceneImage.list", f.scope())
        .await
        .unwrap();
    let rows = rows["intents"].as_array().unwrap();
    assert_eq!(rows.len(), 3);
    let child = &rows[2];
    assert_eq!(child["intent"]["taskRef"], parent["intent"]["taskRef"]);
    assert_eq!(child["intent"]["selected"], false);
    assert_eq!(
        child["intent"]["asset"]["normalizedBoundingBox"],
        json!([100.0, 200.0, 700.0, 900.0])
    );
    assert_eq!(child["intent"]["asset"]["sourceZIndex"], 2);
    {
        let mut intents: Vec<Intent> = rows
            .iter()
            .map(|row| serde_json::from_value(row["intent"].clone()).unwrap())
            .collect();
        assert!(verify_decomposition_selection(&intents, &intents[1]).is_err());
        intents[2].selected = true;
        assert!(verify_decomposition_selection(&intents, &intents[1]).is_ok());
        intents[0].selected = false;
        assert!(verify_decomposition_selection(&intents, &intents[1]).is_err());
    }
    assert!(f
        .call("courseware.sceneImage.begin", f.operation(child))
        .await
        .is_err());
    bundle["images"][1]["target"]["name"] = json!("Different");
    assert!(f
        .call("courseware.sceneImage.bundle.stage", bundle)
        .await
        .is_err());
}

#[tokio::test]
async fn reference_requires_same_private_scope_current_page_and_reviewed_visual_master() {
    let mut f = Fixture::new().await;
    let master = f.submitted("image-model", "scene-001").await;
    let mut request = f.prepare();
    request["target"] = json!({"kind":"cleanPlate"});
    request["referenceIntentId"] = master["intent"]["intentId"].clone();
    assert!(f
        .call("courseware.sceneImage.prepare", request.clone())
        .await
        .is_err());
    let stage = f.stage(&master);
    f.call("courseware.sceneImage.asset.stage", stage.clone())
        .await
        .unwrap();
    assert!(f
        .call("courseware.sceneImage.prepare", request.clone())
        .await
        .is_err());
    let mut adopt = f.operation(&master);
    adopt["expectedSelectedIntentId"] = Value::Null;
    f.call("courseware.sceneImage.asset.adopt", adopt)
        .await
        .unwrap();
    for (field, value) in [
        ("principalKey", json!("b".repeat(64))),
        ("sessionId", json!(f.peer)),
        ("pageId", json!("scene-002")),
        ("target", json!({"kind":"visualMaster"})),
    ] {
        let mut foreign = request.clone();
        foreign[field] = value;
        assert!(
            f.call("courseware.sceneImage.prepare", foreign)
                .await
                .is_err(),
            "{field}"
        );
    }
    let prepared = f
        .call("courseware.sceneImage.prepare", request.clone())
        .await
        .unwrap();
    assert_eq!(
        prepared["intent"]["request"]["referenceImage"]["sha256"],
        stage["asset"]["sha256"]
    );
    assert!(prepared["intent"]["request"]["referenceImage"]
        .get("bytesBase64")
        .is_none());
    f.restart().await;
    let retained = f
        .call("courseware.sceneImage.prepare", request)
        .await
        .unwrap();
    assert_eq!(prepared["intent"], retained["intent"]);
    let replacement = f.submitted("other-model", "scene-001").await;
    f.call("courseware.sceneImage.asset.stage", f.stage(&replacement))
        .await
        .unwrap();
    let mut adopt = f.operation(&replacement);
    adopt["expectedSelectedIntentId"] = master["intent"]["intentId"].clone();
    f.call("courseware.sceneImage.asset.adopt", adopt)
        .await
        .unwrap();
    assert!(f
        .call("courseware.sceneImage.begin", f.operation(&prepared))
        .await
        .is_err());
    let unchanged = f
        .call("courseware.sceneImage.get", f.operation(&prepared))
        .await
        .unwrap();
    assert_eq!(unchanged["intent"]["phase"], "prepared");
}

#[tokio::test]
async fn later_masters_pin_course_style_across_restart_and_refuse_replaced_or_foreign_references() {
    let mut f = Fixture::new().await;
    let master = f.submitted("image-model", "scene-001").await;
    f.call("courseware.sceneImage.asset.stage", f.stage(&master))
        .await
        .unwrap();
    let mut select = f.operation(&master);
    select["expectedSelectedIntentId"] = Value::Null;
    f.call("courseware.sceneImage.asset.adopt", select)
        .await
        .unwrap();
    let mut request = f.prepare();
    request["pageId"] = json!("scene-002");
    let next = f
        .call("courseware.sceneImage.prepare", request.clone())
        .await
        .unwrap();
    assert_eq!(
        next["intent"]["referenceIntentId"],
        master["intent"]["intentId"]
    );
    assert_eq!(
        next["intent"]["request"]["referenceImage"]["sha256"],
        f.stage(&master)["asset"]["sha256"]
    );
    assert!(next["intent"]["request"]["input"]
        .as_str()
        .unwrap()
        .contains("recurring character identity"));
    f.restart().await;
    assert_eq!(
        f.call("courseware.sceneImage.prepare", request.clone())
            .await
            .unwrap(),
        next
    );
    for (field, value) in [
        ("referenceIntentId", json!("foreign")),
        ("principalKey", json!("b".repeat(64))),
        ("sessionId", json!(f.peer)),
    ] {
        let mut wrong = request.clone();
        wrong[field] = value;
        assert!(f
            .call("courseware.sceneImage.prepare", wrong)
            .await
            .is_err());
    }
    let replacement = f.submitted("another-model", "scene-001").await;
    f.call("courseware.sceneImage.asset.stage", f.stage(&replacement))
        .await
        .unwrap();
    let mut select = f.operation(&replacement);
    select["expectedSelectedIntentId"] = master["intent"]["intentId"].clone();
    f.call("courseware.sceneImage.asset.adopt", select)
        .await
        .unwrap();
    assert!(f
        .call("courseware.sceneImage.begin", f.operation(&next))
        .await
        .is_err());
    // Decomposition remains page-local even though masters use a course reference.
    request["target"] = json!({"kind":"cleanPlate"});
    request["referenceIntentId"] = replacement["intent"]["intentId"].clone();
    assert!(f
        .call("courseware.sceneImage.prepare", request)
        .await
        .is_err());
}

#[tokio::test]
async fn course_visual_bible_is_reviewed_persisted_and_included_in_master_prompts() {
    let mut f = Fixture::new().await;
    let mut plan: Value = serde_json::from_slice(&std::fs::read(f.path()).unwrap()).unwrap();
    plan["visualBible"] = json!({"artDirection":"Matte watercolor, cream and green palette",
        "characters":"Pandy: black and white panda with green scarf and fixed proportions",
        "setting":"One woodland classroom; no unplanned outdoor or stage changes"});
    let bytes = serde_json::to_vec(&plan).unwrap();
    f.sha256 = hex::encode(sha2::Sha256::digest(&bytes));
    std::fs::write(f.path(), bytes).unwrap();
    f.approve().await;
    f.restart().await;
    let prepared = f
        .call("courseware.sceneImage.prepare", f.prepare())
        .await
        .unwrap();
    let prompt = prepared["intent"]["request"]["input"].as_str().unwrap();
    for text in [
        "Matte watercolor",
        "green scarf",
        "woodland classroom",
        "no duplicate mascots",
    ] {
        assert!(prompt.contains(text), "{text}");
    }
    let saved = f
        .call("courseware.scenePlan.get", json!({"sessionId":f.session}))
        .await
        .unwrap();
    assert_eq!(
        saved["approval"]["plan"]["visualBible"],
        plan["visualBible"]
    );
}

#[test]
fn reference_request_hash_matches_desktop_and_java_fixture_without_changing_legacy_hash() {
    let mut request = ImageRequest {
        kind: "image".into(),
        model: "scene-image".into(),
        input: "A bright classroom. 小朋友😀".into(),
        reference_image: None,
    };
    assert_eq!(
        request.hash(),
        "44ecfadd1f67a10194854070a668f25f21da00c98905a78465c6f68bc4523da5"
    );
    request.reference_image = Some(ReferenceImage {
        sha256: "d8aeb7b31114535bbf9035568464d5eb3dadfabaa70525a487d2c04571203426".into(),
        mime_type: "image/png".into(),
        byte_length: 70,
    });
    assert_eq!(
        request.hash(),
        "d7ebe81a655cdb742f9b5dceee3a2419a0fbe7e49ce73dde29bad23496987881"
    );
}

#[tokio::test]
async fn native_layer_bundle_above_sixteen_mib_archives_under_existing_rpc_limit() {
    let mut f = Fixture::new().await;
    let master = f.submitted("image-model", "scene-001").await;
    f.call("courseware.sceneImage.asset.stage", f.stage(&master))
        .await
        .unwrap();
    let mut adopt = f.operation(&master);
    adopt["expectedSelectedIntentId"] = Value::Null;
    f.call("courseware.sceneImage.asset.adopt", adopt)
        .await
        .unwrap();
    let mut prepare = f.prepare();
    prepare["target"] = json!({"kind":"cleanPlate"});
    prepare["model"] = json!("seedream-layers");
    prepare["referenceIntentId"] = master["intent"]["intentId"].clone();
    prepare["decomposition"] = json!(true);
    let parent = f.submit(prepare).await;
    let stage = f.stage(&parent);
    // Main owns full PNG decoding; Host verifies byte/hash/metadata consistency.
    let mut bytes = STANDARD
        .decode(stage["bytesBase64"].as_str().unwrap())
        .unwrap();
    bytes.resize(5 * 1024 * 1024, 0);
    let mut image = json!({"target":{"kind":"cleanPlate"},"asset":stage["asset"],"bytesBase64":STANDARD.encode(&bytes)});
    image["asset"]["byteLength"] = json!(bytes.len());
    image["asset"]["sha256"] = json!(hex::encode(sha2::Sha256::digest(&bytes)));
    let mut images = vec![image.clone()];
    for z in 1..5 {
        let mut layer = image.clone();
        layer["target"] = json!({"kind":"layer","name":format!("Layer {z}")});
        layer["asset"]["sourceZIndex"] = json!(z);
        layer["asset"]["normalizedBoundingBox"] = json!([100, 100, 900, 900]);
        images.push(layer);
    }
    let mut bundle = f.operation(&parent);
    bundle["images"] = json!(images);
    assert!(serde_json::to_vec(&bundle).unwrap().len() < 64 * 1024 * 1024);
    f.call("courseware.sceneImage.bundle.stage", bundle)
        .await
        .unwrap();
    f.restart().await;
    let saved = f
        .call("courseware.sceneImage.get", f.operation(&parent))
        .await
        .unwrap();
    assert_eq!(saved["intent"]["asset"]["byteLength"], 5 * 1024 * 1024);
}
