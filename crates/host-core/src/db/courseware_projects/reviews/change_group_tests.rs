use super::tests::{seed, write};
use super::*;
use serde_json::json;

fn group(db: &Database, root: &str, project: &CoursewareProject) -> Value {
    db.courseware_project_context(root, &project.project_id)
        .unwrap()["sourceChange"]
        .clone()
}

#[test]
fn saved_page_teaching_failure_survives_restart_without_rolling_back_later_work() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_str().unwrap();
    let db = Database::open_in_dir(dir.path()).unwrap();
    let original = db
        .open_identified_courseware_project(root, &seed('a', "change-group"))
        .unwrap();
    let original = write(
        &db,
        root,
        &original,
        vec![json!({"id":"speech","type":"speech","text":"Apple"})],
    );
    assert!(group(&db, root, &original).is_null());
    let target = seed('b', "change-group");
    let review = db.prepare_courseware_review(root, &target).unwrap();
    let id = review["reviewId"].as_str().unwrap();
    let pending = group(&db, root, &original);
    assert_eq!(pending["changeGroupId"], id);
    assert_eq!(pending["phase"], "source-review");
    assert_eq!(pending["baselineSource"], original.source.sha256);
    assert_eq!(
        pending["baselineTeachingRevision"],
        original.teaching_revision
    );
    assert_eq!(pending["targetSource"], target.sha256);
    assert_eq!(pending["completed"], json!(["source-saved"]));
    let adopted = db
        .adopt_courseware_review(
            root,
            &target,
            id,
            &[Some(original.pages[0].page_id.clone())],
        )
        .unwrap();
    assert_eq!(group(&db, root, &adopted)["phase"], "teaching-review");
    let failed_write = TeachingWrite {
        project_id: adopted.project_id.clone(),
        page_id: adopted.pages[0].page_id.clone(),
        expected_source_revision: adopted.source.revision.clone(),
        expected_teaching_revision: adopted.teaching_revision.clone(),
        actions: vec![json!({"id":"speech","type":"speech","text":"Pear"})],
    };
    db.conn.execute_batch("CREATE TRIGGER teaching_failure BEFORE UPDATE ON kv WHEN NEW.ns='coursewareProjects.v1' BEGIN SELECT RAISE(ABORT,'fixture teaching failure'); END;").unwrap();
    assert!(db.write_courseware_teaching(root, &failed_write).is_err());
    let failed = group(&db, root, &adopted);
    assert_eq!(failed["pendingPageIds"], json!([adopted.pages[0].page_id]));
    assert_eq!(
        failed["completed"],
        json!(["source-saved", "source-associated"])
    );
    assert!(db
        .capture_courseware_snapshot(
            root,
            &target,
            "failed-build",
            &adopted.source.revision,
            &adopted.teaching_revision,
            vec![]
        )
        .unwrap_err()
        .to_string()
        .contains("confirm every teaching page"));
    db.conn
        .execute_batch("DROP TRIGGER teaching_failure;")
        .unwrap();
    drop(db);
    let db = Database::open_in_dir(dir.path()).unwrap();
    assert_eq!(group(&db, root, &adopted), failed);
    let later = write(
        &db,
        root,
        &adopted,
        vec![json!({"id":"speech","type":"speech","text":"Later human words"})],
    );
    assert!(db.write_courseware_teaching(root, &failed_write).is_err());
    let current = db
        .get_courseware_project(root, &original.project_id)
        .unwrap()
        .unwrap();
    assert_eq!(current.source.sha256, target.sha256);
    assert_eq!(current.pages[0].actions, later.pages[0].actions);
    assert_eq!(group(&db, root, &later)["changeGroupId"], id);
    let ready = db
        .review_courseware_page(
            root,
            &later.project_id,
            &later.pages[0].page_id,
            &later.source.revision,
            &later.teaching_revision,
        )
        .unwrap();
    let completed = group(&db, root, &ready);
    assert_eq!(completed["phase"], "complete");
    assert_eq!(completed["pendingPageIds"], json!([]));
    assert_eq!(
        completed["currentTeachingRevision"],
        ready.teaching_revision
    );
    assert_eq!(
        completed["completed"],
        json!(["source-saved", "source-associated", "teaching-review"])
    );
    let edited = write(
        &db,
        root,
        &ready,
        vec![json!({"id":"speech","type":"speech","text":"Changed after confirmation"})],
    );
    assert_eq!(group(&db, root, &edited)["phase"], "teaching-review");
}

#[test]
fn source_association_and_its_receipt_are_atomic_and_legacy_reviews_upgrade() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_str().unwrap();
    let db = Database::open_in_dir(dir.path()).unwrap();
    let original = db
        .open_identified_courseware_project(root, &seed('a', "change-group"))
        .unwrap();
    let target = seed('b', "change-group");
    let review = db.prepare_courseware_review(root, &target).unwrap();
    let pending = group(&db, root, &original);
    db.conn.execute_batch("CREATE TRIGGER receipt_failure BEFORE UPDATE ON kv WHEN NEW.ns='coursewareSourceChanges.v1' BEGIN SELECT RAISE(ABORT,'fixture receipt failure'); END;").unwrap();
    assert!(db
        .adopt_courseware_review(
            root,
            &target,
            review["reviewId"].as_str().unwrap(),
            &[Some(original.pages[0].page_id.clone())]
        )
        .is_err());
    assert_eq!(group(&db, root, &original), pending);
    assert_eq!(
        db.get_courseware_project(root, &original.project_id)
            .unwrap()
            .unwrap()
            .source
            .sha256,
        original.source.sha256
    );
    db.conn.execute_batch("DROP TRIGGER receipt_failure; DELETE FROM kv WHERE ns IN ('coursewareSourceChanges.v1','coursewareSourceChangeLatest.v1');").unwrap();
    let adopted = db
        .adopt_courseware_review(
            root,
            &target,
            review["reviewId"].as_str().unwrap(),
            &[Some(original.pages[0].page_id.clone())],
        )
        .unwrap();
    assert_eq!(group(&db, root, &adopted)["phase"], "teaching-review");
    assert_eq!(
        group(&db, root, &adopted)["baselineSource"],
        original.source.sha256
    );
    assert!(db
        .courseware_project_context("/other-workspace", &adopted.project_id)
        .is_err());
}

#[test]
fn fresh_review_preserves_old_receipts_and_stale_intent_is_visible() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_str().unwrap();
    let db = Database::open_in_dir(dir.path()).unwrap();
    let original = db
        .open_identified_courseware_project(root, &seed('a', "change-group"))
        .unwrap();
    let target = seed('b', "change-group");
    let first = db.prepare_courseware_review(root, &target).unwrap();
    assert_eq!(db.prepare_courseware_review(root, &target).unwrap(), first);
    let later = write(
        &db,
        root,
        &original,
        vec![json!({"id":"speech","type":"speech","text":"Newer teaching"})],
    );
    assert_eq!(group(&db, root, &later)["stale"], true);
    let retained: Vec<String> = db
        .conn
        .prepare("SELECT value_json FROM kv WHERE ns='coursewareSourceChanges.v1'")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    assert_eq!(retained.len(), 1);
    assert!(db
        .adopt_courseware_review(
            root,
            &target,
            first["reviewId"].as_str().unwrap(),
            &[Some(later.pages[0].page_id.clone())]
        )
        .is_err());
    let second = db.prepare_courseware_review(root, &target).unwrap();
    assert_ne!(second["reviewId"], first["reviewId"]);
    assert_eq!(group(&db, root, &later)["stale"], false);
    let all: Vec<String> = db
        .conn
        .prepare("SELECT value_json FROM kv WHERE ns='coursewareSourceChanges.v1'")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    assert_eq!(all.len(), 2);
    assert!(all.contains(&retained[0]));
    db.conn
        .execute_batch("DELETE FROM kv WHERE ns='coursewareSourceChanges.v1';")
        .unwrap();
    assert!(db
        .courseware_project_context(root, &later.project_id)
        .unwrap_err()
        .to_string()
        .contains("receipt is missing"));
}
