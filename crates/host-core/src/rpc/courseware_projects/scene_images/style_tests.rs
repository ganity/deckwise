use super::*;

#[tokio::test]
async fn desktop_pins_provider_parameters_and_normalized_reference_without_changing_reviewed_source() {
    let mut f = Fixture::new().await;
    let master = f.submitted("image-model", "scene-001").await;
    assert_eq!(master["intent"]["request"]["parameters"], json!({"image_size":"1280x800","quality":"high"}));
    let mut stage = f.stage(&master);
    let mut source_bytes = STANDARD.decode(stage["bytesBase64"].as_str().unwrap()).unwrap();
    source_bytes.resize(9 * 1024 * 1024, 0);
    stage["bytesBase64"] = json!(STANDARD.encode(&source_bytes));
    stage["asset"]["byteLength"] = json!(source_bytes.len());
    stage["asset"]["sha256"] = json!(hex::encode(Sha256::digest(&source_bytes)));
    let source = stage["asset"]["sha256"].clone();
    f.call("courseware.sceneImage.asset.stage", stage).await.unwrap();
    let mut adopt = f.operation(&master);
    adopt["expectedSelectedIntentId"] = Value::Null;
    f.call("courseware.sceneImage.asset.adopt", adopt).await.unwrap();
    let mut prepare = f.prepare();
    prepare["model"] = json!("seedream-layers");
    prepare["target"] = json!({"kind":"cleanPlate"});
    prepare["decomposition"] = json!(true);
    prepare["referenceIntentId"] = master["intent"]["intentId"].clone();
    // Main owns full native decoding/encoding; Host checks and archives the exact wire bytes.
    let jpeg = b"\xff\xd8\xffdesktop-encoded-reference\xff\xd9";
    prepare["referenceInput"] = json!({"sourceSha256":source,"bytesBase64":STANDARD.encode(jpeg)});
    let mut forged = prepare.clone();
    forged["referenceInput"]["sourceSha256"] = json!("a".repeat(64));
    assert!(f.call("courseware.sceneImage.prepare", forged).await.is_err());
    let layer = f.call("courseware.sceneImage.prepare", prepare.clone()).await.unwrap();
    assert_eq!(layer["intent"]["sourceReferenceImage"]["sha256"], source);
    assert_eq!(layer["intent"]["sourceReferenceImage"]["byteLength"], source_bytes.len());
    assert_eq!(layer["intent"]["request"]["referenceImage"]["sha256"], hex::encode(Sha256::digest(jpeg)));
    assert_eq!(layer["intent"]["request"]["parameters"], json!({"size":"2K","output_format":"png","response_format":"url","watermark":false}));
    f.restart().await;
    let saved = f.call("courseware.sceneImage.reference.get", f.operation(&layer)).await.unwrap();
    assert_eq!(std::fs::read(saved["path"].as_str().unwrap()).unwrap(), jpeg);
    assert_eq!(f.call("courseware.sceneImage.prepare", prepare).await.unwrap(), layer);
    let original = f.call("courseware.sceneImage.asset.get", f.operation(&master)).await.unwrap();
    assert_eq!(original["intent"]["asset"]["sha256"], source);
}

#[tokio::test]
async fn explicit_decomposition_retry_uses_maic_prompt_and_keeps_legacy_receipt_and_reference() {
    let mut f = Fixture::new().await;
    let master = f.submitted("image-model", "scene-001").await;
    f.call("courseware.sceneImage.asset.stage", f.stage(&master)).await.unwrap();
    let mut adopt = f.operation(&master);
    adopt["expectedSelectedIntentId"] = Value::Null;
    f.call("courseware.sceneImage.asset.adopt", adopt).await.unwrap();
    let mut prepare = f.prepare();
    prepare["target"] = json!({"kind":"cleanPlate"});
    prepare["referenceIntentId"] = master["intent"]["intentId"].clone();
    prepare["decomposition"] = json!(true);
    let parent = f.submit(prepare.clone()).await;
    let legacy = {
        let state = f.state.lock().await;
        let key = storage_key(f.root.to_str().unwrap(), &Scope { session_id: f.session.clone(), principal_key: "a".repeat(64) }).unwrap();
        let mut intents = load(&state, &key).unwrap();
        let intent = intents.iter_mut().find(|intent| intent.intent_id == parent["intent"]["intentId"].as_str().unwrap()).unwrap();
        intent.request.input = "Legacy extra decomposition instructions".into();
        intent.request_hash = intent.request.hash();
        intent.task_ref.as_mut().unwrap().request_hash = intent.request_hash.clone();
        let legacy = intent.view(Some(&f.sha256));
        save(&state, &key, &intents).unwrap();
        legacy
    };
    let retry = f.call("courseware.sceneImage.retry", f.operation(&legacy)).await.unwrap();
    assert_eq!(retry["intent"]["request"]["input"], prompts::LAYER_PROMPT);
    assert_eq!(retry["intent"]["request"]["referenceImage"], legacy["intent"]["request"]["referenceImage"]);
    assert_eq!(retry["intent"]["referenceIntentId"], master["intent"]["intentId"]);
    assert_ne!(retry["intent"]["requestHash"], legacy["intent"]["requestHash"]);
    assert_eq!(f.call("courseware.sceneImage.get", f.operation(&legacy)).await.unwrap(), legacy);
    f.restart().await;
    assert_eq!(f.call("courseware.sceneImage.retry", f.operation(&legacy)).await.unwrap(), retry);
    assert_eq!(f.call("courseware.sceneImage.prepare", prepare).await.unwrap(), retry);
}

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
async fn long_approved_later_page_fits_master_prompt_without_revising_the_plan() {
    let mut f = Fixture::new().await;
    let mut plan: Value = serde_json::from_slice(&std::fs::read(f.path()).unwrap()).unwrap();
    let art = "Soft hand-painted watercolor, warm light and layered paper texture. ".repeat(6);
    let characters = "Five original animal friends with distinct shapes, outfits and faces. ".repeat(5);
    let setting = "A bright kindergarten room with calm wall art and a deep floor. ".repeat(3);
    let story = "The animal friends take turns greeting each other around the classroom. ".repeat(10);
    plan["visualBible"] = json!({"artDirection":art,"characters":characters,"setting":setting});
    plan["pages"][1]["visualIntent"] = json!(story);
    plan["pages"][1]["visibleText"] = json!(["Hello!", "Good morning!", "早上好"]);
    let bytes = serde_json::to_vec(&plan).unwrap();
    f.sha256 = hex::encode(Sha256::digest(&bytes));
    std::fs::write(f.path(), bytes).unwrap();
    f.approve().await;

    let cover = f.submitted("image-model", "scene-001").await;
    f.call("courseware.sceneImage.asset.stage", f.stage(&cover))
        .await
        .unwrap();
    let mut adopt = f.operation(&cover);
    adopt["expectedSelectedIntentId"] = Value::Null;
    f.call("courseware.sceneImage.asset.adopt", adopt)
        .await
        .unwrap();

    let mut request = f.prepare();
    request["pageId"] = json!("scene-002");
    request["planningRequired"] = json!(true);
    request["instructions"] = json!("Keep the five friends waving in matching warm light.");
    let prepared = f
        .call("courseware.sceneImage.prepare", request)
        .await
        .unwrap();
    let prompt = prepared["intent"]["request"]["input"].as_str().unwrap();
    for required in [
        &art,
        &characters,
        &setting,
        &story,
        "Hello!",
        "Good morning!",
        "早上好",
        "Keep the five friends waving in matching warm light.",
    ] {
        assert!(
            prompt.contains(required),
            "approved content missing: {required}"
        );
    }
    assert!(prompt.encode_utf16().count() <= 4000);
    assert_eq!(prepared["intent"]["planSha256"], f.sha256);
    assert_eq!(
        prepared["intent"]["referenceIntentId"],
        cover["intent"]["intentId"]
    );
    assert_eq!(
        f.call("courseware.sceneImage.prepare", f.prepare())
            .await
            .unwrap()["intent"]["intentId"],
        cover["intent"]["intentId"]
    );
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
        parameters: None,
        kind: "image".into(),
        model: "scene-image".into(),
        input: "A bright classroom. 小朋友😀".into(),
        reference_image: None,
    };
    assert_eq!(
        request.hash(),
        "44ecfadd1f67a10194854070a668f25f21da00c98905a78465c6f68bc4523da5"
    );
    request.parameters = Some(json!({"quality":"high","image_size":"1280x800"}));
    assert_eq!(request.hash(), "4e7b648731d7c0830a04c077e45abe21f364705992c136b2a86d4808dac14240");
    request.parameters = None;
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

#[tokio::test]
async fn native_layer_bundle_streams_over_44_mib_without_publishing_partial_assets() {
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
    for z in 1..10 {
        let mut layer = image.clone();
        layer["target"] = json!({"kind":"layer","name":format!("Layer {z}")});
        layer["asset"]["sourceZIndex"] = json!(z);
        layer["asset"]["normalizedBoundingBox"] = json!([100, 100, 900, 900]);
        images.push(layer);
    }
    for image in &images {
        let mut chunk = f.operation(&parent);
        chunk["stageOnly"] = json!(true);
        chunk["images"] = json!([image]);
        assert!(serde_json::to_vec(&chunk).unwrap().len() < 12 * 1024 * 1024);
        f.call("courseware.sceneImage.bundle.stage", chunk)
            .await
            .unwrap();
    }
    let partial = f
        .call("courseware.sceneImage.get", f.operation(&parent))
        .await
        .unwrap();
    assert!(partial["intent"]["asset"].is_null());
    f.restart().await;
    for image in &mut images {
        image.as_object_mut().unwrap().remove("bytesBase64");
    }
    let mut bundle = f.operation(&parent);
    bundle["images"] = json!(images);
    assert!(serde_json::to_vec(&bundle).unwrap().len() < 100_000);
    let mut missing = bundle.clone();
    missing["images"][1]["asset"]["sha256"] = json!("e".repeat(64));
    assert!(f
        .call("courseware.sceneImage.bundle.stage", missing)
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
    f.call("courseware.sceneImage.bundle.stage", bundle)
        .await
        .unwrap();
    let saved = f
        .call("courseware.sceneImage.get", f.operation(&parent))
        .await
        .unwrap();
    assert_eq!(saved["intent"]["asset"]["byteLength"], 5 * 1024 * 1024);
}

#[tokio::test]
async fn visual_master_preserves_required_group_and_names_without_unrelated_content() {
    let mut f = Fixture::new().await;
    let mut plan: Value = serde_json::from_slice(&std::fs::read(f.path()).unwrap()).unwrap();
    let names = [
        "Monkey Munchy",
        "Panda Pandy",
        "Dog Doffy",
        "Cat Catty",
        "Teddy Bear",
    ];
    plan["pages"][0]["visibleText"] = json!(names);
    plan["pages"][0]["visualIntent"] = json!("Show all five animals with their names: Monkey Munchy, Panda Pandy, Dog Doffy, Cat Catty, Teddy Bear.");
    plan["visualBible"] = json!({"artDirection":"Bright clay 3D", "characters":"Five recurring animal friends", "setting":"Kindergarten classroom"});
    let bytes = serde_json::to_vec(&plan).unwrap();
    f.sha256 = hex::encode(sha2::Sha256::digest(&bytes));
    std::fs::write(f.path(), bytes).unwrap();
    f.approve().await;
    let prepared = f
        .call("courseware.sceneImage.prepare", f.prepare())
        .await
        .unwrap();
    let prompt = prepared["intent"]["request"]["input"].as_str().unwrap();
    for name in names {
        assert!(prompt.contains(name));
    }
    assert!(prompt
        .contains("Preserve every lesson-required subject, name and prop; do not cap their count"));
    assert!(prompt.contains("No unrequested subjects, duplicate portraits/badges, extra text carriers or decorative props"));
    assert!(prompt
        .contains("Use depth, light, color and materials for atmosphere, not piles of objects"));
    assert!(prompt.contains("identity guide, not a cast list for every page"));
    assert!(prompt.contains("Bright clay 3D"));
    assert!(prompt.encode_utf16().count() <= 4000);
}

#[tokio::test]
async fn planned_master_prompt_is_checked_pinned_and_reused_after_restart() {
    let mut f = Fixture::new().await;
    let mut request = f.prepare();
    request["planningRequired"] = json!(true);
    let prepared = f
        .call("courseware.sceneImage.prepare", request.clone())
        .await
        .unwrap();
    assert!(f
        .call("courseware.sceneImage.begin", f.operation(&prepared))
        .await
        .is_err());
    request["plannedPrompt"] = json!({"sourceRequestHash":prepared["intent"]["requestHash"],"input":"1280x800 16:10: 圆 Circle"});
    let mut invalid = request.clone();
    invalid["plannedPrompt"]["input"] = json!("Omitted teaching text");
    assert!(f
        .call("courseware.sceneImage.prepare", invalid)
        .await
        .is_err());
    let mut stale = request.clone();
    stale["plannedPrompt"]["sourceRequestHash"] = json!("b".repeat(64));
    assert!(f
        .call("courseware.sceneImage.prepare", stale)
        .await
        .is_err());
    let planned = f
        .call("courseware.sceneImage.prepare", request.clone())
        .await
        .unwrap();
    assert_eq!(
        planned["intent"]["intentId"],
        prepared["intent"]["intentId"]
    );
    assert_ne!(
        planned["intent"]["requestHash"],
        prepared["intent"]["requestHash"]
    );
    assert_ne!(
        planned["intent"]["idempotencyKey"],
        prepared["intent"]["idempotencyKey"]
    );
    assert_eq!(
        planned["intent"]["sourcePrompt"],
        prepared["intent"]["request"]["input"]
    );
    f.restart().await;
    assert_eq!(
        f.call("courseware.sceneImage.prepare", f.prepare())
            .await
            .unwrap(),
        planned
    );
    request["plannedPrompt"]["input"] = json!("A different nondeterministic direction: 圆 Circle");
    assert_eq!(
        f.call("courseware.sceneImage.prepare", request)
            .await
            .unwrap(),
        planned
    );
    f.call("courseware.sceneImage.begin", f.operation(&planned))
        .await
        .unwrap();
    let latest = f
        .call("courseware.sceneImage.prepare", f.prepare())
        .await
        .unwrap();
    assert_eq!(latest["intent"]["request"], planned["intent"]["request"]);
}

#[tokio::test]
async fn an_existing_submitted_master_cannot_be_replanned() {
    let f = Fixture::new().await;
    let submitted = f.submit(f.prepare()).await;
    let mut request = f.prepare();
    request["plannedPrompt"] = json!({"sourceRequestHash":submitted["intent"]["requestHash"],"input":"1280x800: 圆 Circle"});
    assert!(f
        .call("courseware.sceneImage.prepare", request)
        .await
        .is_err());
    assert_eq!(
        f.call("courseware.sceneImage.get", f.operation(&submitted))
            .await
            .unwrap(),
        submitted
    );
}
