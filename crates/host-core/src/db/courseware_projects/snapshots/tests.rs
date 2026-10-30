use super::*;

pub(super) fn seed() -> SavedProjectSeed {
    let identity = SavedSourceIdentity::parse(include_bytes!(
        "../../../courseware/identity/fixtures/identity.json"
    ))
    .unwrap();
    SavedProjectSeed {
        project_id: "office-snapshot-test".into(),
        sha256: identity.value()["sourceSha256"].as_str().unwrap().into(),
        pages: 1,
        identity: Some(identity),
    }
}

pub(super) fn assets() -> Vec<Asset> {
    vec![Asset {
        id: "voice-1".into(),
        sha256: "a".repeat(64),
        mime_type: "audio/wav".into(),
    }]
}

pub(super) fn ready(db: &Database, root: &str) -> CoursewareProject {
    let p = db
        .open_identified_courseware_project(root, &seed())
        .unwrap();
    let p = db.write_courseware_teaching(root, &TeachingWrite {
        project_id: p.project_id, page_id: p.pages[0].page_id.clone(),
        expected_source_revision: p.source.revision, expected_teaching_revision: p.teaching_revision,
        actions: vec![json!({"id":"speech-1","type":"speech","text":"Good!","audioAssetId":"voice-1"})],
    }).unwrap();
    db.review_courseware_page(
        root,
        &p.project_id,
        &p.pages[0].page_id,
        &p.source.revision,
        &p.teaching_revision,
    )
    .unwrap()
}

fn capture(db: &Database, root: &str, p: &CoursewareProject) -> Result<SnapshotRecord> {
    db.capture_courseware_snapshot(
        root,
        &seed(),
        "snapshot-1",
        &p.source.revision,
        &p.teaching_revision,
        assets(),
    )
}

#[test]
fn snapshot_survives_restart_and_live_edits_without_changing_the_source_or_mapping() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_str().unwrap();
    let db = Database::open_in_dir(dir.path()).unwrap();
    let p = ready(&db, root);
    let frozen = capture(&db, root, &p).unwrap();
    let expected = serde_json::to_value(&frozen).unwrap();
    assert_eq!(
        serde_json::to_value(capture(&db, root, &p).unwrap()).unwrap(),
        expected
    );
    assert_eq!(frozen.mapping()["pages"][0]["pageId"], p.pages[0].page_id);
    assert_eq!(
        frozen.mapping()["pages"][0]["objects"]
            .as_array()
            .unwrap()
            .len(),
        4
    );
    let edited = db
        .write_courseware_teaching(
            root,
            &TeachingWrite {
                project_id: p.project_id.clone(),
                page_id: p.pages[0].page_id.clone(),
                expected_source_revision: p.source.revision.clone(),
                expected_teaching_revision: p.teaching_revision.clone(),
                actions: vec![json!({"id":"speech-1","type":"speech","text":"Changed"})],
            },
        )
        .unwrap();
    assert_eq!(edited.pages[0].review_state, "review");
    assert_eq!(edited.source.sha256, p.source.sha256);
    assert!(capture(&db, root, &p)
        .unwrap_err()
        .to_string()
        .contains("baseline changed"));
    drop(db);
    let db = Database::open_in_dir(dir.path()).unwrap();
    assert_eq!(
        serde_json::to_value(
            db.get_courseware_snapshot(root, &p.project_id, "snapshot-1")
                .unwrap()
        )
        .unwrap(),
        expected
    );
    assert!(db
        .get_courseware_snapshot("/another/workspace", &p.project_id, "snapshot-1")
        .is_err());
    assert!(db
        .get_courseware_snapshot(root, &p.project_id, "../escape")
        .is_err());
    assert_eq!(
        db.get_courseware_project(root, &p.project_id)
            .unwrap()
            .unwrap()
            .pages[0]
            .actions[0]["text"],
        "Changed"
    );
}

#[test]
fn attention_authoring_preserves_audio_waits_and_logical_targets_in_the_frozen_export() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_str().unwrap();
    let db = Database::open_in_dir(dir.path()).unwrap();
    let p = ready(&db, root);
    let original = db
        .capture_courseware_snapshot(
            root,
            &seed(),
            "snapshot-before-attention",
            &p.source.revision,
            &p.teaching_revision,
            assets(),
        )
        .unwrap();
    let mapping = original.mapping();
    let objects = mapping["pages"][0]["objects"].as_array().unwrap();
    let targets = vec![
        objects[0]["objectId"].clone(),
        objects[1]["objectId"].clone(),
    ];
    let actions = vec![
        json!({"id":"speech-1","type":"speech","text":"Good!","audioAssetId":"voice-1","pauseAfterMs":500,
        "visualCues":[
            {"id":"attention-highlight","atMs":0,"endMs":1000,"effect":{"type":"highlight","elementIds":targets}},
            {"id":"attention-spotlight","atMs":1000,"endMs":2000,"effect":{"type":"spotlight","elementId":targets[0],"elementIds":[targets[1]]}}
        ]}),
        json!({"id":"wait","type":"interaction_checkpoint","checkpointId":"wait","checkpointKind":"teacher_continue"}),
    ];
    let edited = db
        .write_courseware_teaching(
            root,
            &TeachingWrite {
                project_id: p.project_id.clone(),
                page_id: p.pages[0].page_id.clone(),
                expected_source_revision: p.source.revision.clone(),
                expected_teaching_revision: p.teaching_revision.clone(),
                actions: actions.clone(),
            },
        )
        .unwrap();
    assert_eq!(edited.pages[0].review_state, "review");
    assert!(capture(&db, root, &edited).is_err());
    let confirmed = db
        .review_courseware_page(
            root,
            &edited.project_id,
            &edited.pages[0].page_id,
            &edited.source.revision,
            &edited.teaching_revision,
        )
        .unwrap();
    let frozen = capture(&db, root, &confirmed).unwrap();
    assert_eq!(frozen.project.pages[0].actions, actions);
    assert_eq!(frozen.snapshot.asset_ids, vec!["voice-1"]);
    assert_eq!(
        frozen.mapping()["pages"][0]["objects"][0]["objectId"],
        targets[0]
    );
    assert_eq!(
        frozen.mapping()["pages"][0]["objects"][1]["objectId"],
        targets[1]
    );
    drop(db);
    let db = Database::open_in_dir(dir.path()).unwrap();
    let reopened = db
        .get_courseware_snapshot(root, &confirmed.project_id, "snapshot-1")
        .unwrap();
    assert_eq!(reopened.project.pages[0].actions, actions);
    assert_eq!(reopened.mapping(), frozen.mapping());
}

#[test]
fn ordinary_attention_context_to_snapshot_fixture() {
    let input = std::env::var_os("DECKWISE_EFFECT_HOST_INPUT")
        .map(|path| serde_json::from_slice::<Value>(&std::fs::read(path).unwrap()).unwrap());
    for task_type in ["plain", "import"] {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        let db = Database::open_in_dir(dir.path()).unwrap();
        let mut s = seed();
        s.project_id = format!("attention-{task_type}");
        let fixed_assets = if let Some(input) = &input {
            let identity =
                SavedSourceIdentity::parse(&serde_json::to_vec(&input["identity"]).unwrap())
                    .unwrap();
            s.sha256 = identity.value()["sourceSha256"].as_str().unwrap().into();
            s.pages = identity.value()["pages"].as_array().unwrap().len();
            s.identity = Some(identity);
            serde_json::from_value::<Vec<Asset>>(input["assets"].clone()).unwrap()
        } else {
            assets()
        };
        let mut p = db
            .open_identified_courseware_project_with_metadata(root, &s, task_type, None)
            .unwrap();
        let context = db.courseware_project_context(root, &p.project_id).unwrap();
        let mut target_pages = Vec::new();
        for index in 0..p.pages.len() {
            let targets = context["savedObjects"]["pages"][index]["objects"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|object| {
                    matches!(object["kind"].as_str(), Some("text" | "shape" | "image"))
                })
                .take(2)
                .map(|object| object["objectId"].clone())
                .collect::<Vec<_>>();
            assert!(!targets.is_empty());
            target_pages.push(targets.clone());
            p = db.write_courseware_teaching(root, &TeachingWrite {
                project_id: p.project_id.clone(), page_id: p.pages[index].page_id.clone(),
                expected_source_revision: p.source.revision.clone(), expected_teaching_revision: p.teaching_revision.clone(),
                actions: vec![
                    json!({"id":format!("speech-{index}"),"type":"speech","text":"Find the current objects.","audioAssetId":fixed_assets[0].id,
                        "visualCues":[
                            {"id":"highlight","atMs":0,"endMs":800,"effect":{"type":"highlight","elementIds":targets}},
                            {"id":"spotlight","atMs":800,"endMs":1900,"effect":{"type":"spotlight","elementId":targets[0],"elementIds":targets[1..]}}
                        ]}),
                    json!({"id":format!("wait-{index}"),"type":"interaction_checkpoint","checkpointId":format!("wait-{index}"),"checkpointKind":"teacher_continue"})
                ],
            }).unwrap();
        }
        for index in 0..p.pages.len() {
            p = db
                .review_courseware_page(
                    root,
                    &p.project_id,
                    &p.pages[index].page_id,
                    &p.source.revision,
                    &p.teaching_revision,
                )
                .unwrap();
        }
        let frozen = db
            .capture_courseware_snapshot(
                root,
                &s,
                "attention-snapshot",
                &p.source.revision,
                &p.teaching_revision,
                fixed_assets,
            )
            .unwrap();
        for (index, targets) in target_pages.iter().enumerate() {
            for target in targets {
                assert!(frozen.mapping()["pages"][index]["objects"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|binding| binding["objectId"] == *target));
            }
        }
        assert_eq!(frozen.project.task_type, task_type);
        println!(
            "DECKWISE_EFFECT_SNAPSHOT {}",
            json!({"project":frozen.project,
            "snapshot":frozen.snapshot,"mapping":frozen.mapping(),"targets":target_pages})
        );
    }
}

#[test]
fn confirmation_is_revision_checked_preserves_locks_and_is_invalidated_by_edits() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_str().unwrap();
    let db = Database::open_in_dir(dir.path()).unwrap();
    let p = ready(&db, root);
    let locked = db
        .set_courseware_page_lock(
            root,
            &p.project_id,
            &p.pages[0].page_id,
            &p.source.revision,
            &p.teaching_revision,
            true,
        )
        .unwrap();
    assert!(db
        .review_courseware_page(
            root,
            &p.project_id,
            &p.pages[0].page_id,
            &p.source.revision,
            &p.teaching_revision
        )
        .is_err());
    let confirmed = db
        .review_courseware_page(
            root,
            &p.project_id,
            &p.pages[0].page_id,
            &locked.source.revision,
            &locked.teaching_revision,
        )
        .unwrap();
    assert!(confirmed.pages[0].locked);
    assert_eq!(confirmed.pages[0].actions, locked.pages[0].actions);
    assert_eq!(confirmed.pages[0].review_state, "ready");
    assert_ne!(confirmed.teaching_revision, locked.teaching_revision);
    let reopened = db
        .get_courseware_project(root, &p.project_id)
        .unwrap()
        .unwrap();
    assert_eq!(reopened.teaching_revision, confirmed.teaching_revision);
}

#[test]
fn capture_requires_confirmed_pages_fresh_mapping_and_exact_fixed_audio_references() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_str().unwrap();
    let db = Database::open_in_dir(dir.path()).unwrap();
    let initial = db
        .open_identified_courseware_project(root, &seed())
        .unwrap();
    assert!(capture(&db, root, &initial)
        .unwrap_err()
        .to_string()
        .contains("confirm every"));
    let p = ready(&db, root);
    assert!(db
        .capture_courseware_snapshot(
            root,
            &seed(),
            "missing-audio",
            &p.source.revision,
            &p.teaching_revision,
            vec![]
        )
        .unwrap_err()
        .to_string()
        .contains("fixed audio"));
    let mut wrong = assets();
    wrong[0].id = "other-voice".into();
    assert!(db
        .capture_courseware_snapshot(
            root,
            &seed(),
            "wrong-audio",
            &p.source.revision,
            &p.teaching_revision,
            wrong
        )
        .is_err());
    let mut extra = assets();
    let mut second = extra[0].clone();
    second.id = "unused".into();
    extra.push(second);
    assert!(db
        .capture_courseware_snapshot(
            root,
            &seed(),
            "extra",
            &p.source.revision,
            &p.teaching_revision,
            extra
        )
        .is_err());
    let mut duplicate = assets();
    duplicate.push(duplicate[0].clone());
    assert!(db
        .capture_courseware_snapshot(
            root,
            &seed(),
            "duplicate",
            &p.source.revision,
            &p.teaching_revision,
            duplicate
        )
        .is_err());
    let mut absent = seed();
    absent.identity = None;
    assert!(db
        .capture_courseware_snapshot(
            root,
            &absent,
            "no-mapping",
            &p.source.revision,
            &p.teaching_revision,
            assets()
        )
        .is_err());
    let mut drift = seed();
    let mut identity = drift.identity.unwrap().value().clone();
    identity["pages"][0]["objects"][0]["contentFingerprint"] = json!("b".repeat(64));
    drift.identity =
        Some(SavedSourceIdentity::parse(&serde_json::to_vec(&identity).unwrap()).unwrap());
    assert!(db
        .capture_courseware_snapshot(
            root,
            &drift,
            "drift",
            &p.source.revision,
            &p.teaching_revision,
            assets()
        )
        .is_err());
    assert!(db
        .get_courseware_snapshot(root, &p.project_id, "missing-audio")
        .is_err());
}

#[test]
fn snapshot_ids_cannot_replace_existing_content_and_sql_failure_leaves_no_record() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_str().unwrap();
    let db = Database::open_in_dir(dir.path()).unwrap();
    let p = ready(&db, root);
    let original = capture(&db, root, &p).unwrap();
    let mut changed = assets();
    changed[0].sha256 = "b".repeat(64);
    assert!(db
        .capture_courseware_snapshot(
            root,
            &seed(),
            "snapshot-1",
            &p.source.revision,
            &p.teaching_revision,
            changed
        )
        .unwrap_err()
        .to_string()
        .contains("different content"));
    db.conn.execute_batch("CREATE TEMP TRIGGER snapshot_failure BEFORE INSERT ON kv WHEN NEW.ns = 'coursewareSnapshots.v1' BEGIN SELECT RAISE(ABORT, 'fixture disk failure'); END;").unwrap();
    assert!(db
        .capture_courseware_snapshot(
            root,
            &seed(),
            "snapshot-2",
            &p.source.revision,
            &p.teaching_revision,
            assets()
        )
        .is_err());
    assert!(db
        .get_courseware_snapshot(root, &p.project_id, "snapshot-2")
        .is_err());
    assert_eq!(
        serde_json::to_value(
            db.get_courseware_snapshot(root, &p.project_id, "snapshot-1")
                .unwrap()
        )
        .unwrap(),
        serde_json::to_value(original).unwrap()
    );
    assert_eq!(
        db.get_courseware_project(root, &p.project_id)
            .unwrap()
            .unwrap()
            .teaching_revision,
        p.teaching_revision
    );
}

#[test]
fn corrupt_persisted_binding_or_audio_metadata_is_rejected_on_read() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_str().unwrap();
    let db = Database::open_in_dir(dir.path()).unwrap();
    let p = ready(&db, root);
    let record = capture(&db, root, &p).unwrap();
    for field in ["mapping", "page", "audio", "source", "snapshotId"] {
        let mut value = serde_json::to_value(&record).unwrap();
        match field {
            "mapping" => value["snapshot"]["mappingRevision"] = json!("forged"),
            "page" => value["project"]["pages"][0]["pageId"] = json!("forged"),
            "audio" => value["assets"][0]["sha256"] = json!("../escape"),
            "source" => value["snapshot"]["source"]["sha256"] = json!("b".repeat(64)),
            _ => value["snapshot"]["snapshotId"] = json!("another-id"),
        }
        db.kv_set(
            SNAPSHOTS,
            &key(root, &p.project_id, "snapshot-1").unwrap(),
            &value,
        )
        .unwrap();
        assert!(
            db.get_courseware_snapshot(root, &p.project_id, "snapshot-1")
                .is_err(),
            "{field}"
        );
    }
}

#[test]
fn explicit_delay_survives_teaching_and_snapshot_and_rejects_invalid_values() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_str().unwrap();
    let db = Database::open_in_dir(dir.path()).unwrap();
    let p = ready(&db, root);
    let mut write = TeachingWrite {
        project_id: p.project_id.clone(),
        page_id: p.pages[0].page_id.clone(),
        expected_source_revision: p.source.revision.clone(),
        expected_teaching_revision: p.teaching_revision.clone(),
        actions: p.pages[0].actions.clone(),
    };
    for ms in [
        json!(-1),
        json!(0.5),
        json!(30001),
        json!("1000"),
        Value::Null,
    ] {
        write
            .actions
            .push(json!({"id":"delay","type":"delay","durationMs":ms}));
        assert!(db.write_courseware_teaching(root, &write).is_err());
        write.actions.pop();
    }
    write
        .actions
        .push(json!({"id":"delay","type":"delay","durationMs":1200}));
    let saved = db.write_courseware_teaching(root, &write).unwrap();
    let reviewed = db
        .review_courseware_page(
            root,
            &saved.project_id,
            &saved.pages[0].page_id,
            &saved.source.revision,
            &saved.teaching_revision,
        )
        .unwrap();
    let snapshot = capture(&db, root, &reviewed).unwrap();
    assert_eq!(snapshot.project.pages[0].actions[1], write.actions[1]);
}

#[test]
fn native_animation_nodes_survive_restart_and_snapshot_with_exact_source_and_order() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_str().unwrap();
    let db = Database::open_in_dir(dir.path()).unwrap();
    let p = ready(&db, root);
    let node = |index| {
        json!({"id":format!("native-{index}"),"type":"native_animation","version":1,
        "sourceSha256":p.source.sha256,"stepIndex":index})
    };
    let mut write = TeachingWrite {
        project_id: p.project_id.clone(),
        page_id: p.pages[0].page_id.clone(),
        expected_source_revision: p.source.revision.clone(),
        expected_teaching_revision: p.teaching_revision.clone(),
        actions: vec![node(0), p.pages[0].actions[0].clone(), node(1)],
    };
    for (key, value) in [
        ("version", json!(2)),
        ("stepIndex", json!(-1)),
        ("stepIndex", json!(0.5)),
        ("stepIndex", json!(200)),
        ("sourceSha256", json!("f".repeat(64))),
        ("sourceSha256", Value::Null),
        ("extra", json!(true)),
    ] {
        let mut invalid = node(0);
        invalid[key] = value;
        write.actions = vec![invalid];
        assert!(db.write_courseware_teaching(root, &write).is_err());
        assert_eq!(
            db.get_courseware_project(root, &p.project_id)
                .unwrap()
                .unwrap()
                .teaching_revision,
            p.teaching_revision
        );
    }
    for invalid in [
        vec![node(1)],
        vec![node(0), node(2)],
        vec![node(1), node(0)],
    ] {
        write.actions = invalid;
        assert!(db.write_courseware_teaching(root, &write).is_err());
    }
    write.actions = vec![node(0), p.pages[0].actions[0].clone(), node(1)];
    let saved = db.write_courseware_teaching(root, &write).unwrap();
    let reviewed = db
        .review_courseware_page(
            root,
            &saved.project_id,
            &saved.pages[0].page_id,
            &saved.source.revision,
            &saved.teaching_revision,
        )
        .unwrap();
    let frozen = capture(&db, root, &reviewed).unwrap();
    assert_eq!(frozen.project.pages[0].actions, write.actions);
    // Source review cannot silently carry source-specific ordinals into different bytes.
    assert!(super::super::reviews::portable_narration(&reviewed, true).is_err());
    drop(db);
    let db = Database::open_in_dir(dir.path()).unwrap();
    assert_eq!(
        db.get_courseware_project(root, &p.project_id)
            .unwrap()
            .unwrap()
            .pages[0]
            .actions,
        write.actions
    );
    assert_eq!(
        capture(&db, root, &reviewed).unwrap().project.pages[0].actions,
        write.actions
    );
}
