use super::*;

fn fixture() -> (CoursewareProject, TeachingWrite) {
    let raw: Value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../packages/shared/src/courseware-contract.fixtures/accepted.json"
    )))
    .unwrap();
    (
        serde_json::from_value(raw["project"].clone()).unwrap(),
        serde_json::from_value(raw["write"].clone()).unwrap(),
    )
}

#[test]
fn saved_source_opens_idempotently_and_changed_source_preserves_teaching() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("pi.sqlite");
    let workspace = dir.path().to_str().unwrap();
    let saved;
    {
        let db = Database::open(&path).unwrap();
        let original = db
            .open_saved_courseware_project(workspace, "office-lesson", &"a".repeat(64), 2)
            .unwrap();
        let write = TeachingWrite {
            project_id: original.project_id.clone(),
            page_id: original.pages[1].page_id.clone(),
            expected_source_revision: original.source.revision.clone(),
            expected_teaching_revision: original.teaching_revision,
            actions: vec![serde_json::json!({"id":"speech-1","type":"speech","text":"Good!"})],
        };
        saved = db.write_courseware_teaching(workspace, &write).unwrap();
        let reopened = db
            .open_saved_courseware_project(workspace, "office-lesson", &"a".repeat(64), 2)
            .unwrap();
        assert_eq!(
            serde_json::to_value(reopened).unwrap(),
            serde_json::to_value(&saved).unwrap()
        );
        for (hash, pages) in [("b".repeat(64), 2), ("a".repeat(64), 3)] {
            assert!(db
                .open_saved_courseware_project(workspace, "office-lesson", &hash, pages)
                .unwrap_err()
                .to_string()
                .starts_with("COURSEWARE_CONFLICT"));
        }
        assert!(db
            .open_saved_courseware_project(
                workspace,
                "office-oversized",
                &"a".repeat(64),
                usize::MAX
            )
            .is_err());
    }
    let db = Database::open(&path).unwrap();
    let reopened = db
        .open_saved_courseware_project(workspace, "office-lesson", &"a".repeat(64), 2)
        .unwrap();
    assert_eq!(
        serde_json::to_value(reopened).unwrap(),
        serde_json::to_value(saved).unwrap()
    );
}

#[test]
fn two_pages_survive_reopen_and_old_schema_is_unchanged() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("pi.sqlite");
    let workspace = dir.path().to_str().unwrap();
    let (project, mut write) = fixture();
    let saved;
    {
        let db = Database::open(&path).unwrap();
        db.kv_set("app", "unrelated", &serde_json::json!({"keep": true}))
            .unwrap();
        db.create_courseware_project(workspace, &project).unwrap();
        let first = db.write_courseware_teaching(workspace, &write).unwrap();
        assert_eq!(first.pages[0].actions, write.actions);
        let unlocked = db
            .set_courseware_page_lock(
                workspace,
                &project.project_id,
                "fixture-page-2",
                &project.source.revision,
                &first.teaching_revision,
                false,
            )
            .unwrap();
        write.page_id = "fixture-page-2".into();
        write.expected_teaching_revision = unlocked.teaching_revision;
        write.actions[0]["text"] = serde_json::json!("Four equal sides.");
        saved = db.write_courseware_teaching(workspace, &write).unwrap();
        assert_ne!(saved.teaching_revision, project.teaching_revision);
        assert_eq!(saved.source.sha256, project.source.sha256);
    }
    let db = Database::open(&path).unwrap();
    let loaded = db
        .get_courseware_project(workspace, &project.project_id)
        .unwrap()
        .unwrap();
    assert_eq!(
        loaded
            .education_context
            .as_ref()
            .unwrap()
            .subject
            .as_deref(),
        Some("english")
    );
    assert_eq!(
        serde_json::to_value(loaded).unwrap(),
        serde_json::to_value(saved).unwrap()
    );
    assert_eq!(
        db.kv_get("app", "unrelated").unwrap(),
        Some(serde_json::json!({"keep": true}))
    );
    let version: i64 = db
        .conn
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .unwrap();
    assert_eq!(version, super::super::SCHEMA_VERSION);
}

#[test]
fn shared_conflict_fixture_and_manual_locks_preserve_data() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open_in_dir(dir.path()).unwrap();
    let workspace = dir.path().to_str().unwrap();
    let raw: Value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../packages/shared/src/courseware-contract.fixtures/stale-write.json"
    )))
    .unwrap();
    let project: CoursewareProject = serde_json::from_value(raw["project"].clone()).unwrap();
    let mut write: TeachingWrite = serde_json::from_value(raw["write"].clone()).unwrap();
    db.create_courseware_project(workspace, &project).unwrap();
    assert!(db
        .write_courseware_teaching(workspace, &write)
        .unwrap_err()
        .to_string()
        .starts_with("COURSEWARE_CONFLICT"));
    write.expected_source_revision = project.source.revision.clone();
    write.expected_teaching_revision = project.teaching_revision.clone();
    write.page_id = "fixture-page-2".into();
    assert!(db
        .write_courseware_teaching(workspace, &write)
        .unwrap_err()
        .to_string()
        .starts_with("COURSEWARE_LOCKED"));
    let after = db
        .get_courseware_project(workspace, &project.project_id)
        .unwrap()
        .unwrap();
    assert_eq!(serde_json::to_value(after).unwrap(), raw["project"]);
    assert!(db.create_courseware_project(workspace, &project).is_err());
    assert!(db
        .get_courseware_project("/another/workspace", &project.project_id)
        .unwrap()
        .is_none());
}

#[test]
fn invalid_input_is_rejected_before_inserting() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open_in_dir(dir.path()).unwrap();
    let workspace = dir.path().to_str().unwrap();
    let (mut project, _) = fixture();
    project.pages.push(project.pages[0].clone());
    assert!(db.create_courseware_project(workspace, &project).is_err());
    assert!(db
        .get_courseware_project(workspace, &project.project_id)
        .unwrap()
        .is_none());
    let mut raw = serde_json::to_value(project).unwrap();
    raw["apiKey"] = serde_json::json!("not-allowed");
    assert!(serde_json::from_value::<CoursewareProject>(raw).is_err());
    let (project, _) = fixture();
    let mut raw = serde_json::to_value(project).unwrap();
    raw["educationContext"] = Value::Null;
    assert!(serde_json::from_value::<CoursewareProject>(raw).is_err());
}

#[test]
fn failed_sql_update_and_stale_second_writer_preserve_last_saved_revision() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("pi.sqlite");
    let db = Database::open(&path).unwrap();
    let other = Database::open(&path).unwrap();
    let workspace = dir.path().to_str().unwrap();
    let (project, write) = fixture();
    db.create_courseware_project(workspace, &project).unwrap();
    db.conn
        .execute_batch(
            "CREATE TRIGGER fail_courseware_save AFTER UPDATE ON kv
         WHEN NEW.ns = 'coursewareProjects.v1' BEGIN SELECT RAISE(ABORT, 'injected failure'); END;",
        )
        .unwrap();
    assert!(db.write_courseware_teaching(workspace, &write).is_err());
    let after = db
        .get_courseware_project(workspace, &project.project_id)
        .unwrap()
        .unwrap();
    assert_eq!(
        serde_json::to_value(after).unwrap(),
        serde_json::to_value(&project).unwrap()
    );
    db.conn
        .execute_batch("DROP TRIGGER fail_courseware_save")
        .unwrap();
    let saved = db.write_courseware_teaching(workspace, &write).unwrap();
    assert!(other
        .write_courseware_teaching(workspace, &write)
        .unwrap_err()
        .to_string()
        .starts_with("COURSEWARE_CONFLICT"));
    assert_eq!(
        other
            .get_courseware_project(workspace, &project.project_id)
            .unwrap()
            .unwrap()
            .teaching_revision,
        saved.teaching_revision
    );
}
