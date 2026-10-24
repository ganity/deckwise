use super::*;
use crate::courseware::SavedProjectSeed;

fn setup(
    db: &Database,
    root: &str,
) -> (CoursewareProject, SavedProjectSeed, TeachingWrite, Pending) {
    let accepted: Value = serde_json::from_slice(include_bytes!(
        "../../../../../../packages/shared/src/courseware-contract.fixtures/accepted.json"
    ))
    .unwrap();
    let project: CoursewareProject = serde_json::from_value(accepted["project"].clone()).unwrap();
    db.create_courseware_project(root, &project).unwrap();
    let seed = SavedProjectSeed {
        project_id: project.project_id.clone(),
        sha256: project.source.sha256.clone(),
        pages: project.pages.len(),
        identity: None,
    };
    let producer: Value =
        serde_json::from_slice(include_bytes!("../candidates/fixtures/b2-narration.json")).unwrap();
    let write: TeachingWrite = serde_json::from_value(producer["write"].clone()).unwrap();
    let pending = db
        .prepare_courseware_chat_change(
            root,
            &project.project_id,
            OperationRequest {
                session_id: "chat-1",
                turn_id: "turn-1",
                tool_call_id: "narration-call",
                tool_name: "ppt_propose_page_narration",
                args: &json!({}),
            },
        )
        .unwrap();
    db.stage_narration_candidate(root, &seed, "candidate-1", &write)
        .unwrap();
    db.finish_courseware_chat_change(
        &pending,
        json!({"state":"acknowledged","saved":false,"candidateId":"candidate-1"}),
    )
    .unwrap();
    (project, seed, write, pending)
}

fn progress(db: &Database, root: &str, project: &CoursewareProject) -> Value {
    db.courseware_chat_change_context(root, project).unwrap()[0]["operations"][0]["candidate"]
        .clone()
}

#[test]
fn candidate_adoption_links_immutable_revision_and_later_changes_are_not_erased() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_str().unwrap();
    let path = dir.path().join("pi.sqlite");
    let db = Database::open(&path).unwrap();
    let (original, seed, write, _) = setup(&db, root);
    assert_eq!(progress(&db, root, &original)["status"], "needs-review");
    let adopted = db
        .adopt_narration_candidate(root, &seed, "candidate-1")
        .unwrap();
    let linked = progress(&db, root, &adopted);
    assert_eq!(linked["status"], "adopted");
    assert_eq!(linked["teachingRevision"], adopted.teaching_revision);
    assert_eq!(linked["sourceSha256"], adopted.source.sha256);
    assert_eq!(linked["pageIds"], json!([write.page_id]));
    drop(db);
    let db = Database::open(&path).unwrap();
    assert_eq!(progress(&db, root, &adopted), linked);
    let unlocked = db
        .set_courseware_page_lock(
            root,
            &adopted.project_id,
            &adopted.pages[1].page_id,
            &adopted.source.revision,
            &adopted.teaching_revision,
            false,
        )
        .unwrap();
    let peer = &unlocked.pages[1];
    let next = db
        .write_courseware_teaching(
            root,
            &TeachingWrite {
                project_id: unlocked.project_id.clone(),
                page_id: peer.page_id.clone(),
                expected_source_revision: unlocked.source.revision.clone(),
                expected_teaching_revision: unlocked.teaching_revision.clone(),
                actions: vec![json!({"id":"peer-new","type":"speech","text":"Later peer edit."})],
            },
        )
        .unwrap();
    assert_eq!(
        progress(&db, root, &next),
        linked,
        "Unrelated page edits do not erase the adopted result"
    );
    let mut next_write = write.clone();
    next_write.expected_teaching_revision = next.teaching_revision.clone();
    next_write.actions[0]["text"] = json!("Later target edit.");
    let latest = db.write_courseware_teaching(root, &next_write).unwrap();
    let changed = progress(&db, root, &latest);
    assert_eq!(changed["status"], "superseded");
    assert_eq!(
        changed["teachingRevision"], adopted.teaching_revision,
        "Historical result must not become the newest revision"
    );
    assert_eq!(latest.pages[1].actions, next.pages[1].actions);
    assert!(db
        .courseware_chat_change_context("/foreign", &latest)
        .unwrap()
        .is_empty());
}

#[test]
fn failed_result_receipt_rolls_back_narration_and_candidate_until_explicit_retry() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_str().unwrap();
    let db = Database::open_in_dir(dir.path()).unwrap();
    let (original, seed, _, _) = setup(&db, root);
    db.conn.execute_batch("CREATE TRIGGER fail_adopted_result BEFORE INSERT ON kv WHEN NEW.ns='coursewareChatCandidateAdoptions.v1' BEGIN SELECT RAISE(ABORT,'fixture adoption receipt failure'); END;").unwrap();
    assert!(db
        .adopt_narration_candidate(root, &seed, "candidate-1")
        .is_err());
    assert_eq!(
        json!(db
            .get_courseware_project(root, &seed.project_id)
            .unwrap()
            .unwrap()),
        json!(original)
    );
    assert_eq!(progress(&db, root, &original)["status"], "needs-review");
    assert_eq!(
        db.conn
            .query_row(
                "SELECT count(*) FROM kv WHERE ns='coursewareHistory.v1'",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );
    db.conn
        .execute_batch("DROP TRIGGER fail_adopted_result;")
        .unwrap();
    let next = db
        .adopt_narration_candidate(root, &seed, "candidate-1")
        .unwrap();
    assert_eq!(progress(&db, root, &next)["status"], "adopted");
}

#[test]
fn rejected_stale_and_legacy_adopted_results_never_claim_current_adoption() {
    for state in ["rejected", "stale", "legacy"] {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        let db = Database::open_in_dir(dir.path()).unwrap();
        let (original, seed, mut write, _) = setup(&db, root);
        let mut current = original;
        if state == "rejected" {
            db.reject_narration_candidate(root, &seed.project_id, "candidate-1")
                .unwrap();
        }
        if state == "stale" {
            write.actions[0]["text"] = json!("Intervening edit.");
            current = db.write_courseware_teaching(root, &write).unwrap();
        }
        if state == "legacy" {
            current = db
                .adopt_narration_candidate(root, &seed, "candidate-1")
                .unwrap();
            db.conn
                .execute(
                    "DELETE FROM kv WHERE ns='coursewareChatCandidateAdoptions.v1'",
                    [],
                )
                .unwrap();
        }
        assert_eq!(
            progress(&db, root, &current)["status"],
            if state == "legacy" { "unknown" } else { state }
        );
    }
}
