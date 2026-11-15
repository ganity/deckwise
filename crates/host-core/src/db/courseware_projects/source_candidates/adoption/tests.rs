use super::*;
use serde_json::json;

fn seed(hash: char) -> SavedProjectSeed {
    let mut identity: Value = serde_json::from_slice(include_bytes!(
        "../../../../courseware/identity/fixtures/identity.json"
    ))
    .unwrap();
    identity["sourceSha256"] = json!(hash.to_string().repeat(64));
    SavedProjectSeed {
        project_id: "office-adoption".into(),
        sha256: hash.to_string().repeat(64),
        pages: 1,
        identity: Some(
            SavedSourceIdentity::parse(&serde_json::to_vec(&identity).unwrap()).unwrap(),
        ),
    }
}

fn fixture(db: &Database, root: &str, verified: bool) -> CoursewareProject {
    let original = seed('a');
    let mut project = db
        .open_identified_courseware_project(root, &original)
        .unwrap();
    project = db
        .write_courseware_teaching(
            root,
            &TeachingWrite {
                project_id: project.project_id.clone(),
                page_id: project.pages[0].page_id.clone(),
                expected_source_revision: project.source.revision.clone(),
                expected_teaching_revision: project.teaching_revision.clone(),
                actions: vec![
                    json!({"id":"speech-1", "type":"speech", "text":"Good!", "pauseAfterMs":4000}),
                ],
            },
        )
        .unwrap();
    let request = SourceCandidateRequest {
        candidate_id: "candidate-1".into(),
        page_id: project.pages[0].page_id.clone(),
        kind: Kind::PageFade,
        expected_source_revision: project.source.revision.clone(),
        expected_teaching_revision: project.teaching_revision.clone(),
        style_batch: None,
    };
    let prepared = db
        .prepare_source_candidate(root, &original, request)
        .unwrap();
    let output = seed('b');
    db.stage_source_candidate_with_evidence(
        root,
        &project.project_id,
        "candidate-1",
        ParsedOutput {
            sha256: output.sha256.clone(),
            pages: output.pages,
            identity: output.identity.map(|identity| identity.value().clone()),
        },
        verified.then(|| FadeEvidence {
            protocol: "deckwise-main-fade/1".into(),
            source_sha256: original.sha256,
            output_sha256: output.sha256,
            mapping_revision: prepared["mappingRevision"].as_str().unwrap().into(),
            page_id: project.pages[0].page_id.clone(),
            slide_part: "ppt/slides/slide1.xml".into(),
        }),
    )
    .unwrap();
    project
}

fn project(db: &Database, root: &str) -> Value {
    serde_json::to_value(
        db.get_courseware_project(root, "office-adoption")
            .unwrap()
            .unwrap(),
    )
    .unwrap()
}

#[test]
fn interrupted_adoption_retains_intent_and_commits_all_records_once_after_restart() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_str().unwrap();
    let path = dir.path().join("pi.sqlite");
    let original;
    let receipt;
    let before_identity;
    {
        let db = Database::open(&path).unwrap();
        original = fixture(&db, root, true);
        before_identity = db
            .kv_get(
                identities::IDENTITY_NAMESPACE,
                &identities::identity_key(root, "office-adoption", &seed('a').sha256).unwrap(),
            )
            .unwrap()
            .unwrap();
        receipt = db
            .prepare_source_adoption(root, &seed('a'), "candidate-1")
            .unwrap();
        assert_eq!(receipt["status"], "pending");
        assert_eq!(
            db.prepare_source_adoption(root, &seed('a'), "candidate-1")
                .unwrap(),
            receipt
        );
        assert_eq!(project(&db, root), serde_json::to_value(&original).unwrap());
        assert!(db.ensure_no_source_adoption(root).is_err());
        db.ensure_no_source_adoption("/other-workspace").unwrap();
    }
    let committed;
    {
        let db = Database::open(&path).unwrap();
        assert_eq!(
            db.get_source_adoption(root, "office-adoption").unwrap(),
            receipt
        );
        assert!(db.ensure_no_source_adoption(root).is_err());
        committed = db
            .resolve_source_adoption(
                root,
                &seed('b'),
                receipt["adoptionId"].as_str().unwrap(),
                true,
            )
            .unwrap();
        assert_eq!(committed["status"], "committed");
        let next = &committed["project"];
        assert_eq!(next["source"]["sha256"], seed('b').sha256);
        assert_ne!(next["teachingRevision"], original.teaching_revision);
        assert_eq!(next["pages"][0]["pageId"], original.pages[0].page_id);
        assert_eq!(
            next["pages"][0]["actions"],
            json!(original.pages[0].actions)
        );
        assert_eq!(next["pages"][0]["locked"], original.pages[0].locked);
        let after_identity = db
            .kv_get(
                identities::IDENTITY_NAMESPACE,
                &identities::identity_key(root, "office-adoption", &seed('b').sha256).unwrap(),
            )
            .unwrap()
            .unwrap();
        assert_eq!(after_identity["pages"], before_identity["pages"]);
        assert_ne!(
            after_identity["mappingRevision"],
            before_identity["mappingRevision"]
        );
        assert_eq!(
            db.kv_get(
                identities::IDENTITY_NAMESPACE,
                &identities::identity_key(root, "office-adoption", &seed('a').sha256).unwrap()
            )
            .unwrap()
            .unwrap(),
            before_identity
        );
        let history_key = serde_json::to_string(&(
            storage_key(root, "office-adoption").unwrap(),
            &original.teaching_revision,
        ))
        .unwrap();
        assert_eq!(
            db.kv_get(HISTORY_NAMESPACE, &history_key).unwrap().unwrap(),
            json!(original)
        );
        let candidate = db
            .get_source_candidate(root, "office-adoption", "candidate-1")
            .unwrap();
        assert_eq!(candidate["status"], "adopted");
        assert_eq!(candidate["applied"], true);
        assert!(db
            .reject_source_candidate(root, "office-adoption", "candidate-1")
            .is_err());
        db.ensure_no_source_adoption(root).unwrap();
    }
    let db = Database::open(&path).unwrap();
    assert_eq!(
        db.resolve_source_adoption(
            root,
            &seed('b'),
            receipt["adoptionId"].as_str().unwrap(),
            true
        )
        .unwrap(),
        committed
    );
    assert_eq!(project(&db, root), committed["project"]);
    assert!(db
        .resolve_source_adoption(
            root,
            &seed('a'),
            receipt["adoptionId"].as_str().unwrap(),
            false
        )
        .is_err());
}

#[test]
fn source_candidate_chat_adoption_result_is_atomic_and_survives_restart() {
    use crate::db::courseware_projects::chat_changes::OperationRequest;
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_str().unwrap();
    let path = dir.path().join("pi.sqlite");
    let db = Database::open(&path).unwrap();
    let original = fixture(&db, root, true);
    let pending = db
        .prepare_courseware_chat_change(
            root,
            &original.project_id,
            OperationRequest {
                session_id: "chat-1",
                turn_id: "turn-1",
                tool_call_id: "fade-1",
                tool_name: "ppt_propose_page_fade",
                args: &json!({}),
            },
        )
        .unwrap();
    db.finish_courseware_chat_change(
        &pending,
        json!({"state":"acknowledged","candidateId":"candidate-1","saved":false}),
    )
    .unwrap();
    let view = |db: &Database, current: &CoursewareProject| {
        db.courseware_chat_change_context(root, current).unwrap()[0]["operations"][0]["candidate"]
            .clone()
    };
    assert_eq!(view(&db, &original)["status"], "needs-review");
    let adoption = db
        .prepare_source_adoption(root, &seed('a'), "candidate-1")
        .unwrap();
    db.conn.execute_batch("CREATE TRIGGER fail_source_result BEFORE INSERT ON kv WHEN NEW.ns='coursewareChatCandidateAdoptions.v1' BEGIN SELECT RAISE(ABORT,'fixture source result failure'); END;").unwrap();
    assert!(db
        .resolve_source_adoption(
            root,
            &seed('b'),
            adoption["adoptionId"].as_str().unwrap(),
            true
        )
        .is_err());
    assert_eq!(project(&db, root), json!(original));
    assert_eq!(
        db.get_source_candidate(root, &original.project_id, "candidate-1")
            .unwrap()["status"],
        "needs-review"
    );
    assert_eq!(
        db.get_source_adoption(root, &original.project_id).unwrap()["status"],
        "pending"
    );
    db.conn
        .execute_batch("DROP TRIGGER fail_source_result;")
        .unwrap();
    let committed = db
        .resolve_source_adoption(
            root,
            &seed('b'),
            adoption["adoptionId"].as_str().unwrap(),
            true,
        )
        .unwrap();
    let next: CoursewareProject = serde_json::from_value(committed["project"].clone()).unwrap();
    let linked = view(&db, &next);
    assert_eq!(linked["status"], "adopted");
    assert_eq!(linked["sourceSha256"], seed('b').sha256);
    assert_eq!(linked["teachingRevision"], next.teaching_revision);
    drop(db);
    let db = Database::open(&path).unwrap();
    assert_eq!(view(&db, &next), linked);
}

#[test]
fn cancellation_requires_original_bytes_and_leaves_candidate_and_project_intact() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_str().unwrap();
    let db = Database::open_in_dir(dir.path()).unwrap();
    let original = fixture(&db, root, true);
    let receipt = db
        .prepare_source_adoption(root, &seed('a'), "candidate-1")
        .unwrap();
    let id = receipt["adoptionId"].as_str().unwrap();
    assert!(db
        .resolve_source_adoption(root, &seed('b'), id, false)
        .is_err());
    assert!(db
        .resolve_source_adoption(root, &seed('a'), id, true)
        .is_err());
    let cancelled = db
        .resolve_source_adoption(root, &seed('a'), id, false)
        .unwrap();
    assert_eq!(cancelled["status"], "cancelled");
    assert_eq!(
        db.resolve_source_adoption(root, &seed('a'), id, false)
            .unwrap(),
        cancelled
    );
    db.ensure_no_source_adoption(root).unwrap();
    assert_eq!(project(&db, root), json!(original));
    assert_eq!(
        db.get_source_candidate(root, "office-adoption", "candidate-1")
            .unwrap()["status"],
        "needs-review"
    );
    let next = db
        .prepare_source_adoption(root, &seed('a'), "candidate-1")
        .unwrap();
    assert_ne!(next["adoptionId"], receipt["adoptionId"]);
    assert!(db
        .resolve_source_adoption(root, &seed('b'), id, true)
        .is_err());
}

#[test]
fn stale_or_unverified_candidates_cannot_create_intent() {
    for change in [
        "unverified",
        "rejected",
        "teaching",
        "mapping",
        "wrong-source",
        "wrong-project",
        "wrong-identity",
        "historical-output",
    ] {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        let db = Database::open_in_dir(dir.path()).unwrap();
        let original = fixture(&db, root, change != "unverified");
        let mut parsed = seed('a');
        match change {
            "rejected" => {
                db.reject_source_candidate(root, "office-adoption", "candidate-1")
                    .unwrap();
            }
            "teaching" => {
                db.set_courseware_page_lock(
                    root,
                    "office-adoption",
                    &original.pages[0].page_id,
                    &original.source.revision,
                    &original.teaching_revision,
                    true,
                )
                .unwrap();
            }
            "mapping" => {
                let key =
                    identities::identity_key(root, "office-adoption", &parsed.sha256).unwrap();
                let mut identity = db
                    .kv_get(identities::IDENTITY_NAMESPACE, &key)
                    .unwrap()
                    .unwrap();
                identity["mappingRevision"] = json!("changed-mapping");
                db.kv_set(identities::IDENTITY_NAMESPACE, &key, &identity)
                    .unwrap();
            }
            "wrong-source" => parsed = seed('c'),
            "wrong-project" => parsed.project_id = "office-other".into(),
            "wrong-identity" => parsed.identity = None,
            "historical-output" => {
                db.kv_set(
                    identities::IDENTITY_NAMESPACE,
                    &identities::identity_key(root, "office-adoption", &seed('b').sha256).unwrap(),
                    &json!({}),
                )
                .unwrap();
            }
            _ => {}
        }
        let before = project(&db, root);
        assert!(
            db.prepare_source_adoption(root, &parsed, "candidate-1")
                .is_err(),
            "{change}"
        );
        db.ensure_no_source_adoption(root).unwrap();
        assert_eq!(project(&db, root), before);
        assert!(db.get_source_adoption(root, "office-adoption").is_err());
    }
}

#[test]
fn wrong_identity_owner_and_late_teaching_changes_do_not_commit_or_unlock() {
    for change in [
        "id",
        "workspace",
        "project",
        "source",
        "identity",
        "teaching",
        "candidate",
        "mapping",
    ] {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        let db = Database::open_in_dir(dir.path()).unwrap();
        let original = fixture(&db, root, true);
        let receipt = db
            .prepare_source_adoption(root, &seed('a'), "candidate-1")
            .unwrap();
        let mut parsed = seed('b');
        let mut owner = root;
        let mut id = receipt["adoptionId"].as_str().unwrap();
        match change {
            "id" => id = "forged-id",
            "workspace" => owner = "/other-workspace",
            "project" => parsed.project_id = "office-other".into(),
            "source" => parsed = seed('c'),
            "identity" => {
                let mut identity = parsed.identity.as_ref().unwrap().value().clone();
                identity["pages"][0]["contentFingerprint"] = json!("c".repeat(64));
                parsed.identity = Some(
                    SavedSourceIdentity::parse(&serde_json::to_vec(&identity).unwrap()).unwrap(),
                );
            }
            "teaching" => {
                db.set_courseware_page_lock(
                    root,
                    "office-adoption",
                    &original.pages[0].page_id,
                    &original.source.revision,
                    &original.teaching_revision,
                    true,
                )
                .unwrap();
            }
            "candidate" => {
                db.reject_source_candidate(root, "office-adoption", "candidate-1")
                    .unwrap();
            }
            "mapping" => {
                let key =
                    identities::identity_key(root, "office-adoption", &seed('a').sha256).unwrap();
                let mut identity = db
                    .kv_get(identities::IDENTITY_NAMESPACE, &key)
                    .unwrap()
                    .unwrap();
                identity["mappingRevision"] = json!("changed-mapping");
                db.kv_set(identities::IDENTITY_NAMESPACE, &key, &identity)
                    .unwrap();
            }
            _ => unreachable!(),
        }
        let before = project(&db, root);
        assert!(
            db.resolve_source_adoption(owner, &parsed, id, true)
                .is_err(),
            "{change}"
        );
        assert_eq!(project(&db, root), before);
        assert_eq!(
            db.get_source_adoption(root, "office-adoption").unwrap(),
            receipt
        );
        assert!(db.ensure_no_source_adoption(root).is_err());
    }
}

#[test]
fn sql_failure_at_each_commit_step_rolls_back_all_records_and_preserves_recovery_intent() {
    for (operation, namespace) in [
        ("INSERT", HISTORY_NAMESPACE),
        ("INSERT", identities::IDENTITY_NAMESPACE),
        ("UPDATE", NAMESPACE),
        ("UPDATE", CANDIDATES),
        ("UPDATE", ADOPTIONS),
        ("DELETE", LOCKS),
    ] {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        let db = Database::open_in_dir(dir.path()).unwrap();
        let original = fixture(&db, root, true);
        let receipt = db
            .prepare_source_adoption(root, &seed('a'), "candidate-1")
            .unwrap();
        let id = receipt["adoptionId"].as_str().unwrap();
        let row = if operation == "DELETE" { "OLD" } else { "NEW" };
        db.conn.execute_batch(&format!("CREATE TRIGGER adoption_failure BEFORE {operation} ON kv WHEN {row}.ns='{namespace}' BEGIN SELECT RAISE(IGNORE); END;")).unwrap();
        assert!(
            db.resolve_source_adoption(root, &seed('b'), id, true)
                .is_err(),
            "{namespace}"
        );
        assert_eq!(project(&db, root), json!(original), "{namespace}");
        assert_eq!(
            db.get_source_adoption(root, "office-adoption").unwrap(),
            receipt
        );
        assert_eq!(
            db.get_source_candidate(root, "office-adoption", "candidate-1")
                .unwrap()["status"],
            "needs-review"
        );
        assert!(db
            .kv_get(
                identities::IDENTITY_NAMESPACE,
                &identities::identity_key(root, "office-adoption", &seed('b').sha256).unwrap()
            )
            .unwrap()
            .is_none());
        assert!(db.ensure_no_source_adoption(root).is_err());
        db.conn
            .execute_batch("DROP TRIGGER adoption_failure")
            .unwrap();
        assert_eq!(
            db.resolve_source_adoption(root, &seed('b'), id, true)
                .unwrap()["status"],
            "committed"
        );
    }
}

#[test]
fn failed_intent_or_lock_write_creates_neither_record() {
    for namespace in [ADOPTIONS, LOCKS] {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        let db = Database::open_in_dir(dir.path()).unwrap();
        let original = fixture(&db, root, true);
        db.conn.execute_batch(&format!("CREATE TRIGGER preparation_failure BEFORE INSERT ON kv WHEN NEW.ns='{namespace}' BEGIN SELECT RAISE(IGNORE); END;")).unwrap();
        assert!(db
            .prepare_source_adoption(root, &seed('a'), "candidate-1")
            .is_err());
        assert!(db.get_source_adoption(root, "office-adoption").is_err());
        db.ensure_no_source_adoption(root).unwrap();
        assert_eq!(project(&db, root), json!(original));
    }
}

#[test]
fn only_one_pending_adoption_can_own_a_workspace() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_str().unwrap();
    let db = Database::open_in_dir(dir.path()).unwrap();
    fixture(&db, root, true);
    let pending = db
        .prepare_source_adoption(root, &seed('a'), "candidate-1")
        .unwrap();
    let mut other = seed('a');
    other.project_id = "office-other".into();
    assert!(db
        .prepare_source_adoption(root, &other, "candidate-1")
        .is_err());
    assert!(db
        .prepare_source_adoption(root, &seed('a'), "other-candidate")
        .is_err());
    assert_eq!(
        db.get_source_adoption(root, "office-adoption").unwrap(),
        pending
    );
}

#[test]
fn durability_barrier_rejects_an_incomplete_checkpoint_and_retries_after_reader_release() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("pi.sqlite");
    let db = Database::open(&path).unwrap();
    db.conn.execute_batch("PRAGMA busy_timeout=1").unwrap();
    db.source_adoption_barrier().unwrap();
    let reader = rusqlite::Connection::open(&path).unwrap();
    reader
        .execute_batch("BEGIN; SELECT count(*) FROM kv;")
        .unwrap();
    db.kv_set("checkpoint-test", "key", &json!({"value":1}))
        .unwrap();
    assert!(db
        .source_adoption_barrier()
        .unwrap_err()
        .to_string()
        .contains("checkpoint is incomplete"));
    reader.execute_batch("COMMIT").unwrap();
    db.source_adoption_barrier().unwrap();
    let other = Database::open(&path).unwrap();
    assert_eq!(
        other.kv_get("checkpoint-test", "key").unwrap(),
        Some(json!({"value":1}))
    );
}
