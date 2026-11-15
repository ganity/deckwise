use super::*;
use crate::courseware::{identity::SavedSourceIdentity, SavedProjectSeed};

fn setup(db: &Database, root: &str) -> (SavedProjectSeed, CoursewareProject) {
    let identity = SavedSourceIdentity::parse(include_bytes!(
        "../../../../courseware/identity/fixtures/identity.json"
    ))
    .unwrap();
    let seed = SavedProjectSeed {
        project_id: "resolution-project".into(),
        sha256: identity.value()["sourceSha256"].as_str().unwrap().into(),
        pages: 1,
        identity: Some(identity),
    };
    let p = db.open_identified_courseware_project(root, &seed).unwrap();
    let p = db
        .review_courseware_page(
            root,
            &p.project_id,
            &p.pages[0].page_id,
            &p.source.revision,
            &p.teaching_revision,
        )
        .unwrap();
    (seed, p)
}

fn declare(db: &Database, root: &str, p: &CoursewareProject, turn: &str) -> ResolutionRequest {
    db.declare_courseware_chat_plan(
        root,
        &p.project_id,
        OperationRequest {
            session_id: "owner",
            turn_id: turn,
            tool_call_id: turn,
            tool_name: "ppt_record_change_plan",
            args: &json!({}),
        },
        &Plan {
            tool_call_id: turn.into(),
            page_id: p.pages[0].page_id.clone(),
            page_number: 1,
            edit_generation: 1,
            items: vec![PlanItem {
                tool_name: "ppt_propose_page_narration".into(),
                label: "Rewrite narration".into(),
            }],
        },
        &p.source.revision,
        &p.teaching_revision,
    )
    .unwrap();
    let view = db.courseware_chat_change_context(root, p).unwrap();
    let change = view.iter().find(|c| c["turnId"] == turn).unwrap();
    ResolutionRequest {
        change_group_id: change["changeGroupId"].as_str().unwrap().into(),
        receipt_sha256: change["receiptSha256"].as_str().unwrap().into(),
        note: "Reviewed current page; retain the manually edited narration.".into(),
    }
}

fn resolve(
    db: &Database,
    root: &str,
    p: &CoursewareProject,
    r: &ResolutionRequest,
) -> Result<CoursewareProject> {
    db.resolve_courseware_chat_change(
        root,
        "owner",
        &p.project_id,
        &p.pages[0].page_id,
        &p.source.revision,
        &p.teaching_revision,
        r,
    )
}

#[test]
fn chat_audit_needs_no_manual_closure_for_snapshots_and_preserves_history_after_restart() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_str().unwrap();
    let db = Database::open_in_dir(dir.path()).unwrap();
    let (seed, p) = setup(&db, root);
    db.capture_courseware_snapshot(
        root,
        &seed,
        "old",
        &p.source.revision,
        &p.teaching_revision,
        vec![],
    )
    .unwrap();
    let r = declare(&db, root, &p, "turn-1");
    db.capture_courseware_snapshot(
        root,
        &seed,
        "without-manual-closure",
        &p.source.revision,
        &p.teaching_revision,
        vec![],
    )
    .unwrap();
    assert!(db
        .get_courseware_snapshot(root, &p.project_id, "old")
        .is_ok());
    let newer = db.write_courseware_teaching(root, &TeachingWrite { project_id: p.project_id.clone(),
        page_id: p.pages[0].page_id.clone(), expected_source_revision: p.source.revision.clone(),
        expected_teaching_revision: p.teaching_revision.clone(), actions: vec![json!({"id":"later","type":"interaction_checkpoint","checkpointId":"later","checkpointKind":"teacher_continue"})] }).unwrap();
    assert!(resolve(&db, root, &p, &r).is_err());
    let closed = resolve(&db, root, &newer, &r).unwrap();
    assert_eq!(closed.pages[0].actions, newer.pages[0].actions);
    assert_eq!(closed.source.sha256, newer.source.sha256);
    assert_ne!(closed.teaching_revision, newer.teaching_revision);
    assert!(db
        .kv_get(
            HISTORY_NAMESPACE,
            &serde_json::to_string(&(
                storage_key(root, &p.project_id).unwrap(),
                &newer.teaching_revision
            ))
            .unwrap()
        )
        .unwrap()
        .is_some());
    let view = db.courseware_chat_change_context(root, &closed).unwrap();
    assert_eq!(view[0]["plan"]["items"][0]["status"], "not-recorded");
    assert_eq!(
        view[0]["resolution"]["teachingRevision"],
        closed.teaching_revision
    );
    assert!(resolve(&db, root, &closed, &r).is_err());
    db.capture_courseware_snapshot(
        root,
        &seed,
        "after",
        &closed.source.revision,
        &closed.teaching_revision,
        vec![],
    )
    .unwrap();
    assert!(db
        .prepare_courseware_chat_change(
            root,
            &p.project_id,
            OperationRequest {
                session_id: "owner",
                turn_id: "turn-1",
                tool_call_id: "late",
                tool_name: "ppt_propose_page_narration",
                args: &json!({})
            }
        )
        .is_err());
    drop(db);
    let db = Database::open_in_dir(dir.path()).unwrap();
    assert_eq!(
        db.courseware_chat_change_context(root, &closed).unwrap(),
        view
    );
    declare(&db, root, &closed, "turn-2");
    assert!(db
        .get_courseware_snapshot(root, &p.project_id, "after")
        .is_ok());
}

#[test]
fn declared_chat_resolution_refuses_forgery_races_storage_failure_and_hidden_history_bypass() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_str().unwrap();
    let db = Database::open_in_dir(dir.path()).unwrap();
    let (seed, p) = setup(&db, root);
    let r = declare(&db, root, &p, "first");
    assert!(db
        .resolve_courseware_chat_change(
            root,
            "foreign",
            &p.project_id,
            &p.pages[0].page_id,
            &p.source.revision,
            &p.teaching_revision,
            &r
        )
        .is_err());
    let mut bad = r.clone();
    bad.receipt_sha256 = "a".repeat(64);
    assert!(resolve(&db, root, &p, &bad).is_err());
    bad = r.clone();
    bad.note.clear();
    assert!(resolve(&db, root, &p, &bad).is_err());
    let pending = db
        .prepare_courseware_chat_change(
            root,
            &p.project_id,
            OperationRequest {
                session_id: "owner",
                turn_id: "first",
                tool_call_id: "operation",
                tool_name: "ppt_propose_page_narration",
                args: &json!({"baseline":{"pageId":p.pages[0].page_id}}),
            },
        )
        .unwrap();
    assert!(resolve(&db, root, &p, &r).is_err());
    db.finish_courseware_chat_change(&pending, json!({"state":"uncertain","saved":false}))
        .unwrap();
    let view = db.courseware_chat_change_context(root, &p).unwrap();
    let r = ResolutionRequest {
        receipt_sha256: view[0]["receiptSha256"].as_str().unwrap().into(),
        ..r
    };
    db.conn.execute_batch("CREATE TRIGGER fail_resolution BEFORE INSERT ON kv WHEN NEW.ns='coursewareChatResolutions.v1' BEGIN SELECT RAISE(ABORT,'fixture failure'); END;").unwrap();
    assert!(resolve(&db, root, &p, &r).is_err());
    assert_eq!(
        json!(db
            .get_courseware_project(root, &p.project_id)
            .unwrap()
            .unwrap()),
        json!(p)
    );
    assert_eq!(db.courseware_chat_change_context(root, &p).unwrap(), view);
    assert_eq!(
        db.conn
            .query_row(
                "SELECT count(*) FROM kv WHERE ns=?1",
                [HISTORY_NAMESPACE],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );
    db.conn
        .execute_batch("DROP TRIGGER fail_resolution;")
        .unwrap();
    let closed = resolve(&db, root, &p, &r).unwrap();
    assert!(db
        .finish_courseware_chat_change(&pending, json!({"state":"acknowledged","saved":false}))
        .unwrap_err()
        .to_string()
        .contains("cannot be rewritten"));
    assert_eq!(
        db.courseware_chat_change_context(root, &closed).unwrap()[0]["plan"]["items"][0]["status"],
        "unknown"
    );
    for n in 0..11 {
        declare(&db, root, &closed, &format!("later-{n}"));
    }
    assert_eq!(
        db.courseware_chat_change_context(root, &closed)
            .unwrap()
            .len(),
        10
    );
    db.capture_courseware_snapshot(
        root,
        &seed,
        "without-history-closure",
        &closed.source.revision,
        &closed.teaching_revision,
        vec![],
    )
    .unwrap();
}
