use super::*;
use serde_json::json;

fn fixture_seed() -> SavedProjectSeed {
    let identity = SavedSourceIdentity::parse(include_bytes!(
        "../../../courseware/identity/fixtures/identity.json"
    ))
    .unwrap();
    SavedProjectSeed {
        project_id: "office-identity-test".into(),
        sha256: identity.value()["sourceSha256"].as_str().unwrap().into(),
        pages: 1,
        identity: Some(identity),
    }
}

fn identity(db: &Database) -> Value {
    db.conn
        .query_row(
            "SELECT value_json FROM kv WHERE ns = ?1",
            [IDENTITY_NAMESPACE],
            |row| row.get::<_, String>(0),
        )
        .map(|text| serde_json::from_str(&text).unwrap())
        .unwrap()
}

#[test]
fn first_open_uses_selected_task_and_teaching_settings_without_rewriting_existing_project() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
    let workspace = dir.path().to_str().unwrap();
    let seed = fixture_seed();
    let education: CoursewareEducationContext = serde_json::from_value(json!({
        "schoolStage": "kindergarten", "subject": "english", "grade": "大班"
    }))
    .unwrap();
    let project = db
        .open_identified_courseware_project_with_metadata(
            workspace,
            &seed,
            "scene",
            Some(education),
        )
        .unwrap();
    assert_eq!(project.task_type, "scene");
    assert_eq!(
        project.education_context.as_ref().unwrap().grade.as_deref(),
        Some("大班")
    );
    let narrated = db
        .initialize_generated_narration(
            workspace,
            &project.project_id,
            &seed.sha256,
            "问候课",
            &["和朋友挥手，说 Hello。".into()],
        )
        .unwrap();
    assert_eq!(narrated.title, "问候课");
    assert_eq!(
        narrated.pages[0].actions[0]["text"],
        "和朋友挥手，说 Hello。"
    );
    assert_eq!(narrated.pages[0].actions[0]["type"], "speech");
    let repeated = db
        .initialize_generated_narration(
            workspace,
            &project.project_id,
            &seed.sha256,
            "问候课",
            &["和朋友挥手，说 Hello。".into()],
        )
        .unwrap();
    assert_eq!(repeated.teaching_revision, narrated.teaching_revision);
    assert!(db
        .initialize_generated_narration(
            workspace,
            &project.project_id,
            &seed.sha256,
            "问候课",
            &["另一段讲解".into()],
        )
        .is_err());
    let reopened = db
        .open_identified_courseware_project_with_metadata(workspace, &seed, "import", None)
        .unwrap();
    assert_eq!(reopened.task_type, "scene");
    assert_eq!(reopened.pages[0].page_id, project.pages[0].page_id);
    assert_eq!(
        reopened.education_context.unwrap().subject.as_deref(),
        Some("english")
    );
    assert_eq!(
        reopened.pages[0].actions[0]["text"],
        "和朋友挥手，说 Hello。"
    );
    assert_eq!(reopened.title, "问候课");
}

#[test]
fn same_source_keeps_logical_ids_mapping_revision_teaching_and_locks_after_restart() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("pi.sqlite");
    let workspace = dir.path().to_str().unwrap();
    let seed = fixture_seed();
    let saved;
    let project;
    {
        let db = Database::open(&path).unwrap();
        let initial = db
            .open_identified_courseware_project(workspace, &seed)
            .unwrap();
        let edited = db
            .write_courseware_teaching(
                workspace,
                &TeachingWrite {
                    project_id: initial.project_id.clone(),
                    page_id: initial.pages[0].page_id.clone(),
                    expected_source_revision: initial.source.revision.clone(),
                    expected_teaching_revision: initial.teaching_revision,
                    actions: vec![json!({"id":"speech-1","type":"speech","text":"Good!"})],
                },
            )
            .unwrap();
        project = db
            .set_courseware_page_lock(
                workspace,
                &edited.project_id,
                &edited.pages[0].page_id,
                &edited.source.revision,
                &edited.teaching_revision,
                true,
            )
            .unwrap();
        saved = identity(&db);
        assert_eq!(saved["pages"][0]["logicalId"], project.pages[0].page_id);
        assert!(
            SavedSourceIdentity::parse(&serde_json::to_vec(&saved).unwrap())
                .unwrap()
                .same_export(seed.identity.as_ref().unwrap())
        );
        assert_eq!(
            serde_json::to_value(
                db.open_identified_courseware_project(workspace, &seed)
                    .unwrap()
            )
            .unwrap(),
            serde_json::to_value(&project).unwrap()
        );
        assert_eq!(identity(&db), saved);
    }
    let db = Database::open(&path).unwrap();
    assert_eq!(
        serde_json::to_value(
            db.open_identified_courseware_project(workspace, &seed)
                .unwrap()
        )
        .unwrap(),
        serde_json::to_value(&project).unwrap()
    );
    assert_eq!(identity(&db), saved);
    let mut changed = fixture_seed();
    changed.sha256 = "b".repeat(64);
    assert!(db
        .open_identified_courseware_project(workspace, &changed)
        .unwrap_err()
        .to_string()
        .starts_with("COURSEWARE_CONFLICT"));
    assert_eq!(identity(&db), saved);
    let mut drift = seed.identity.unwrap().value().clone();
    drift["pages"][0]["objects"][0]["contentFingerprint"] = json!("b".repeat(64));
    changed.sha256 = project.source.sha256.clone();
    changed.identity =
        Some(SavedSourceIdentity::parse(&serde_json::to_vec(&drift).unwrap()).unwrap());
    assert!(db
        .open_identified_courseware_project(workspace, &changed)
        .unwrap_err()
        .to_string()
        .starts_with("COURSEWARE_CONFLICT"));
    assert_eq!(identity(&db), saved);
    assert_eq!(
        serde_json::to_value(
            db.get_courseware_project(workspace, &project.project_id)
                .unwrap()
                .unwrap()
        )
        .unwrap(),
        serde_json::to_value(project).unwrap()
    );
}

#[test]
fn identity_failure_rolls_back_new_project_and_existing_projects_upgrade_without_changes() {
    let dir = tempfile::tempdir().unwrap();
    let workspace = dir.path().to_str().unwrap();
    let db = Database::open_in_dir(dir.path()).unwrap();
    let seed = fixture_seed();
    db.conn.execute_batch("CREATE TRIGGER identity_failure BEFORE INSERT ON kv WHEN NEW.ns = 'coursewareIdentities.v1' BEGIN SELECT RAISE(ABORT, 'fixture disk failure'); END;").unwrap();
    assert!(db
        .open_identified_courseware_project(workspace, &seed)
        .is_err());
    assert!(db
        .get_courseware_project(workspace, &seed.project_id)
        .unwrap()
        .is_none());
    db.conn
        .execute_batch("DROP TRIGGER identity_failure;")
        .unwrap();
    let legacy = db
        .open_saved_courseware_project(workspace, &seed.project_id, &seed.sha256, seed.pages)
        .unwrap();
    let upgraded = db
        .open_identified_courseware_project(workspace, &seed)
        .unwrap();
    assert_eq!(
        serde_json::to_value(upgraded).unwrap(),
        serde_json::to_value(&legacy).unwrap()
    );
    let saved = identity(&db);
    assert_eq!(saved["pages"][0]["logicalId"], legacy.pages[0].page_id);
    let legacy_seed = SavedProjectSeed {
        identity: None,
        ..seed
    };
    db.open_identified_courseware_project(workspace, &legacy_seed)
        .unwrap();
    assert_eq!(identity(&db), saved);
    db.open_identified_courseware_project("/different/workspace", &legacy_seed)
        .unwrap();
    assert_eq!(identity(&db), saved);
}
