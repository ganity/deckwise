use super::*;
use serde_json::json;

fn seed(hash: &str) -> SavedProjectSeed {
    let mut value: Value = serde_json::from_slice(include_bytes!(
        "../../../courseware/identity/fixtures/identity.json"
    ))
    .unwrap();
    value["sourceSha256"] = hash.into();
    for (index, object) in value["pages"][0]["objects"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .enumerate()
    {
        object["sourceObjectName"] = format!("Shape {index}").into();
    }
    SavedProjectSeed {
        project_id: "office-native-test".into(),
        sha256: hash.into(),
        pages: 1,
        identity: Some(SavedSourceIdentity::parse(&serde_json::to_vec(&value).unwrap()).unwrap()),
    }
}
fn proof() -> NativeLineage {
    NativeLineage {
        protocol: "deckwise-office-page-lineage/1".into(),
        project_id: "f".repeat(64),
        document_id: "native-test".into(),
        session_id: "session".into(),
        save_request_id: "save".into(),
        source_sha256: "a".repeat(64),
        output_sha256: "b".repeat(64),
        opened_page_tokens: vec!["page-token".into()],
        page_tokens: vec!["page-token".into()],
        objects: vec![(0..4)
            .map(|index| ObjectLineage {
                name: format!("Shape {index}"),
                source_name: Some(format!("Shape {index}")),
                source_page_token: Some("page-token".into()),
            })
            .collect()],
        animation_unchanged: vec![true],
    }
}

#[test]
fn native_save_preserves_identity_and_narration_rebases_drafts_and_recovers_after_restart() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_str().unwrap();
    let old_seed = seed(&"a".repeat(64));
    let new_seed = seed(&"b".repeat(64));
    let save_id;
    let baseline;
    {
        let db = Database::open_in_dir(dir.path()).unwrap();
        let opened = db
            .open_identified_courseware_project_with_metadata(root, &old_seed, "scene", None)
            .unwrap();
        baseline = db
            .initialize_generated_narration(
                root,
                &opened.project_id,
                &old_seed.sha256,
                "Lesson",
                &["Hello".into()],
            )
            .unwrap();
        let draft_key = serde_json::to_string(&(
            root,
            "session",
            &baseline.project_id,
            &baseline.pages[0].page_id,
        ))
        .unwrap();
        db.kv_set(DRAFTS, &draft_key, &json!({"revision":"draft-1","baseline":baseline,"pageId":baseline.pages[0].page_id,
            "actions":[{"id":"speech-draft","type":"speech","text":"My unsaved explanation"}],"instruction":""})).unwrap();
        let prepared = db
            .prepare_native_save(root, "/lesson.pptx", &new_seed, &proof())
            .unwrap();
        save_id = prepared["saveId"].as_str().unwrap().to_owned();
        assert!(db.ensure_no_source_adoption(root).is_err());
        assert!(db
            .resolve_native_save(root, &save_id, &"c".repeat(64))
            .is_err());
    }
    let db = Database::open_in_dir(dir.path()).unwrap();
    assert!(db
        .native_save_for_path(root, "/lesson.pptx")
        .unwrap()
        .is_some());
    assert_eq!(
        db.resolve_native_save(root, &save_id, &new_seed.sha256)
            .unwrap()["status"],
        "committed"
    );
    assert_eq!(
        db.resolve_native_save(root, &save_id, &new_seed.sha256)
            .unwrap()["status"],
        "committed"
    );
    db.ensure_no_source_adoption(root).unwrap();
    let current = db
        .open_identified_courseware_project(root, &new_seed)
        .unwrap();
    assert_eq!(current.pages[0].page_id, baseline.pages[0].page_id);
    assert_eq!(current.pages[0].actions, baseline.pages[0].actions);
    let old = db
        .courseware_project_context(root, &current.project_id)
        .unwrap();
    assert_eq!(
        old["savedObjects"]["pages"][0]["objects"][0]["objectId"],
        db.kv_get(
            identities::IDENTITY_NAMESPACE,
            &identities::identity_key(root, &current.project_id, &old_seed.sha256).unwrap()
        )
        .unwrap()
        .unwrap()["pages"][0]["objects"][0]["logicalId"]
    );
    let key = serde_json::to_string(&(
        root,
        "session",
        &baseline.project_id,
        &baseline.pages[0].page_id,
    ))
    .unwrap();
    let draft = db.kv_get(DRAFTS, &key).unwrap().unwrap();
    assert_eq!(draft["baseline"]["source"]["sha256"], new_seed.sha256);
    assert_eq!(draft["actions"][0]["text"], "My unsaved explanation");
    db.write_courseware_teaching(
        root,
        &TeachingWrite {
            project_id: current.project_id.clone(),
            page_id: current.pages[0].page_id.clone(),
            expected_source_revision: current.source.revision.clone(),
            expected_teaching_revision: current.teaching_revision.clone(),
            actions: current.pages[0].actions.clone(),
        },
    )
    .unwrap();
}

#[test]
fn native_save_copy_does_not_steal_original_objects_and_cancel_keeps_baseline() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_str().unwrap();
    let db = Database::open_in_dir(dir.path()).unwrap();
    let baseline = db
        .open_identified_courseware_project(root, &seed(&"a".repeat(64)))
        .unwrap();
    let mut lineage = proof();
    lineage.objects[0][0].source_name = None;
    lineage.objects[0][0].source_page_token = None;
    let new_seed = seed(&"b".repeat(64));
    let receipt = db
        .prepare_native_save(root, "/lesson.pptx", &new_seed, &lineage)
        .unwrap();
    let id = receipt["saveId"].as_str().unwrap();
    assert_eq!(
        db.resolve_native_save(root, id, &baseline.source.sha256)
            .unwrap()["status"],
        "cancelled"
    );
    let receipt = db
        .prepare_native_save(root, "/lesson.pptx", &new_seed, &lineage)
        .unwrap();
    db.resolve_native_save(root, receipt["saveId"].as_str().unwrap(), &new_seed.sha256)
        .unwrap();
    let current = db
        .courseware_project_context(root, &baseline.project_id)
        .unwrap();
    let old = db
        .kv_get(
            identities::IDENTITY_NAMESPACE,
            &identities::identity_key(root, &baseline.project_id, &baseline.source.sha256).unwrap(),
        )
        .unwrap()
        .unwrap();
    assert_ne!(
        current["savedObjects"]["pages"][0]["objects"][0]["objectId"],
        old["pages"][0]["objects"][0]["logicalId"]
    );
    assert_eq!(
        current["savedObjects"]["pages"][0]["objects"][1]["objectId"],
        old["pages"][0]["objects"][1]["logicalId"]
    );
}

#[test]
fn native_save_disables_deleted_attention_and_changed_native_animation_with_visible_history() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_str().unwrap();
    let db = Database::open_in_dir(dir.path()).unwrap();
    let mut baseline = db
        .open_identified_courseware_project(root, &seed(&"a".repeat(64)))
        .unwrap();
    let old = db
        .courseware_project_context(root, &baseline.project_id)
        .unwrap();
    let target = old["savedObjects"]["pages"][0]["objects"][0]["objectId"].clone();
    baseline.pages[0].actions = vec![
        json!({"id":"speech","type":"speech","text":"Look here", "visualCues":[
        {"id":"cue","atMs":0,"endMs":1000,"effect":{"type":"highlight","elementIds":[target]}}]}),
        json!({"id":"animation","type":"native_animation","version":1,"sourceSha256":baseline.source.sha256,"stepIndex":0}),
    ];
    db.kv_set(
        NAMESPACE,
        &storage_key(root, &baseline.project_id).unwrap(),
        &serde_json::to_value(&baseline).unwrap(),
    )
    .unwrap();
    let mut proof = proof();
    proof.objects[0][0].source_name = None;
    proof.animation_unchanged[0] = false;
    let receipt = db
        .prepare_native_save(root, "/lesson.pptx", &seed(&"b".repeat(64)), &proof)
        .unwrap();
    assert_eq!(receipt["warnings"].as_array().unwrap().len(), 1);
    db.resolve_native_save(root, receipt["saveId"].as_str().unwrap(), &"b".repeat(64))
        .unwrap();
    let context = db
        .courseware_project_context(root, &baseline.project_id)
        .unwrap();
    assert_eq!(
        context["project"]["pages"][0]["actions"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        context["project"]["pages"][0]["actions"][0]["text"],
        "Look here"
    );
    assert_eq!(
        context["project"]["pages"][0]["actions"][0]["visualCues"],
        json!([])
    );
    assert_eq!(context["saveWarnings"], receipt["warnings"]);
    let history_key = serde_json::to_string(&(
        storage_key(root, &baseline.project_id).unwrap(),
        &baseline.teaching_revision,
    ))
    .unwrap();
    assert_eq!(
        db.kv_get(HISTORY_NAMESPACE, &history_key).unwrap().unwrap(),
        serde_json::to_value(&baseline).unwrap()
    );
}
