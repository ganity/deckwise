use super::*;
use serde_json::json;

fn setup(db: &Database, root: &str) -> (CoursewareProject, Selection, Audio) {
    let raw: Value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../packages/shared/src/courseware-contract.fixtures/accepted.json"
    )))
    .unwrap();
    let project: CoursewareProject = serde_json::from_value(raw["project"].clone()).unwrap();
    db.create_courseware_project(root, &project).unwrap();
    let selection = Selection {
        intent_id: "intent".into(),
        principal_key: "a".repeat(64),
        project_id: project.project_id.clone(),
        page_id: project.pages[0].page_id.clone(),
        action_id: "narration-0".into(),
        expected_source_revision: project.source.revision.clone(),
        expected_teaching_revision: project.teaching_revision.clone(),
        model: "courseware-tts-v1".into(),
        voice: None,
    };
    let prepared = db.prepare_courseware_tts(root, selection.clone()).unwrap();
    db.begin_courseware_tts(
        root,
        &selection.project_id,
        &selection.principal_key,
        &selection.intent_id,
        "test-session",
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
    let audio = Audio {
        task_ref: task,
        sha256: "b".repeat(64),
        mime_type: "audio/wav".into(),
        byte_length: 1644,
        duration_ms: 100,
    };
    (project, selection, audio)
}
fn stage(db: &Database, root: &str, s: &Selection, a: Audio) -> Result<Record> {
    db.stage_courseware_tts_audio(root, &s.project_id, &s.principal_key, &s.intent_id, a)
}
fn get(db: &Database, root: &str, s: &Selection) -> Result<Record> {
    db.get_courseware_tts_audio(root, &s.project_id, &s.principal_key, &s.intent_id)
}
fn adopt(
    db: &Database,
    root: &str,
    s: &Selection,
    rev: &str,
    old: Option<&str>,
) -> Result<CoursewareProject> {
    db.adopt_courseware_tts_audio(
        root,
        &s.project_id,
        &s.principal_key,
        &s.intent_id,
        rev,
        old,
    )
}
fn write(
    db: &Database,
    root: &str,
    p: &CoursewareProject,
    actions: Vec<Value>,
) -> CoursewareProject {
    db.write_courseware_teaching(
        root,
        &TeachingWrite {
            project_id: p.project_id.clone(),
            page_id: p.pages[0].page_id.clone(),
            expected_source_revision: p.source.revision.clone(),
            expected_teaching_revision: p.teaching_revision.clone(),
            actions,
        },
    )
    .unwrap()
}

#[test]
fn receipt_is_private_immutable_and_durable_without_teaching_mutation() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_str().unwrap();
    let path = dir.path().join("db.sqlite");
    let db = Database::open(&path).unwrap();
    let (p, s, a) = setup(&db, root);
    let first = stage(&db, root, &s, a.clone()).unwrap();
    assert!(first.adopted_teaching_revision.is_none());
    assert_eq!(
        serde_json::to_value(stage(&db, root, &s, a.clone()).unwrap()).unwrap(),
        serde_json::to_value(&first).unwrap()
    );
    let mut changed = a.clone();
    changed.sha256 = "c".repeat(64);
    assert!(stage(&db, root, &s, changed).is_err());
    let mut bad = s.clone();
    bad.principal_key = "c".repeat(64);
    assert!(get(&db, root, &bad).is_err());
    assert!(get(&db, "other", &s).is_err());
    let mut forged = a;
    forged.task_ref.task_id = "foreign".into();
    assert!(stage(&db, root, &s, forged).is_err());
    assert_eq!(
        db.get_courseware_project(root, &p.project_id)
            .unwrap()
            .unwrap()
            .teaching_revision,
        p.teaching_revision
    );
    drop(db);
    let db = Database::open(&path).unwrap();
    assert_eq!(
        serde_json::to_value(get(&db, root, &s).unwrap()).unwrap(),
        serde_json::to_value(first).unwrap()
    );
}

#[test]
fn adoption_changes_only_selected_audio_and_replays_after_restart() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_str().unwrap();
    let path = dir.path().join("db.sqlite");
    let db = Database::open(&path).unwrap();
    let (p, s, a) = setup(&db, root);
    stage(&db, root, &s, a.clone()).unwrap();
    let mut actions = p.pages[0].actions.clone();
    actions[0]["pauseAfterMs"] = json!(850);
    actions[0]["customCue"] = json!({"keep":true});
    actions.push(json!({"id":"spot","type":"spotlight","elementId":"keep"}));
    let edited = write(&db, root, &p, actions.clone());
    assert!(adopt(&db, root, &s, &p.teaching_revision, None).is_err());
    let saved = adopt(&db, root, &s, &edited.teaching_revision, None).unwrap();
    let expected = a.asset().id;
    actions[0]["audioAssetId"] = json!(expected);
    assert_eq!(saved.pages[0].actions, actions);
    assert_eq!(saved.pages[0].review_state, "review");
    assert_ne!(saved.teaching_revision, edited.teaching_revision);
    assert_eq!(
        serde_json::to_value(&saved.pages[1..]).unwrap(),
        serde_json::to_value(&p.pages[1..]).unwrap()
    );
    assert_eq!(saved.source.sha256, p.source.sha256);
    drop(db);
    let db = Database::open(&path).unwrap();
    let replay = adopt(&db, root, &s, &edited.teaching_revision, None).unwrap();
    assert_eq!(replay.teaching_revision, saved.teaching_revision);
    assert_eq!(
        get(&db, root, &s).unwrap().adopted_teaching_revision,
        Some(saved.teaching_revision)
    );
}

#[test]
fn revoice_preserves_cues_and_verified_audio_needs_no_page_confirmation() {
    use crate::courseware::{identity::SavedSourceIdentity, SavedProjectSeed};
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_str().unwrap();
    let path = dir.path().join("revoice.sqlite");
    let db = Database::open(&path).unwrap();
    let identity = SavedSourceIdentity::parse(include_bytes!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/src/courseware/identity/fixtures/identity.json"
    )))
    .unwrap();
    let seed = SavedProjectSeed {
        project_id: "revoice-cue-review".into(),
        sha256: identity.value()["sourceSha256"].as_str().unwrap().into(),
        pages: 1,
        identity: Some(identity),
    };
    let initial = db.open_identified_courseware_project(root, &seed).unwrap();
    let focus_id = db
        .courseware_project_context(root, &initial.project_id)
        .unwrap()["mapping"]["pages"][0]["objects"][0]["objectId"]
        .as_str()
        .unwrap()
        .to_owned();
    let speech = vec![
        json!({"id":"narration-0","type":"speech","text":"Look at the square.",
        "attention":{"type":"highlight","objectIds":[focus_id]}}),
    ];
    let mut p = write(&db, root, &initial, speech);
    let receipt = |p: &CoursewareProject, name: &str, digest: char| {
        let selection = Selection {
            intent_id: name.into(),
            principal_key: "a".repeat(64),
            project_id: p.project_id.clone(),
            page_id: p.pages[0].page_id.clone(),
            action_id: "narration-0".into(),
            expected_source_revision: p.source.revision.clone(),
            expected_teaching_revision: p.teaching_revision.clone(),
            model: "courseware-tts-v1".into(),
            voice: None,
        };
        let prepared = db.prepare_courseware_tts(root, selection.clone()).unwrap();
        db.begin_courseware_tts(
            root,
            &p.project_id,
            &selection.principal_key,
            name,
            "test-session",
        )
        .unwrap();
        let task = TaskRef {
            task_id: format!("task-{name}"),
            idempotency_key: prepared["intent"]["idempotencyKey"]
                .as_str()
                .unwrap()
                .into(),
            request_hash: prepared["intent"]["requestHash"].as_str().unwrap().into(),
        };
        db.bind_courseware_tts(
            root,
            &p.project_id,
            &selection.principal_key,
            name,
            task.clone(),
        )
        .unwrap();
        let audio = Audio {
            task_ref: task,
            sha256: digest.to_string().repeat(64),
            mime_type: "audio/wav".into(),
            byte_length: 1644,
            duration_ms: if name == "old" { 1000 } else { 2000 },
        };
        stage(&db, root, &selection, audio.clone()).unwrap();
        (selection, audio)
    };
    let (old_intent, old_audio) = receipt(&p, "old", 'b');
    assert!(p.pages[0].actions[0].get("visualCues").is_none());
    p = adopt(&db, root, &old_intent, &p.teaching_revision, None).unwrap();
    assert!(p.pages[0].actions[0].get("attention").is_none());
    assert_eq!(
        p.pages[0].actions[0]["visualCues"],
        json!([
            {"id":"focus-narration-0","atMs":0,"endMs":old_audio.duration_ms,
             "effect":{"type":"highlight","elementIds":[focus_id]}}
        ])
    );
    let cues = json!([
        {"id":"old-highlight","atMs":100,"endMs":300,"effect":{"type":"highlight","elementIds":["square"]}},
        {"id":"old-spotlight","atMs":400,"endMs":800,"effect":{"type":"spotlight","elementId":"square"}}
    ]);
    let mut actions = p.pages[0].actions.clone();
    actions[0]["visualCues"] = cues.clone();
    p = write(&db, root, &p, actions);
    p = db
        .review_courseware_page(
            root,
            &p.project_id,
            &p.pages[0].page_id,
            &p.source.revision,
            &p.teaching_revision,
        )
        .unwrap();
    let old_snapshot = db
        .capture_courseware_snapshot(
            root,
            &seed,
            "before-revoice",
            &p.source.revision,
            &p.teaching_revision,
            vec![old_audio.asset()],
        )
        .unwrap();
    let old_frozen = serde_json::to_value(&old_snapshot).unwrap();
    let before_candidate = serde_json::to_value(&p).unwrap();
    let (new_intent, new_audio) = receipt(&p, "new", 'c');
    assert_eq!(
        serde_json::to_value(
            db.get_courseware_project(root, &p.project_id)
                .unwrap()
                .unwrap()
        )
        .unwrap(),
        before_candidate
    );
    let adopted = adopt(
        &db,
        root,
        &new_intent,
        &p.teaching_revision,
        Some(&old_audio.asset().id),
    )
    .unwrap();
    assert_eq!(adopted.pages[0].actions[0]["visualCues"], cues);
    assert_eq!(
        adopted.pages[0].actions[0]["audioAssetId"],
        new_audio.asset().id
    );
    assert_eq!(adopted.pages[0].review_state, "review");
    let frozen = db
        .capture_courseware_snapshot(
            root,
            &seed,
            "unreviewed-revoice",
            &adopted.source.revision,
            &adopted.teaching_revision,
            vec![new_audio.asset()],
        )
        .unwrap();
    assert_eq!(frozen.project.pages[0].actions, adopted.pages[0].actions);
    assert!(db
        .review_courseware_page(
            root,
            &p.project_id,
            &p.pages[0].page_id,
            &p.source.revision,
            &p.teaching_revision
        )
        .is_err());
    drop(db);
    let db = Database::open(&path).unwrap();
    let persisted = db
        .get_courseware_project(root, &p.project_id)
        .unwrap()
        .unwrap();
    assert_eq!(persisted.pages[0].review_state, "review");
    assert_eq!(
        serde_json::to_value(
            db.get_courseware_snapshot(root, &p.project_id, "before-revoice")
                .unwrap()
        )
        .unwrap(),
        old_frozen
    );
    let reviewed = db
        .review_courseware_page(
            root,
            &p.project_id,
            &p.pages[0].page_id,
            &persisted.source.revision,
            &persisted.teaching_revision,
        )
        .unwrap();
    let next = db
        .capture_courseware_snapshot(
            root,
            &seed,
            "after-reviewed-revoice",
            &reviewed.source.revision,
            &reviewed.teaching_revision,
            vec![new_audio.asset()],
        )
        .unwrap();
    assert_eq!(next.project.pages[0].actions[0]["visualCues"], cues);
    assert_eq!(
        next.project.pages[0].actions[0]["audioAssetId"],
        new_audio.asset().id
    );
    assert_eq!(
        serde_json::to_value(
            db.get_courseware_snapshot(root, &p.project_id, "before-revoice")
                .unwrap()
        )
        .unwrap(),
        old_frozen
    );
}

#[test]
fn locks_edited_speech_changed_source_and_replaced_audio_reject_without_writes() {
    for case in ["lock", "text", "source", "audio", "legacy"] {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        let db = Database::open(&dir.path().join("db.sqlite")).unwrap();
        let (p, s, a) = setup(&db, root);
        stage(&db, root, &s, a).unwrap();
        let mut changed = p.clone();
        match case {
            "lock" => {
                changed = db
                    .set_courseware_page_lock(
                        root,
                        &p.project_id,
                        &p.pages[0].page_id,
                        &p.source.revision,
                        &p.teaching_revision,
                        true,
                    )
                    .unwrap();
            }
            "source" => {
                let mut v = serde_json::to_value(&p).unwrap();
                v["source"]["sha256"] = json!("f".repeat(64));
                db.conn
                    .execute(
                        "UPDATE kv SET value_json=?1 WHERE ns=?2",
                        params![serde_json::to_string(&v).unwrap(), NAMESPACE],
                    )
                    .unwrap();
            }
            _ => {
                let mut actions = p.pages[0].actions.clone();
                if case == "text" {
                    actions[0]["text"] = json!("Edited")
                } else if case == "audio" {
                    actions[0]["audioAssetId"] = json!("new-audio")
                } else {
                    actions[0]["audioUrl"] = json!("private-legacy")
                };
                changed = write(&db, root, &p, actions);
            }
        }
        let before = db
            .get_courseware_project(root, &p.project_id)
            .unwrap()
            .unwrap();
        assert!(
            adopt(&db, root, &s, &changed.teaching_revision, None).is_err(),
            "{case}"
        );
        assert_eq!(
            serde_json::to_value(db.get_courseware_project(root, &p.project_id).unwrap()).unwrap(),
            serde_json::to_value(Some(before)).unwrap()
        );
        assert!(get(&db, root, &s)
            .unwrap()
            .adopted_teaching_revision
            .is_none());
    }
}

#[test]
fn parallel_speech_intents_adopt_with_fresh_cas_without_another_paid_request() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_str().unwrap();
    let db = Database::open(&dir.path().join("db.sqlite")).unwrap();
    let (p, s, a) = setup(&db, root);
    let mut actions = p.pages[0].actions.clone();
    actions.push(json!({"id":"speech-two","type":"speech","text":"Good!"}));
    let p = write(&db, root, &p, actions);
    let second = Selection {
        intent_id: "intent-two".into(),
        action_id: "speech-two".into(),
        expected_teaching_revision: p.teaching_revision.clone(),
        ..s.clone()
    };
    let prepared = db.prepare_courseware_tts(root, second.clone()).unwrap();
    db.begin_courseware_tts(
        root,
        &second.project_id,
        &second.principal_key,
        &second.intent_id,
        "test-session",
    )
    .unwrap();
    let task = TaskRef {
        task_id: "task-two".into(),
        idempotency_key: prepared["intent"]["idempotencyKey"]
            .as_str()
            .unwrap()
            .into(),
        request_hash: prepared["intent"]["requestHash"].as_str().unwrap().into(),
    };
    db.bind_courseware_tts(
        root,
        &second.project_id,
        &second.principal_key,
        &second.intent_id,
        task.clone(),
    )
    .unwrap();
    stage(&db, root, &s, a.clone()).unwrap();
    stage(
        &db,
        root,
        &second,
        Audio {
            task_ref: task,
            sha256: "c".repeat(64),
            ..a
        },
    )
    .unwrap();
    let one = adopt(&db, root, &s, &p.teaching_revision, None).unwrap();
    assert!(adopt(&db, root, &second, &p.teaching_revision, None).is_err());
    let two = adopt(&db, root, &second, &one.teaching_revision, None).unwrap();
    assert!(two.pages[0]
        .actions
        .iter()
        .all(|a| a["audioAssetId"].is_string()));
}

#[test]
fn ignored_sql_writes_roll_back_both_teaching_and_receipt() {
    for namespace in [AUDIO, NAMESPACE] {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        let db = Database::open(&dir.path().join("db.sqlite")).unwrap();
        let (p, s, a) = setup(&db, root);
        stage(&db, root, &s, a).unwrap();
        db.conn.execute_batch(&format!("CREATE TRIGGER ignore_audio BEFORE UPDATE ON kv WHEN NEW.ns='{namespace}' BEGIN SELECT RAISE(IGNORE); END;")).unwrap();
        assert!(adopt(&db, root, &s, &p.teaching_revision, None).is_err());
        assert_eq!(
            db.get_courseware_project(root, &p.project_id)
                .unwrap()
                .unwrap()
                .teaching_revision,
            p.teaching_revision
        );
        assert!(get(&db, root, &s)
            .unwrap()
            .adopted_teaching_revision
            .is_none());
    }
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_str().unwrap();
    let db = Database::open(&dir.path().join("db.sqlite")).unwrap();
    let (_, s, a) = setup(&db, root);
    db.conn.execute_batch("CREATE TRIGGER ignore_audio BEFORE INSERT ON kv WHEN NEW.ns='coursewareTtsAudio.v1' BEGIN SELECT RAISE(IGNORE); END;").unwrap();
    assert!(stage(&db, root, &s, a).is_err());
    assert!(get(&db, root, &s).is_err());
}

#[test]
fn corrupt_or_invalid_audio_metadata_is_never_adopted() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_str().unwrap();
    let db = Database::open(&dir.path().join("db.sqlite")).unwrap();
    let (p, s, a) = setup(&db, root);
    for field in ["sha256", "mimeType", "byteLength", "durationMs"] {
        let mut value = serde_json::to_value(&a).unwrap();
        value[field] = match field {
            "sha256" => json!("../escape"),
            "mimeType" => json!("text/html"),
            _ => json!(0),
        };
        let bad = serde_json::from_value(value).unwrap();
        assert!(stage(&db, root, &s, bad).is_err());
    }
    stage(&db, root, &s, a).unwrap();
    let mut corrupt = serde_json::to_value(get(&db, root, &s).unwrap()).unwrap();
    corrupt["audio"]["taskRef"]["taskId"] = json!("foreign");
    db.conn
        .execute(
            "UPDATE kv SET value_json=?1 WHERE ns=?2",
            params![serde_json::to_string(&corrupt).unwrap(), AUDIO],
        )
        .unwrap();
    assert!(get(&db, root, &s).is_err());
    assert!(adopt(&db, root, &s, &p.teaching_revision, None).is_err());
}

#[test]
fn checkpoint_failures_recover_receipts_and_adoption_without_second_mutation() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_str().unwrap();
    let path = dir.path().join("db.sqlite");
    let db = Database::open(&path).unwrap();
    let (p, s, a) = setup(&db, root);
    db.conn.execute_batch("PRAGMA busy_timeout=1").unwrap();
    db.source_adoption_barrier().unwrap();
    let reader = rusqlite::Connection::open(&path).unwrap();
    reader
        .execute_batch("BEGIN; SELECT count(*) FROM kv;")
        .unwrap();
    assert!(stage(&db, root, &s, a.clone())
        .unwrap_err()
        .to_string()
        .contains("checkpoint is incomplete"));
    assert!(get(&db, root, &s)
        .unwrap()
        .adopted_teaching_revision
        .is_none());
    reader.execute_batch("COMMIT").unwrap();
    stage(&db, root, &s, a).unwrap();
    reader
        .execute_batch("BEGIN; SELECT count(*) FROM kv;")
        .unwrap();
    assert!(adopt(&db, root, &s, &p.teaching_revision, None)
        .unwrap_err()
        .to_string()
        .contains("checkpoint is incomplete"));
    let revision = db
        .get_courseware_project(root, &p.project_id)
        .unwrap()
        .unwrap()
        .teaching_revision;
    assert_eq!(
        get(&db, root, &s).unwrap().adopted_teaching_revision,
        Some(revision.clone())
    );
    reader.execute_batch("COMMIT").unwrap();
    drop(reader);
    drop(db);
    let db = Database::open(&path).unwrap();
    assert_eq!(
        adopt(&db, root, &s, &p.teaching_revision, None)
            .unwrap()
            .teaching_revision,
        revision
    );
    db.kv_set(
        "coursewareSourceAdoptionLocks.v1",
        &storage_key(root, "source-adoption").unwrap(),
        &json!("pending"),
    )
    .unwrap();
    assert!(adopt(&db, root, &s, &revision, None).is_err());
    assert!(get(&db, root, &s).is_ok());
}

#[test]
fn replacing_previous_audio_requires_exact_id_and_old_receipts_cannot_restore_it() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_str().unwrap();
    let db = Database::open(&dir.path().join("db.sqlite")).unwrap();
    let (p, s, a) = setup(&db, root);
    stage(&db, root, &s, a).unwrap();
    let mut actions = p.pages[0].actions.clone();
    actions[0]["audioAssetId"] = json!("previous-audio");
    let p = write(&db, root, &p, actions);
    assert!(adopt(&db, root, &s, &p.teaching_revision, None).is_err());
    assert!(adopt(&db, root, &s, &p.teaching_revision, Some("different")).is_err());
    let saved = adopt(&db, root, &s, &p.teaching_revision, Some("previous-audio")).unwrap();
    let mut actions = saved.pages[0].actions.clone();
    actions[0]["audioAssetId"] = json!("replacement-after-adoption");
    let replaced = write(&db, root, &saved, actions);
    assert!(adopt(
        &db,
        root,
        &s,
        &replaced.teaching_revision,
        Some("replacement-after-adoption")
    )
    .is_err());
    assert_eq!(
        db.get_courseware_project(root, &s.project_id)
            .unwrap()
            .unwrap()
            .teaching_revision,
        replaced.teaching_revision
    );
}

#[test]
fn missing_focus_repair_reuses_verified_audio_and_preserves_all_existing_actions() {
    use crate::courseware::{identity::SavedSourceIdentity, SavedProjectSeed};
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_str().unwrap();
    let db = Database::open_in_dir(dir.path()).unwrap();
    let identity = SavedSourceIdentity::parse(include_bytes!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/src/courseware/identity/fixtures/identity.json"
    )))
    .unwrap();
    let seed = SavedProjectSeed {
        project_id: "focus-repair".into(),
        sha256: identity.value()["sourceSha256"].as_str().unwrap().into(),
        pages: 1,
        identity: Some(identity),
    };
    let initial = db
        .open_identified_courseware_project_with_metadata(root, &seed, "scene", None)
        .unwrap();
    let mapping = serde_json::from_value(json!({"pages":[{"slideId":"scene-001","sourceHash":format!("sha256:{}", "a".repeat(64)), "slidePart":"ppt/slides/slide1.xml",
        "teaching":{"pageType":"slide","phase":"explore","objective":"Greet","durationSeconds":30,"requiredObjects":[]},
        "elements":seed.identity.as_ref().unwrap().value()["pages"][0]["objects"].as_array().unwrap().iter().enumerate().map(|(i,o)|
            json!({"elementId":format!("object-{i}"),"objectName":format!("object-{i}"),"sourceShapeId":o["sourceShapeId"],"type":if o["type"]=="image" {"image_layer"} else {"native_shape"}})).collect::<Vec<_>>()}]})).unwrap();
    db.initialize_generated_scene_objects(root, &initial, &mapping)
        .unwrap();
    let target = db
        .courseware_project_context(root, &initial.project_id)
        .unwrap()["mapping"]["pages"][0]["objects"][0]["objectId"]
        .as_str()
        .unwrap()
        .to_owned();
    let project = write(
        &db,
        root,
        &initial,
        vec![
            json!({"id":"narration-0","type":"speech","text":"Hello.","source":"generated","pauseAfterMs":1000}),
        ],
    );
    let selection = Selection {
        intent_id: "original".into(),
        principal_key: "a".repeat(64),
        project_id: project.project_id.clone(),
        page_id: project.pages[0].page_id.clone(),
        action_id: "narration-0".into(),
        expected_source_revision: project.source.revision.clone(),
        expected_teaching_revision: project.teaching_revision.clone(),
        model: "courseware-tts-v1".into(),
        voice: None,
    };
    let prepared = db.prepare_courseware_tts(root, selection.clone()).unwrap();
    db.begin_courseware_tts(
        root,
        &project.project_id,
        &selection.principal_key,
        "original",
        "test-session",
    )
    .unwrap();
    let task = TaskRef {
        task_id: "original-task".into(),
        idempotency_key: prepared["intent"]["idempotencyKey"]
            .as_str()
            .unwrap()
            .into(),
        request_hash: prepared["intent"]["requestHash"].as_str().unwrap().into(),
    };
    db.bind_courseware_tts(
        root,
        &project.project_id,
        &selection.principal_key,
        "original",
        task.clone(),
    )
    .unwrap();
    let audio = Audio {
        task_ref: task,
        sha256: "b".repeat(64),
        mime_type: "audio/wav".into(),
        byte_length: 1644,
        duration_ms: 1234,
    };
    stage(&db, root, &selection, audio).unwrap();
    let project = adopt(&db, root, &selection, &project.teaching_revision, None).unwrap();
    let original = project.pages[0].actions[0].clone();
    let mut proposed = original.clone();
    proposed["attention"] = json!({"type":"highlight","objectIds":[target]});
    let request = TeachingWrite {
        project_id: project.project_id.clone(),
        page_id: project.pages[0].page_id.clone(),
        expected_source_revision: project.source.revision.clone(),
        expected_teaching_revision: project.teaching_revision.clone(),
        actions: vec![proposed],
    };
    let repaired = db
        .repair_required_teaching(root, &seed, &project, &request)
        .unwrap();
    let mut speech = repaired.pages[0].actions[0].clone();
    assert_eq!(speech["visualCues"][0]["endMs"], 1234);
    assert_eq!(
        speech["visualCues"][0]["effect"]["elementIds"],
        json!([target])
    );
    speech.as_object_mut().unwrap().remove("visualCues");
    assert_eq!(speech, original);
    assert!(db
        .repair_required_teaching(root, &seed, &project, &request)
        .is_err());
    let mut overwrite = request.clone();
    overwrite.expected_teaching_revision = repaired.teaching_revision.clone();
    assert!(db
        .repair_required_teaching(root, &seed, &repaired, &overwrite)
        .is_err());
    let mut addition = repaired.pages[0].actions[0].clone();
    addition.as_object_mut().unwrap().remove("visualCues");
    addition["attention"] = json!({"type":"spotlight","objectIds":[target],"animation":"pulse"});
    overwrite.actions = vec![addition];
    let extended = db.repair_required_teaching(root, &seed, &repaired, &overwrite).unwrap();
    let effects = extended.pages[0].actions[0]["visualCues"].as_array().unwrap();
    assert_eq!(effects.len(), 3);
    assert_eq!(effects[0], repaired.pages[0].actions[0]["visualCues"][0]);
    assert_eq!(effects[1]["effect"]["type"], "element_animation");
    assert_eq!(effects[2]["endMs"], 1234);
    assert_ne!(effects[0]["id"], effects[2]["id"]);
    let mut preserved = extended.pages[0].actions[0].clone();
    preserved.as_object_mut().unwrap().remove("visualCues");
    assert_eq!(preserved, original);
    assert_eq!(
        db.get_courseware_project(root, &project.project_id)
            .unwrap()
            .unwrap()
            .teaching_revision,
        extended.teaching_revision
    );
}
