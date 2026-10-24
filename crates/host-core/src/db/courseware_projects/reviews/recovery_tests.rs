use super::{
    tests::{seed, write},
    *,
};
use serde_json::json;

fn adopt(
    db: &Database,
    root: &str,
    target: &SavedProjectSeed,
    project: &CoursewareProject,
) -> CoursewareProject {
    let review = db.prepare_courseware_review(root, target).unwrap();
    db.adopt_courseware_review(
        root,
        target,
        review["reviewId"].as_str().unwrap(),
        &[Some(project.pages[0].page_id.clone())],
    )
    .unwrap()
}

#[test]
fn office_undo_creates_new_teaching_revision_preserving_later_edits_and_history() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_str().unwrap();
    let original = seed('a', "undo-source");
    let changed = seed('b', "undo-source");
    let db = Database::open_in_dir(dir.path()).unwrap();
    let initial = db
        .open_identified_courseware_project(root, &original)
        .unwrap();
    let historical_mapping = db
        .courseware_project_context(root, &initial.project_id)
        .unwrap()["mapping"]
        .clone();
    let changed_project = adopt(&db, root, &changed, &initial);
    let later = write(
        &db,
        root,
        &changed_project,
        vec![
            json!({"id":"speech","type":"speech","text":"Keep the teacher's later narration","source":"external","pauseAfterMs":1900}),
        ],
    );
    let restored = adopt(&db, root, &original, &later);
    assert_eq!(restored.source.sha256, original.sha256);
    assert_eq!(restored.pages[0].actions, later.pages[0].actions);
    assert_eq!(restored.pages[0].page_id, later.pages[0].page_id);
    assert_eq!(restored.pages[0].review_state, "review");
    assert_ne!(restored.teaching_revision, later.teaching_revision);
    assert_ne!(restored.teaching_revision, initial.teaching_revision);
    assert!(db
        .capture_courseware_snapshot(
            root,
            &original,
            "unreviewed-undo",
            &restored.source.revision,
            &restored.teaching_revision,
            vec![]
        )
        .unwrap_err()
        .to_string()
        .contains("confirm every teaching page"));
    assert_eq!(
        db.courseware_project_context(root, &initial.project_id)
            .unwrap()["mapping"],
        historical_mapping
    );
    let history_key = serde_json::to_string(&(
        storage_key(root, &later.project_id).unwrap(),
        &later.teaching_revision,
    ))
    .unwrap();
    assert_eq!(
        db.kv_get(HISTORY_NAMESPACE, &history_key).unwrap().unwrap(),
        serde_json::to_value(&later).unwrap()
    );
    drop(db);
    let db = Database::open_in_dir(dir.path()).unwrap();
    assert_eq!(
        serde_json::to_value(
            db.get_courseware_project(root, &initial.project_id)
                .unwrap()
                .unwrap()
        )
        .unwrap(),
        serde_json::to_value(&restored).unwrap()
    );
    let redone = adopt(&db, root, &changed, &restored);
    assert_eq!(redone.pages[0].actions, later.pages[0].actions);
    assert_ne!(redone.teaching_revision, restored.teaching_revision);
}

fn records(db: &Database) -> Vec<(String, String, String)> {
    db.conn
        .prepare("SELECT ns,key,value_json FROM kv ORDER BY ns,key")
        .unwrap()
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .unwrap()
        .map(Result::unwrap)
        .collect()
}

#[test]
fn office_undo_rejects_stale_review_and_rolls_back_failure_before_retry() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_str().unwrap();
    let original = seed('a', "undo-source");
    let changed = seed('b', "undo-source");
    let db = Database::open_in_dir(dir.path()).unwrap();
    let initial = db
        .open_identified_courseware_project(root, &original)
        .unwrap();
    let current = adopt(&db, root, &changed, &initial);
    let stale = db.prepare_courseware_review(root, &original).unwrap();
    let later = write(
        &db,
        root,
        &current,
        vec![json!({"id":"speech","type":"speech","text":"Written after the undo review opened"})],
    );
    let before = records(&db);
    assert!(db
        .adopt_courseware_review(
            root,
            &original,
            stale["reviewId"].as_str().unwrap(),
            &[Some(later.pages[0].page_id.clone())]
        )
        .unwrap_err()
        .to_string()
        .contains("changed during review"));
    assert_eq!(records(&db), before);
    let review = db.prepare_courseware_review(root, &original).unwrap();
    let before = records(&db);
    db.conn.execute_batch("CREATE TRIGGER undo_failure BEFORE UPDATE ON kv WHEN NEW.ns='coursewareProjects.v1' BEGIN SELECT RAISE(ABORT,'fixture undo failure'); END;").unwrap();
    let error = db
        .adopt_courseware_review(
            root,
            &original,
            review["reviewId"].as_str().unwrap(),
            &[Some(later.pages[0].page_id.clone())],
        )
        .unwrap_err();
    assert!(error.to_string().contains("fixture undo failure"));
    assert_eq!(records(&db), before);
    db.conn.execute_batch("DROP TRIGGER undo_failure;").unwrap();
    drop(db);
    let db = Database::open_in_dir(dir.path()).unwrap();
    let restored = db
        .adopt_courseware_review(
            root,
            &original,
            review["reviewId"].as_str().unwrap(),
            &[Some(later.pages[0].page_id.clone())],
        )
        .unwrap();
    assert_eq!(restored.pages[0].actions, later.pages[0].actions);
    assert_ne!(restored.teaching_revision, later.teaching_revision);
}

#[test]
fn office_undo_refuses_conflicting_historical_page_association_or_parser_export() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_str().unwrap();
    let original = seed('a', "undo-source");
    let db = Database::open_in_dir(dir.path()).unwrap();
    let initial = db
        .open_identified_courseware_project(root, &original)
        .unwrap();
    let current = adopt(&db, root, &seed('b', "undo-source"), &initial);
    let review = db.prepare_courseware_review(root, &original).unwrap();
    let before = records(&db);
    assert!(db
        .adopt_courseware_review(
            root,
            &original,
            review["reviewId"].as_str().unwrap(),
            &[None]
        )
        .unwrap_err()
        .to_string()
        .contains("historical source identity"));
    assert_eq!(records(&db), before);
    let mut different_export = seed('a', "undo-source");
    let mut value = different_export.identity.take().unwrap().value().clone();
    value["pages"][0]["contentFingerprint"] = json!("d".repeat(64));
    different_export.identity =
        Some(SavedSourceIdentity::parse(&serde_json::to_vec(&value).unwrap()).unwrap());
    let review = db
        .prepare_courseware_review(root, &different_export)
        .unwrap();
    let before = records(&db);
    assert!(db
        .adopt_courseware_review(
            root,
            &different_export,
            review["reviewId"].as_str().unwrap(),
            &[Some(current.pages[0].page_id.clone())]
        )
        .unwrap_err()
        .to_string()
        .contains("historical source identity"));
    assert_eq!(records(&db), before);
}

#[test]
fn office_undo_requires_explicit_cue_target_review_and_preserves_current_words() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_str().unwrap();
    let original = seed('a', "undo-source");
    let db = Database::open_in_dir(dir.path()).unwrap();
    let initial = db
        .open_identified_courseware_project(root, &original)
        .unwrap();
    let original_context = db
        .courseware_project_context(root, &initial.project_id)
        .unwrap();
    let historical_target =
        original_context["savedObjects"]["pages"][0]["objects"][1]["objectId"].clone();
    let current = adopt(&db, root, &seed('b', "undo-source"), &initial);
    let current_context = db
        .courseware_project_context(root, &current.project_id)
        .unwrap();
    let target = current_context["savedObjects"]["pages"][0]["objects"][0]["objectId"].clone();
    let later = write(
        &db,
        root,
        &current,
        vec![
            json!({"id":"speech","type":"speech","text":"New words survive undo","visualCues":[{"id":"cue","atMs":0,"endMs":800,"effect":{"type":"highlight","elementIds":[target]}}]}),
        ],
    );
    let review = db.prepare_courseware_review(root, &original).unwrap();
    let page_bindings = [Some(later.pages[0].page_id.clone())];
    let before = records(&db);
    assert!(db
        .adopt_courseware_review(
            root,
            &original,
            review["reviewId"].as_str().unwrap(),
            &page_bindings
        )
        .unwrap_err()
        .to_string()
        .contains("every effect target requires explicit association"));
    assert_eq!(records(&db), before);
    let restored = db
        .adopt_courseware_review_with_effects(
            root,
            &original,
            review["reviewId"].as_str().unwrap(),
            &page_bindings,
            &[json!({"pageIndex":0,"objectId":target,"targetIndex":2})],
        )
        .unwrap();
    assert_eq!(
        restored.pages[0].actions[0]["text"],
        "New words survive undo"
    );
    assert_eq!(
        restored.pages[0].actions[0]["visualCues"][0]["effect"]["elementIds"],
        json!([historical_target])
    );
    assert_eq!(restored.pages[0].review_state, "review");
}
