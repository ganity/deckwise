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
fn native_save_recovers_pending_tts_across_restart_without_changing_paid_requests() {
    use super::super::tts::{audio::Audio, Selection, TaskRef};
    for phase in ["unknown", "submitted", "archived", "rejected"] {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        let db = Database::open_in_dir(dir.path()).unwrap();
        let opened = db
            .open_identified_courseware_project_with_metadata(
                root,
                &seed(&"a".repeat(64)),
                "scene",
                None,
            )
            .unwrap();
        let baseline = db
            .initialize_generated_narration(
                root,
                &opened.project_id,
                &opened.source.sha256,
                "Lesson",
                &["Hello".into()],
            )
            .unwrap();
        let selection = Selection {
            intent_id: "pending".into(),
            principal_key: "d".repeat(64),
            project_id: baseline.project_id.clone(),
            page_id: baseline.pages[0].page_id.clone(),
            action_id: baseline.pages[0].actions[0]["id"].as_str().unwrap().into(),
            expected_source_revision: baseline.source.revision.clone(),
            expected_teaching_revision: baseline.teaching_revision.clone(),
            model: "tts".into(),
            voice: None,
        };
        let original =
            db.prepare_courseware_tts(root, selection.clone()).unwrap()["intent"].clone();
        if phase == "rejected" {
            db.kv_set(
                "coursewareTask.v1",
                "session",
                &json!({"teamProjectId":uuid::Uuid::new_v4().to_string()}),
            )
            .unwrap();
        }
        db.begin_courseware_tts(
            root,
            &selection.project_id,
            &selection.principal_key,
            &selection.intent_id,
            "session",
        )
        .unwrap();
        let task = TaskRef {
            task_id: "paid-task".into(),
            idempotency_key: original["idempotencyKey"].as_str().unwrap().into(),
            request_hash: original["requestHash"].as_str().unwrap().into(),
        };
        let audio = Audio {
            task_ref: task.clone(),
            sha256: "e".repeat(64),
            mime_type: "audio/mpeg".into(),
            byte_length: 100,
            duration_ms: 1000,
        };
        if matches!(phase, "submitted" | "archived") {
            db.bind_courseware_tts(
                root,
                &selection.project_id,
                &selection.principal_key,
                &selection.intent_id,
                task.clone(),
            )
            .unwrap();
        }
        if phase == "archived" {
            db.stage_courseware_tts_audio(
                root,
                &selection.project_id,
                &selection.principal_key,
                &selection.intent_id,
                audio.clone(),
            )
            .unwrap();
        }
        // An aborted export must not advance pending media's source binding.
        let cancelled = db
            .prepare_native_save(root, "/lesson.pptx", &seed(&"b".repeat(64)), &proof())
            .unwrap();
        db.resolve_native_save(
            root,
            cancelled["saveId"].as_str().unwrap(),
            &baseline.source.sha256,
        )
        .unwrap();
        assert!(db
            .get_courseware_tts(
                root,
                &selection.project_id,
                &selection.principal_key,
                &selection.intent_id
            )
            .unwrap()["intent"]["boundSource"]
            .is_null());
        let receipt = db
            .prepare_native_save(root, "/lesson.pptx", &seed(&"b".repeat(64)), &proof())
            .unwrap();
        let save_id = receipt["saveId"].as_str().unwrap().to_owned();
        drop(db);
        let db = Database::open_in_dir(dir.path()).unwrap();
        db.resolve_native_save(root, &save_id, &"b".repeat(64))
            .unwrap();
        // A second round-trip must follow the verified binding, not the original hash.
        let mut lineage = proof();
        lineage.source_sha256 = "b".repeat(64);
        lineage.output_sha256 = "c".repeat(64);
        let receipt = db
            .prepare_native_save(root, "/lesson.pptx", &seed(&"c".repeat(64)), &lineage)
            .unwrap();
        db.resolve_native_save(root, receipt["saveId"].as_str().unwrap(), &"c".repeat(64))
            .unwrap();
        let retained = db
            .get_courseware_tts(
                root,
                &selection.project_id,
                &selection.principal_key,
                &selection.intent_id,
            )
            .unwrap()["intent"]
            .clone();
        for field in [
            "selection",
            "sourceSha256",
            "request",
            "requestHash",
            "idempotencyKey",
        ] {
            assert_eq!(
                retained[field], original[field],
                "{phase}: immutable {field}"
            );
        }
        assert_eq!(retained["boundSource"]["sha256"], "c".repeat(64), "{phase}");
        if phase == "rejected" {
            db.reject_courseware_tts(
                root,
                &selection.project_id,
                &selection.principal_key,
                &selection.intent_id,
                super::super::tts::RejectedRequest {
                    idempotency_key: task.idempotency_key,
                    request_hash: task.request_hash,
                },
            )
            .unwrap();
            assert_eq!(
                db.get_courseware_tts(
                    root,
                    &selection.project_id,
                    &selection.principal_key,
                    &selection.intent_id
                )
                .unwrap()["intent"]["phase"],
                "rejected"
            );
            continue;
        }
        if phase == "unknown" {
            db.bind_courseware_tts(
                root,
                &selection.project_id,
                &selection.principal_key,
                &selection.intent_id,
                task,
            )
            .unwrap();
        }
        db.stage_courseware_tts_audio(
            root,
            &selection.project_id,
            &selection.principal_key,
            &selection.intent_id,
            audio,
        )
        .unwrap();
        let project = db
            .get_courseware_project(root, &selection.project_id)
            .unwrap()
            .unwrap();
        let adopted = db
            .adopt_courseware_tts_audio(
                root,
                &selection.project_id,
                &selection.principal_key,
                &selection.intent_id,
                &project.teaching_revision,
                None,
            )
            .unwrap();
        assert_eq!(
            adopted.pages[0].actions[0]["audioAssetId"],
            format!("tts-{}", "e".repeat(64))
        );
    }
}

#[test]
fn native_save_does_not_rebind_stale_speech_or_copied_pages_and_keeps_adoption_guards() {
    use super::super::tts::{audio::Audio, Selection, TaskRef};
    for change in ["text", "page", "locked", "prepared"] {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        let db = Database::open_in_dir(dir.path()).unwrap();
        let opened = db
            .open_identified_courseware_project_with_metadata(
                root,
                &seed(&"a".repeat(64)),
                "scene",
                None,
            )
            .unwrap();
        let baseline = db
            .initialize_generated_narration(
                root,
                &opened.project_id,
                &opened.source.sha256,
                "Lesson",
                &["Hello".into()],
            )
            .unwrap();
        let selection = Selection {
            intent_id: "pending".into(),
            principal_key: "d".repeat(64),
            project_id: baseline.project_id.clone(),
            page_id: baseline.pages[0].page_id.clone(),
            action_id: baseline.pages[0].actions[0]["id"].as_str().unwrap().into(),
            expected_source_revision: baseline.source.revision.clone(),
            expected_teaching_revision: baseline.teaching_revision.clone(),
            model: "tts".into(),
            voice: None,
        };
        let prepared = db.prepare_courseware_tts(root, selection.clone()).unwrap();
        if change != "prepared" {
            db.begin_courseware_tts(
                root,
                &selection.project_id,
                &selection.principal_key,
                &selection.intent_id,
                "session",
            )
            .unwrap();
            let task = TaskRef {
                task_id: "task".into(),
                idempotency_key: prepared["intent"]["idempotencyKey"]
                    .as_str()
                    .unwrap()
                    .into(),
                request_hash: prepared["intent"]["requestHash"].as_str().unwrap().into(),
            };
            db.bind_courseware_tts(
                root,
                &selection.project_id,
                &selection.principal_key,
                &selection.intent_id,
                task.clone(),
            )
            .unwrap();
            db.stage_courseware_tts_audio(
                root,
                &selection.project_id,
                &selection.principal_key,
                &selection.intent_id,
                Audio {
                    task_ref: task,
                    sha256: "e".repeat(64),
                    mime_type: "audio/mpeg".into(),
                    byte_length: 100,
                    duration_ms: 1000,
                },
            )
            .unwrap();
        }
        let mut lineage = proof();
        if change == "text" {
            let mut actions = baseline.pages[0].actions.clone();
            actions[0]["text"] = json!("Changed");
            db.write_courseware_teaching(
                root,
                &TeachingWrite {
                    project_id: baseline.project_id.clone(),
                    page_id: selection.page_id.clone(),
                    expected_source_revision: baseline.source.revision.clone(),
                    expected_teaching_revision: baseline.teaching_revision.clone(),
                    actions,
                },
            )
            .unwrap();
        } else if change == "page" {
            lineage.page_tokens[0] = "copied-page".into();
        } else if change == "locked" {
            db.set_courseware_page_lock(
                root,
                &baseline.project_id,
                &selection.page_id,
                &baseline.source.revision,
                &baseline.teaching_revision,
                true,
            )
            .unwrap();
        }
        let receipt = db
            .prepare_native_save(root, "/lesson.pptx", &seed(&"b".repeat(64)), &lineage)
            .unwrap();
        db.resolve_native_save(root, receipt["saveId"].as_str().unwrap(), &"b".repeat(64))
            .unwrap();
        let retained = db
            .get_courseware_tts(
                root,
                &selection.project_id,
                &selection.principal_key,
                &selection.intent_id,
            )
            .unwrap();
        assert_eq!(
            retained["intent"]["boundSource"].is_null(),
            change != "locked",
            "{change}"
        );
        let project = db
            .get_courseware_project(root, &selection.project_id)
            .unwrap()
            .unwrap();
        assert!(
            db.adopt_courseware_tts_audio(
                root,
                &selection.project_id,
                &selection.principal_key,
                &selection.intent_id,
                &project.teaching_revision,
                None
            )
            .is_err(),
            "{change}"
        );
        assert!(db
            .get_courseware_tts(
                root,
                &selection.project_id,
                &"f".repeat(64),
                &selection.intent_id
            )
            .is_err());
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


#[test]
fn native_save_rebinds_durable_workflow_without_reauthorizing_execution() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_str().unwrap();
    let db = Database::open_in_dir(dir.path()).unwrap();
    let project = db
        .open_identified_courseware_project(root, &seed(&"a".repeat(64)))
        .unwrap();
    let session =
        crate::sessions::create_session(&db, None, None, None, None, Some(root.into())).unwrap();
    let turn = crate::sessions::begin_turn(&db, &session.id, None, None).unwrap();
    let checkpoint = super::super::workflow::Checkpoint {
        revision: 1,
        project_id: project.project_id.clone(),
        source_sha256: project.source.sha256.clone(),
        status: "running".into(),
        repair_attempts: std::collections::BTreeMap::from([("c".repeat(64), 2)]),
        last_resume: Some("d".repeat(64)),
    };
    db.save_courseware_workflow_checkpoint(root, &session.id, &turn, 0, &checkpoint)
        .unwrap();
    let receipt = db
        .prepare_native_save(root, "slides.pptx", &seed(&"b".repeat(64)), &proof())
        .unwrap();
    let save_id = receipt["saveId"].as_str().unwrap();
    assert_eq!(
        db.courseware_workflow_checkpoint(root, &session.id, &project.project_id)
            .unwrap()
            .unwrap()
            .source_sha256,
        "a".repeat(64)
    );
    db.resolve_native_save(root, save_id, &"b".repeat(64))
        .unwrap();
    db.resolve_native_save(root, save_id, &"b".repeat(64))
        .unwrap();
    crate::sessions::end_turn(&db, &turn, "aborted", None, None, false).unwrap();
    drop(db);
    let db = Database::open_in_dir(dir.path()).unwrap();
    let rebound = db
        .courseware_workflow_checkpoint(root, &session.id, &project.project_id)
        .unwrap()
        .unwrap();
    assert_eq!(rebound.source_sha256, "b".repeat(64));
    assert_eq!(rebound.revision, 2);
    assert_eq!(rebound.repair_attempts, checkpoint.repair_attempts);
    assert!(rebound.last_resume.is_none());
    assert!(db
        .save_courseware_workflow_checkpoint(
            root,
            &session.id,
            &turn,
            2,
            &super::super::workflow::Checkpoint {
                revision: 3,
                ..rebound
            }
        )
        .is_err());
}

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
