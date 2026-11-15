use super::*;

#[test]
fn native_save_preserves_pending_music_and_video_originals() {
    use sha2::{Digest, Sha256};
    for adopted in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        let db = Database::open_in_dir(dir.path()).unwrap();
        let project = db
            .open_identified_courseware_project_with_metadata(
                root,
                &seed(&"a".repeat(64)),
                "scene",
                None,
            )
            .unwrap();
        let mut actions = project.pages[0].actions.clone();
        actions.push(json!({"id":"song","type":"music_slot","title":"Hello","prompt":"Original slot prompt"}));
        actions.push(json!({"id":"clip","type":"video_slot","prompt":"A greeting gesture"}));
        let project = db
            .write_courseware_teaching(
                root,
                &TeachingWrite {
                    project_id: project.project_id.clone(),
                    page_id: project.pages[0].page_id.clone(),
                    expected_source_revision: project.source.revision.clone(),
                    expected_teaching_revision: project.teaching_revision.clone(),
                    actions,
                },
            )
            .unwrap();
        let original = db
            .prepare_courseware_video(
                root,
                &project.project_id,
                &"d".repeat(64),
                &project.pages[0].page_id,
                "clip",
                "video",
            )
            .unwrap();
        db.begin_courseware_video(
            root,
            &project.project_id,
            &"d".repeat(64),
            &original.intent_id,
            "session",
        )
        .unwrap();
        if adopted {
            let task = super::super::tts::TaskRef {
                task_id: "video-task".into(),
                idempotency_key: original.idempotency_key.clone(),
                request_hash: original.request_hash.clone(),
            };
            db.bind_courseware_video(
                root,
                &project.project_id,
                &"d".repeat(64),
                &original.intent_id,
                task.clone(),
            )
            .unwrap();
            db.stage_courseware_video(
                root,
                &project.project_id,
                &"d".repeat(64),
                &original.intent_id,
                &task,
                super::super::video::VideoAsset {
                    sha256: "e".repeat(64),
                    byte_length: 1000,
                    duration_ms: 5000,
                    width: 1280,
                    height: 720,
                },
            )
            .unwrap();
            db.adopt_courseware_video(
                root,
                &project.project_id,
                &"d".repeat(64),
                &original.intent_id,
                &project.teaching_revision,
            )
            .unwrap();
        }
        let key = serde_json::to_string(&(
            std::fs::canonicalize(root).unwrap(),
            "session",
            "d".repeat(64),
        ))
        .unwrap();
        let slot = &hex::encode(Sha256::digest(b"song"))[..16];
        let music = json!([{"intentId":"original-song","draft":{"id":format!("auto-music-{}-p1-{slot}-{}",project.source.sha256,"f".repeat(24))},
        "request":{"kind":"music","input":"Supplier lyrics differ from the slot"},"phase":"submission-unknown","idempotencyKey":"original-key","requestHash":"original-hash"}, {"intentId":"ambiguous-song","draft":{"id":format!("auto-music-{}-p1-{}",project.source.sha256,"f".repeat(32))},"request":{"kind":"music"},"phase":"submission-unknown"}]);
        db.kv_set(super::super::music::JOURNAL, &key, &music)
            .unwrap();
        for (old, new) in [('a', 'b'), ('b', 'c')] {
            let mut lineage = proof();
            lineage.source_sha256 = old.to_string().repeat(64);
            lineage.output_sha256 = new.to_string().repeat(64);
            let receipt = db
                .prepare_native_save(
                    root,
                    "/lesson.pptx",
                    &seed(&new.to_string().repeat(64)),
                    &lineage,
                )
                .unwrap();
            db.resolve_native_save(
                root,
                receipt["saveId"].as_str().unwrap(),
                &new.to_string().repeat(64),
            )
            .unwrap();
            let current = db
                .get_courseware_project(root, &project.project_id)
                .unwrap()
                .unwrap();
            let retained = db
                .get_courseware_video(
                    root,
                    &project.project_id,
                    &"d".repeat(64),
                    &original.intent_id,
                )
                .unwrap();
            assert!(
                retained.matches(&current),
                "pending video must follow verified saves"
            );
            assert_eq!(retained.source.sha256, original.source.sha256);
            assert_eq!(retained.request_hash, original.request_hash);
            if adopted {
                assert_eq!(db.portable_video_assets(root, &current).unwrap().len(), 1);
            }
            let records = db
                .kv_get(super::super::music::JOURNAL, &key)
                .unwrap()
                .unwrap();
            assert_eq!(
                records[0]["target"]["source"]["sha256"],
                new.to_string().repeat(64)
            );
            assert_eq!(records[0]["target"]["actionId"], "song");
            assert_eq!(records[1]["unresolvedProjectId"], project.project_id);
            assert_eq!(records[0]["request"], music[0]["request"]);
            assert_eq!(records[0]["draft"], music[0]["draft"]);
        }
    }
}

#[test]
fn native_save_v2_preserves_objects_through_rename_duplicate_names_and_reorder() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_str().unwrap();
    let db = Database::open_in_dir(dir.path()).unwrap();
    let old_seed = seed(&"a".repeat(64));
    let opened = db
        .open_identified_courseware_project_with_metadata(root, &old_seed, "scene", None)
        .unwrap();
    let before = db
        .courseware_project_context(root, &opened.project_id)
        .unwrap();
    let mut value = seed(&"b".repeat(64)).identity.unwrap().value().clone();
    let objects = value["pages"][0]["objects"].as_array_mut().unwrap();
    let mut lineage = proof();
    lineage.protocol = "deckwise-office-page-lineage/2".into();
    for (index, (object, item)) in objects.iter_mut().zip(&mut lineage.objects[0]).enumerate() {
        item.source_shape_id = object["sourceShapeId"].as_str().map(str::to_owned);
        item.shape_id = Some((100 + index).to_string());
        item.source_name = None;
        item.name = "Same renamed object".into();
        object["sourceShapeId"] = item.shape_id.clone().unwrap().into();
        object["sourceObjectName"] = item.name.clone().into();
    }
    objects.reverse();
    lineage.objects[0].reverse();
    let new_seed = SavedProjectSeed {
        identity: Some(SavedSourceIdentity::parse(&serde_json::to_vec(&value).unwrap()).unwrap()),
        ..seed(&"b".repeat(64))
    };
    let receipt = db
        .prepare_native_save(root, "/lesson.pptx", &new_seed, &lineage)
        .unwrap();
    db.resolve_native_save(root, receipt["saveId"].as_str().unwrap(), &new_seed.sha256)
        .unwrap();
    let after = db
        .courseware_project_context(root, &opened.project_id)
        .unwrap();
    let ids = |context: &Value| {
        context["savedObjects"]["pages"][0]["objects"]
            .as_array()
            .unwrap()
            .iter()
            .map(|object| object["objectId"].clone())
            .collect::<Vec<_>>()
    };
    let mut expected = ids(&before);
    expected.reverse();
    assert_eq!(ids(&after), expected);
}

#[test]
fn native_save_v2_rejects_invalid_and_duplicate_output_ids_without_a_pending_save() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_str().unwrap();
    let db = Database::open_in_dir(dir.path()).unwrap();
    db.open_identified_courseware_project_with_metadata(
        root,
        &seed(&"a".repeat(64)),
        "scene",
        None,
    )
    .unwrap();
    for invalid in [None, Some("invalid"), Some("12345678901"), Some("42")] {
        let mut lineage = proof();
        lineage.protocol = "deckwise-office-page-lineage/2".into();
        for (index, item) in lineage.objects[0].iter_mut().enumerate() {
            item.shape_id = Some((42 + index).to_string());
        }
        lineage.objects[0][1].shape_id = invalid.map(str::to_owned);
        assert!(db
            .prepare_native_save(root, "/lesson.pptx", &seed(&"b".repeat(64)), &lineage)
            .is_err());
        assert!(db
            .native_save_for_path(root, "/lesson.pptx")
            .unwrap()
            .is_none());
    }
}
