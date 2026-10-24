use super::*;
use serde_json::json;

fn setup(db: &Database, workspace: &str) -> (CoursewareProject, Selection) {
    let raw: Value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../packages/shared/src/courseware-contract.fixtures/accepted.json"
    )))
    .unwrap();
    let project: CoursewareProject = serde_json::from_value(raw["project"].clone()).unwrap();
    db.create_courseware_project(workspace, &project).unwrap();
    let selection = Selection {
        intent_id: "intent-1".into(),
        principal_key: "a".repeat(64),
        project_id: project.project_id.clone(),
        page_id: project.pages[0].page_id.clone(),
        action_id: "narration-0".into(),
        expected_source_revision: project.source.revision.clone(),
        expected_teaching_revision: project.teaching_revision.clone(),
        model: "courseware-tts-v1".into(),
        voice: Some("alloy".into()),
    };
    (project, selection)
}

fn get(db: &Database, workspace: &str, s: &Selection) -> Value {
    db.get_courseware_tts(workspace, &s.project_id, &s.principal_key, &s.intent_id)
        .unwrap()
}

fn begin(db: &Database, workspace: &str, s: &Selection) -> Result<Value> {
    db.begin_courseware_tts(workspace, &s.project_id, &s.principal_key, &s.intent_id, "test-session")
}

fn task(view: &Value) -> TaskRef {
    TaskRef {
        task_id: "remote-task-1".into(),
        idempotency_key: view["intent"]["idempotencyKey"].as_str().unwrap().into(),
        request_hash: view["intent"]["requestHash"].as_str().unwrap().into(),
    }
}

#[test]
fn durable_request_replays_across_restart_and_explicit_regeneration_gets_a_new_key() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("pi.sqlite");
    let workspace = dir.path().join("中文课件");
    std::fs::create_dir(&workspace).unwrap();
    let root = workspace.to_str().unwrap();
    let (selection, original, submitted);
    {
        let db = Database::open(&path).unwrap();
        (original, selection) = setup(&db, root);
        let first = db.prepare_courseware_tts(root, selection.clone()).unwrap();
        assert_eq!(first["intent"]["request"]["input"], "Look at the square.");
        assert_eq!(first["intent"]["phase"], "prepared");
        assert_eq!(
            db.prepare_courseware_tts(root, selection.clone()).unwrap(),
            first
        );
        let uncertain = begin(&db, root, &selection).unwrap();
        assert_eq!(uncertain["intent"]["phase"], "submission-unknown");
        assert!(begin(&db, root, &selection).is_err());
        let reference = task(&uncertain);
        submitted = db
            .bind_courseware_tts(
                root,
                &selection.project_id,
                &selection.principal_key,
                &selection.intent_id,
                reference.clone(),
            )
            .unwrap();
        assert_eq!(
            db.bind_courseware_tts(
                root,
                &selection.project_id,
                &selection.principal_key,
                &selection.intent_id,
                reference
            )
            .unwrap(),
            submitted
        );
        assert!(begin(&db, root, &selection).is_err());
        assert_eq!(
            serde_json::to_value(
                db.get_courseware_project(root, &selection.project_id)
                    .unwrap()
                    .unwrap()
            )
            .unwrap(),
            serde_json::to_value(&original).unwrap()
        );
    }
    let db = Database::open(&path).unwrap();
    assert_eq!(get(&db, root, &selection), submitted);
    let mut regenerate = selection.clone();
    regenerate.intent_id = "explicit-regeneration".into();
    let fresh = db.prepare_courseware_tts(root, regenerate).unwrap();
    assert_ne!(
        fresh["intent"]["idempotencyKey"],
        submitted["intent"]["idempotencyKey"]
    );
    assert_eq!(
        fresh["intent"]["requestHash"],
        submitted["intent"]["requestHash"]
    );
    let list = db
        .list_courseware_tts(root, &selection.project_id, &selection.principal_key)
        .unwrap();
    assert_eq!(list.len(), 2);
    assert!(list
        .iter()
        .all(|v| v.get("request").is_none() && v["audioReady"] == false));
}

#[test]
fn java_hash_matches_retained_c_response_and_bilingual_utf16_lengths() {
    let request = Request {
        kind: "tts".into(),
        model: "courseware-tts-v1".into(),
        input: "c1 local smoke".into(),
        voice: Some("alloy".into()),
    };
    let fixture: Value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../apps/desktop/test/fixtures/courseware-media-ready.json"
    )))
    .unwrap();
    assert_eq!(request_hash(&request), fixture["requestHash"]);
    let bilingual = Request {
        input: "Good! 小朋友😀".into(),
        voice: Some("teacher_1".into()),
        ..request.clone()
    };
    assert_eq!(
        request_hash(&bilingual),
        "1614bc16420a22f45df72e5e934e4a28822ae067d8a7dbc2c9b64b6cf2ae6a27"
    );
    let absent = Request {
        voice: None,
        ..request
    };
    assert_ne!(
        request_hash(&absent),
        request_hash(&Request {
            voice: Some("".into()),
            ..absent.clone()
        })
    );
}

#[test]
fn stale_or_locked_selection_never_prepares_and_duplicate_id_cannot_change_request() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open_in_dir(dir.path()).unwrap();
    let root = dir.path().to_str().unwrap();
    let (_, s) = setup(&db, root);
    for mut bad in [
        s.clone(),
        s.clone(),
        s.clone(),
        s.clone(),
        s.clone(),
        s.clone(),
    ]
    .into_iter()
    .enumerate()
    {
        match bad.0 {
            0 => bad.1.expected_source_revision = "stale".into(),
            1 => bad.1.expected_teaching_revision = "stale".into(),
            2 => {
                bad.1.page_id = "fixture-page-2".into();
                bad.1.action_id = "narration-1".into();
            }
            3 => bad.1.model = "../model".into(),
            4 => bad.1.voice = Some("invalid/voice".into()),
            _ => bad.1.principal_key = "bad".into(),
        }
        assert!(db.prepare_courseware_tts(root, bad.1).is_err());
    }
    assert!(db
        .list_courseware_tts(root, &s.project_id, &s.principal_key)
        .unwrap()
        .is_empty());
    let first = db.prepare_courseware_tts(root, s.clone()).unwrap();
    let mut changed = s.clone();
    changed.voice = None;
    assert!(db
        .prepare_courseware_tts(root, changed)
        .unwrap_err()
        .to_string()
        .starts_with("COURSEWARE_CONFLICT"));
    assert_eq!(get(&db, root, &s), first);
    for text in [" ".into(), "😀".repeat(2001)] {
        let mut p = db
            .get_courseware_project(root, &s.project_id)
            .unwrap()
            .unwrap();
        p.pages[0].actions[0]["text"] = json!(text);
        db.kv_set(
            NAMESPACE,
            &storage_key(root, &s.project_id).unwrap(),
            &serde_json::to_value(p).unwrap(),
        )
        .unwrap();
        let mut next = s.clone();
        next.intent_id = "invalid-text".into();
        assert!(db.prepare_courseware_tts(root, next).is_err());
    }
}

#[test]
fn late_task_receipt_is_retained_but_changed_teaching_cannot_be_dispatched() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open_in_dir(dir.path()).unwrap();
    let root = dir.path().to_str().unwrap();
    let (p, s) = setup(&db, root);
    db.prepare_courseware_tts(root, s.clone()).unwrap();
    let uncertain = begin(&db, root, &s).unwrap();
    let changed = db
        .write_courseware_teaching(
            root,
            &TeachingWrite {
                project_id: s.project_id.clone(),
                page_id: s.page_id.clone(),
                expected_source_revision: s.expected_source_revision.clone(),
                expected_teaching_revision: s.expected_teaching_revision.clone(),
                actions: vec![json!({"id":s.action_id,"type":"speech","text":"Changed."})],
            },
        )
        .unwrap();
    assert_ne!(p.teaching_revision, changed.teaching_revision);
    assert_eq!(get(&db, root, &s)["current"], false);
    assert!(begin(&db, root, &s).is_err());
    let retained = db.prepare_courseware_tts(root, s.clone()).unwrap();
    assert_eq!(retained["current"], false);
    assert_eq!(retained["intent"], uncertain["intent"]);
    let reference = task(&uncertain);
    let saved = db
        .bind_courseware_tts(
            root,
            &s.project_id,
            &s.principal_key,
            &s.intent_id,
            reference.clone(),
        )
        .unwrap();
    assert_eq!(saved["current"], false);
    let mut replaced = reference;
    replaced.task_id = "another-task".into();
    assert!(db
        .bind_courseware_tts(
            root,
            &s.project_id,
            &s.principal_key,
            &s.intent_id,
            replaced
        )
        .is_err());
    assert_eq!(get(&db, root, &s), saved);
    assert_eq!(
        db.get_courseware_project(root, &s.project_id)
            .unwrap()
            .unwrap()
            .teaching_revision,
        changed.teaching_revision
    );
}

#[test]
fn account_workspace_and_project_scopes_cannot_borrow_requests() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open_in_dir(dir.path()).unwrap();
    let root = dir.path().to_str().unwrap();
    let (_, s) = setup(&db, root);
    db.prepare_courseware_tts(root, s.clone()).unwrap();
    assert!(db
        .get_courseware_tts(root, &s.project_id, &"b".repeat(64), &s.intent_id)
        .is_err());
    assert!(db
        .list_courseware_tts(root, &s.project_id, &"b".repeat(64))
        .unwrap()
        .is_empty());
    assert!(db
        .get_courseware_tts(
            "/another/workspace",
            &s.project_id,
            &s.principal_key,
            &s.intent_id
        )
        .is_err());
    assert!(db
        .get_courseware_tts(root, "other-project", &s.principal_key, &s.intent_id)
        .is_err());
    let mut untrusted = serde_json::to_value(s.clone()).unwrap();
    untrusted["input"] = json!("forged text");
    assert!(serde_json::from_value::<Selection>(untrusted).is_err());
    let reference = task(&get(&db, root, &s));
    assert!(db
        .bind_courseware_tts(
            root,
            &s.project_id,
            &s.principal_key,
            &s.intent_id,
            reference
        )
        .is_err());
    let uncertain = begin(&db, root, &s).unwrap();
    let mut forged = task(&uncertain);
    forged.request_hash = "f".repeat(64);
    assert!(db
        .bind_courseware_tts(root, &s.project_id, &s.principal_key, &s.intent_id, forged)
        .is_err());
    assert_eq!(get(&db, root, &s), uncertain);
}

#[test]
fn ignored_sql_writes_never_acknowledge_a_request_or_task_and_corruption_rejects() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open_in_dir(dir.path()).unwrap();
    let root = dir.path().to_str().unwrap();
    let (_, s) = setup(&db, root);
    db.conn.execute_batch("CREATE TRIGGER ignore_tts BEFORE INSERT ON kv WHEN NEW.ns='coursewareTtsIntents.v1' BEGIN SELECT RAISE(IGNORE); END;").unwrap();
    assert!(db.prepare_courseware_tts(root, s.clone()).is_err());
    assert!(db
        .list_courseware_tts(root, &s.project_id, &s.principal_key)
        .unwrap()
        .is_empty());
    db.conn.execute_batch("DROP TRIGGER ignore_tts").unwrap();
    let prepared = db.prepare_courseware_tts(root, s.clone()).unwrap();
    db.conn.execute_batch("CREATE TRIGGER ignore_tts BEFORE UPDATE ON kv WHEN NEW.ns='coursewareTtsIntents.v1' BEGIN SELECT RAISE(IGNORE); END;").unwrap();
    assert!(begin(&db, root, &s).is_err());
    assert_eq!(get(&db, root, &s), prepared);
    db.conn.execute_batch("DROP TRIGGER ignore_tts").unwrap();
    let uncertain = begin(&db, root, &s).unwrap();
    db.conn.execute_batch("CREATE TRIGGER ignore_tts BEFORE UPDATE ON kv WHEN NEW.ns='coursewareTtsIntents.v1' BEGIN SELECT RAISE(IGNORE); END;").unwrap();
    assert!(db
        .bind_courseware_tts(
            root,
            &s.project_id,
            &s.principal_key,
            &s.intent_id,
            task(&uncertain)
        )
        .is_err());
    assert_eq!(get(&db, root, &s), uncertain);
    db.conn.execute_batch("DROP TRIGGER ignore_tts").unwrap();
    let mut corrupt = uncertain["intent"].clone();
    corrupt["request"]["input"] = json!("corrupted");
    db.kv_set(
        INTENTS,
        &key(root, &s.project_id, &s.principal_key, &s.intent_id).unwrap(),
        &corrupt,
    )
    .unwrap();
    assert!(db
        .get_courseware_tts(root, &s.project_id, &s.principal_key, &s.intent_id)
        .is_err());
    assert!(db
        .list_courseware_tts(root, &s.project_id, &s.principal_key)
        .is_err());
}

#[test]
fn incomplete_checkpoint_never_acknowledges_and_recovery_keeps_the_same_key() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("pi.sqlite");
    let db = Database::open(&path).unwrap();
    let root = dir.path().to_str().unwrap();
    let (_, s) = setup(&db, root);
    db.conn.execute_batch("PRAGMA busy_timeout=1").unwrap();
    db.source_adoption_barrier().unwrap();
    let reader = rusqlite::Connection::open(&path).unwrap();
    reader
        .execute_batch("BEGIN; SELECT count(*) FROM kv;")
        .unwrap();
    assert!(db
        .prepare_courseware_tts(root, s.clone())
        .unwrap_err()
        .to_string()
        .contains("checkpoint is incomplete"));
    let retained = get(&db, root, &s);
    assert_eq!(retained["intent"]["phase"], "prepared");
    reader.execute_batch("COMMIT").unwrap();
    assert_eq!(
        db.prepare_courseware_tts(root, s.clone()).unwrap(),
        retained
    );

    reader
        .execute_batch("BEGIN; SELECT count(*) FROM kv;")
        .unwrap();
    assert!(begin(&db, root, &s)
        .unwrap_err()
        .to_string()
        .contains("checkpoint is incomplete"));
    let unknown = get(&db, root, &s);
    assert_eq!(unknown["intent"]["phase"], "submission-unknown");
    assert_eq!(
        unknown["intent"]["idempotencyKey"],
        retained["intent"]["idempotencyKey"]
    );
    reader.execute_batch("COMMIT").unwrap();
    assert!(begin(&db, root, &s).is_err());
    assert_eq!(get(&db, root, &s), unknown);

    reader
        .execute_batch("BEGIN; SELECT count(*) FROM kv;")
        .unwrap();
    let reference = task(&unknown);
    assert!(db
        .bind_courseware_tts(
            root,
            &s.project_id,
            &s.principal_key,
            &s.intent_id,
            reference.clone()
        )
        .unwrap_err()
        .to_string()
        .contains("checkpoint is incomplete"));
    reader.execute_batch("COMMIT").unwrap();
    let submitted = db
        .bind_courseware_tts(
            root,
            &s.project_id,
            &s.principal_key,
            &s.intent_id,
            reference,
        )
        .unwrap();
    drop(reader);
    drop(db);
    let reopened = Database::open(&path).unwrap();
    assert_eq!(get(&reopened, root, &s), submitted);
    assert_eq!(
        reopened
            .list_courseware_tts(root, &s.project_id, &s.principal_key)
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn source_adoption_blocks_new_dispatch_but_does_not_hide_recovery() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open_in_dir(dir.path()).unwrap();
    let root = dir.path().to_str().unwrap();
    let (_, s) = setup(&db, root);
    let saved = db.prepare_courseware_tts(root, s.clone()).unwrap();
    db.kv_set(
        "coursewareSourceAdoptionLocks.v1",
        &storage_key(root, "source-adoption").unwrap(),
        &json!("pending"),
    )
    .unwrap();
    assert!(begin(&db, root, &s).is_err());
    assert_eq!(get(&db, root, &s), saved);
    assert_eq!(db.prepare_courseware_tts(root, s.clone()).unwrap(), saved);
    let mut next = s.clone();
    next.intent_id = "new-intent".into();
    assert!(db.prepare_courseware_tts(root, next).is_err());
}

#[test]
fn submission_scope_is_atomic_durable_and_legacy_unknown_never_restarts() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("pi.sqlite");
    let root = dir.path().to_str().unwrap();
    let db = Database::open(&path).unwrap();
    let (_, selection) = setup(&db, root);
    let prepared = db.prepare_courseware_tts(root, selection.clone()).unwrap();
    assert!(prepared["intent"].get("submissionScope").is_none());
    let team = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    db.kv_set("coursewareTask.v1", "test-session", &json!({"taskType":"plain", "teamProjectId":team})).unwrap();
    db.conn.execute_batch("CREATE TRIGGER fail_scope BEFORE UPDATE ON kv WHEN NEW.ns='coursewareTtsIntents.v1' BEGIN SELECT RAISE(FAIL, 'fixture scope write'); END;").unwrap();
    assert!(begin(&db, root, &selection).is_err());
    assert_eq!(get(&db, root, &selection), prepared);
    db.conn.execute_batch("DROP TRIGGER fail_scope;").unwrap();
    let begun = begin(&db, root, &selection).unwrap();
    assert_eq!(begun["intent"]["submissionScope"], json!({"sessionId":"test-session", "teamProjectId":team}));
    assert_eq!(begun["intent"]["idempotencyKey"], prepared["intent"]["idempotencyKey"]);
    assert_eq!(begun["intent"]["requestHash"], prepared["intent"]["requestHash"]);
    drop(db);
    let db = Database::open(&path).unwrap();
    assert_eq!(get(&db, root, &selection), begun);
    assert!(begin(&db, root, &selection).is_err());
    let key = key(root, &selection.project_id, &selection.principal_key, &selection.intent_id).unwrap();
    let mut legacy = begun["intent"].clone();
    legacy.as_object_mut().unwrap().remove("submissionScope");
    db.kv_set(INTENTS, &key, &legacy).unwrap();
    assert_eq!(get(&db, root, &selection)["intent"], legacy);
    assert!(begin(&db, root, &selection).is_err());
    let bound = db.bind_courseware_tts(root, &selection.project_id, &selection.principal_key, &selection.intent_id, task(&begun)).unwrap();
    assert!(bound["intent"].get("submissionScope").is_none());
    assert_eq!(bound["intent"]["phase"], "submitted");
}

#[test]
fn invalid_stored_team_scope_cannot_begin_or_become_personal() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
    let root = dir.path().to_str().unwrap();
    let (_, selection) = setup(&db, root);
    let prepared = db.prepare_courseware_tts(root, selection.clone()).unwrap();
    for team in [Value::Null, json!("../foreign"), json!(42)] {
        db.kv_set("coursewareTask.v1", "test-session", &json!({"teamProjectId":team})).unwrap();
        assert!(begin(&db, root, &selection).is_err());
        assert_eq!(get(&db, root, &selection), prepared);
    }
    for raw in [json!({"sessionId":"test-session"}), json!({"sessionId":"test-session", "teamProjectId":42})] {
        assert!(serde_json::from_value::<super::super::media_scope::SubmissionScope>(raw).is_err());
    }
}

#[test]
fn rejected_team_tts_is_durable_cannot_replay_and_requires_a_new_attempt() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("pi.sqlite");
    let root = dir.path().to_str().unwrap();
    let db = Database::open(&path).unwrap();
    let (original, selection) = setup(&db, root);
    let prepared = db.prepare_courseware_tts(root, selection.clone()).unwrap();
    let receipt = || RejectedRequest {
        idempotency_key: prepared["intent"]["idempotencyKey"].as_str().unwrap().into(),
        request_hash: prepared["intent"]["requestHash"].as_str().unwrap().into(),
    };
    let reject = |db: &Database, request| db.reject_courseware_tts(root, &selection.project_id,
        &selection.principal_key, &selection.intent_id, request);
    assert!(reject(&db, receipt()).is_err());
    let personal = begin(&db, root, &selection).unwrap();
    assert!(reject(&db, receipt()).is_err());
    assert_eq!(get(&db, root, &selection), personal);

    let mut selection = selection.clone();
    selection.intent_id = "team-attempt".into();
    db.kv_set("coursewareTask.v1", "test-session", &json!({"taskType":"plain",
        "teamProjectId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"})).unwrap();
    let team = db.prepare_courseware_tts(root, selection.clone()).unwrap();
    let request = || RejectedRequest {
        idempotency_key: team["intent"]["idempotencyKey"].as_str().unwrap().into(),
        request_hash: team["intent"]["requestHash"].as_str().unwrap().into(),
    };
    let reject = |db: &Database, request| db.reject_courseware_tts(root, &selection.project_id,
        &selection.principal_key, &selection.intent_id, request);
    let begun = begin(&db, root, &selection).unwrap();
    let mut wrong = request(); wrong.request_hash = "f".repeat(64);
    assert!(reject(&db, wrong).is_err());
    assert_eq!(get(&db, root, &selection), begun);
    db.conn.execute_batch("CREATE TRIGGER ignore_reject BEFORE UPDATE ON kv WHEN NEW.ns='coursewareTtsIntents.v1' BEGIN SELECT RAISE(IGNORE); END;").unwrap();
    assert!(reject(&db, request()).is_err());
    assert_eq!(get(&db, root, &selection), begun);
    db.conn.execute_batch("DROP TRIGGER ignore_reject").unwrap();
    let rejected = reject(&db, request()).unwrap();
    assert_eq!(rejected["intent"]["phase"], "rejected");
    assert!(rejected["intent"]["taskRef"].is_null());
    assert!(begin(&db, root, &selection).is_err());
    assert!(db.bind_courseware_tts(root, &selection.project_id, &selection.principal_key,
        &selection.intent_id, task(&begun)).is_err());
    drop(db);
    let db = Database::open(&path).unwrap();
    assert_eq!(get(&db, root, &selection), rejected);
    assert_eq!(db.prepare_courseware_tts(root, selection.clone()).unwrap(), rejected);
    assert_eq!(serde_json::to_value(db.get_courseware_project(root, &selection.project_id).unwrap().unwrap()).unwrap(),
        serde_json::to_value(original).unwrap());
    let mut next = selection.clone(); next.intent_id = "explicit-new-attempt".into();
    let fresh = db.prepare_courseware_tts(root, next).unwrap();
    assert_eq!(fresh["intent"]["phase"], "prepared");
    assert_ne!(fresh["intent"]["idempotencyKey"], rejected["intent"]["idempotencyKey"]);
    assert_eq!(fresh["intent"]["requestHash"], rejected["intent"]["requestHash"]);
}
